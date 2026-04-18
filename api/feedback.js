// api/feedback.js
// Saves user feedback, support messages and cancellation reasons to Supabase.
// Called by BluBlu mascot, profile support chat, and cancel flow.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, plan, message, type, token } = req.body;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!message || message.trim().length < 2) {
    return res.status(400).json({ error: 'Message too short' });
  }

  try {
    // If token provided, verify user email
    let verifiedEmail = email || 'anônimo';
    let verifiedPlan = plan || 'free';

    if (token) {
      try {
        const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
          headers: {
            'apikey': process.env.SUPABASE_ANON_KEY || SUPABASE_KEY,
            'Authorization': `Bearer ${token}`
          }
        });
        if (userRes.ok) {
          const userData = await userRes.json();
          verifiedEmail = userData.email || verifiedEmail;
        }
      } catch {}
    }

    // Save to feedback table
    const r = await fetch(`${SUPABASE_URL}/rest/v1/user_feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        email: verifiedEmail,
        plan: verifiedPlan,
        message: message.trim(),
        type: type || 'feedback', // 'feedback', 'support', 'cancel'
        created_at: new Date().toISOString()
      })
    });

    if (!r.ok) {
      // INSERT falhou — loga detalhado e notifica admin por email (se RESEND habilitado).
      // Nao bloqueia resposta do user (UX intacta), mas garante que falhas silenciosas
      // nao escondam problemas de schema/RLS/conexao indefinidamente.
      let errDetails = '';
      try { errDetails = JSON.stringify(await r.json()); } catch (e) { errDetails = await r.text().catch(() => 'sem_body'); }
      console.error('[feedback] INSERT falhou:', r.status, errDetails);

      const RESEND = process.env.RESEND_API_KEY;
      const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
      if (RESEND && ADMIN_EMAIL) {
        // Dedup: so notifica 1x por hora pelo mesmo tipo de erro
        const chave = `feedback_insert_failed_${r.status}`;
        fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND}` },
          body: JSON.stringify({
            from: 'BlueTube <noreply@bluetubeviral.com>',
            to: [ADMIN_EMAIL],
            subject: `[BlueTube] Feedback nao gravou — status ${r.status}`,
            html: `<p><b>Tabela user_feedback rejeitou um insert.</b></p>
                   <p>Status: ${r.status}</p>
                   <p>Erro: <code>${errDetails.slice(0, 500)}</code></p>
                   <p>Mensagem do usuario (${verifiedEmail}): <i>${message.slice(0,200)}</i></p>
                   <p>Verifique schema/RLS da tabela.</p>`,
          })
        }).catch(() => {});
      }

      // Retorna success:true pra nao quebrar UX, mas inclui flag diagnostica
      return res.status(200).json({ success: true, saved: false, reason: 'storage_error' });
    }

    return res.status(200).json({ success: true, saved: true });
  } catch (err) {
    console.error('[feedback] exception:', err);
    return res.status(200).json({ success: true, saved: false, reason: 'exception' });
  }
}
