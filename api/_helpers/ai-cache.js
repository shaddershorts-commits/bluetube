// api/_helpers/ai-cache.js
// Cache persistente de respostas de IA. Evita re-chamar Claude/OpenAI/Gemini
// pra prompts identicos. Economia estimada 60-80% dos custos de IA.

const crypto = require('crypto');

const TTL_DEFAULT_DAYS = 30; // TTL padrao: 30 dias

function buildKey({ provider, model, system, prompt }) {
  const raw = `${provider || ''}\n${model || ''}\n${system || ''}\n${prompt || ''}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Le cache. Retorna { response, hit: true } ou null
async function getCached({ SUPA_URL, SUPA_KEY, provider, model, system, prompt }) {
  if (!SUPA_URL || !SUPA_KEY) return null;
  const key = buildKey({ provider, model, system, prompt });
  try {
    const r = await fetch(
      `${SUPA_URL}/rest/v1/ai_cache?cache_key=eq.${key}&expires_at=gte.${new Date().toISOString()}&select=response,acessos&limit=1`,
      { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }, signal: AbortSignal.timeout(3000) }
    );
    if (!r.ok) return null;
    const [row] = await r.json();
    if (!row?.response) return null;
    // Incrementa acesso (fire-and-forget)
    fetch(`${SUPA_URL}/rest/v1/ai_cache?cache_key=eq.${key}`, {
      method: 'PATCH',
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ acessos: (row.acessos || 0) + 1, ultimo_acesso: new Date().toISOString() }),
    }).catch(() => {});
    return { response: row.response, hit: true };
  } catch (e) { return null; }
}

// Salva cache. Fire-and-forget (nao bloqueia retorno da IA).
function setCached({ SUPA_URL, SUPA_KEY, provider, model, system, prompt, response, tipo, ttlDays }) {
  if (!SUPA_URL || !SUPA_KEY || !response) return;
  const key = buildKey({ provider, model, system, prompt });
  const ttl = ttlDays || TTL_DEFAULT_DAYS;
  const expires = new Date(Date.now() + ttl * 86400 * 1000).toISOString();
  fetch(`${SUPA_URL}/rest/v1/ai_cache`, {
    method: 'POST',
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      cache_key: key,
      provider, model,
      prompt_sample: (prompt || '').slice(0, 200),
      system_sample: (system || '').slice(0, 100),
      response,
      resposta_tokens: Math.ceil(response.length / 4), // estimativa
      tipo: tipo || null,
      expires_at: expires,
      acessos: 0,
    }),
  }).catch(() => {});
}

module.exports = { getCached, setCached, buildKey, TTL_DEFAULT_DAYS };
