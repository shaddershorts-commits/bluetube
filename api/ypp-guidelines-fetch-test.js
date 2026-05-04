// api/ypp-guidelines-fetch-test.js
//
// FASE 1 / BlueScore v2 — Endpoint isolado de TESTE.
// Faz 6 buscas SerpAPI Search (engine=google) com queries SHORTS-ONLY pra
// validar se conseguimos pegar diretrizes YouTube Shorts atualizadas que
// possam servir como base de conhecimento adaptativa pra IA.
//
// NÃO afeta produção. NÃO altera bluescore-fingerprint nem auth.js.
//
// Uso:
//   GET /api/ypp-guidelines-fetch-test
//
// Custo: 6 buscas SerpAPI (cabe no free tier 250/mês).
// Tempo: ~10-20s (6 paralelos, ~5s cada).
//
// Critério "passou" (avaliação automática):
//   - Pelo menos 4 das 6 queries retornam 1+ resultado oficial YouTube ou
//     fonte trusted (Verge, TechCrunch, etc).
//   - Você lê os snippets manualmente e decide se vale como base de IA.

const SERPAPI_KEY = process.env.SERPAPI_KEY;

// Queries Shorts-only — refinadas pra forçar atualidade + cobertura de diretrizes
const QUERIES = [
  'youtube shorts reused content policy',
  'youtube shorts fund eligibility 2026',
  'youtube shorts ai generated content disclosure',
  'youtube shorts monetization guidelines 2026',
  'youtube shorts copyright music rules',
  'youtube shorts compilation channels demonetized',
];

// Domínios oficiais YouTube/Google
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

// Imprensa especializada em criadores / tech tier 1
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

async function searchSerpAPI(query) {
  const url = `https://serpapi.com/search?engine=google&q=${encodeURIComponent(
    query
  )}&hl=en&gl=us&num=10&api_key=${SERPAPI_KEY}`;
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!SERPAPI_KEY) {
    return res.status(500).json({ error: 'SERPAPI_KEY ausente na Vercel' });
  }

  const startTs = Date.now();

  try {
    // 6 buscas em paralelo
    const results = await Promise.all(
      QUERIES.map(async (query) => {
        const data = await searchSerpAPI(query);
        if (data.error) return { query, error: data.error };

        // SerpAPI ocasionalmente retorna objeto em vez de array — guard
        const organicAll = Array.isArray(data.organic_results) ? data.organic_results : [];
        const top5 = organicAll.slice(0, 5).map((o) => ({
          title: o.title || '',
          link: o.link || '',
          snippet: (o.snippet || '').slice(0, 400),
          source: o.displayed_link || '',
          is_official_youtube: isOfficialYouTube(o.link),
          is_trusted: isTrustedSource(o.link),
        }));

        const featured = data.featured_snippet
          ? {
              title: data.featured_snippet.title || '',
              snippet: (data.featured_snippet.snippet || '').slice(0, 500),
              link: data.featured_snippet.link || '',
              is_official_youtube: isOfficialYouTube(data.featured_snippet.link),
            }
          : null;

        const answerBox = data.answer_box
          ? {
              title: data.answer_box.title || '',
              snippet: (data.answer_box.snippet || data.answer_box.answer || '').slice(0, 500),
              link: data.answer_box.link || '',
            }
          : null;

        const relatedQuestions = (data.related_questions || []).slice(0, 4).map((q) => ({
          question: q.question || '',
          snippet: (q.snippet || '').slice(0, 300),
          link: q.link || '',
        }));

        const officialCount = top5.filter((r) => r.is_official_youtube).length;
        const trustedCount = top5.filter((r) => r.is_trusted).length;
        const usefulCount = officialCount + trustedCount;

        return {
          query,
          counts: {
            total_organic: organicAll.length,
            official_youtube: officialCount,
            trusted: trustedCount,
            useful: usefulCount,
          },
          featured_snippet: featured,
          answer_box: answerBox,
          top5,
          related_questions: relatedQuestions,
        };
      })
    );

    // Avaliação automática
    // Logica: avaliar PRIMEIRO se queries que NAO falharam atingiram passedQueries>=4.
    // Falha transiente de 1 query nao deve mascarar verdict de PASS quando 5/6 OK.
    const passedQueries = results.filter((r) => (r.counts?.useful || 0) >= 1).length;
    const totalUseful = results.reduce((s, r) => s + (r.counts?.useful || 0), 0);
    const errors = results.filter((r) => r.error).length;

    let verdict;
    if (passedQueries >= 4) {
      verdict = errors > 0
        ? `PASS — base viável (${passedQueries}/${QUERIES.length} queries OK; ${errors} falharam transiente)`
        : `PASS — base de conhecimento viável (${passedQueries}/${QUERIES.length} queries com fonte trusted)`;
    } else if (errors === QUERIES.length) {
      verdict = 'ERROR — TODAS as buscas falharam (provavel SERPAPI_KEY invalida ou rate limit)';
    } else if (errors > 0) {
      verdict = `INCONCLUSIVO — ${passedQueries}/${QUERIES.length} passaram + ${errors} falharam (rerun pode resolver)`;
    } else {
      verdict = 'FAIL — SerpAPI Search nao cobre bem diretrizes (menos de 4 queries com fonte trusted)';
    }

    return res.status(200).json({
      ok: true,
      verdict,
      summary: {
        queries_total: QUERIES.length,
        queries_with_useful_result: passedQueries,
        queries_with_error: errors,
        total_useful_results: totalUseful,
      },
      results,
      timing_ms: Date.now() - startTs,
    });
  } catch (e) {
    return res.status(500).json({
      error: e.message,
      timing_ms: Date.now() - startTs,
    });
  }
};
