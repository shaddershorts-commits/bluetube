// api/pix-renewal-reminder.js — Lembrete Pix 30d / 15d antes do vencimento
// =====================================================================
// Cron diario 10h UTC via GitHub Actions. Detecta subscribers que pagaram
// via Pix anual (billing_method='pix_annual') cujo plan_expires_at cai em
// ~30 dias OU ~15 dias. Envia email informativo com link de checkout.
//
// Janela:
//   - 30d: plan_expires_at entre NOW+29d e NOW+31d  → flag pix_reminder_30d_sent_at
//   - 15d: plan_expires_at entre NOW+14d e NOW+16d  → flag pix_reminder_15d_sent_at
//
// Idempotente: flags separadas evitam reenvio. Cron pode rodar 2x/dia sem dup.
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY
// Auth: ?admin_secret=ADMIN_SECRET (chamado pelo GitHub Actions)

const { signToken } = require('./_helpers/unsub-token');

function firstName(email) {
  if (!email) return 'criador';
  const local = String(email).split('@')[0];
  const seg = local.split(/[._-]/)[0] || local;
  if (!seg || /^\d+$/.test(seg)) return 'criador';
  return seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
}

function htmlToText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function brl(cents) {
  const v = Number(cents) / 100;
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function buildReminderEmail(email, plan, daysRemaining, expiresAt) {
  const nome = firstName(email);
  const unsubToken = signToken(email);
  const unsubUrl = `https://bluetubeviral.com/api/v1/unsubscribe?token=${unsubToken}`;

  const planLabel = plan === 'master' ? 'Master' : 'Full';
  const priceCents = plan === 'master' ? 80988 : 26988; // R$809,88 / R$269,88
  const priceText = brl(priceCents);

  const expiresDate = new Date(expiresAt).toLocaleDateString('pt-BR', {
    day: '2-digit', month: 'long', year: 'numeric'
  });

  const subject = daysRemaining <= 16
    ? `${nome}, seu BlueTube ${planLabel} vence em ${daysRemaining} dias`
    : `${nome}, renovação do BlueTube ${planLabel} em ${daysRemaining} dias`;

  const preheader = `Vence em ${expiresDate}. Renove via Pix anual e ganhe 1 mês extra.`;

  const body = `<p>${nome}, lembrete informativo.</p>
<p>Seu plano <strong>BlueTube ${planLabel}</strong> vence em <strong>${daysRemaining} dias</strong> (${expiresDate}).</p>
<p>Você assinou via Pix anual, então não há cobrança automática. Pra continuar usando o ${planLabel} sem interrupção, basta renovar antes do vencimento.</p>
<p><strong>Renovação:</strong></p>
<ul>
  <li>Pix anual: <strong>${priceText}</strong> (13 meses pelo preço de 12)</li>
  <li>Ou cartão mensal/anual com renovação automática</li>
</ul>
<p>Se não renovar até ${expiresDate}, sua conta volta automaticamente pro plano Free. Sem cobrança, sem pegadinha.</p>
<p>Pra renovar, clica no botão abaixo.</p>`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#0a0e1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e5e7eb;">
<div style="display:none;font-size:1px;color:#0a0e1a;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0e1a;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:linear-gradient(180deg,#0f172a 0%,#0a0e1a 100%);border:1px solid #1e293b;border-radius:12px;">
<tr><td style="padding:32px 32px 16px;"><div style="font-size:14px;color:#64748b;letter-spacing:1px;text-transform:uppercase;">BlueTube</div></td></tr>
<tr><td style="padding:0 32px 24px;font-size:16px;line-height:1.65;color:#cbd5e1;">${body}</td></tr>
<tr><td style="padding:0 32px 32px;" align="left">
<a href="https://bluetubeviral.com/#plans" style="display:inline-block;background:linear-gradient(135deg,#3b82f6 0%,#1d4ed8 100%);color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:15px;">Renovar ${planLabel} →</a>
</td></tr>
<tr><td style="padding:24px 32px;border-top:1px solid #1e293b;font-size:12px;color:#64748b;line-height:1.6;">
<p style="margin:0 0 8px;">BlueTube · Plataforma de criadores de Shorts</p>
<p style="margin:0;">Não quer mais receber? <a href="${unsubUrl}" style="color:#94a3b8;">Descadastrar em 1 clique</a></p>
</td></tr>
</table></td></tr></table></body></html>`;

  const text = `${preheader}\n\n${htmlToText(body)}\n\nRenovar ${planLabel} →\nhttps://bluetubeviral.com/#plans\n\n---\nBlueTube\nDescadastrar: ${unsubUrl}`;

  return { subject, html, text, unsubUrl };
}

async function fetchWindow(SU, H, lowerISO, upperISO) {
  const url = `${SU}/rest/v1/subscribers?billing_method=eq.pix_annual&plan_expires_at=gte.${lowerISO}&plan_expires_at=lte.${upperISO}&select=email,plan,plan_expires_at,pix_reminder_30d_sent_at,pix_reminder_15d_sent_at&limit=500`;
  const r = await fetch(url, { headers: H });
  return r.ok ? r.json() : [];
}

module.exports = async function handler(req, res) {
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  const querySecret = req.query?.admin_secret;
  const isAdmin = ADMIN_SECRET && querySecret === ADMIN_SECRET;
  const isVercelCron = !!req.headers['x-vercel-cron'];
  if (!isAdmin && !isVercelCron) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const RESEND = process.env.RESEND_API_KEY;
  if (!SU || !SK || !RESEND) return res.status(200).json({ ok: false, error: 'missing env' });

  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const now = new Date();
  const results = { found_30d: 0, sent_30d: 0, found_15d: 0, sent_15d: 0, skipped: 0, errors: 0 };

  try {
    // Janela 30d
    const lower30 = new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000).toISOString();
    const upper30 = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000).toISOString();
    const list30 = await fetchWindow(SU, H, lower30, upper30);
    results.found_30d = list30.length;

    for (const sub of list30) {
      if (sub.pix_reminder_30d_sent_at) { results.skipped++; continue; }
      const days = Math.max(1, Math.ceil((new Date(sub.plan_expires_at).getTime() - now.getTime()) / 86400000));
      const { subject, html, text, unsubUrl } = buildReminderEmail(sub.email, sub.plan, days, sub.plan_expires_at);

      const sr = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND}` },
        body: JSON.stringify({
          from: 'BlueTube <noreply@bluetubeviral.com>',
          reply_to: 'suporte@bluetubeviral.com',
          to: [sub.email], subject, html, text,
          headers: {
            'List-Unsubscribe': `<${unsubUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            'X-Entity-Ref-ID': 'bt-pix-reminder-30d',
          },
        }),
      });
      if (sr.ok) {
        await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(sub.email)}`, {
          method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
          body: JSON.stringify({ pix_reminder_30d_sent_at: now.toISOString() }),
        }).catch(() => {});
        results.sent_30d++;
      } else {
        results.errors++;
      }
      await new Promise(r => setTimeout(r, 150));
    }

    // Janela 15d
    const lower15 = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const upper15 = new Date(now.getTime() + 16 * 24 * 60 * 60 * 1000).toISOString();
    const list15 = await fetchWindow(SU, H, lower15, upper15);
    results.found_15d = list15.length;

    for (const sub of list15) {
      if (sub.pix_reminder_15d_sent_at) { results.skipped++; continue; }
      const days = Math.max(1, Math.ceil((new Date(sub.plan_expires_at).getTime() - now.getTime()) / 86400000));
      const { subject, html, text, unsubUrl } = buildReminderEmail(sub.email, sub.plan, days, sub.plan_expires_at);

      const sr = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND}` },
        body: JSON.stringify({
          from: 'BlueTube <noreply@bluetubeviral.com>',
          reply_to: 'suporte@bluetubeviral.com',
          to: [sub.email], subject, html, text,
          headers: {
            'List-Unsubscribe': `<${unsubUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            'X-Entity-Ref-ID': 'bt-pix-reminder-15d',
          },
        }),
      });
      if (sr.ok) {
        await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(sub.email)}`, {
          method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
          body: JSON.stringify({ pix_reminder_15d_sent_at: now.toISOString() }),
        }).catch(() => {});
        results.sent_15d++;
      } else {
        results.errors++;
      }
      await new Promise(r => setTimeout(r, 150));
    }

    return res.status(200).json({ ok: true, ...results, timestamp: now.toISOString() });
  } catch (e) {
    console.error(`[pix-renewal-reminder] fatal: ${e.message}`);
    return res.status(200).json({ ok: false, error: e.message, ...results });
  }
};
