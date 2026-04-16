// api/_helpers/cache.js — Cache layer with Upstash Redis (graceful fallback)
// CommonJS

let redis = null;

function getRedis() {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_URL;
  const token = process.env.UPSTASH_REDIS_TOKEN;
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
