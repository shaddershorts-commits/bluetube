// api/bluelens-cleanup.js
//
// Cron weekly que deleta entries do cache do BlueLens com mais de 8 dias.
// TTL real do cache = 7 dias. Margem de 1 dia evita race conditions.
//
// Schedule (vercel.json): Domingo 04:00 UTC (low traffic).
//
// Resposta: { ok: true, deleted: N, cutoff: ISO }

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const supaH = SUPA_KEY ? { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY } : null;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  if (!supaH || !SUPA_URL) {
    return res.status(500).json({ error: 'SUPABASE nao configurado' });
  }

  // TTL 7 dias + 1 dia margem = corta entries > 8 dias
  const cutoff = new Date(Date.now() - 8 * 86400 * 1000).toISOString();

  try {
    const r = await fetch(
      `${SUPA_URL}/rest/v1/bluelens_cache?created_at=lt.${encodeURIComponent(cutoff)}`,
      {
        method: 'DELETE',
        headers: { ...supaH, 'Prefer': 'count=exact, return=minimal' },
        signal: AbortSignal.timeout(30000),
      }
    );
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return res.status(502).json({ error: `Supabase HTTP ${r.status}: ${body.slice(0, 200)}` });
    }
    // content-range = "items 0-N/total" ou apenas "*/total"
    const range = r.headers.get('content-range') || '';
    const deleted = range.split('/')[1] || '?';
    console.log(`[bluelens-cleanup] deleted ${deleted} entries older than ${cutoff}`);
    return res.status(200).json({ ok: true, deleted, cutoff });
  } catch (e) {
    return res.status(500).json({ error: e.message?.slice(0, 200) });
  }
};
