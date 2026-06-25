// api/checkout-recovery.js — Recuperacao de checkout abandonado Stripe
//
// Fluxo:
//   1) Cron sweep (15min): lista Stripe sessions status=open (ultimas 4h),
//      UPSERT idempotente em checkout_recovery por stripe_session_id
//   2) Crons send-1h/24h/72h: pra cada bucket de tempo, envia email pros
//      pendentes que nao foram tocados ainda e nao estao unsub/pagos
//   3) Webhook (api/webhook.js) marca status=recovered quando user paga
//      OU status=expired quando Stripe expira a sessao
//
// AUTH: crons usam x-vercel-cron header (auto Vercel). Endpoint stats exige
// Bearer ADMIN_SECRET. Outras chamadas manuais tambem aceitam ADMIN_SECRET.
//
// FILTROS antes de enviar (defesa em profundidade):
//   - email NAO esta em email_marketing.unsubscribed=true (LGPD/CAN-SPAM)
//   - subscriber NAO ja virou pagante por outra rota (plan!='free' efetivo)
//   - status='pending' (nao recuperado/expirado)
//   - email_Xh_sent_at IS NULL (nao enviou esse bucket ainda)
//
// PADROES (conforme codebase existente):
//   - From: 'BlueTube <bluetubeoficial@bluetubeviral.com>'
//   - Rate limit: 100ms entre sends (igual email-marketing.js)
//   - Lotes: 50 por execucao
//   - Unsub via _helpers/unsub-token.js scope=all
//   - Logs em payment_logs (igual payment-monitor.js)

const { signToken } = require('./_helpers/unsub-token');

const FROM = 'BlueTube <bluetubeoficial@bluetubeviral.com>';
const BATCH_SIZE = 50;
const RATE_LIMIT_MS = 100;
// IMPORTANTE: deve ser >= maior bucket (72h) + margem. Senao bucket 72h vira
// dead code (sweep nao captura sessions antigas o suficiente). 80h = 72h + 8h folga.
const SWEEP_WINDOW_HOURS = 80;

// Config por bucket de tempo
const BUCKETS = {
  '1h':  { hoursAgo: 1,  column: 'email_1h_sent_at',  markExpired: false },
  '24h': { hoursAgo: 24, column: 'email_24h_sent_at', markExpired: false },
  '72h': { hoursAgo: 72, column: 'email_72h_sent_at', markExpired: true  },
};

const SUBJECTS = {
  '1h':  'Você esqueceu algo? 👀',
  '24h': 'Enquanto você decide, criadores estão postando agora 📈',
  '72h': 'Última chance: seu acesso expira em horas ⏰',
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const SITE_URL = process.env.SITE_URL || 'https://bluetubeviral.com';
  const ADMIN_SECRET = process.env.ADMIN_SECRET;

  if (!SU || !SK) return res.status(500).json({ error: 'config_missing_supabase' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const action = (req.query.action || '').toString();

  // Auth: cron header OU Bearer ADMIN_SECRET OU ?admin_secret= na query
  // (GitHub Actions usa query string; padrao aceito pelos outros endpoints
  // que foram migrados — ver reference_vercel_crons_limit_github_actions)
  const isCron = !!req.headers['x-vercel-cron'];
  const bearerOk = ADMIN_SECRET && (req.headers.authorization || '') === `Bearer ${ADMIN_SECRET}`;
  const queryOk = ADMIN_SECRET && req.query.admin_secret === ADMIN_SECRET;
  if (!isCron && !bearerOk && !queryOk) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const ctx = { SU, SK, h, STRIPE_SECRET, RESEND_KEY, SITE_URL };

  try {
    if (action === 'sweep')    return await sweep(ctx, res);
    if (action === 'send-1h')  return await sendBatch(ctx, res, '1h');
    if (action === 'send-24h') return await sendBatch(ctx, res, '24h');
    if (action === 'send-72h') return await sendBatch(ctx, res, '72h');
    if (action === 'stats')    return await stats(ctx, res);
    return res.status(400).json({ error: 'action_invalida', valid: ['sweep','send-1h','send-24h','send-72h','stats'] });
  } catch (e) {
    console.error('[checkout-recovery]', action, e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// ACTION: sweep — popula checkout_recovery com sessions abertas do Stripe
// ═══════════════════════════════════════════════════════════════════════════
async function sweep(ctx, res) {
  const { SU, h, STRIPE_SECRET } = ctx;
  const inicio = Date.now();

  if (!STRIPE_SECRET) return res.status(500).json({ error: 'stripe_key_missing' });

  // Lista Stripe sessions criadas nas ultimas SWEEP_WINDOW_HOURS com status=open
  const sinceTs = Math.floor((Date.now() - SWEEP_WINDOW_HOURS * 3600 * 1000) / 1000);
  const params = new URLSearchParams({
    status: 'open',
    'created[gte]': String(sinceTs),
    limit: '100',
    'expand[]': 'data.customer_details',
  });

  const r = await fetch(`https://api.stripe.com/v1/checkout/sessions?${params}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET}` },
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    return res.status(500).json({ error: 'stripe_list_failed', status: r.status, detail: txt.slice(0, 200) });
  }
  const data = await r.json();
  const sessions = data.data || [];

  // ── DEFESA EM PROFUNDIDADE: pre-filter quem JA E pagante ─────────────────
  // Race condition real: user abre checkout (session.created), fecha aba, e
  // depois assina via NOVA session que completa antes desse sweep rodar. A
  // session antiga continua status=open no Stripe ate ~24h. Sem filtro aqui,
  // ela entraria como pending e o filtro no send-Xh marcaria recovered
  // depois — mas durante ~1h a row fica "incorretamente" pending, polui
  // stats e desabilita email-marketing pro user que ja eh pagante.
  // Fix: ja entra na tabela com status=recovered.
  const allEmails = [...new Set(sessions
    .map(s => (s.customer_details?.email || s.customer_email || '').toLowerCase().trim())
    .filter(Boolean))];
  let paidSet = new Set();
  if (allEmails.length > 0) {
    const inList = allEmails.map(encodeURIComponent).join(',');
    const subR = await fetch(
      `${SU}/rest/v1/subscribers?email=in.(${inList})&select=email,plan,plan_expires_at,is_manual`,
      { headers: h }
    );
    if (subR.ok) {
      const subArr = await subR.json();
      const nowDt = new Date();
      paidSet = new Set(subArr.filter(s => {
        if (!s.plan || s.plan === 'free') return false;
        const isManual = s.is_manual === true;
        const notExpired = !s.plan_expires_at || new Date(s.plan_expires_at) > nowDt;
        return isManual || notExpired;
      }).map(s => String(s.email).toLowerCase()));
    }
  }

  let upserted = 0, skipped_no_email = 0, errors = 0, marked_recovered = 0;
  const nowIso = new Date().toISOString();
  for (const session of sessions) {
    const email = (session.customer_details?.email || session.customer_email || '').toLowerCase().trim();
    if (!email) { skipped_no_email++; continue; }

    const isAlreadyPaid = paidSet.has(email);

    const payload = {
      email,
      stripe_session_id: session.id,
      stripe_customer_id: session.customer || null,
      plan: session.metadata?.plan || 'unknown',
      billing: session.metadata?.billing || 'monthly',
      currency: (session.metadata?.currency || session.currency || 'brl').toLowerCase(),
      amount_total: session.amount_total || null,
      session_created_at: new Date(session.created * 1000).toISOString(),
      session_expires_at: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
      updated_at: nowIso,
    };
    // Se ja eh pagante, ja entra como recovered (nao polui pending, nao
    // ativa filtro de email-marketing). UPSERT preserva 'recovered'/'expired'
    // ja existentes via merge-duplicates (so sobrescreve colunas presentes
    // no payload — status='recovered' aqui SO se for novo OU se ja era
    // pending; recovered/expired pre-existentes ficam recovered/expired).
    if (isAlreadyPaid) {
      payload.status = 'recovered';
      payload.recovered_at = nowIso;
      marked_recovered++;
    }

    try {
      const upR = await fetch(`${SU}/rest/v1/checkout_recovery?on_conflict=stripe_session_id`, {
        method: 'POST',
        headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(payload),
      });
      if (upR.ok) upserted++; else errors++;
    } catch (e) { errors++; }
  }

  return res.status(200).json({
    ok: true,
    action: 'sweep',
    total_sessions_stripe: sessions.length,
    upserted,
    marked_recovered_already_paid: marked_recovered,
    skipped_no_email,
    errors,
    window_hours: SWEEP_WINDOW_HOURS,
    duracao_ms: Date.now() - inicio,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION: send-Xh — envia email recovery pros pendentes do bucket
// ═══════════════════════════════════════════════════════════════════════════
async function sendBatch(ctx, res, bucket) {
  const { SU, h, RESEND_KEY, SITE_URL } = ctx;
  const inicio = Date.now();
  const config = BUCKETS[bucket];
  if (!config) return res.status(400).json({ error: 'bucket_invalido' });
  if (!RESEND_KEY) return res.status(500).json({ error: 'resend_key_missing' });

  // Query: pendentes que ainda nao receberam esse bucket e cuja sessao tem
  // pelo menos hoursAgo de idade
  const cutoff = new Date(Date.now() - config.hoursAgo * 3600 * 1000).toISOString();
  const qs = [
    'status=eq.pending',
    `${config.column}=is.null`,
    `session_created_at=lt.${encodeURIComponent(cutoff)}`,
    'order=session_created_at.asc',
    `limit=${BATCH_SIZE}`,
    'select=*',
  ].join('&');

  const rR = await fetch(`${SU}/rest/v1/checkout_recovery?${qs}`, { headers: h });
  const rows = rR.ok ? await rR.json() : [];

  if (!rows.length) {
    return res.status(200).json({
      ok: true, action: `send-${bucket}`, candidatos: 0, sent: 0,
      motivo: 'sem_pendentes', duracao_ms: Date.now() - inicio,
    });
  }

  // Pre-fetch: emails unsubscribed (CAN-SPAM/LGPD)
  const emails = rows.map(r => r.email);
  const inList = emails.map(encodeURIComponent).join(',');
  const unsubR = await fetch(
    `${SU}/rest/v1/email_marketing?email=in.(${inList})&unsubscribed=eq.true&select=email`,
    { headers: h }
  );
  const unsubSet = new Set(unsubR.ok ? (await unsubR.json()).map(u => u.email) : []);

  // Pre-fetch: subscribers que ja viraram pagantes (plan efetivo != 'free')
  const subR = await fetch(
    `${SU}/rest/v1/subscribers?email=in.(${inList})&select=email,plan,plan_expires_at,is_manual,cancel_at_period_end`,
    { headers: h }
  );
  const subArr = subR.ok ? await subR.json() : [];
  const now = new Date();
  const paidSet = new Set(
    subArr.filter(s => {
      if (!s.plan || s.plan === 'free') return false;
      // Mesma logica de resolverPlanoEfetivo (get-plan)
      const isManual = s.is_manual === true;
      const notExpired = !s.plan_expires_at || new Date(s.plan_expires_at) > now;
      return isManual || notExpired;
    }).map(s => s.email)
  );

  let sent = 0, skipped_unsub = 0, skipped_paid = 0, errors = 0;

  for (const row of rows) {
    // Filtro 1: unsubscribed
    if (unsubSet.has(row.email)) {
      skipped_unsub++;
      await markStatus(SU, h, row.id, 'unsubscribed').catch(() => {});
      continue;
    }

    // Filtro 2: ja pagou via outra rota
    if (paidSet.has(row.email)) {
      skipped_paid++;
      await fetch(`${SU}/rest/v1/checkout_recovery?id=eq.${row.id}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'recovered',
          recovered_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      }).catch(() => {});
      continue;
    }

    // Build email
    const html = buildTemplate(bucket, row, SITE_URL);
    const subject = SUBJECTS[bucket];

    try {
      const sr = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({ from: FROM, to: [row.email], subject, html }),
      });

      if (sr.ok) {
        const patch = {
          [config.column]: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        if (config.markExpired) patch.status = 'expired';

        await fetch(`${SU}/rest/v1/checkout_recovery?id=eq.${row.id}`, {
          method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
          body: JSON.stringify(patch),
        });

        // Log em payment_logs (consistente com payment-monitor.js)
        logPaymentLog(SU, h, {
          stripe_session_id: row.stripe_session_id,
          user_email: row.email,
          plan: row.plan,
          amount: row.amount_total ? (row.amount_total / 100).toFixed(2) : '0',
          status: `recovery_email_${bucket}`,
          note: `Email recovery ${bucket} enviado (${config.markExpired ? 'marcado expired' : 'aguardando proxima janela'})`,
        }).catch(() => {});

        sent++;
      } else {
        errors++;
        const errBody = await sr.text().catch(() => '');
        console.error(`[checkout-recovery send-${bucket}] Resend erro ${sr.status}:`, errBody.slice(0, 200));
      }
    } catch (e) {
      errors++;
      console.error(`[checkout-recovery send-${bucket}] exception:`, e.message);
    }

    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }

  return res.status(200).json({
    ok: true,
    action: `send-${bucket}`,
    candidatos: rows.length,
    sent, skipped_unsub, skipped_paid, errors,
    duracao_ms: Date.now() - inicio,
  });
}

async function markStatus(SU, h, id, status) {
  return fetch(`${SU}/rest/v1/checkout_recovery?id=eq.${id}`, {
    method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
  });
}

async function logPaymentLog(SU, h, data) {
  return fetch(`${SU}/rest/v1/payment_logs`, {
    method: 'POST',
    headers: { ...h, Prefer: 'return=minimal' },
    body: JSON.stringify({ ...data, created_at: new Date().toISOString() }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION: stats — dashboard de conversao (admin)
// ═══════════════════════════════════════════════════════════════════════════
async function stats(ctx, res) {
  const { SU, h } = ctx;
  const result = {};

  // Totais por status
  for (const status of ['pending', 'recovered', 'expired', 'unsubscribed']) {
    const r = await fetch(`${SU}/rest/v1/checkout_recovery?status=eq.${status}&select=id`, {
      headers: { ...h, Prefer: 'count=exact', Range: '0-0' },
    });
    const cr = r.headers.get('content-range') || '';
    const m = cr.match(/\/(\d+)$/);
    result[`total_${status}`] = m ? parseInt(m[1], 10) : 0;
  }

  // Enviados por bucket
  for (const bucket of Object.keys(BUCKETS)) {
    const col = BUCKETS[bucket].column;
    const r = await fetch(`${SU}/rest/v1/checkout_recovery?${col}=not.is.null&select=id`, {
      headers: { ...h, Prefer: 'count=exact', Range: '0-0' },
    });
    const cr = r.headers.get('content-range') || '';
    const m = cr.match(/\/(\d+)$/);
    result[`enviados_${bucket}`] = m ? parseInt(m[1], 10) : 0;
  }

  // Taxa de conversao (dos que terminaram o ciclo)
  const finalizados = result.total_recovered + result.total_expired;
  if (finalizados > 0) {
    result.conversion_rate_pct = +(result.total_recovered * 100 / finalizados).toFixed(2);
  } else {
    result.conversion_rate_pct = 0;
  }

  // Recuperacoes nas ultimas 30d
  const desde30d = new Date(Date.now() - 30 * 86400000).toISOString();
  const recR = await fetch(
    `${SU}/rest/v1/checkout_recovery?status=eq.recovered&recovered_at=gte.${desde30d}&select=id`,
    { headers: { ...h, Prefer: 'count=exact', Range: '0-0' } }
  );
  const cr30 = recR.headers.get('content-range') || '';
  const m30 = cr30.match(/\/(\d+)$/);
  result.recovered_last_30d = m30 ? parseInt(m30[1], 10) : 0;

  return res.status(200).json({ ok: true, ...result });
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS DE TEMPLATE
// ═══════════════════════════════════════════════════════════════════════════

function planLabel(plan) {
  if (plan === 'master') return 'BlueTube Master';
  if (plan === 'full') return 'BlueTube Full';
  return 'sua assinatura BlueTube';
}

function planBenefits(plan) {
  if (plan === 'master') {
    return [
      'Roteiros ilimitados',
      'Voz IA realista (BlueVoice)',
      'Download HD',
      'Buscador viral exclusivo',
      'BlueTendências (Blublu IA)',
    ];
  }
  return [
    '9 roteiros por dia',
    'Todos os idiomas',
    'Comunidade exclusiva',
    'Acesso prioritário',
  ];
}

function resumeUrl(SITE_URL, row) {
  // Preserva plan + billing pra retomar checkout
  return `${SITE_URL}/?plan=${encodeURIComponent(row.plan)}&billing=${encodeURIComponent(row.billing)}&recovery=1`;
}

function buildUnsubUrl(email) {
  try {
    const tok = signToken(email);
    return `https://bluetubeviral.com/api/v1/unsubscribe?token=${tok}&scope=all`;
  } catch {
    return 'https://bluetubeviral.com';
  }
}

function safeName(email) {
  if (!email || !email.includes('@')) return 'criador';
  // Regex strip + HTML escape defesa em profundidade
  const raw = email.split('@')[0].replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40) || 'criador';
  return raw.replace(/[<>"&]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' }[c]));
}

function escapeHtml(s) {
  return String(s || '').replace(/[<>"&]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' }[c]));
}

function buildTemplate(bucket, row, SITE_URL) {
  const ctx = {
    name: safeName(row.email),
    planName: escapeHtml(planLabel(row.plan)),
    benefits: planBenefits(row.plan).map(b => escapeHtml(b)),
    cta: resumeUrl(SITE_URL, row),
    unsub: buildUnsubUrl(row.email),
  };
  if (bucket === '1h')  return template1h(ctx);
  if (bucket === '24h') return template24h(ctx);
  if (bucket === '72h') return template72h(ctx);
  return '';
}

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATES HTML (PT-BR)
// ═══════════════════════════════════════════════════════════════════════════

function shellHtml(inner) {
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#020817;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#e8f4ff">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#020817">
  <tr><td align="center" style="padding:30px 16px">
    <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#0a1220;border-radius:16px;border:1px solid rgba(0,170,255,.2);overflow:hidden">
      <tr><td style="padding:24px 24px 8px">
        <div style="font-size:22px;font-weight:800;color:#1a6bff;letter-spacing:-0.5px">BlueTube</div>
      </td></tr>
      ${inner}
    </table>
  </td></tr>
</table></body></html>`;
}

function template1h({ name, planName, benefits, cta, unsub }) {
  const benefitsList = benefits.map(b => `<div style="font-size:14px;color:#cbd5e1;line-height:1.7">✓ ${b}</div>`).join('');
  return shellHtml(`
    <tr><td style="padding:8px 24px 20px">
      <div style="font-size:20px;color:#fff;font-weight:700;margin-bottom:14px">Oi ${name},</div>
      <p style="font-size:15px;color:#cbd5e1;line-height:1.6;margin:0 0 14px">
        Vi que você quase começou a usar o <strong style="color:#fff">${planName}</strong> hoje, mas o pagamento não foi finalizado.
      </p>
      <p style="font-size:15px;color:#cbd5e1;line-height:1.6;margin:0 0 22px">
        Tudo bem? Pode ter sido só uma distração — acontece. 🙃
      </p>
      <p style="font-size:14px;color:#cbd5e1;line-height:1.6;margin:0 0 18px">Se quiser continuar de onde parou, é só clicar abaixo:</p>
      <div style="text-align:center;margin:0 0 26px">
        <a href="${cta}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px">Continuar minha assinatura →</a>
      </div>
      <div style="background:rgba(0,170,255,.06);border:1px solid rgba(0,170,255,.15);border-radius:12px;padding:18px;margin:0 0 22px">
        <div style="font-size:12px;font-weight:700;color:#00aaff;margin-bottom:10px;letter-spacing:0.5px">O QUE VOCÊ VAI TER COM O ${planName.toUpperCase()}:</div>
        ${benefitsList}
      </div>
      <p style="font-size:13px;color:#7d92b8;line-height:1.6;margin:0 0 6px">Qualquer dúvida, é só responder esse email.</p>
      <p style="font-size:13px;color:#7d92b8;margin:0">Time BlueTube</p>
    </td></tr>
    <tr><td style="padding:14px 24px 20px;font-size:11px;color:#7d92b8;border-top:1px solid #1a2740;line-height:1.6">
      Para parar de receber esses lembretes: <a href="${unsub}" style="color:#7d92b8">descadastrar</a>.
    </td></tr>
  `);
}

function template24h({ name, planName, cta, unsub }) {
  return shellHtml(`
    <tr><td style="padding:8px 24px 20px">
      <div style="font-size:20px;color:#fff;font-weight:700;margin-bottom:14px">${name},</div>
      <p style="font-size:15px;color:#cbd5e1;line-height:1.6;margin:0 0 18px">
        Ontem você quase entrou pra dentro do BlueTube.
      </p>
      <div style="background:rgba(0,170,255,.06);border:1px solid rgba(0,170,255,.15);border-radius:12px;padding:18px;margin:0 0 22px">
        <div style="font-size:13px;color:#cbd5e1;line-height:1.9">
          🎬 <strong style="color:#fff">Milhares de roteiros</strong> foram gerados nas últimas 24h<br/>
          🚀 <strong style="color:#fff">Novos canais</strong> começaram a postar diariamente com IA<br/>
          ⚡ <strong style="color:#fff">Shorts</strong> viralizaram usando nosso buscador
        </div>
      </div>
      <p style="font-size:15px;color:#cbd5e1;line-height:1.6;margin:0 0 14px">
        Você ainda tá tentando criar tudo do zero?
      </p>
      <p style="font-size:14px;color:#cbd5e1;line-height:1.6;margin:0 0 22px">
        Cada dia que passa, mais gente sai na frente. O algoritmo do YouTube/TikTok premia <strong style="color:#fff">quem posta com consistência</strong> — e isso só é possível com IA fazendo o trabalho pesado.
      </p>
      <div style="text-align:center;margin:0 0 22px">
        <a href="${cta}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px">Voltar pro meu checkout →</a>
      </div>
      <p style="font-size:13px;color:#cbd5e1;text-align:center;margin:0 0 18px">
        Sem fidelidade. Cancela em 1 clique. 7 dias de garantia.
      </p>
      <p style="font-size:13px;color:#7d92b8;margin:0 0 6px">Time BlueTube</p>
      <p style="font-size:12px;color:#fbbf24;font-style:italic;margin:14px 0 0">
        P.S.: Esse link expira em 48h. Depois disso, vai precisar começar tudo de novo.
      </p>
    </td></tr>
    <tr><td style="padding:14px 24px 20px;font-size:11px;color:#7d92b8;border-top:1px solid #1a2740;line-height:1.6">
      Para parar de receber esses lembretes: <a href="${unsub}" style="color:#7d92b8">descadastrar</a>.
    </td></tr>
  `);
}

function template72h({ name, planName, cta, unsub }) {
  return shellHtml(`
    <tr><td style="padding:8px 24px 20px">
      <div style="font-size:20px;color:#fff;font-weight:700;margin-bottom:14px">${name},</div>
      <p style="font-size:15px;color:#cbd5e1;line-height:1.6;margin:0 0 14px">
        Esse é o último email sobre seu checkout pendente do <strong style="color:#fff">${planName}</strong>.
      </p>
      <p style="font-size:15px;color:#fbbf24;line-height:1.6;margin:0 0 22px;font-weight:600">
        Em algumas horas, o link vai expirar de vez. Pra voltar depois, você vai precisar começar do zero.
      </p>
      <div style="background:rgba(0,170,255,.06);border:1px solid rgba(0,170,255,.15);border-radius:12px;padding:18px;margin:0 0 22px">
        <div style="font-size:12px;font-weight:700;color:#00aaff;margin-bottom:10px;letter-spacing:0.5px">OLHA O QUE VOCÊ AINDA PODE PEGAR AGORA:</div>
        <div style="font-size:14px;color:#cbd5e1;line-height:1.8">
          ✓ Acesso completo às ferramentas<br/>
          ✓ 7 dias de garantia (cancela e devolvemos)<br/>
          ✓ Sem cartão escondido, sem renovação automática surpresa
        </div>
      </div>
      <div style="text-align:center;margin:0 0 26px">
        <a href="${cta}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px">Garantir meu acesso agora →</a>
      </div>
      <p style="font-size:13px;color:#7d92b8;line-height:1.6;margin:0 0 14px">
        Se não quer mais ouvir falar disso, sem problema:<br/>
        <a href="${unsub}" style="color:#7d92b8;text-decoration:underline">Descadastrar dos lembretes</a>
      </p>
      <p style="font-size:13px;color:#cbd5e1;margin:0 0 6px">Foi um prazer.</p>
      <p style="font-size:13px;color:#7d92b8;margin:0">Time BlueTube</p>
      <p style="font-size:12px;color:#7d92b8;font-style:italic;margin:14px 0 0">
        P.S.: Não vou te encher mais sobre isso. Decisão é sua.
      </p>
    </td></tr>
    <tr><td style="padding:14px 24px 20px;font-size:11px;color:#7d92b8;border-top:1px solid #1a2740;line-height:1.6">
      Você está recebendo esse email porque iniciou um checkout no BlueTube. <a href="${unsub}" style="color:#7d92b8">Descadastrar</a>.
    </td></tr>
  `);
}
