// api/_helpers/cache.js — Cache layer with Upstash Redis (graceful fallback)
// CommonJS

let redis = null;

// Aceita os DOIS padrões de nome — o antigo (UPSTASH_REDIS_URL) e o atual do
// pacote @upstash/redis (UPSTASH_REDIS_REST_URL), igual o health.js já fazia.
//
// 2026-07-30: a Vercel tinha só as REST_*, e este arquivo procurava só as sem
// REST. Resultado: getRedis() devolvia null, o cache ficava 100% desligado em
// silêncio, o banco Upstash recebia ZERO comandos — e foi apagado pela
// automação deles, que deleta banco gratuito com 14 dias de inatividade.
// O cache não parou porque o banco morreu; o banco morreu porque o cache
// nunca conectou. Aceitar os dois nomes evita a próxima versão disso.
function getRedis() {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_TOKEN;
  if (!url || !token) return null;
  try {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({ url, token });
    return redis;
  } catch(e) { return null; }
}

async function cacheGet(key) {
  const r = getRedis();
  if (!r) return null;
  try {
    const val = await r.get(key);
    if (val === null || val === undefined) return null;
    return typeof val === 'string' ? JSON.parse(val) : val;
  } catch(e) { return null; }
}

async function cacheSet(key, value, ttlSeconds) {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(key, JSON.stringify(value), { ex: ttlSeconds || 300 });
  } catch(e) {}
}

async function cacheDel(key) {
  const r = getRedis();
  if (!r) return;
  try { await r.del(key); } catch(e) {}
}

async function cacheGetOrSet(key, fn, ttlSeconds) {
  const cached = await cacheGet(key);
  if (cached !== null) return cached;
  const result = await fn();
  await cacheSet(key, result, ttlSeconds || 300);
  return result;
}

module.exports = { cacheGet, cacheSet, cacheDel, cacheGetOrSet };
