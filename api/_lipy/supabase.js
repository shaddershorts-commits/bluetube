// Cliente Supabase compartilhado (Lipy) — CommonJS
const { createClient } = require('@supabase/supabase-js');

let client = null;

function getSupabase() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn('[lipy/supabase] credenciais ausentes — stub');
    return stubClient();
  }
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

function stubClient() {
  const chain = () => new Proxy({}, { get: () => (...args) => {
    if (args.length === 0) return chain();
    return Promise.resolve({ data: null, error: null });
  }});
  return {
    from: () => chain(),
    storage: { from: () => ({ upload: async () => ({ data: null, error: null }), getPublicUrl: () => ({ data: { publicUrl: '' } }) }) }
  };
}

module.exports = { getSupabase };
