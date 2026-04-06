// api/health.js — Public uptime health check
// Register at uptimerobot.com → bluetubeviral.com/api/health (5min interval)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  const services = {
    supabase: false,
    openai: !!process.env.OPENAI_API_KEY,
    gemini: !!process.env.GEMINI_KEY_1,
    elevenlabs: !!process.env.ELEVENLABS_API_KEY,
    stripe: !!process.env.STRIPE_SECRET_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY
  };

  // Ping Supabase with a lightweight query
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?select=email&limit=1`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
        signal: AbortSignal.timeout(5000)
      });
      services.supabase = r.ok;
    } catch (e) {
      services.supabase = false;
    }
  }

  const allUp = Object.values(services).every(Boolean);

  return res.status(allUp ? 200 : 503).json({
    status: allUp ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    services,
    version: '1.0.0'
  });
};
