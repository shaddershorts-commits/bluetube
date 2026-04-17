// api/_helpers/db.js — Camada de abstração com retry + circuit breaker
// sobre a REST API do Supabase. Usa raw fetch (padrão do projeto) em vez
// de @supabase/supabase-js pra não adicionar dependência.
const SU = process.env.SUPABASE_URL;
const SK = process.env.SUPABASE_SERVICE_KEY;
const AK = process.env.SUPABASE_ANON_KEY || SK;

const DEFAULT_HEADERS = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

const state = {
  failures: 0,
  lastFailure: null,
  circuitOpen: false,
};
const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_TIMEOUT = 60000; // 1 min

function checkCircuit() {
  if (!state.circuitOpen) return;
  const elapsed = Date.now() - state.lastFailure;
  if (elapsed > CIRCUIT_TIMEOUT) {
    state.circuitOpen = false;
    state.failures = 0;
    console.log('[db] circuit breaker resetado após timeout');
    return;
  }
  const err = new Error('DB_CIRCUIT_OPEN');
  err.code = 'DB_CIRCUIT_OPEN';
  throw err;
}

async function notifyAdmin(subject, details) {
  try {
    if (!process.env.RESEND_API_KEY || !process.env.ADMIN_EMAIL) return;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'monitor@bluetubeviral.com',
        to: process.env.ADMIN_EMAIL,
        subject: `🚨 ${subject}`,
        html: `<h2>🚨 ${subject}</h2><pre>${String(details).slice(0, 2000)}</pre>`,
      }),
    });
  } catch (e) { /* silencioso */ }
}

function recordFailure(err) {
  state.failures++;
  state.lastFailure = Date.now();
  if (state.failures >= CIRCUIT_THRESHOLD && !state.circuitOpen) {
    state.circuitOpen = true;
    console.error('[db] circuit breaker ABERTO após ' + state.failures + ' falhas');
    notifyAdmin('DB circuit breaker ABERTO', err?.message || err);
  }
}

function recordSuccess() {
  if (state.failures) console.log('[db] sucesso após ' + state.failures + ' falhas — zerando contador');
  state.failures = 0;
  state.circuitOpen = false;
}

// Executa uma função que retorna Promise, com retry exponencial + circuit breaker
async function execute(fn, { retries = 3, baseDelay = 400 } = {}) {
  checkCircuit();
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const result = await fn();
      recordSuccess();
      return result;
    } catch (e) {
      lastErr = e;
      if (i === retries) break;
      const delay = baseDelay * Math.pow(2, i) + Math.random() * 200;
      console.warn(`[db] tentativa ${i + 1}/${retries + 1} falhou: ${e.message} (retry em ${Math.round(delay)}ms)`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  recordFailure(lastErr);
  throw lastErr;
}

// Helper: fetch com timeout
async function doFetch(path, init = {}, timeout = 15000) {
  if (!SU) throw new Error('SUPABASE_URL não configurada');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${SU}${path}`, {
      ...init,
      headers: { ...DEFAULT_HEADERS, ...(init.headers || {}) },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`supabase ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function buildQuery(q = {}) {
  const parts = [];
  if (q.select) parts.push('select=' + encodeURIComponent(q.select));
  if (q.eq) Object.entries(q.eq).forEach(([k, v]) => parts.push(`${encodeURIComponent(k)}=eq.${encodeURIComponent(v)}`));
  if (q.neq) Object.entries(q.neq).forEach(([k, v]) => parts.push(`${encodeURIComponent(k)}=neq.${encodeURIComponent(v)}`));
  if (q.in) Object.entries(q.in).forEach(([k, arr]) => parts.push(`${encodeURIComponent(k)}=in.(${arr.map(encodeURIComponent).join(',')})`));
  if (q.order) parts.push(`order=${encodeURIComponent(q.order.column)}.${q.order.ascending === false ? 'desc' : 'asc'}`);
  if (q.limit) parts.push('limit=' + q.limit);
  if (q.offset) parts.push('offset=' + q.offset);
  return parts.length ? '?' + parts.join('&') : '';
}

const db = {
  async select(table, query = {}) {
    return execute(async () => {
      const res = await doFetch(`/rest/v1/${table}${buildQuery(query)}`);
      const data = await res.json();
      return query.single ? data[0] || null : data;
    });
  },

  async insert(table, data) {
    return execute(async () => {
      const res = await doFetch(`/rest/v1/${table}`, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(data),
      });
      const rows = await res.json();
      return Array.isArray(data) ? rows : rows[0];
    });
  },

  async update(table, data, conditions = {}) {
    return execute(async () => {
      const qs = buildQuery({ eq: conditions }).replace(/^\?/, '');
      const res = await doFetch(`/rest/v1/${table}?${qs}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(data),
      });
      return res.json();
    });
  },

  async upsert(table, data, options = {}) {
    return execute(async () => {
      const prefer = ['return=representation'];
      if (options.onConflict) prefer.push(`resolution=merge-duplicates`);
      const path = `/rest/v1/${table}${options.onConflict ? `?on_conflict=${options.onConflict}` : ''}`;
      const res = await doFetch(path, {
        method: 'POST',
        headers: { Prefer: prefer.join(',') },
        body: JSON.stringify(data),
      });
      return res.json();
    });
  },

  async delete(table, conditions = {}) {
    return execute(async () => {
      const qs = buildQuery({ eq: conditions }).replace(/^\?/, '');
      if (!qs) throw new Error('delete sem conditions é bloqueado por segurança');
      await doFetch(`/rest/v1/${table}?${qs}`, { method: 'DELETE' });
      return true;
    });
  },

  // Raw access quando precisa de queries específicas do PostgREST que o wrapper
  // não cobre (ilike, or=, etc). Mantém retry + circuit breaker.
  async raw(path, init = {}) {
    return execute(async () => {
      const res = await doFetch(path, init);
      const ct = res.headers.get('content-type') || '';
      return ct.includes('json') ? res.json() : res.text();
    });
  },

  get state() { return { ...state }; },
};

module.exports = { db, DEFAULT_HEADERS };
