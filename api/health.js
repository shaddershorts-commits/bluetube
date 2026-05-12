// api/health.js — Health check avançado de 10 serviços, em paralelo, com
// classificação de criticidade e alerta por email quando degrada.
// Usado pelo status.html e pelo monitor-health cron.

const CRITICAL_SERVICES = ['supabase', 'stripe']; // se qualquer um cair → status=critical
// Serviços com fallback gracioso — flagam no painel mas NÃO contam pro alerta
// de "degraded" (não vale acordar ninguém por blip de Redis que tem fallback).
const NON_ALERTING_SERVICES = ['upstash_redis'];

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
      // Sistema usa rotação de ~40 chaves. Não basta testar 1 — uma chave
      // exausta (403) é normal sob carga, a rotação cobre. Testa até 5 chaves
      // e passa se QUALQUER uma responder ok. Só falha se TODAS as 5 derem erro
      // (aí sim é crise real de quota).
      const keys = [];
      if (process.env.YOUTUBE_API_KEY) keys.push(process.env.YOUTUBE_API_KEY);
      for (let i = 1; i <= 39; i++) {
        if (process.env[`YOUTUBE_API_KEY_${i}`]) keys.push(process.env[`YOUTUBE_API_KEY_${i}`]);
      }
      if (!keys.length) throw new Error('não configurado');
      const toTest = keys.slice(0, 5);
      let lastStatus = null;
      for (const key of toTest) {
        if (signal.aborted) break;
        try {
          const r = await fetch(
            `https://www.googleapis.com/youtube/v3/videos?id=dQw4w9WgXcQ&part=id&key=${key}`,
            { signal }
          );
          if (r.ok) return; // achou uma chave funcionando — ok
          lastStatus = r.status;
        } catch (e) { lastStatus = e.message; }
      }
      throw new Error(`${toTest.length} chaves testadas, todas falharam (última: ${lastStatus})`);
    }, 8000),

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
  // Pra decidir "degraded" só conta serviços que NÃO têm fallback gracioso
  const alertingDown = Object.entries(checks)
    .filter(([name, v]) => v.status === 'error' && !NON_ALERTING_SERVICES.includes(name)).length;

  const status =
    criticalDown.length > 0 ? 'critical' :
    alertingDown > 2 ? 'degraded' :
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

  // ── ALERTA COM DEBOUNCE ────────────────────────────────────────────────────
  // Regras:
  //   'critical' (supabase/stripe down) → 1 email no início, depois silêncio até recuperar.
  //   'degraded' (3+ não-críticos)      → só alerta após 2 checagens seguidas ruins,
  //                                       e mesmo assim 1 email por episódio (não spam).
  //   'ok'/'partial'                    → limpa estado (próxima degradação volta a contar do zero).
  // Estado em api_cache: { status, alerted } com TTL 30min.
  if (SU && SK && process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
    const cH = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

    if (status === 'critical' || status === 'degraded') {
      let prev = null;
      try {
        // Read com timeout 3s — se Supabase tá lento (justo quando isso importa),
        // não bloqueia: cai pro caminho prev=null (alerta direto, melhor errar pra mais).
        const rctrl = new AbortController();
        const rt = setTimeout(() => rctrl.abort(), 3000);
        const pr = await fetch(`${SU}/rest/v1/api_cache?cache_key=eq.health_last_status&expires_at=gt.${new Date().toISOString()}&select=value`, { headers: cH, signal: rctrl.signal });
        clearTimeout(rt);
        if (pr.ok) { const pd = await pr.json(); prev = pd?.[0]?.value || null; }
      } catch (e) {}
      const prevBad = prev && (prev.status === 'critical' || prev.status === 'degraded');
      const prevAlerted = prev && prev.alerted === true;
      const escalouPraCritical = status === 'critical' && prev && prev.status !== 'critical';

      // critical: alerta na 1ª vez E quando escala de degraded→critical (mesmo se degraded já alertou).
      // degraded: alerta só na 2ª seguida. Nunca re-alerta no mesmo nível de episódio.
      const deveAlertar = escalouPraCritical || (!prevAlerted && (status === 'critical' || (status === 'degraded' && prevBad)));

      if (deveAlertar) {
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
              ${status === 'degraded' ? '<p style="font-size:13px;color:#888">Degradação sustentada (2+ checagens) — não é blip transitório.</p>' : ''}
              <ul>${failed}</ul>
              <p><a href="https://bluetubeviral.com/status">Status page →</a></p>
            `,
          }),
        }).catch(() => {});
      }
      // Salva estado: alerted fica true uma vez que alertamos (não re-alerta no episódio)
      fetch(`${SU}/rest/v1/api_cache`, {
        method: 'POST', headers: { ...cH, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ cache_key: 'health_last_status', value: { status, alerted: prevAlerted || deveAlertar, at: new Date().toISOString() }, expires_at: new Date(Date.now() + 30 * 60000).toISOString() }),
      }).catch(() => {});
    } else {
      // ok ou partial → recuperou, limpa estado
      fetch(`${SU}/rest/v1/api_cache?cache_key=eq.health_last_status`, {
        method: 'DELETE', headers: cH,
      }).catch(() => {});
    }
  }

  const statusCode = status === 'critical' ? 500 : status === 'degraded' ? 503 : 200;
  return res.status(statusCode).json(response);
};
