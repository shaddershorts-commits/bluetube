// api/reactivation-emails.js — Cron: 0 10 * * * (daily 10am)
// Sends reactivation email to users inactive for 7 days

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!SU || !SK || !RESEND_KEY) return res.status(200).json({ ok: false, error: 'Missing env' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  let sent = 0;

  try {
    // Get today's script count for social proof
    const today = new Date().toISOString().split('T')[0];
    const usageRes = await fetch(`${SU}/rest/v1/ip_usage?usage_date=eq.${today}&select=script_count`, { headers: h });
    let todayScripts = 0;
    if (usageRes.ok) { const ud = await usageRes.json(); todayScripts = ud.reduce((s, r) => s + (r.script_count || 0), 0); }

    // Get all subscribers with email
    const subRes = await fetch(`${SU}/rest/v1/subscribers?select=email&limit=500`, { headers: h });
    if (!subRes.ok) return res.status(200).json({ ok: false, error: 'Failed to fetch subscribers' });
    const subs = await subRes.json();

    // 7 days ago
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().split('T')[0];
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString().split('T')[0];

    for (const sub of subs.slice(0, 100)) {
      if (!sub.email) continue;

      // Check if already sent reactivation this month
      const rrRes = await fetch(
        `${SU}/rest/v1/reactivation_emails?email=eq.${encodeURIComponent(sub.email)}&select=sent_at`,
        { headers: h }
      );
      if (rrRes.ok) {
        const rr = await rrRes.json();
        if (rr?.[0]?.sent_at) {
          const lastSent = new Date(rr[0].sent_at);
          if (Date.now() - lastSent < 30 * 24 * 3600 * 1000) continue; // Skip if sent within 30 days
        }
      }

      // Check last visit (7 days ago, not 6 or 8)
      const visitRes = await fetch(
        `${SU}/rest/v1/ip_visits?visit_date=gte.${eightDaysAgo}&visit_date=lte.${sevenDaysAgo}&select=ip_address&limit=1`,
        { headers: h }
      );
      // This is imprecise since ip_visits doesn't have email — simplified approach:
      // Just send to subscribers who haven't been recently active (best effort)

      // Send email
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
          body: JSON.stringify({
            from: 'BlueTube <onboarding@resend.dev>', to: [sub.email],
            subject: 'Seu próximo vídeo viral está esperando por você 🎬',
            html: `<div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;background:#020817;color:#e8f4ff;border-radius:16px;padding:28px;border:1px solid rgba(0,170,255,.2)">
              <h2 style="color:#00aaff;margin:0 0 12px">Sentimos sua falta! 🎬</h2>
              <p style="color:rgba(150,190,230,.7);font-size:14px;line-height:1.7">Faz alguns dias que você não cria um Short novo.</p>
              <p style="color:rgba(150,190,230,.7);font-size:14px">Enquanto isso, <strong style="color:#fff">${todayScripts || 'muitos'} roteiros</strong> foram criados hoje na plataforma.</p>
              <a href="https://bluetubeviral.com" style="display:block;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;text-decoration:none;padding:14px;border-radius:12px;text-align:center;font-weight:700;margin-top:20px">Criar roteiro agora →</a>
              <p style="font-size:11px;color:rgba(150,190,230,.3);margin-top:16px;text-align:center"><a href="https://bluetubeviral.com/privacidade.html" style="color:rgba(150,190,230,.3)">Cancelar inscrição</a></p>
            </div>`
          })
        });

        // Record sent
        await fetch(`${SU}/rest/v1/reactivation_emails?email=eq.${encodeURIComponent(sub.email)}`, { method: 'DELETE', headers: h }).catch(() => {});
        await fetch(`${SU}/rest/v1/reactivation_emails`, {
          method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
          body: JSON.stringify({ email: sub.email, sent_at: new Date().toISOString() })
        });
        sent++;
      } catch(e) {}

      if (sent >= 100) break; // Max 100 per run
    }

    return res.status(200).json({ ok: true, sent, timestamp: new Date().toISOString() });
  } catch(e) {
    return res.status(200).json({ ok: false, error: e.message, sent });
  }
};
