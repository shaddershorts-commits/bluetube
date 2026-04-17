// api/monitor-health.js — cron a cada 5 min. Chama /api/health, salva
// histórico em system_health_log e verifica mudanças no changelog das APIs
// críticas (OpenAI, ElevenLabs, Anthropic, Stripe).

const SITE = process.env.SITE_URL || 'https://bluetubeviral.com';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Endpoint "ping" usado como heartbeat de testes
  if (req.method === 'GET' && req.query?.action === 'ping') {
    return res.status(200).json({ ok: true, now: new Date().toISOString() });
  }

  // Endpoint "history" pra dashboards (últimos N snapshots)
  if (req.method === 'GET' && req.query?.action === 'history') {
    const limit = Math.min(parseInt(req.query.limit) || 96, 500); // default 96 = últimas 8h se roda 5/5min
    const SU = process.env.SUPABASE_URL;
    const SK = process.env.SUPABASE_SERVICE_KEY;
    if (!SU || !SK) return res.status(500).json({ error: 'supabase não configurado' });
    try {
      const r = await fetch(
        `${SU}/rest/v1/system_health_log?select=status,summary,created_at&order=created_at.desc&limit=${limit}`,
        { headers: { apikey: SK, Authorization: 'Bearer ' + SK } }
      );
      if (!r.ok) throw new Error('supabase ' + r.status);
      const history = await r.json();
      return res.status(200).json({ history });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Default: executa o check, salva histórico, verifica changelogs
  try {
    const healthR = await fetch(`${SITE}/api/health`, { signal: AbortSignal.timeout(30000) });
    const health = await healthR.json();

    // Salva no Supabase (fire-and-forget se falhar)
    const SU = process.env.SUPABASE_URL;
    const SK = process.env.SUPABASE_SERVICE_KEY;
    if (SU && SK) {
      fetch(`${SU}/rest/v1/system_health_log`, {
        method: 'POST',
        headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: health.status,
          services: health.services,
          summary: health.summary,
          created_at: new Date().toISOString(),
        }),
      }).catch(() => {});

      // GC leve: apaga entradas > 30 dias (silencioso)
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      fetch(`${SU}/rest/v1/system_health_log?created_at=lt.${cutoff}`, {
        method: 'DELETE',
        headers: { apikey: SK, Authorization: 'Bearer ' + SK },
      }).catch(() => {});
    }

    // Verifica changelogs das APIs críticas (roda com baixa frequência pra não gastar fetch)
    // 1/hora basta — o cron é 5/5min mas só roda o check de changelog se minuto=0-5.
    const mm = new Date().getUTCMinutes();
    if (mm < 6) await checkAPIChangelogs();

    return res.status(200).json({ ok: true, logged: health.status, services_ok: health.summary?.ok });
  } catch (e) {
    console.error('[monitor-health]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// Hash do topo das páginas de changelog das APIs. Quando mudar, alerta.
// Armazena hash anterior em memória do processo (reset a cada cold start).
const changelogHashes = {};

// Extrai o texto "estável" da página: remove scripts, styles, SVGs, comments,
// atributos dinâmicos (nonces, ids, classes minificadas, csrf), hashes hex
// e timestamps. Isso evita falsos positivos quando a página só muda por
// build hash / CSP nonce / token de sessão. Resultado: só alerta quando o
// texto visível muda de verdade.
function extractStableText(raw) {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<meta[^>]*>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    // Remove atributos que mudam a cada request (nonce, csrf, ids hash, classes minificadas)
    .replace(/\s(nonce|data-[\w-]+|id|class|style|srcset|integrity|crossorigin)="[^"]*"/gi, '')
    // Remove hashes hex longos (build ids, asset hashes)
    .replace(/\b[a-f0-9]{16,}\b/gi, '')
    // Remove timestamps / numeros grandes (session ids, epoch)
    .replace(/\b\d{10,}\b/g, '')
    // Reduz qualquer tag restante a só o nome
    .replace(/<(\/?\w+)[^>]*>/g, '<$1>')
    // Colapsa whitespace
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function checkAPIChangelogs() {
  const endpoints = [
    { name: 'OpenAI', url: 'https://platform.openai.com/docs/changelog' },
    { name: 'Anthropic', url: 'https://docs.anthropic.com/en/release-notes/api' },
    { name: 'ElevenLabs', url: 'https://elevenlabs.io/docs/changelog' },
    { name: 'Stripe', url: 'https://stripe.com/docs/upgrades' },
  ];

  const crypto = require('crypto');
  for (const ep of endpoints) {
    try {
      const r = await fetch(ep.url, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const text = await r.text();
      const cleaned = extractStableText(text);
      // Amostra maior agora (3000) — scripts/styles removidos liberam espaço
      const sample = cleaned.slice(0, 3000);
      const hash = crypto.createHash('md5').update(sample).digest('hex');
      const prev = changelogHashes[ep.name];
      changelogHashes[ep.name] = hash;
      if (prev && prev !== hash && process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
        fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'monitor@bluetubeviral.com',
            to: process.env.ADMIN_EMAIL,
            subject: `⚠️ ${ep.name} atualizou o changelog`,
            html: `<h2>⚠️ ${ep.name} pode ter mudado a API</h2>
                   <p>Checagem automática detectou alteração em:<br>
                   <a href="${ep.url}">${ep.url}</a></p>
                   <p>Revise se algo quebrou antes do próximo deploy.</p>`,
          }),
        }).catch(() => {});
      }
    } catch { /* silencioso */ }
  }
}
