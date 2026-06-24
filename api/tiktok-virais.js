// api/tiktok-virais.js — TikTok Virais engine (2026-06-24)
// =====================================================================
// Actions:
//   coletar (cron 3x/dia 6/14/22 UTC) — busca top por país via TikAPI
//   listar (frontend GET) — retorna vídeos filtrados por período/país
//   limpar (cron diário 4h UTC) — DELETE vídeos > 30 dias
//
// TikAPI endpoint: GET /public/explore?country=XX&count=30
// Filtro local: stats.diggCount >= 1_000_000
// Países: us, br, mx, es, jp, kr, id, fr (8 países, conforme decisão)

// 2026-06-24: expandido de 8 → 17 países (alvo ~220 reqs/dia, 73% quota).
// CN: TikTok não opera na China oficialmente (lá é Douyin separado).
// Mantemos no array pra TikAPI tentar — se retornar 0, é esperado.
const COUNTRIES = [
  // Originais (8): América + Europa + Ásia central
  'us', 'br', 'mx', 'es', 'jp', 'kr', 'id', 'fr',
  // Novos (9): Europa expandida + sudeste asiático + outros
  'uk', 'de', 'it', 'ph', 'th', 'vn', 'tr', 'ca', 'cn',
];
const MIN_LIKES = 800_000; // 2026-06-24: baixado de 1M pra 800k a pedido do user
const FETCH_COUNT_PER_COUNTRY = 30; // TikAPI retorna até 30/chamada
const RETENTION_DAYS = 30;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const TIKAPI_KEY = process.env.TIKAPI_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'config_missing' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const action = req.query.action || (req.body && req.body.action);

  try {
    if (action === 'coletar') return await coletar(req, res, { SU, h, TIKAPI_KEY });
    if (action === 'listar')  return await listar(req, res, { SU, h });
    if (action === 'limpar')  return await limpar(req, res, { SU, h });
    return res.status(400).json({ error: 'action_invalida', actions: ['coletar', 'listar', 'limpar'] });
  } catch (e) {
    console.error('[tiktok-virais fatal]', e?.message);
    return res.status(500).json({ error: e?.message });
  }
};

// ── COLETAR (cron 3x/dia) ────────────────────────────────────────────────────
async function coletar(req, res, { SU, h, TIKAPI_KEY }) {
  // Auth: cron Vercel ou admin
  const isCron = !!req.headers['x-vercel-cron'];
  const isAdmin = req.query.admin_secret === process.env.ADMIN_SECRET;
  if (!isCron && !isAdmin) return res.status(401).json({ error: 'unauthorized' });
  if (!TIKAPI_KEY) return res.status(500).json({ error: 'TIKAPI_KEY_missing' });

  const results = { ok: true, by_country: {}, total_inserted: 0, total_skipped: 0, total_failed: 0 };

  // 2026-06-24: paralelizado com Promise.allSettled.
  // Antes: serial (loop com 300ms delay) → ~10s × 16 países = 160s estourava
  //        Vercel maxDuration 120s. Agora: ~10-15s totais pra 17 países.
  // Trade-off: pico de 17 fetches simultâneos pra TikAPI. Plano Starter não
  // tem rate limit por segundo (só por dia), então aguenta tranquilo.
  const settled = await Promise.allSettled(COUNTRIES.map(async (country) => {
    const stat = { fetched: 0, qualified: 0, inserted: 0, errors: 0 };
    try {
      const url = `https://api.tikapi.io/public/explore?country=${country}&count=${FETCH_COUNT_PER_COUNTRY}`;
      const r = await fetch(url, {
        headers: { 'X-API-KEY': TIKAPI_KEY, 'accept': 'application/json' },
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) {
        stat.errors++;
        return { country, stat: { ...stat, http_status: r.status }, failed: true };
      }
      const data = await r.json();
      const items = Array.isArray(data?.itemList) ? data.itemList : [];
      stat.fetched = items.length;

      const qualified = items.filter(v => (v?.stats?.diggCount || 0) >= MIN_LIKES);
      stat.qualified = qualified.length;

      const now = new Date().toISOString();
      const rows = qualified.map(v => ({
        tiktok_video_id: v.id,
        video_url: `https://www.tiktok.com/@${v.author?.uniqueId || 'tiktok'}/video/${v.id}`,
        thumbnail_url: v.video?.cover || v.video?.dynamicCover || null,
        caption: (v.desc || '').slice(0, 500),
        author_handle: v.author?.uniqueId || null,
        author_name: v.author?.nickname || null,
        author_avatar: v.author?.avatarLarger || v.author?.avatarMedium || null,
        likes_count: v.stats?.diggCount || 0,
        views_count: v.stats?.playCount || 0,
        comments_count: v.stats?.commentCount || 0,
        shares_count: v.stats?.shareCount || 0,
        country,
        duration_sec: v.video?.duration || 0,
        tiktok_created_at: v.createTime ? new Date(v.createTime * 1000).toISOString() : null,
        collected_at: now,
        last_seen_at: now,
        status: 'active',
      }));

      if (rows.length) {
        const upR = await fetch(`${SU}/rest/v1/tiktok_virais?on_conflict=tiktok_video_id`, {
          method: 'POST',
          headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows),
        });
        if (upR.ok) {
          stat.inserted = rows.length;
        } else {
          const errText = await upR.text();
          console.error(`[tiktok-virais:coletar:${country}] upsert ${upR.status}:`, errText.slice(0, 200));
          stat.errors++;
          return { country, stat, failed: true };
        }
      }
      return { country, stat, skipped: rows.length === 0 };
    } catch (e) {
      console.error(`[tiktok-virais:coletar:${country}]`, e?.message);
      stat.errors++;
      return { country, stat, failed: true };
    }
  }));

  // Consolida resultados de cada país
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value) {
      const { country, stat, failed, skipped } = s.value;
      results.by_country[country] = stat;
      if (failed) results.total_failed++;
      else if (skipped) results.total_skipped++;
      else results.total_inserted += stat.inserted;
    } else {
      // Promise rejeitada (extremo raro — Promise.allSettled raramente rejeita)
      results.total_failed++;
    }
  }

  return res.status(200).json({ ...results, timestamp: new Date().toISOString() });
}

// ── LISTAR (frontend GET) ────────────────────────────────────────────────────
// Params: period=24h|7d|30d, country=all|us|br|..., sort=likes|views, limit, offset
async function listar(req, res, { SU, h }) {
  const period = req.query.period || '24h';
  const country = req.query.country || 'all';
  const sortParam = req.query.sort || 'likes';
  const sort = sortParam === 'views' ? 'views_count' : 'likes_count';
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = Math.max(0, parseInt(req.query.offset) || 0);

  const PERIOD_MS = {
    '24h': 24 * 3600 * 1000,
    '7d':  7 * 24 * 3600 * 1000,
    '30d': 30 * 24 * 3600 * 1000,
  };
  const since = new Date(Date.now() - (PERIOD_MS[period] || PERIOD_MS['24h'])).toISOString();

  let url = `${SU}/rest/v1/tiktok_virais?status=eq.active&collected_at=gte.${since}`;
  if (country !== 'all' && COUNTRIES.includes(country)) {
    url += `&country=eq.${country}`;
  }
  url += `&order=${sort}.desc&limit=${limit}&offset=${offset}`;
  url += `&select=tiktok_video_id,video_url,thumbnail_url,caption,author_handle,author_name,author_avatar,likes_count,views_count,comments_count,shares_count,country,duration_sec,tiktok_created_at,collected_at`;

  const r = await fetch(url, { headers: { ...h, Prefer: 'count=exact' } });
  const items = r.ok ? await r.json() : [];
  const total = parseInt((r.headers.get('content-range') || '').split('/')[1] || '0') || items.length;

  return res.status(200).json({
    ok: true,
    period, country, sort: sortParam, limit, offset, total,
    has_more: offset + items.length < total,
    items,
  });
}

// ── LIMPAR (cron diário) ─────────────────────────────────────────────────────
// DELETE vídeos com collected_at > 30 dias
async function limpar(req, res, { SU, h }) {
  const isCron = !!req.headers['x-vercel-cron'];
  const isAdmin = req.query.admin_secret === process.env.ADMIN_SECRET;
  if (!isCron && !isAdmin) return res.status(401).json({ error: 'unauthorized' });

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
  const r = await fetch(`${SU}/rest/v1/tiktok_virais?collected_at=lt.${cutoff}`, {
    method: 'DELETE',
    headers: { ...h, Prefer: 'return=minimal' },
  });
  return res.status(200).json({
    ok: r.ok,
    cutoff,
    retention_days: RETENTION_DAYS,
    timestamp: new Date().toISOString(),
  });
}
