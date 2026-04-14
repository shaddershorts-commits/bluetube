// Lipy — CRUD de clientes
const { getSupabase } = require('./_lipy/supabase');
const { ok, fail, readJson, cors } = require('./_lipy/http');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const sb = getSupabase();

  try {
    if (req.method === 'GET') {
      const id = req.query?.id;
      if (id) {
        const { data } = await sb.from('lipy_clientes').select('*').eq('id', id).maybeSingle();
        return ok(res, { cliente: data });
      }
      const { data } = await sb.from('lipy_clientes').select('*').order('created_at', { ascending: false });
      return ok(res, { clientes: data || [] });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const { data, error } = await sb.from('lipy_clientes').insert(body).select().single();
      if (error) return fail(res, 400, error.message);
      return ok(res, { cliente: data });
    }

    if (req.method === 'PUT') {
      const body = await readJson(req);
      const { id, ...updates } = body;
      const { data, error } = await sb.from('lipy_clientes').update(updates).eq('id', id).select().single();
      if (error) return fail(res, 400, error.message);
      return ok(res, { cliente: data });
    }

    if (req.method === 'DELETE') {
      const id = req.query?.id;
      await sb.from('lipy_clientes').delete().eq('id', id);
      return ok(res, { deleted: true });
    }

    return fail(res, 405, 'método não suportado');
  } catch (err) {
    return fail(res, 500, err.message);
  }
};
