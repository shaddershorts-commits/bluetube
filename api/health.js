// api/health.js — Health check avançado de 10 serviços, em paralelo, com
// classificação de criticidade e alerta por email quando degrada.
// Usado pelo status.html e pelo monitor-health cron.

const CRITICAL_SERVICES = ['supabase', 'stripe']; // se qualquer um cair → status=critical

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const checks = {};
  const start = Date.now();

  async function check(name, fn, timeout = 5000) {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      await fn(ctrl.signal);
      clearTimeout(timer);
      checks[name] = { status: 'ok', latency_ms: Date.now() - t0 };
    } catch (e) {
      clearTimeout(timer);
      checks[name] = {
        status: 'error',
        latency_ms: Date.now() - t0,
        error: e.name === 'AbortError' ? 'timeout' : e.message,
      };
    }
  }

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;

  await Promise.allSettled([
    check('supabase', async (signal) => {
      if (!SU || !SK) throw new Error('não configurado');
      const r = await fetch(`${SU}/rest/v1/subscribers?select=email&limit=1`, {
        headers: { apikey: SK, Authorization: 'Bearer ' + SK },
        signal,
      });
      if (!r.ok) throw new Error(`status ${r.status}`);
    }),

    check('openai', async (signal) => {
      if (!process.env.OPENAI_API_KEY) throw new Error('não configurado');
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
        signal,
      });
      if (!r.ok) throw new Error(`status ${r.status}`);
    }),

    check('gemini', async (signal) => {
      const key = process.env.GEMINI_KEY_1 || process.env.GEMINI_API_KEY;
      if (!key) throw new Error('não configurado');
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, { signal });
      if (!r.ok) throw new Error(`status ${r.status}`);
    }),

    check('anthropic', async (signal) => {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error('não configurado');
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal,
      });
      if (!r.ok) throw new Error(`status ${r.status}`);
    }, 10000),

    check('elevenlabs', async (signal) => {
      if (!process.env.ELEVENLABS_API_KEY) throw new Error('não configurado');
      const r = await fetch('https://api.elevenlabs.io/v1/user', {
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
        signal,
      });
      if (!r.ok) throw new Error(`status ${r.status}`);
    }),

    check('stripe', async (signal) => {
      if (!process.env.STRIPE_SECRET_KEY) throw new Error('não configurado');
      const r = await fetch('https://api.stripe.com/v1/balance', {
        headers: { Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY },
        signal,
      });
      if (!r.ok) throw new Error(`status ${r.status}`);
    }),

    check('youtube_api', async (signal) => {
      const key = process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_API_KEY_1;
      if (!key) throw new Error('não configurado');
      const r = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?id=dQw4w9WgXcQ&part=id&key=${key}`,
        { signal }
      );
      if (!r.ok) throw new Error(`status ${r.status}`);
    }),

    check('resend', async (signal) => {
      if (!process.env.RESEND_API_KEY) throw new Error('não configurado');
      const r = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY },
        signal,
      });
      if (!r.ok) throw new Error(`status ${r.status}`);
    }),

    check('cobalt', async (signal) => {
      if (!process.env.COBALT_API_URL) throw new Error('não configurado');
      const headers = { Accept: 'application/json' };
      if (process.env.COBALT_API_KEY) headers.Authorization = 'Api-Key ' + process.env.COBALT_API_KEY;
      const r = await fetch(process.env.COBALT_API_URL, { headers, signal });
      if (!r.ok) throw new Error(`status ${r.status}`);
    }),

    check('upstash_redis', async (signal) => {
      // Aceita os dois padrões: o antigo (UPSTASH_REDIS_URL) e o atual do
      // pacote @upstash/redis (UPSTASH_REDIS_REST_URL).
      const url = process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_URL;
      const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_TOKEN;
      if (!url || !token) throw new Error('não configurado');
      const r = await fetch(`${url}/ping`, {
        headers: { Authorization: 'Bearer ' + token },
        signal,
      });
      if (!r.ok) throw new Error(`status ${r.status}`);
    }),
  ]);

  const services = Object.values(checks);
  const criticalDown = CRITICAL_SERVICES.filter((s) => checks[s]?.status === 'error');
  const totalDown = services.filter((s) => s.status === 'error').length;

  const status =
    criticalDown.length > 0 ? 'critical' :
    totalDown > 2 ? 'degraded' :
    totalDown > 0 ? 'partial' : 'ok';

  const response = {
    status,
    timestamp: new Date().toISOString(),
    latency_total_ms: Date.now() - start,
    services: checks,
    summary: {
      total: services.length,
      ok: services.filter((s) => s.status === 'ok').length,
      error: totalDown,
      critical_down: criticalDown,
    },
    version: '2.0.0',
  };

  // Envia alerta fire-and-forget quando degrada (só critical/degraded pra não spammar)
  if ((status === 'critical' || status === 'degraded') && process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
    const failed = Object.entries(checks).filter(([, v]) => v.status === 'error')
      .map(([name, v]) => `<li><b>${name}</b>: ${v.error}</li>`).join('');
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'monitor@bluetubeviral.com',
        to: process.env.ADMIN_EMAIL,
        subject: `🚨 BlueTube ${status.toUpperCase()}: ${criticalDown.join(', ') || totalDown + ' serviços com erro'}`,
        html: `
          <h2 style="color:#ff4444">Status: ${status.toUpperCase()}</h2>
          <p>Críticos abaixo: ${criticalDown.length ? '<b>' + criticalDown.join(', ') + '</b>' : 'nenhum'}</p>
          <ul>${failed}</ul>
          <p><a href="https://bluetubeviral.com/status.html">Status page →</a></p>
        `,
      }),
    }).catch(() => {});
  }

  const statusCode = status === 'critical' ? 500 : status === 'degraded' ? 503 : 200;
  return res.status(statusCode).json(response);
};
