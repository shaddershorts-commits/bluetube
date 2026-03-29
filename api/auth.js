// api/auth.js
// Handles user authentication via Supabase Auth
// Supports: Google OAuth, Email/Password
// Returns session token used to identify premium users

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, email, password, token } = req.body;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Auth not configured' });
  }

  const authBase = `${SUPABASE_URL}/auth/v1`;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
  };

  try {
    // ── SIGN UP ──────────────────────────────────────────────────────────────
    if (action === 'signup') {
      const r = await fetch(`${authBase}/signup`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, password })
      });
      const data = await r.json();
      if (!r.ok) return res.status(400).json({ error: data.msg || data.error_description || 'Signup failed' });
      return res.status(200).json({ user: data.user, session: data.session });
    }

    // ── SIGN IN ──────────────────────────────────────────────────────────────
    if (action === 'signin') {
      const r = await fetch(`${authBase}/token?grant_type=password`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, password })
      });
      const data = await r.json();
      if (!r.ok) return res.status(400).json({ error: data.error_description || 'Invalid credentials' });
      return res.status(200).json({ user: data.user, session: { access_token: data.access_token } });
    }

    // ── GOOGLE OAUTH URL ─────────────────────────────────────────────────────
    if (action === 'google') {
      const redirectTo = process.env.SITE_URL
        ? `${process.env.SITE_URL}/auth/callback`
        : 'https://bluetube-ten.vercel.app/auth/callback';
      const url = `${authBase}/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`;
      return res.status(200).json({ url });
    }

    // ── VERIFY TOKEN ─────────────────────────────────────────────────────────
    if (action === 'verify' && token) {
      const r = await fetch(`${authBase}/user`, {
        headers: { ...headers, 'Authorization': `Bearer ${token}` }
      });
      const data = await r.json();
      if (!r.ok) return res.status(401).json({ error: 'Invalid token' });
      return res.status(200).json({ user: data });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'Authentication service error' });
  }
}
