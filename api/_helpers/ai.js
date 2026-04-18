// api/_helpers/ai.js — Multi-provider AI com fallback automático.
// Ordem: OpenAI → Gemini (10 chaves rotativas) → Claude Haiku.
// Circuit breaker por provider: 3 falhas consecutivas → bloqueia 5min.

const TIMEOUT_MS = 30000;

function withTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}

// ── Gemini: rotaciona entre GEMINI_API_KEY, GEMINI_KEY_1..GEMINI_KEY_9, etc.
function listGeminiKeys() {
  return Object.entries(process.env)
    .filter(([k, v]) => /^GEMINI_(API_)?KEY(_\d+)?$/i.test(k) && v)
    .map(([, v]) => v);
}
let geminiIdx = 0;
function nextGeminiKey() {
  const keys = listGeminiKeys();
  if (!keys.length) return null;
  const k = keys[geminiIdx % keys.length];
  geminiIdx++;
  return k;
}

const PROVIDERS = [
  {
    name: 'openai',
    available: () => !!process.env.OPENAI_API_KEY,
    call: async (prompt, systemPrompt, maxTokens, opts) => {
      const t = withTimeout(TIMEOUT_MS);
      try {
        const body = {
          model: opts?.openaiModel || 'gpt-4o-mini',
          max_tokens: maxTokens,
          messages: [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            { role: 'user', content: prompt },
          ],
        };
        if (opts?.temperature != null) body.temperature = opts.temperature;
        if (opts?.topP != null) body.top_p = opts.topP;
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
          body: JSON.stringify(body),
          signal: t.signal,
        });
        if (!r.ok) {
          const err = await r.text().catch(() => '');
          throw new Error(`OpenAI ${r.status} ${err.slice(0, 200)}`);
        }
        const d = await r.json();
        return d.choices?.[0]?.message?.content || '';
      } finally { t.clear(); }
    },
  },
  {
    name: 'gemini',
    available: () => listGeminiKeys().length > 0,
    call: async (prompt, systemPrompt, maxTokens, opts) => {
      const key = nextGeminiKey();
      if (!key) throw new Error('Gemini sem chaves disponíveis');
      const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
      const model = opts?.geminiModel || 'gemini-2.0-flash';
      const genConfig = { maxOutputTokens: maxTokens };
      if (opts?.temperature != null) genConfig.temperature = opts.temperature;
      if (opts?.topP != null) genConfig.topP = opts.topP;
      const t = withTimeout(TIMEOUT_MS);
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: fullPrompt }] }],
              generationConfig: genConfig,
            }),
            signal: t.signal,
          }
        );
        if (!r.ok) {
          const err = await r.text().catch(() => '');
          throw new Error(`Gemini ${r.status} ${err.slice(0, 200)}`);
        }
        const d = await r.json();
        return d.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
      } finally { t.clear(); }
    },
  },
  {
    name: 'claude',
    available: () => !!process.env.ANTHROPIC_API_KEY,
    call: async (prompt, systemPrompt, maxTokens, opts) => {
      const t = withTimeout(TIMEOUT_MS);
      try {
        const body = {
          model: opts?.claudeModel || 'claude-haiku-4-5',
          max_tokens: maxTokens,
          system: systemPrompt || undefined,
          messages: [{ role: 'user', content: prompt }],
        };
        if (opts?.temperature != null) body.temperature = opts.temperature;
        if (opts?.topP != null) body.top_p = opts.topP;
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
          signal: t.signal,
        });
        if (!r.ok) {
          const err = await r.text().catch(() => '');
          throw new Error(`Claude ${r.status} ${err.slice(0, 200)}`);
        }
        const d = await r.json();
        return d.content?.[0]?.text || '';
      } finally { t.clear(); }
    },
  },
];

// Estado por provider
const state = Object.fromEntries(
  PROVIDERS.map((p) => [p.name, { failures: 0, blockedUntil: 0 }])
);

function isBlocked(name) {
  return state[name].blockedUntil > Date.now();
}

function recordFailure(name) {
  const s = state[name];
  s.failures++;
  if (s.failures >= 3) {
    s.blockedUntil = Date.now() + 5 * 60 * 1000;
    console.error(`[ai] provider ${name} BLOQUEADO por 5 min após 3 falhas`);
  }
}

function recordSuccess(name) {
  state[name].failures = 0;
  state[name].blockedUntil = 0;
}

/**
 * @param {string} prompt
 * @param {string} [systemPrompt]
 * @param {number} [maxTokens=1000]
 * @param {string} [preferred] — 'openai' | 'gemini' | 'claude'
 * @param {object} [options] — { temperature, topP, openaiModel, geminiModel, claudeModel }
 * @returns {Promise<{ result: string, provider: string }>}
 */
async function callAI(prompt, systemPrompt = '', maxTokens = 1000, preferred = null, options = {}) {
  const ordered = preferred
    ? [PROVIDERS.find((p) => p.name === preferred), ...PROVIDERS.filter((p) => p.name !== preferred)].filter(Boolean)
    : PROVIDERS;

  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
  const useCache = !options?.noCache && SUPA_URL && SUPA_KEY;

  // Cache check — se o mesmo prompt foi feito antes, retorna resposta cacheada
  // Opt-out: passar { noCache: true } em options. Opt-in pro tipo/ttl: { cacheTipo, cacheTtlDays }.
  if (useCache && ordered.length > 0) {
    try {
      const { getCached } = require('./ai-cache.js');
      const primary = ordered[0];
      const modelForKey =
        primary.name === 'claude' ? (options?.claudeModel || 'claude-haiku-4-5')
        : primary.name === 'openai' ? (options?.openaiModel || 'gpt-4o-mini')
        : primary.name === 'gemini' ? (options?.geminiModel || 'gemini-2.5-flash')
        : primary.name;
      const cached = await getCached({
        SUPA_URL, SUPA_KEY,
        provider: primary.name, model: modelForKey,
        system: systemPrompt, prompt,
      });
      if (cached?.response) {
        console.log(`[ai cache] HIT ${primary.name} (${cached.response.length} chars)`);
        return { result: cached.response, provider: primary.name, cached: true };
      }
    } catch (e) { /* cache falhou — segue pra chamar IA normalmente */ }
  }

  const errors = [];
  for (const p of ordered) {
    if (!p.available()) { errors.push({ provider: p.name, error: 'unavailable' }); continue; }
    if (isBlocked(p.name)) { errors.push({ provider: p.name, error: 'blocked' }); continue; }
    try {
      const result = await p.call(prompt, systemPrompt, maxTokens, options);
      if (!result) throw new Error('resposta vazia');
      recordSuccess(p.name);
      console.log(`[ai] ${p.name} ok (${result.length} chars)`);

      // Salva no cache (fire-and-forget)
      if (useCache) {
        try {
          const { setCached } = require('./ai-cache.js');
          const modelForKey =
            p.name === 'claude' ? (options?.claudeModel || 'claude-haiku-4-5')
            : p.name === 'openai' ? (options?.openaiModel || 'gpt-4o-mini')
            : p.name === 'gemini' ? (options?.geminiModel || 'gemini-2.5-flash')
            : p.name;
          setCached({
            SUPA_URL, SUPA_KEY,
            provider: p.name, model: modelForKey,
            system: systemPrompt, prompt, response: result,
            tipo: options?.cacheTipo || null,
            ttlDays: options?.cacheTtlDays,
          });
        } catch (e) { /* cache write falhou — ok */ }
      }

      return { result, provider: p.name, cached: false };
    } catch (e) {
      console.error(`[ai] ${p.name} falhou: ${e.message}`);
      recordFailure(p.name);
      errors.push({ provider: p.name, error: e.message });
    }
  }

  const err = new Error('Todos os providers de IA falharam');
  err.attempts = errors;
  throw err;
}

function getState() {
  return Object.fromEntries(Object.entries(state).map(([k, v]) => [k, { ...v, blocked: isBlocked(k) }]));
}

module.exports = { callAI, getState };
