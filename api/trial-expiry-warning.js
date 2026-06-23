// api/trial-expiry-warning.js — Aviso aos 20d do trial 30d (2026-06-23)
// =====================================================================
// Cron diario 10h UTC. Detecta subscribers com trial_origin='email_30d'
// cujo plan_expires_at cai em ~10 dias (faltam ~10 = passaram ~20 dos 30).
//
// Janela do cron: plan_expires_at entre NOW+9d e NOW+11d (cobre 2 dias).
// Idempotente: marca trial_warning_sent_at no subscribers pra nao reenviar.

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

function buildWarningEmail(email, daysRemaining) {
  const nome = firstName(email);
  const unsubToken = signToken(email);
  const unsubUrl = `https://bluetubeviral.com/api/v1/unsubscribe?token=${unsubToken}`;
  const subject = `${nome}, faltam ${daysRemaining} dias do seu trial`;
  const preheader = 'Sem cobrança automática. Mas vale conversar antes que volte pra Free.';

  const body = `<p>${nome}, aviso amigável.</p>
<p>Seu trial de 30 dias no Full vai expirar em <strong>${daysRemaining} dias</strong>.</p>
<p>Recapitulando o que acontece:</p>
<ul>
  <li><strong>Se você não fizer nada:</strong> sua conta volta automaticamente pra Free no fim do prazo. Sem cobrança, sem pegadinha.</li>
  <li><strong>Se você quiser continuar Full:</strong> só clicar no link abaixo e assinar — R$29,99/mês pelo cartão.</li>
</ul>
<p>Aproveitando os ${30 - daysRemaining} dias que você já usou — me conta honestamente: o Full tá te ajudando?</p>
<p>Se sim, faz sentido continuar. Se não, sem ressentimento — talvez não seja o momento certo.</p>
<p>Pra quem tá em dúvida: as features que mais geram resultado pra criador iniciante são <strong>BlueScore</strong> (descobrir o que tá travando) e <strong>BlueVoice</strong> (publicar mais rápido). Se você usou bem essas duas, R$29,99 paga sozinho.</p>`;

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
<a href="https://bluetubeviral.com/#plans" style="display:inline-block;background:linear-gradient(135deg,#3b82f6 0%,#1d4ed8 100%);color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:15px;">Continuar Full por R$29,99 →</a>
</td></tr>
<tr><td style="padding:24px 32px;border-top:1px solid #1e293b;font-size:12px;color:#64748b;line-height:1.6;">
<p style="margin:0 0 8px;">BlueTube · Plataforma de criadores de Shorts</p>
<p style="margin:0;">Não quer mais receber? <a href="${unsubUrl}" style="color:#94a3b8;">Descadastrar em 1 clique</a></p>
</td></tr>
</table></td></tr></table></body></html>`;

  const text = `${preheader}\n\n${htmlToText(body)}\n\nContinuar Full por R$29,99 →\nhttps://bluetubeviral.com/#plans\n\n---\nBlueTube\nDescadastrar: ${unsubUrl}`;

  return { subject, html, text, unsubUrl };
}

module.exports = async function handler(req, res) {
  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const RESEND = process.env.RESEND_API_KEY;
  if (!SU || !SK || !RESEND) return res.status(200).json({ ok: false, error: 'missing env' });

  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const now = new Date();
  const lower = new Date(now.getTime() + 9 * 24 * 60 * 60 * 1000).toISOString();
  const upper = new Date(now.getTime() + 11 * 24 * 60 * 60 * 1000).toISOString();
  const results = { found: 0, sent: 0, skipped: 0, errors: 0 };

  try {
    // Busca trials chegando ao fim (10 dias restantes)
    // trial_warning_sent_at is null = ainda nao avisado
    const url = `${SU}/rest/v1/subscribers?trial_origin=eq.email_30d&plan=eq.full&plan_expires_at=gte.${lower}&plan_expires_at=lte.${upper}&select=email,plan_expires_at,trial_warning_sent_at,trial_started_at&limit=200`;
    const r = await fetch(url, { headers: H });
    const list = r.ok ? await r.json() : [];
    results.found = list.length;

    for (const sub of list) {
      if (sub.trial_warning_sent_at) { results.skipped++; continue; }

      const expires = new Date(sub.plan_expires_at);
      const daysRemaining = Math.max(1, Math.ceil((expires.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));

      const { subject, html, text, unsubUrl } = buildWarningEmail(sub.email, daysRemaining);

      try {
        const sr = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND}` },
          body: JSON.stringify({
            from: 'BlueTube <noreply@bluetubeviral.com>',
            reply_to: 'suporte@bluetubeviral.com',
            to: [sub.email],
            subject, html, text,
            headers: {
              'List-Unsubscribe': `<${unsubUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
              'X-Entity-Ref-ID': `bt-trial-warning`,
            },
          }),
        });

        if (sr.ok) {
          await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(sub.email)}`, {
            method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
            body: JSON.stringify({ trial_warning_sent_at: now.toISOString() }),
          }).catch(() => {});
          results.sent++;
        } else {
          const errText = await sr.text();
          console.log(`[trial-expiry-warning] resend ${sr.status}: ${errText.slice(0, 200)}`);
          results.errors++;
        }
      } catch (e) {
        console.log(`[trial-expiry-warning] err: ${e.message}`);
        results.errors++;
      }

      await new Promise(r => setTimeout(r, 150));
    }

    return res.status(200).json({ ok: true, ...results, timestamp: now.toISOString() });
  } catch (e) {
    console.error(`[trial-expiry-warning] fatal: ${e.message}`);
    return res.status(200).json({ ok: false, error: e.message, ...results });
  }
};
