// api/reactivation-emails.js — Cron: 0 10 * * 3 (weekly, Wednesday 10am)
// Sends reactivation email to inactive subscribers, rotating through 3 FOMO variants
// to avoid inbox-duplicate spam detection.

// ── 3 VARIAÇÕES DE COPY — rotacionadas para evitar duplicata visual ──
const VARIANTS = [
  {
    subject: 'Enquanto você estava fora, {todayScripts} criadores postaram hoje 👀',
    headline: 'A plataforma não parou.',
    body: 'Hoje, <strong style="color:#fff">{todayScripts} roteiros</strong> foram criados no BlueTube — enquanto seu canal ficou parado. Cada dia que passa sem publicar, um criador novo ocupa seu espaço no algoritmo.',
    cta: 'Voltar a criar agora →'
  },
  {
    subject: 'Seu próximo viral está a 2 minutos de existir 🎬',
    headline: 'Falta pouco.',
    body: 'Você já sabe como funciona: cola um link, escolhe o tom, e seu roteiro viral tá pronto. <strong style="color:#fff">2 minutos.</strong> Nem dá pra pôr o café na xícara.',
    cta: 'Criar meu próximo Short →'
  },
  {
    subject: 'O algoritmo não espera. Seu canal tá perdendo posição 📉',
    headline: 'Consistência > Perfeição.',
    body: 'Canais que postam semanalmente crescem 4x mais que os que postam quando "tem inspiração". Quanto tempo faz desde seu último Short? <strong style="color:#fff">O YouTube tá notando.</strong>',
    cta: 'Gerar roteiro pra hoje →'
  }
];

function pickVariant() {
  // Semana do ano → escolhe variante determinística (todos os usuários recebem a mesma na mesma semana,
  // mas variante muda a cada semana, evitando repetição no inbox do mesmo usuário)
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const week = Math.floor((now - start) / (7 * 24 * 3600 * 1000));
  return VARIANTS[week % VARIANTS.length];
}

function renderEmail(variant, todayScripts) {
  const count = todayScripts || 'muitos';
  const subject = variant.subject.replace('{todayScripts}', count);
  const body = variant.body.replace('{todayScripts}', count);
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#020817;color:#e8f4ff;border-radius:16px;padding:32px;border:1px solid rgba(0,170,255,.2)">
    <div style="font-family:'DM Mono',monospace;font-size:11px;color:#00aaff;letter-spacing:.1em;text-transform:uppercase;margin-bottom:8px">BlueTube</div>
    <h2 style="color:#00aaff;margin:0 0 16px;font-size:22px;line-height:1.3">${variant.headline}</h2>
    <p style="color:rgba(200,225,255,.8);font-size:15px;line-height:1.7;margin:0 0 24px">${body}</p>
    <a href="https://bluetubeviral.com" style="display:block;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;text-decoration:none;padding:16px;border-radius:12px;text-align:center;font-weight:700;font-size:15px">${variant.cta}</a>
    <p style="font-size:11px;color:rgba(150,190,230,.35);margin-top:24px;text-align:center;line-height:1.6">
      Você recebe este email porque criou uma conta no BlueTube.<br>
      <a href="https://bluetubeviral.com/privacidade.html" style="color:rgba(150,190,230,.5)">Cancelar inscrição</a>
    </p>
  </div>`;
  return { subject, html };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!SU || !SK || !RESEND_KEY) return res.status(200).json({ ok: false, error: 'Missing env' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  let sent = 0, skipped_recent = 0, skipped_new = 0, skipped_error = 0;

  try {
    // Social proof: roteiros criados hoje
    const today = new Date().toISOString().split('T')[0];
    const usageRes = await fetch(`${SU}/rest/v1/ip_usage?usage_date=eq.${today}&select=script_count`, { headers: h });
    let todayScripts = 0;
    if (usageRes.ok) { const ud = await usageRes.json(); todayScripts = ud.reduce((s, r) => s + (r.script_count || 0), 0); }

    // Busca subscribers com created_at para filtrar conta nova
    const subRes = await fetch(`${SU}/rest/v1/subscribers?select=email,created_at&limit=500`, { headers: h });
    if (!subRes.ok) return res.status(200).json({ ok: false, error: 'Failed to fetch subscribers' });
    const subs = await subRes.json();

    const variant = pickVariant();
    const now = Date.now();
    const DEDUPE_MS = 21 * 24 * 3600 * 1000; // 21 dias
    const NEW_USER_MS = 7 * 24 * 3600 * 1000; // Pula quem criou conta há <7 dias

    for (const sub of subs.slice(0, 100)) {
      if (!sub.email) continue;

      // Pula conta recém-criada (evita enviar reativação pra quem acabou de entrar)
      if (sub.created_at) {
        const age = now - new Date(sub.created_at).getTime();
        if (age < NEW_USER_MS) { skipped_new++; continue; }
      }

      // Dedupe FAIL-SAFE: se a query falhar, NÃO envia (melhor pular que fazer spam)
      const rrRes = await fetch(
        `${SU}/rest/v1/reactivation_emails?email=eq.${encodeURIComponent(sub.email)}&select=sent_at&order=sent_at.desc&limit=1`,
        { headers: h }
      );
      if (!rrRes.ok) {
        // Tabela indisponível ou erro — não envia, registra skip
        skipped_error++;
        continue;
      }
      const rr = await rrRes.json();
      if (rr?.[0]?.sent_at) {
        const lastSent = new Date(rr[0].sent_at).getTime();
        if (now - lastSent < DEDUPE_MS) { skipped_recent++; continue; }
      }

      // Envia a variante da semana
      const { subject, html } = renderEmail(variant, todayScripts);
      try {
        const sendRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
          body: JSON.stringify({
            from: 'BlueTube <noreply@bluetubeviral.com>',
            to: [sub.email],
            subject,
            html
          })
        });
        if (!sendRes.ok) continue;

        // Registra envio SÓ se o Resend aceitou (Upsert por email: limpa anteriores + grava nova)
        await fetch(`${SU}/rest/v1/reactivation_emails?email=eq.${encodeURIComponent(sub.email)}`, {
          method: 'DELETE', headers: h
        }).catch(() => {});
        await fetch(`${SU}/rest/v1/reactivation_emails`, {
          method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
          body: JSON.stringify({ email: sub.email, sent_at: new Date().toISOString() })
        });
        sent++;
      } catch (e) { /* next */ }

      if (sent >= 100) break;
    }

    return res.status(200).json({
      ok: true, sent,
      skipped: { recent: skipped_recent, new_users: skipped_new, db_error: skipped_error },
      variant_used: variant.subject.slice(0, 50),
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message, sent });
  }
};
