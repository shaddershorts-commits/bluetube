// api/helpers/cache.js — Supabase-backed response cache

const crypto = require('crypto');

function cacheKey(parts) {
  return crypto.createHash('md5').update(parts.join('|')).digest('hex');
}

/**
 * Get cached value. Returns parsed value or null.
 */
async function getCache(key, supabaseUrl, supabaseKey) {
  if (!supabaseUrl || !supabaseKey) return null;
  try {
    const now = new Date().toISOString();
    const r = await fetch(
      `${supabaseUrl}/rest/v1/api_cache?cache_key=eq.${encodeURIComponent(key)}&expires_at=gt.${now}&select=value&limit=1`,
      {
        headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
        signal: AbortSignal.timeout(3000)
      }
    );
    if (!r.ok) return null;
    const data = await r.json();
    return data?.[0]?.value || null;
  } catch (e) {
    return null;
  }
}

/**
 * Set cache value with TTL in hours.
 */
async function setCache(key, value, ttlHours, supabaseUrl, supabaseKey) {
  if (!supabaseUrl || !supabaseKey) return;
  try {
    const expires = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
    // Upsert via DELETE + POST (simpler than ON CONFLICT handling via REST)
    await fetch(`${supabaseUrl}/rest/v1/api_cache?cache_key=eq.${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
    }).catch(() => {});
    await fetch(`${supabaseUrl}/rest/v1/api_cache`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ cache_key: key, value, created_at: new Date().toISOString(), expires_at: expires })
    });
  } catch (e) {
    // Cache write failure is non-critical
  }
}

/**
 * Invalidate a cache entry.
 */
async function invalidateCache(key, supabaseUrl, supabaseKey) {
  if (!supabaseUrl || !supabaseKey) return;
  try {
    await fetch(`${supabaseUrl}/rest/v1/api_cache?cache_key=eq.${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
    });
  } catch (e) {}
}

module.exports = { cacheKey, getCache, setCache, invalidateCache };
