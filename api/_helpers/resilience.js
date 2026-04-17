// api/_helpers/resilience.js — Utilitários de resiliência genéricos.

/**
 * Retry com backoff exponencial + jitter + timeout por tentativa.
 * fn recebe um AbortSignal.
 */
async function withRetry(fn, options = {}) {
  const {
    retries = 3,
    baseDelay = 1000,
    maxDelay = 10000,
    timeout = 30000,
    onRetry = null,
    shouldRetry = () => true,
  } = options;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      return await fn(ctrl.signal);
    } catch (e) {
      lastErr = e;
      if (attempt === retries || !shouldRetry(e)) {
        clearTimeout(timer);
        throw e;
      }
      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay) + Math.random() * 500;
      console.warn(`[resilience] retry ${attempt + 1}/${retries} em ${Math.round(delay)}ms — ${e.message}`);
      if (onRetry) try { onRetry(attempt + 1, e); } catch {}
      await new Promise((r) => setTimeout(r, delay));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * Tenta fn; se falhar todas as retries, chama fallbackFn.
 */
async function withFallback(fn, fallbackFn, options = {}) {
  try {
    return await withRetry(fn, options);
  } catch (err) {
    console.warn(`[resilience] principal falhou (${err.message}) — usando fallback`);
    try {
      return await fallbackFn(err);
    } catch (fbErr) {
      console.error(`[resilience] fallback tambem falhou: ${fbErr.message}`);
      throw err; // Preserva erro original
    }
  }
}

// Rate limiter em memória (bom pra Vercel quente; cold start reseta).
// Para limite distribuído use blue_rate_limits no Supabase.
const store = new Map();

function checkRateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  const windowStart = now - windowMs;
  const arr = (store.get(key) || []).filter((t) => t > windowStart);
  arr.push(now);
  store.set(key, arr);

  // GC leve quando o store crescer
  if (store.size > 10000) {
    for (const [k, v] of store) {
      if (v.every((t) => t < windowStart)) store.delete(k);
    }
  }

  return {
    allowed: arr.length <= maxRequests,
    remaining: Math.max(0, maxRequests - arr.length),
    resetAt: new Date(windowStart + windowMs).toISOString(),
  };
}

/**
 * Memoização com TTL — útil pra cachear chamadas caras de API por alguns
 * segundos/minutos em memória do processo.
 */
const memoStore = new Map();
function memoize(fn, { key, ttlMs = 60000 }) {
  return async (...args) => {
    const k = typeof key === 'function' ? key(...args) : key;
    const cached = memoStore.get(k);
    if (cached && Date.now() - cached.at < ttlMs) return cached.value;
    const value = await fn(...args);
    memoStore.set(k, { value, at: Date.now() });
    return value;
  };
}

module.exports = { withRetry, withFallback, checkRateLimit, memoize };
