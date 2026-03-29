// api/auth.js — BlueTube Auth
// Supabase Auth: signup, signin, OTP verify, Google OAuth
// Uses SUPABASE_ANON_KEY (falls back to SUPABASE_SERVICE_KEY if not set)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, email, password, token, otp } = req.body;
  const SUPABASE_URL = process.env.SUPABASE_URL;

  // Use anon key if available, fallback to service key
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing env vars:', { hasUrl: !!SUPABASE_URL, hasKey: !!SUPABASE_KEY });
    return res.status(500).json({ error: `Configuração incompleta: URL=${!!SUPABASE_URL} KEY=${!!SUPABASE_KEY}` });
  }

  const authBase = `${SUPABASE_URL}/auth/v1`;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  try {

    // ── SIGN UP (email + password, sends confirmation email) ─────────────────
    if (action === 'signup') {
      if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios' });
      if (password.length < 6) return res.status(400).json({ error: 'Senha deve ter mínimo 6 caracteres' });

      const signupUrl = `${authBase}/signup`;
      console.log('Signing up:', email, 'URL:', signupUrl);

      const r = await fetch(signupUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email,
          password,
          options: {
            emailRedirectTo: `${process.env.SITE_URL || 'https://bluetube-ten.vercel.app'}/`
          }
        })
      });
      const data = await r.json();
      console.log('Signup response status:', r.status, 'data:', JSON.stringify(data).slice(0, 200));

      if (!r.ok) {
        const msg = data.msg || data.error_description || data.error || 'Erro ao criar conta';
        if (msg.includes('already registered')) return res.status(400).json({ error: 'Este email já está cadastrado. Faça login.' });
        return res.status(400).json({ error: msg });
      }

      // If email confirmation is enabled in Supabase, session will be null
      if (!data.session) {
        return res.status(200).json({
          needsConfirmation: true,
          message: 'Conta criada! Verifique seu email e clique no link de confirmação.'
        });
      }
      return res.status(200).json({ user: data.user, session: data.session });
    }

    // ── SIGN IN ───────────────────────────────────────────────────────────────
    if (action === 'signin') {
      if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios' });

      const r = await fetch(`${authBase}/token?grant_type=password`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, password })
      });
      const data = await r.json();

      if (!r.ok) {
        const msg = data.error_description || data.msg || data.error || 'Credenciais inválidas';
        if (msg.includes('Invalid login') || msg.includes('invalid')) {
          return res.status(400).json({ error: 'Email ou senha incorretos' });
        }
        if (msg.includes('Email not confirmed')) {
          return res.status(400).json({ error: 'Email não confirmado. Verifique sua caixa de entrada.' });
        }
        return res.status(400).json({ error: msg });
      }

      return res.status(200).json({
        user: data.user,
        session: { access_token: data.access_token }
      });
    }

    // ── SEND OTP (magic link / email code) ────────────────────────────────────
    if (action === 'send_otp') {
      if (!email) return res.status(400).json({ error: 'Email é obrigatório' });

      const r = await fetch(`${authBase}/otp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, create_user: true })
      });

      if (!r.ok) {
        const data = await r.json();
        return res.status(400).json({ error: data.msg || 'Erro ao enviar código' });
      }

      return res.status(200).json({ sent: true, message: 'Código enviado para seu email!' });
    }

    // ── VERIFY OTP ────────────────────────────────────────────────────────────
    if (action === 'verify_otp') {
      if (!email || !otp) return res.status(400).json({ error: 'Email e código são obrigatórios' });

      const r = await fetch(`${authBase}/verify`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, token: otp, type: 'email' })
      });
      const data = await r.json();

      if (!r.ok) {
        return res.status(400).json({ error: 'Código inválido ou expirado. Tente novamente.' });
      }

      return res.status(200).json({
        user: data.user,
        session: { access_token: data.access_token }
      });
    }

    // ── GOOGLE OAUTH ──────────────────────────────────────────────────────────
    if (action === 'google') {
      const redirectTo = `${process.env.SITE_URL || 'https://bluetube-ten.vercel.app'}/`;
      const url = `${authBase}/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`;
      return res.status(200).json({ url });
    }

    // ── VERIFY TOKEN ──────────────────────────────────────────────────────────
    if (action === 'verify' && token) {
      const r = await fetch(`${authBase}/user`, {
        headers: { ...headers, 'Authorization': `Bearer ${token}` }
      });
      const data = await r.json();
      if (!r.ok) return res.status(401).json({ error: 'Token inválido' });
      return res.status(200).json({ user: data });
    }

    return res.status(400).json({ error: 'Ação inválida' });

  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'Erro interno. Tente novamente em instantes.' });
  }
}
