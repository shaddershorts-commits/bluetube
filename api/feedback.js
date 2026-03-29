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
      const err = await r.json();
      console.error('Feedback save error:', err);
      // Don't fail the user — just log
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Feedback error:', err);
    return res.status(200).json({ success: true }); // Fail silently
  }
}
