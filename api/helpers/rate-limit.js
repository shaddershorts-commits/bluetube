// api/helpers/rate-limit.js — IP-based rate limiting via Supabase

const WINDOW_MS = 60 * 1000; // 1 minute window

// Sensitive endpoints get tighter limits
const ENDPOINT_LIMITS = {
  '/api/rewrite': 10,
  '/api/transcript': 10,
  '/api/generate-from-zero': 10,
  '/api/blue-editor': 10,
  '/api/title-suggest': 10,
  '/api/blue-voices': 10,
};
const DEFAULT_LIMIT = 20;

// Internal IPs that skip rate limiting
const WHITELIST = ['127.0.0.1', '::1'];

/**
 * Check rate limit. Returns { allowed, remaining, retryAfter } or null on error (fail open).
 */
async function checkRateLimit(ip, endpoint, supabaseUrl, supabaseKey) {
  if (!supabaseUrl || !supabaseKey) return { allowed: true, remaining: 999 };
  if (WHITELIST.includes(ip)) return { allowed: true, remaining: 999 };

  const limit = ENDPOINT_LIMITS[endpoint] || DEFAULT_LIMIT;
  const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();
  const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' };

  try {
    // Count requests in current window
    const countRes = await fetch(
      `${supabaseUrl}/rest/v1/rate_limits?ip=eq.${encodeURIComponent(ip)}&endpoint=eq.${encodeURIComponent(endpoint)}&window_start=gte.${windowStart}&select=count`,
      { headers, signal: AbortSignal.timeout(3000) }
    );

    let currentCount = 0;
    if (countRes.ok) {
      const data = await countRes.json();
      currentCount = data?.[0]?.count || data?.length || 0;
    }

    if (currentCount >= limit) {
      return { allowed: false, remaining: 0, retryAfter: 60 };
    }

    // Log this request (fire-and-forget)
    fetch(`${supabaseUrl}/rest/v1/rate_limits`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ ip, endpoint, count: 1, window_start: new Date().toISOString() })
    }).catch(() => {});

    return { allowed: true, remaining: limit - currentCount - 1 };
  } catch (e) {
    // Fail open — don't block users if rate limit check fails
    return { allowed: true, remaining: 999 };
  }
}

/**
 * Apply rate limit and return 429 response if exceeded. Returns true if blocked.
 */
async function applyRateLimit(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const endpoint = req.url?.split('?')[0] || '/api/unknown';
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  const rl = await checkRateLimit(ip, endpoint, supabaseUrl, supabaseKey);
  if (!rl.allowed) {
    res.setHeader('Retry-After', '60');
    res.status(429).json({
      error: 'Muitas requisições. Aguarde 1 minuto e tente novamente.',
      retry_after: 60
    });
    return true;
  }
  return false;
}

module.exports = { checkRateLimit, applyRateLimit };
