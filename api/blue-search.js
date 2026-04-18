// api/blue-search.js — Busca full-text turbinada (FTS + fuzzy + trending)
// Usa pg_trgm + tsvector do Supabase. Small compute = <100ms pra milhoes de rows.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });
  const h = { apikey: SK, Authorization: 'Bearer ' + SK };

  const q = (req.query.q || '').trim();
  const type = req.query.type || 'all';
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  // Trending (no query) — pega top virais da ultima semana
  if (!q || q.length < 2) {
    try {
      const desde = new Date(Date.now() - 7 * 86400000).toISOString();
      const tr = await fetch(
        `${SU}/rest/v1/blue_videos?status=eq.active&video_url=neq.null&created_at=gte.${desde}&order=views.desc&limit=8&select=id,title,thumbnail_url,views,user_id`,
        { headers: h }
      );
      const trending = tr.ok ? await tr.json() : [];
      return res.status(200).json({ videos: trending, users: [], trending: true });
    } catch(e) { return res.status(200).json({ videos: [], users: [], trending: true }); }
  }

  // Sanitize
  const safeQ = q.replace(/['"\\%_]/g, '');

  // Converte query em tsquery (portuguese + unaccent + prefix match)
  // Ex: "financas pix" -> "financas:* & pix:*"
  const ftsQuery = q
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/).filter(w => w.length >= 2)
    .map(w => `${w}:*`)
    .join(' & ');

  const results = { videos: [], users: [], fonte: 'fts' };

  async function searchVideosFTS() {
    if (!ftsQuery) return [];
    try {
      const r = await fetch(
        `${SU}/rest/v1/blue_videos?status=eq.active&video_url=neq.null&search_tsv=fts(portuguese).${encodeURIComponent(ftsQuery)}&order=score.desc&limit=${limit}&select=id,title,description,thumbnail_url,views,likes,user_id,created_at,score`,
        { headers: h, signal: AbortSignal.timeout(4000) }
      );
      if (r.ok) return await r.json();
    } catch (e) {}
    return [];
  }

  async function searchVideosFallback() {
    try {
      const r = await fetch(
        `${SU}/rest/v1/blue_videos?status=eq.active&video_url=neq.null&or=(title.ilike.*${encodeURIComponent(safeQ)}*,description.ilike.*${encodeURIComponent(safeQ)}*)&order=views.desc&limit=${limit}&select=id,title,description,thumbnail_url,views,likes,user_id,created_at`,
        { headers: h, signal: AbortSignal.timeout(4000) }
      );
      if (r.ok) return await r.json();
    } catch (e) {}
    return [];
  }

  async function searchUsersFTS() {
    if (!ftsQuery) return [];
    try {
      const r = await fetch(
        `${SU}/rest/v1/blue_profiles?search_tsv=fts(portuguese).${encodeURIComponent(ftsQuery)}&limit=${limit}&select=user_id,username,display_name,avatar_url,bio,verificado`,
        { headers: h, signal: AbortSignal.timeout(4000) }
      );
      if (r.ok) return await r.json();
    } catch (e) {}
    return [];
  }

  async function searchUsersFallback() {
    try {
      const r = await fetch(
        `${SU}/rest/v1/blue_profiles?or=(username.ilike.*${encodeURIComponent(safeQ)}*,display_name.ilike.*${encodeURIComponent(safeQ)}*)&limit=${limit}&select=user_id,username,display_name,avatar_url,bio,verificado`,
        { headers: h, signal: AbortSignal.timeout(4000) }
      );
      if (r.ok) return await r.json();
    } catch (e) {}
    return [];
  }

  try {
    // Tenta FTS (fast), cai pra fallback se nao houver resultados OU coluna nao existe
    if (type === 'all' || type === 'videos') {
      results.videos = await searchVideosFTS();
      if (results.videos.length === 0) {
        results.videos = await searchVideosFallback();
        results.fonte = 'fallback';
      }
    }
    if (type === 'all' || type === 'users') {
      results.users = await searchUsersFTS();
      if (results.users.length === 0) {
        results.users = await searchUsersFallback();
        results.fonte = 'fallback';
      }
    }
    return res.status(200).json(results);
  } catch(e) {
    return res.status(500).json({ error: e.message, videos: [], users: [] });
  }
};
