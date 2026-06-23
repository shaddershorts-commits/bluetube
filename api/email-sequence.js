// api/email-sequence.js — Engine de email-marketing 24m (2026-06-23)
// =====================================================================
// Substitui o cron antigo /api/email-marketing (mantido vivo pra fallback).
//
// Cron:
//   - ?audience=free → Quintas 10h UTC (subscribers free + cancelados)
//   - ?audience=full → Sextas 10h UTC (subscribers full ativos)
//
// Cadencia:
//   - free → 1x por semana
//   - full → 1x a cada 10 dias (3x por mes)
//
// Templates: api/_helpers/email-templates-library.js (24 free + 16 full)
// Trial: ~12.5% dos free recebem oferta trial 30d (1x por user max)
//
// Anti-spam:
//   - Reply-To: suporte@bluetubeviral.com (Gmail premia)
//   - Plain text version derivada do HTML
//   - List-Unsubscribe header (1-click RFC 8058)
//   - Filtro plano: full/master ativos NUNCA recebem sequencia free
//   - Filtro recovery: users em checkout_recovery pendente NAO recebem

const { signToken } = require('./_helpers/unsub-token');
const { signTrialToken } = require('./_helpers/trial-token');
const { FREE_TEMPLATES, FULL_TEMPLATES } = require('./_helpers/email-templates-library');

const FREE_INTERVAL_MS = 6 * 24 * 60 * 60 * 1000;  // 6 dias (~1x/semana)
const FULL_INTERVAL_MS = 9 * 24 * 60 * 60 * 1000;  // 9 dias (~1x/10d)
const TRIAL_PROBABILITY = 0.125; // ~12.5% chance por envio (~1x a cada 8 emails)

// ── HELPERS ────────────────────────────────────────────────────────────────────

function firstName(email) {
  if (!email) return 'criador';
  const local = String(email).split('@')[0];
  // primeiro segmento alfa antes de . _ -
  const seg = local.split(/[._-]/)[0] || local;
  if (!seg || /^\d+$/.test(seg)) return 'criador';
  return seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
}

function daysBetween(start, end) {
  if (!start) return 0;
  const ms = (end || Date.now()) - new Date(start).getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

function htmlToText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fillVariables(text, vars) {
  return String(text)
    .replace(/\{\{nome\}\}/g, vars.nome || 'criador')
    .replace(/\{\{dias_no_bluetube\}\}/g, String(vars.dias_no_bluetube || 0))
    .replace(/\{\{trial_token\}\}/g, vars.trial_token || '')
    .replace(/\{\{unsubscribe_url\}\}/g, vars.unsubscribe_url || '');
}

function buildEmail(template, user, vars) {
  const subject = fillVariables(template.subject, vars);
  const preheader = fillVariables(template.preheader || '', vars);
  const body = fillVariables(template.body, vars);
  const ctaText = fillVariables(template.cta_text, vars);
  const ctaUrl = fillVariables(template.cta_url, vars);
  const unsubUrl = vars.unsubscribe_url;

  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#0a0e1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e5e7eb;">
<div style="display:none;font-size:1px;color:#0a0e1a;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0e1a;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:linear-gradient(180deg,#0f172a 0%,#0a0e1a 100%);border:1px solid #1e293b;border-radius:12px;">
<tr><td style="padding:32px 32px 16px;">
<div style="font-size:14px;color:#64748b;letter-spacing:1px;text-transform:uppercase;">BlueTube</div>
</td></tr>
<tr><td style="padding:0 32px 24px;font-size:16px;line-height:1.65;color:#cbd5e1;">
${body}
</td></tr>
<tr><td style="padding:0 32px 32px;" align="left">
<a href="${ctaUrl}" style="display:inline-block;background:linear-gradient(135deg,#3b82f6 0%,#1d4ed8 100%);color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:15px;">${ctaText}</a>
</td></tr>
<tr><td style="padding:24px 32px;border-top:1px solid #1e293b;font-size:12px;color:#64748b;line-height:1.6;">
<p style="margin:0 0 8px;">BlueTube · Plataforma de criadores de Shorts</p>
<p style="margin:0;">Não quer mais receber? <a href="${unsubUrl}" style="color:#94a3b8;">Descadastrar em 1 clique</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const text = `${preheader}\n\n${htmlToText(body)}\n\n${ctaText}\n${ctaUrl}\n\n---\nBlueTube\nDescadastrar: ${unsubUrl}`;

  return { subject, html, text };
}

// ── MAIN HANDLER ───────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const RESEND = process.env.RESEND_API_KEY;
  if (!SU || !SK || !RESEND) return res.status(200).json({ ok: false, error: 'Missing env' });

  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const now = new Date();
  const audience = (req.query?.audience || 'free').toLowerCase();
  if (!['free', 'full'].includes(audience)) {
    return res.status(400).json({ ok: false, error: 'audience must be free|full' });
  }

  const TEMPLATES = audience === 'free' ? FREE_TEMPLATES : FULL_TEMPLATES;
  const INTERVAL_MS = audience === 'free' ? FREE_INTERVAL_MS : FULL_INTERVAL_MS;
  const POSITION_FIELD = audience === 'free' ? 'sequence_position' : 'full_position';

  const results = { audience, synced: 0, sent: 0, skipped: 0, errors: 0, trial_offered: 0 };

  try {
    // ── SYNC: garante que todos os subscribers do plano X estao em email_marketing
    const subRes = await fetch(`${SU}/rest/v1/subscribers?select=email,created_at,plan,plan_expires_at,cancel_at_period_end,trial_origin&limit=2000`, { headers: H });
    const subs = subRes.ok ? await subRes.json() : [];

    const subMap = new Map(subs.map(s => [String(s.email).toLowerCase(), s]));

    const emRes = await fetch(`${SU}/rest/v1/email_marketing?select=email&limit=2000`, { headers: H });
    const existing = new Set((emRes.ok ? await emRes.json() : []).map(e => String(e.email).toLowerCase()));

    for (const s of subs) {
      if (s.email && !existing.has(String(s.email).toLowerCase())) {
        await fetch(`${SU}/rest/v1/email_marketing`, {
          method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
          body: JSON.stringify({
            email: s.email,
            sequence_position: 0,
            full_position: 0,
            total_sent: 0,
            unsubscribed: false,
            audience: 'free',
            created_at: s.created_at || now.toISOString(),
          })
        }).catch(() => {});
        results.synced++;
      }
    }

    // ── ELIGIBLE ────────────────────────────────────────────────────────────
    const cutoffISO = new Date(now.getTime() - INTERVAL_MS).toISOString();
    const testEmailsParam = req.query?.test_emails;
    let eligible = [];

    if (testEmailsParam) {
      const list = String(testEmailsParam).split(',').map(e => e.trim()).filter(Boolean);
      const inList = list.map(encodeURIComponent).join(',');
      const emR = await fetch(`${SU}/rest/v1/email_marketing?email=in.(${inList})&unsubscribed=eq.false&select=*`, { headers: H });
      eligible = emR.ok ? await emR.json() : [];
      console.log(`[email-sequence:${audience}] MODO TESTE alvos:${list.length} encontrados:${eligible.length}`);
    } else {
      const eligR = await fetch(
        `${SU}/rest/v1/email_marketing?unsubscribed=eq.false&or=(last_sent_at.is.null,last_sent_at.lt.${cutoffISO})&select=*&limit=500&order=last_sent_at.asc.nullsfirst`,
        { headers: H }
      );
      eligible = eligR.ok ? await eligR.json() : [];
    }

    // ── FILTRO POR AUDIENCIA + PLANO ──────────────────────────────────────
    eligible = eligible.filter(u => {
      const sub = subMap.get(String(u.email).toLowerCase());
      if (audience === 'free') {
        // Free recebe: sem registro (anonimo), plan=free, ou plan pago vencido
        if (!sub) return true;
        if (sub.cancel_at_period_end === true) return false;
        if (!sub.plan || sub.plan === 'free') return true;
        if (sub.plan_expires_at && new Date(sub.plan_expires_at) < now) return true;
        return false;
      } else {
        // Full recebe: apenas plan=full ATIVO (nao trial 30d, pra nao acelerar funil)
        if (!sub) return false;
        if (sub.plan !== 'full') return false;
        if (sub.cancel_at_period_end === true) return false;
        if (sub.plan_expires_at && new Date(sub.plan_expires_at) < now) return false;
        // Trial 30d via email: NAO recebe upsell master (let trial play out)
        if (sub.trial_origin === 'email_30d') return false;
        return true;
      }
    });

    // ── FILTRO RECOVERY ───────────────────────────────────────────────────
    if (eligible.length > 0) {
      const emails = eligible.map(e => e.email).filter(Boolean);
      const inList = emails.map(encodeURIComponent).join(',');
      const recR = await fetch(
        `${SU}/rest/v1/checkout_recovery?email=in.(${inList})&status=eq.pending&select=email`,
        { headers: H }
      );
      const pendingSet = new Set(recR.ok ? (await recR.json()).map(r => String(r.email).toLowerCase()) : []);
      if (pendingSet.size > 0) {
        eligible = eligible.filter(u => !pendingSet.has(String(u.email).toLowerCase()));
      }
    }

    // Cap por execucao pra nao queimar quota Resend
    const MAX_PER_RUN = audience === 'free' ? 300 : 100;
    if (eligible.length > MAX_PER_RUN) eligible = eligible.slice(0, MAX_PER_RUN);
    results.eligible_count = eligible.length;

    // ── SEND ──────────────────────────────────────────────────────────────
    for (const user of eligible) {
      const sub = subMap.get(String(user.email).toLowerCase());
      const pos = (audience === 'free' ? (user.sequence_position || 0) : (user.full_position || 0));

      // Selecao do template
      let template = TEMPLATES[pos % TEMPLATES.length];

      // Free: pode substituir template normal por trial offer (~12.5% chance se nao foi oferecido)
      // Garante 1 trial por user (trial_offered_at != null trava)
      let usingTrial = false;
      if (audience === 'free' && !user.trial_offered_at && !template.is_trial) {
        // Determinismo por email pra reproduzir comportamento em smoke
        const seed = require('crypto').createHash('md5').update(user.email + ':' + now.toISOString().slice(0, 10)).digest('hex');
        const rand = parseInt(seed.slice(0, 8), 16) / 0xffffffff;
        if (rand < TRIAL_PROBABILITY) {
          const trialTemplate = TEMPLATES.find(t => t.is_trial);
          if (trialTemplate) {
            template = trialTemplate;
            usingTrial = true;
          }
        }
      }

      // Vars de substituicao
      const unsubToken = signToken(user.email);
      const unsubUrl = `https://bluetubeviral.com/api/v1/unsubscribe?token=${unsubToken}`;
      let trialToken = '';
      if (template.is_trial) {
        try { trialToken = signTrialToken(user.email); } catch (e) {}
      }

      const vars = {
        nome: firstName(user.email),
        dias_no_bluetube: daysBetween(sub?.created_at || user.created_at, now.getTime()),
        unsubscribe_url: unsubUrl,
        trial_token: trialToken,
      };

      const { subject, html, text } = buildEmail(template, user, vars);

      try {
        const sr = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND}` },
          body: JSON.stringify({
            from: 'BlueTube <noreply@bluetubeviral.com>',
            reply_to: 'suporte@bluetubeviral.com',
            to: [user.email],
            subject,
            html,
            text,
            headers: {
              'List-Unsubscribe': `<${unsubUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
              'X-Entity-Ref-ID': `bt-seq-${audience}-${template.id}`,
            },
          })
        });

        if (sr.ok) {
          const patch = {
            last_sent_at: now.toISOString(),
            total_sent: (user.total_sent || 0) + 1,
            audience,
          };
          if (audience === 'free' && !usingTrial) {
            patch.sequence_position = (pos + 1) % TEMPLATES.length;
          } else if (audience === 'full') {
            patch.full_position = (pos + 1) % TEMPLATES.length;
          }
          // Trial nao avanca position (avanca proxima execucao normal)
          if (usingTrial || template.is_trial) {
            patch.trial_offered_at = now.toISOString();
            results.trial_offered++;
          }

          await fetch(`${SU}/rest/v1/email_marketing?email=eq.${encodeURIComponent(user.email)}`, {
            method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
            body: JSON.stringify(patch)
          });
          results.sent++;
        } else {
          const errText = await sr.text();
          console.log(`[email-sequence:${audience}] resend fail ${sr.status}: ${errText.slice(0, 200)}`);
          results.errors++;
        }
      } catch (e) {
        console.log(`[email-sequence:${audience}] send err: ${e.message}`);
        results.errors++;
      }

      // Rate limit Resend 10/s — 150ms entre envios da margem
      await new Promise(r => setTimeout(r, 150));
    }

    return res.status(200).json({ ok: true, ...results, timestamp: now.toISOString() });
  } catch (e) {
    console.error(`[email-sequence:${audience}] fatal: ${e.message}`);
    return res.status(200).json({ ok: false, error: e.message, ...results });
  }
};
