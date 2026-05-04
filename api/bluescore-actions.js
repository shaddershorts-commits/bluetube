// api/bluescore-actions.js
//
// FASE 4 / BlueScore v2 — Actions de gerenciamento das análises do user.
// Replica padrão do BlueTendências (salvar/deletar/listar).
// Isolamento por user_id — usuário só vê suas próprias análises.
//
// Actions:
//   GET  ?action=salvas&token=X         → lista 50 últimas com salva=true
//   POST { action:'salvar', analise_id, token }   → marca salva=true
//   POST { action:'deletar', analise_id, token }  → marca salva=false
//
// Auth: token Supabase Bearer (mesmo do BlueTendências).

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || SUPA_KEY;

const PROMPT_VERSION = 'v2-fase3-deep';

const supaH = {
  apikey: SUPA_KEY,
  Authorization: 'Bearer ' + SUPA_KEY,
  'Content-Type': 'application/json',
};

async function getUser(token) {
  if (!token) return null;
  try {
    const r = await fetch(`${SUPA_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(5000),
    });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

async function listarSalvas(userId) {
  const url =
    `${SUPA_URL}/rest/v1/bluescore_analises` +
    `?user_id=eq.${userId}` +
    `&prompt_version=eq.${PROMPT_VERSION}` +
    `&salva=eq.true` +
    `&select=id,canal_id,canal_nome,nicho,verdict,compliance_score,score,diagnostico,created_at` +
    `&order=created_at.desc&limit=50`;
  try {
    const r = await fetch(url, { headers: supaH, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { ok: false, error: 'fetch_failed' };
    const rows = await r.json();
    return { ok: true, count: rows.length, analises: rows };
  } catch (e) { return { ok: false, error: (e.message || '').slice(0, 150) }; }
}

async function patchSalva(userId, analiseId, salva) {
  // user_id no filtro garante isolamento (usuário X não pode mexer em análise de Y)
  const url =
    `${SUPA_URL}/rest/v1/bluescore_analises` +
    `?id=eq.${encodeURIComponent(analiseId)}` +
    `&user_id=eq.${userId}`;
  try {
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { ...supaH, Prefer: 'return=representation' },
      body: JSON.stringify({ salva: !!salva }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ok: false, error: `HTTP ${r.status}: ${txt.slice(0, 150)}` };
    }
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: false, error: 'analise_nao_encontrada_ou_nao_pertence_ao_user' };
    }
    return { ok: true, salva: rows[0].salva };
  } catch (e) { return { ok: false, error: (e.message || '').slice(0, 150) }; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SUPA_URL || !SUPA_KEY) {
    return res.status(500).json({ error: 'Supabase nao configurado' });
  }

  // Token de auth
  const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
  const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const queryToken = req.query?.token || '';
  const bodyToken = (req.body && typeof req.body === 'object') ? req.body.token : '';
  const token = headerToken || queryToken || bodyToken;
  if (!token) return res.status(401).json({ error: 'token_obrigatorio' });

  const user = await getUser(token);
  if (!user?.id) return res.status(401).json({ error: 'token_invalido' });
  const userId = user.id;

  // GET: listar salvas
  if (req.method === 'GET') {
    const action = req.query?.action;
    if (action !== 'salvas') {
      return res.status(400).json({ error: 'action invalida (use ?action=salvas)' });
    }
    const result = await listarSalvas(userId);
    if (!result.ok) return res.status(500).json({ error: result.error });
    return res.status(200).json(result);
  }

  // POST: salvar/deletar
  if (req.method === 'POST') {
    const action = req.body?.action;
    const analiseId = req.body?.analise_id;
    if (!action || !analiseId) {
      return res.status(400).json({ error: 'action e analise_id obrigatorios' });
    }
    if (action === 'salvar') {
      const result = await patchSalva(userId, analiseId, true);
      if (!result.ok) return res.status(404).json({ error: result.error });
      return res.status(200).json({ ok: true, salva: true });
    }
    if (action === 'deletar') {
      const result = await patchSalva(userId, analiseId, false);
      if (!result.ok) return res.status(404).json({ error: result.error });
      return res.status(200).json({ ok: true, salva: false });
    }
    return res.status(400).json({ error: 'action invalida (use salvar|deletar)' });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
