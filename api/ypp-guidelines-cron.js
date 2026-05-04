// api/ypp-guidelines-cron.js
//
// FASE 2 / BlueScore v2 — Cron WEEKLY que atualiza ypp_guidelines_cache
// com diretrizes YouTube Shorts atuais via SerpAPI Search.
//
// BlueScore IA usa esse cache como base de conhecimento adaptativa
// (substitui texto hardcoded de 6 meses atrás por snippets atualizados
// na semana corrente).
//
// Schedule: Domingo 05h UTC (low traffic). Configurado em vercel.json.
// Trigger manual: GET /api/ypp-guidelines-cron?force=true
//
// Custo: 8 buscas SerpAPI/semana = ~32/mês (cabe no free 250).

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

// 8 queries Shorts-only (6 da Fase 1 + 2 novas: hooks + thumbnail)
const QUERIES = [
  'youtube shorts reused content policy',
  'youtube shorts fund eligibility 2026',
  'youtube shorts ai generated content disclosure',
  'youtube shorts monetization guidelines 2026',
  'youtube shorts copyright music rules',
  'youtube shorts compilation channels demonetized',
  'youtube shorts viewer retention hook tips',
  'youtube shorts thumbnail clickbait policy',
];

function isOfficialYouTube(link) {
  if (!link) return false;
  try {
    const host = new URL(link).hostname.toLowerCase();
    return (
      host === 'support.google.com' ||
      host === 'blog.youtube' ||
      host === 'www.youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'creators.youtube.com'
    );
  } catch { return false; }
}

function isTrustedSource(link) {
  if (!link) return false;
  try {
    const host = new URL(link).hostname.toLowerCase().replace(/^www\./, '');
    const trusted = [
      'theverge.com', 'techcrunch.com', 'wired.com', 'engadget.com',
      'socialmediatoday.com', 'searchenginejournal.com', 'tubefilter.com',
      'reuters.com', 'bloomberg.com', 'bbc.com', 'cnet.com',
      'forbes.com', 'businessinsider.com', 'hollywoodreporter.com',
    ];
    return trusted.some((t) => host === t || host.endsWith('.' + t));
  } catch { return false; }
}

// ISO week format YYYY-Www (ex: "2026-W18"). Mesmo cálculo usado no auth.js.
function getCurrentISOWeek() {
  const now = new Date();
  const target = new Date(now.valueOf());
  const dayNr = (now.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay()) + 7) % 7);
  }
  const weekNum = 1 + Math.ceil((firstThursday - target) / 604800000);
  return `${now.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

async function searchSerpAPI(query) {
  const url = `https://serpapi.com/search?engine=google&q=${encodeURIComponent(query)}&hl=en&gl=us&num=10&api_key=${SERPAPI_KEY}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { error: `HTTP ${r.status}: ${txt.slice(0, 200)}` };
    }
    return await r.json();
  } catch (e) {
    return { error: 'fetch_failed: ' + (e.message || '').slice(0, 150) };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  if (!SERPAPI_KEY) return res.status(500).json({ error: 'SERPAPI_KEY ausente' });
  if (!SUPA_URL || !SUPA_KEY) return res.status(500).json({ error: 'Supabase nao configurado' });

  const supaH = {
    apikey: SUPA_KEY,
    Authorization: 'Bearer ' + SUPA_KEY,
    'Content-Type': 'application/json',
  };

  const week = getCurrentISOWeek();
  const startTs = Date.now();

  try {
    // 1. Busca todas as 8 queries em paralelo
    const results = await Promise.all(QUERIES.map((q) => searchSerpAPI(q)));

    // 2. Extrai snippets úteis (featured_snippet + top3 organic oficial/trusted)
    const rows = [];
    let errorCount = 0;

    for (let i = 0; i < QUERIES.length; i++) {
      const r = results[i];
      if (r.error) { errorCount++; continue; }

      // Featured snippet (rank_position = 0, prioridade máxima)
      if (r.featured_snippet?.snippet && r.featured_snippet?.link) {
        rows.push({
          query: QUERIES[i],
          snippet: String(r.featured_snippet.snippet).slice(0, 500),
          source_link: r.featured_snippet.link,
          source_displayed: r.featured_snippet.displayed_link || '',
          is_official_youtube: isOfficialYouTube(r.featured_snippet.link),
          is_trusted: isTrustedSource(r.featured_snippet.link),
          rank_position: 0,
          week_iso: week,
        });
      }

      // Top 3 organic que sejam oficial YouTube ou trusted source
      const organic = Array.isArray(r.organic_results) ? r.organic_results : [];
      const useful = organic
        .slice(0, 5)
        .filter((o) => o.snippet && (isOfficialYouTube(o.link) || isTrustedSource(o.link)))
        .slice(0, 3);

      useful.forEach((o, idx) => {
        rows.push({
          query: QUERIES[i],
          snippet: String(o.snippet).slice(0, 500),
          source_link: o.link,
          source_displayed: o.displayed_link || '',
          is_official_youtube: isOfficialYouTube(o.link),
          is_trusted: isTrustedSource(o.link),
          rank_position: idx + 1,
          week_iso: week,
        });
      });
    }

    // 3. Limpa entries de semanas antigas (mantém apenas current)
    let deletedOld = 0;
    try {
      const delR = await fetch(
        `${SUPA_URL}/rest/v1/ypp_guidelines_cache?week_iso=neq.${encodeURIComponent(week)}`,
        {
          method: 'DELETE',
          headers: { ...supaH, Prefer: 'count=exact, return=minimal' },
          signal: AbortSignal.timeout(10000),
        }
      );
      const range = delR.headers.get('content-range') || '';
      deletedOld = parseInt(range.split('/')[1] || '0') || 0;
    } catch (e) {
      // não bloquear cron por falha em delete
      console.warn('[ypp-cron] delete old failed:', e.message);
    }

    // 4. Limpa entries da semana atual (rerun sobrescreve)
    try {
      await fetch(
        `${SUPA_URL}/rest/v1/ypp_guidelines_cache?week_iso=eq.${encodeURIComponent(week)}`,
        {
          method: 'DELETE',
          headers: supaH,
          signal: AbortSignal.timeout(10000),
        }
      );
    } catch (e) {
      console.warn('[ypp-cron] delete current week failed:', e.message);
    }

    // 5. Insert batch (sem upsert — já limpamos a semana atual)
    let insertedCount = 0;
    if (rows.length > 0) {
      const insR = await fetch(`${SUPA_URL}/rest/v1/ypp_guidelines_cache`, {
        method: 'POST',
        headers: { ...supaH, Prefer: 'return=minimal' },
        body: JSON.stringify(rows),
        signal: AbortSignal.timeout(15000),
      });
      if (!insR.ok) {
        const txt = await insR.text().catch(() => '');
        return res.status(500).json({
          error: `insert failed HTTP ${insR.status}: ${txt.slice(0, 250)}`,
          week,
          attempted_rows: rows.length,
          timing_ms: Date.now() - startTs,
        });
      }
      insertedCount = rows.length;
    }

    // 6. Stats por query (pra debug)
    const statsByQuery = {};
    for (const row of rows) {
      statsByQuery[row.query] = (statsByQuery[row.query] || 0) + 1;
    }

    return res.status(200).json({
      ok: true,
      week,
      inserted: insertedCount,
      deleted_old_weeks: deletedOld,
      queries_total: QUERIES.length,
      queries_with_error: errorCount,
      stats_by_query: statsByQuery,
      timing_ms: Date.now() - startTs,
    });
  } catch (e) {
    return res.status(500).json({
      error: e.message,
      week,
      timing_ms: Date.now() - startTs,
    });
  }
};
