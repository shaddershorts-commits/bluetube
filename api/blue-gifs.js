// api/blue-gifs.js — GIFs (GIPHY) + figurinhas salvas pro app Blue.
//   GET  ?action=search&q=...&token=...   → { gifs:[{url,preview}], disabled? }
//   GET  ?action=stickers&token=...       → { stickers:[url] }
//   POST { action:'save-sticker', token, url }  → salva figurinha
//   POST { action:'del-sticker',  token, url }  → remove figurinha
// Sem GIPHY_API_KEY configurada, search devolve { disabled:true } (o app
// esconde a aba de GIF). Mesma chave que liga os GIFs da Comunidade.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  const GK = process.env.GIPHY_API_KEY;
  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  const action = req.method === 'GET' ? req.query.action : req.body?.action;
  const token = req.method === 'GET' ? req.query.token : req.body?.token;

  // ── GIF SEARCH (GIPHY) ─────────────────────────────────────────────────────
  if (action === 'search') {
    if (!GK) return res.status(200).json({ gifs: [], disabled: true });
    const q = String(req.query.q || '').replace(/<[^>]*>/g, '').trim().slice(0, 60);
    const url = q
      ? `https://api.giphy.com/v1/gifs/search?api_key=${GK}&q=${encodeURIComponent(q)}&limit=24&rating=pg-13&lang=pt`
      : `https://api.giphy.com/v1/gifs/trending?api_key=${GK}&limit=24&rating=pg-13`;
    try {
      const gr = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!gr.ok) return res.status(200).json({ gifs: [] });
      const gd = await gr.json();
      return res.status(200).json({
        gifs: (gd.data || []).map((g) => ({
          url: g.images?.fixed_height?.url || g.images?.original?.url,
          preview: g.images?.fixed_height_small?.url || g.images?.fixed_height?.url,
        })).filter((g) => g.url),
      });
    } catch (e) { return res.status(200).json({ gifs: [] }); }
  }

  // Auth pras figurinhas
  if (!token) return res.status(401).json({ error: 'Login necessário.' });
  let userId = null;
  try {
    const ur = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (ur.ok) userId = (await ur.json()).id;
  } catch (e) {}
  if (!userId) return res.status(401).json({ error: 'Token inválido.' });

  const isGif = (u) => typeof u === 'string' && /^https:\/\/(media\d*\.giphy\.com|i\.giphy\.com)\//.test(u) && u.length < 500;

  // ── LISTAR FIGURINHAS ──────────────────────────────────────────────────────
  if (action === 'stickers') {
    const r = await fetch(`${SU}/rest/v1/blue_stickers?user_id=eq.${userId}&order=created_at.desc&limit=60&select=url`, { headers: H });
    const rows = r.ok ? await r.json() : [];
    return res.status(200).json({ stickers: rows.map((s) => s.url) });
  }

  // ── SALVAR FIGURINHA ───────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'save-sticker') {
    const url = req.body?.url;
    if (!isGif(url)) return res.status(400).json({ error: 'GIF inválido.' });
    const r = await fetch(`${SU}/rest/v1/blue_stickers`, {
      method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: userId, url, created_at: new Date().toISOString() }),
    });
    return res.status(200).json({ ok: r.ok });
  }

  // ── REMOVER FIGURINHA ──────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'del-sticker') {
    const url = req.body?.url;
    if (!url) return res.status(400).json({ error: 'url obrigatória' });
    await fetch(`${SU}/rest/v1/blue_stickers?user_id=eq.${userId}&url=eq.${encodeURIComponent(url)}`, { method: 'DELETE', headers: H });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Ação inválida.' });
};
