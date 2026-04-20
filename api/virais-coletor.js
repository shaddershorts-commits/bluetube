// api/virais-coletor.js — Coletor de Shorts virais que alimenta virais_banco.
// Chamado APENAS por crons (nao pelo usuario). Banco acumulativo: vídeos
// antigos nao somem, apenas descem na ordenacao padrao (por coletado_em).
//
// Actions:
//   GET ?action=coletar-trending     — trending BR + shorts em alta
//   GET ?action=coletar-nichos       — 3 nichos rotativos por execucao
//   GET ?action=atualizar-metricas   — refresh de stats dos videos recentes
//   GET ?action=calcular-scores      — recalcula viral_score
//   GET ?action=status               — metricas do banco (pra admin)
//
// Usa fetch REST do Supabase (nao depende de @supabase/supabase-js).
// NUNCA modifica api/auth.js.

const { youtubeRequest } = require('./_helpers/youtube');

const SU = process.env.SUPABASE_URL;
const SK = process.env.SUPABASE_SERVICE_KEY;
const HDR = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

module.exports = async function handler(req, res) {
  if (!SU || !SK) return res.status(500).json({ error: 'config_missing' });
  const { action } = req.query;
  try {
    switch (action) {
      case 'coletar-trending':   return await coletarTrending(res);
      case 'coletar-nichos':     return await coletarPorNichos(res);
      case 'atualizar-metricas': return await atualizarMetricas(res);
      case 'calcular-scores':    return await calcularScores(res);
      case 'backfill-nichos':    return await backfillNichos(res, req);
      case 'migrar-nicho':       return await migrarNicho(res, req);
      case 'expandir-canais':    return await expandirCanais(res, req);
      case 'status':             return await statusBanco(res);
      default:                   return res.status(400).json({ error: 'action_invalida' });
    }
  } catch (e) {
    console.error('[virais-coletor]', action, e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ── HELPERS ─────────────────────────────────────────────────────────────────
function parseDuracao(duration) {
  if (!duration) return 0;
  const m = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

function extrairHashtags(texto) {
  const matches = texto.match(/#[\w\u00C0-\u017F]+/g) || [];
  return [...new Set(matches.map(h => h.toLowerCase()))].slice(0, 10);
}

function detectarIdioma(snippet) {
  const lang = (snippet.defaultAudioLanguage || snippet.defaultLanguage || '').toLowerCase();
  if (lang.startsWith('pt')) return 'pt';
  if (lang.startsWith('en')) return 'en';
  if (lang.startsWith('es')) return 'es';
  // Fallback heuristico no titulo
  const t = (snippet.title || '').toLowerCase();
  if (/[áàâãéêíóôõúç]/.test(t)) return 'pt';
  return 'other';
}

// Prioridade: regionCode explicito da coleta > idioma do audio > default BR
function detectarPais(snippet, regionCode) {
  if (regionCode) return regionCode.toUpperCase();
  const lang = (snippet.defaultAudioLanguage || snippet.defaultLanguage || '').toLowerCase();
  if (lang.startsWith('pt')) return 'BR';
  if (lang.startsWith('en')) return 'US';
  if (lang.startsWith('es')) return 'ES';
  return 'BR';
}

// Mapa: YouTube categoryId -> nicho do nosso sistema
// Auto-inferencia pra videos coletados em 'trending' (que nao tem nicho explicito)
// Entertainment, Comedy, Film -> curiosidades (unificado)
const CATEGORY_TO_NICHO = {
  '20': 'games',            // Gaming
  '28': 'ia',               // Science & Technology
  '15': 'animais',          // Pets & Animals
  '10': 'artistas',         // Music
  '22': 'pessoas_blogs',    // People & Blogs
  '24': 'curiosidades',     // Entertainment -> curiosidades
  '23': 'curiosidades',     // Comedy -> curiosidades
  '1':  'curiosidades',     // Film & Animation -> curiosidades
  '17': 'curiosidades',     // Sports -> curiosidades (conteudo viral)
  '26': 'pessoas_blogs',    // Howto & Style
  '27': 'pessoas_blogs',    // Education
  '25': 'pessoas_blogs',    // News & Politics
};

function inferirNichoPorCategoria(categoryId) {
  if (!categoryId) return null;
  return CATEGORY_TO_NICHO[String(categoryId)] || null;
}

async function supaUpsert(table, rows, onConflict) {
  if (!rows || !rows.length) return { ok: true, count: 0 };
  const qs = onConflict ? `?on_conflict=${onConflict}` : '';
  const r = await fetch(`${SU}/rest/v1/${table}${qs}`, {
    method: 'POST',
    headers: { ...HDR, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  return { ok: r.ok, status: r.status };
}

async function supaSelect(path) {
  const r = await fetch(`${SU}/rest/v1/${path}`, { headers: HDR });
  if (!r.ok) return null;
  return r.json();
}

async function supaPatch(path, payload) {
  return fetch(`${SU}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...HDR, Prefer: 'return=minimal' },
    body: JSON.stringify(payload),
  });
}

async function logColeta(tipo, params, novos, atualizados, cota, duracao, erro) {
  try {
    await fetch(`${SU}/rest/v1/virais_coletas_log`, {
      method: 'POST',
      headers: { ...HDR, Prefer: 'return=minimal' },
      body: JSON.stringify({
        tipo_busca: tipo,
        parametros: params || {},
        videos_encontrados: novos + atualizados,
        videos_novos: novos,
        videos_atualizados: atualizados,
        cota_gasta: cota,
        duracao_ms: duracao,
        erro: erro || null,
      }),
    });
  } catch (e) { /* best-effort */ }
}

// ── NORMALIZACAO + SALVAR ──────────────────────────────────────────────────
function normalizarVideo(item, nicho, regionCode) {
  if (!item || !item.snippet) return null;
  const youtubeId = typeof item.id === 'string' ? item.id : item.id?.videoId;
  if (!youtubeId) return null;

  const snippet = item.snippet;
  const stats = item.statistics || {};
  const duracao = parseDuracao(item.contentDetails?.duration);

  // Shorts apenas (<= 90s inclui tolerancia pra erros de parse)
  if (duracao > 90 && duracao !== 0) return null;

  const views = Number(stats.viewCount || 0);
  const likes = Number(stats.likeCount || 0);
  const comentarios = Number(stats.commentCount || 0);
  const taxaEngajamento = views > 0 ? +(((likes + comentarios) / views) * 100).toFixed(4) : 0;

  // Nicho: priorizar o explicito (quando veio de coletar-nichos), senao
  // inferir pelo categoryId do YouTube (funciona pra coletar-trending)
  const nichoFinal = nicho || inferirNichoPorCategoria(snippet.categoryId);

  return {
    youtube_id: youtubeId,
    titulo: (snippet.title || '').slice(0, 500),
    thumbnail_url: snippet.thumbnails?.maxres?.url
      || snippet.thumbnails?.high?.url
      || snippet.thumbnails?.medium?.url
      || snippet.thumbnails?.default?.url || null,
    url: `https://youtube.com/shorts/${youtubeId}`,
    canal_id: snippet.channelId || null,
    canal_nome: snippet.channelTitle || null,
    views, likes, comentarios,
    duracao_segundos: duracao,
    taxa_engajamento: taxaEngajamento,
    nicho: nichoFinal,
    idioma: detectarIdioma(snippet),
    pais: detectarPais(snippet, regionCode),
    hashtags: extrairHashtags((snippet.description || '') + ' ' + (snippet.title || '')),
    tags: (snippet.tags || []).slice(0, 10),
    publicado_em: snippet.publishedAt || null,
    atualizado_em: new Date().toISOString(),
  };
}

async function salvarVideos(items, nicho, regionCode) {
  const rows = items.map(it => normalizarVideo(it, nicho, regionCode)).filter(Boolean);
  if (!rows.length) return { novos: 0, atualizados: 0 };
  // Pra saber quantos sao novos, consulta existentes em lote
  const ids = rows.map(r => r.youtube_id);
  const existentes = await supaSelect(
    `virais_banco?youtube_id=in.(${ids.map(encodeURIComponent).join(',')})&select=youtube_id`
  ) || [];
  const setExistentes = new Set(existentes.map(e => e.youtube_id));
  const novos = rows.filter(r => !setExistentes.has(r.youtube_id)).length;
  const atualizados = rows.length - novos;
  // Upsert em batch
  await supaUpsert('virais_banco', rows, 'youtube_id');
  return { novos, atualizados };
}

// ── ACTION: coletar-trending ───────────────────────────────────────────────
// Rotaciona entre paises pra diversificar o banco. Cada execucao processa
// 1 pais (rota via ultimo_pais salvo no log). Com crons a cada 2h, cada
// pais pega uma coleta a cada 6h aprox.
// Rotacao ponderada: cada entrada = ~9% das execucoes da trending.
// Distribuicao: BR=1 (~9%), US=2 (~18%), outros paises=1 cada (~9%).
// Internacional total ~91%. India (IN) propositalmente ausente.
const PAISES_TRENDING = [
  { code: 'BR', lang: 'pt-BR', relevance: 'pt' },
  { code: 'US', lang: 'en',    relevance: 'en' },
  { code: 'US', lang: 'en',    relevance: 'en' },
  { code: 'MX', lang: 'es',    relevance: 'es' },
  { code: 'AR', lang: 'es',    relevance: 'es' },
  { code: 'ES', lang: 'es',    relevance: 'es' },
  { code: 'GB', lang: 'en',    relevance: 'en' },
  { code: 'DE', lang: 'de',    relevance: 'de' },
  { code: 'FR', lang: 'fr',    relevance: 'fr' },
  { code: 'JP', lang: 'ja',    relevance: 'ja' },
  { code: 'KR', lang: 'ko',    relevance: 'ko' },
];

async function coletarTrending(res) {
  const inicio = Date.now();
  let novos = 0, atualizados = 0, cota = 0;

  // Escolhe o proximo pais (rotacao baseada no ultimo log de trending)
  const last = await supaSelect(
    `virais_coletas_log?tipo_busca=eq.trending&order=created_at.desc&limit=1&select=parametros`
  );
  const ultimoIdx = last?.[0]?.parametros?.pais_idx;
  const idx = (typeof ultimoIdx === 'number' ? (ultimoIdx + 1) : 0) % PAISES_TRENDING.length;
  const pais = PAISES_TRENDING[idx];

  try {
    // 1) Trending geral (Shorts saem junto — filtramos por duracao no normalizar)
    const trending = await youtubeRequest('videos', {
      part: 'snippet,statistics,contentDetails',
      chart: 'mostPopular',
      regionCode: pais.code,
      videoCategoryId: '0',
      maxResults: 50,
      hl: pais.lang,
    });
    cota += 1;

    // 2) Busca #shorts em alta nas ultimas 48h pro pais
    const shortsSearch = await youtubeRequest('search', {
      part: 'snippet',
      q: '#shorts',
      type: 'video',
      videoDuration: 'short',
      order: 'viewCount',
      regionCode: pais.code,
      relevanceLanguage: pais.relevance,
      maxResults: 50,
      publishedAfter: new Date(Date.now() - 48 * 3600000).toISOString(),
    });
    cota += 100;

    const shortsIds = (shortsSearch.items || []).map(v => v.id?.videoId).filter(Boolean);

    // 3) Detalhes completos dos shorts encontrados
    let shortsDetalhes = { items: [] };
    if (shortsIds.length) {
      shortsDetalhes = await youtubeRequest('videos', {
        part: 'snippet,statistics,contentDetails',
        id: shortsIds.join(','),
      });
      cota += 1;
    }

    const todos = [...(trending.items || []), ...(shortsDetalhes.items || [])];
    const r = await salvarVideos(todos, null, pais.code);
    novos = r.novos; atualizados = r.atualizados;

    // Expansao automatica: se a coleta trouxe virais bombados de um canal
    // que ainda nao expandimos, roda 1 expansion inline (so pra BR pra nao
    // encher banco com conteudo LatAm dificil de replicar).
    if (pais.code === 'BR' && novos > 0) {
      try {
        const expR = await expandirCanaisInterno(1);
        if (expR?.canais_processados > 0) {
          novos += expR.novos || 0;
          atualizados += expR.atualizados || 0;
          cota += expR.cota_gasta || 0;
        }
      } catch (e) { console.error('[trending -> expandir]:', e.message); }
    }

    await logColeta('trending',
      { pais: pais.code, pais_idx: idx },
      novos, atualizados, cota, Date.now() - inicio);
    return res.status(200).json({ ok: true, pais: pais.code, novos, atualizados, cota });
  } catch (e) {
    await logColeta('trending',
      { pais: pais.code, pais_idx: idx },
      novos, atualizados, cota, Date.now() - inicio, e.message);
    throw e;
  }
}

// ── ACTION: coletar-nichos ─────────────────────────────────────────────────
// Nichos atuais — 7 categorias alinhadas com taxonomia YouTube oficial.
// categoryIds = IDs oficiais do YouTube (quota barata: chart=mostPopular
// custa 1 unidade em vez de 100 do search). Se nicho nao tem categoryId
// nativo (ex: "curiosidades"), cai em search terms.
const NICHOS = [
  {
    nome: 'curiosidades',
    // Incorporou Entertainment (24), Film (1), Comedy (23) — tudo que e
    // conteudo de entretenimento viral/curioso cai aqui.
    categoryIds: ['24', '1', '23'],
    termos: ['curiosidades', 'voce sabia', 'fatos interessantes', 'viral brasil'],
  },
  {
    nome: 'games',
    categoryIds: ['20'], // Gaming
    termos: ['gameplay', 'free fire', 'minecraft brasil', 'gaming'],
  },
  {
    nome: 'ia',
    categoryIds: ['28'], // Science & Technology
    termos: ['inteligencia artificial', 'chatgpt', 'ai tools', 'ia brasil'],
  },
  {
    nome: 'animais',
    categoryIds: ['15'], // Pets & Animals
    termos: ['cachorro', 'gato', 'pet brasil', 'animal fofo'],
  },
  {
    nome: 'artistas',
    categoryIds: ['10'], // Music
    termos: ['show brasil', 'famoso', 'artista brasileiro', 'ao vivo'],
  },
  {
    nome: 'pessoas_blogs',
    categoryIds: ['22'], // People & Blogs
    termos: ['dia na vida', 'rotina', 'vlog brasil', 'pov'],
  },
];

async function coletarPorNichos(res) {
  const inicio = Date.now();
  let totalNovos = 0, totalAtualizados = 0, cota = 0;

  // Rotaciona pela lista — 3 nichos por execucao (cobre todos em ~3 execucoes)
  const last = await supaSelect(
    `virais_coletas_log?tipo_busca=eq.nicho&order=created_at.desc&limit=1&select=parametros`
  );
  const ultimoIndice = last?.[0]?.parametros?.ultimo_indice ?? -1;
  const inicioIndice = (ultimoIndice + 1) % NICHOS.length;
  const nichosAgora = [
    NICHOS[inicioIndice],
    NICHOS[(inicioIndice + 1) % NICHOS.length],
    NICHOS[(inicioIndice + 2) % NICHOS.length],
  ];

  for (const nicho of nichosAgora) {
    // Estrategia hibrida: categoryIds (barato, 1 unidade) + 1 termo search (backup)
    const ids = new Set();

    // 1) Chart=mostPopular por categoria (1 unidade cada, ate 50 videos)
    for (const catId of (nicho.categoryIds || [])) {
      try {
        const chartRes = await youtubeRequest('videos', {
          part: 'snippet,statistics,contentDetails',
          chart: 'mostPopular',
          regionCode: 'BR',
          videoCategoryId: catId,
          maxResults: 50,
          hl: 'pt',
        });
        cota += 1;
        const items = chartRes.items || [];
        const r = await salvarVideos(items, nicho.nome, 'BR');
        totalNovos += r.novos;
        totalAtualizados += r.atualizados;
        items.forEach(v => ids.add(v.id));
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        console.error(`[virais-coletor] nicho ${nicho.nome}/cat${catId}:`, e.message);
      }
    }

    // 2) Search-based (1 termo) — complementa com videos que chart perdeu
    //    Usado sempre pra "curiosidades" e como descoberta auxiliar nos demais
    const termosAlvo = nicho.categoryIds?.length ? nicho.termos.slice(0, 1) : nicho.termos.slice(0, 2);
    for (const termo of termosAlvo) {
      try {
        const search = await youtubeRequest('search', {
          part: 'snippet',
          q: `${termo} #shorts`,
          type: 'video',
          videoDuration: 'short',
          order: 'viewCount',
          regionCode: 'BR',
          relevanceLanguage: 'pt',
          maxResults: 25,
          publishedAfter: new Date(Date.now() - 72 * 3600000).toISOString(),
        });
        cota += 100;

        const searchIds = (search.items || []).map(v => v.id?.videoId).filter(Boolean).filter(id => !ids.has(id));
        if (!searchIds.length) continue;

        const detalhes = await youtubeRequest('videos', {
          part: 'snippet,statistics,contentDetails',
          id: searchIds.join(','),
        });
        cota += 1;

        const r = await salvarVideos(detalhes.items || [], nicho.nome, 'BR');
        totalNovos += r.novos;
        totalAtualizados += r.atualizados;

        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        console.error(`[virais-coletor] nicho ${nicho.nome}/${termo}:`, e.message);
      }
    }
  }

  const ultimoIndiceProcessado = (inicioIndice + 2) % NICHOS.length;
  await logColeta('nicho', { ultimo_indice: ultimoIndiceProcessado, nichos: nichosAgora.map(n => n.nome) },
    totalNovos, totalAtualizados, cota, Date.now() - inicio);

  return res.status(200).json({
    ok: true,
    nichos_processados: nichosAgora.map(n => n.nome),
    novos: totalNovos,
    atualizados: totalAtualizados,
    cota,
  });
}

// ── ACTION: atualizar-metricas ─────────────────────────────────────────────
async function atualizarMetricas(res) {
  const inicio = Date.now();
  // Refresh inteligente — 3 buckets paralelos (maximo 200 videos / 4 unidades YouTube):
  //   A) Top 100 por velocidade_views_24h (ultima semana) — semi-virais crescendo
  //   B) Top 50 coletados nas ultimas 48h (padrao antigo — recentes quentes)
  //   C) Top 50 evergreens >7d com views altas (nao deixa stale)
  const umaSemana = new Date(Date.now() - 7 * 86400000).toISOString();
  const doisDias = new Date(Date.now() - 48 * 3600000).toISOString();
  const seteDias = new Date(Date.now() - 7 * 86400000).toISOString();

  const [bucketA, bucketB, bucketC] = await Promise.all([
    supaSelect(
      `virais_banco?ativo=eq.true&coletado_em=gte.${umaSemana}&velocidade_views_24h=gt.0&order=velocidade_views_24h.desc&limit=100&select=id,youtube_id,vezes_atualizado,nicho`
    ),
    supaSelect(
      `virais_banco?ativo=eq.true&coletado_em=gte.${doisDias}&order=views.desc&limit=50&select=id,youtube_id,vezes_atualizado,nicho`
    ),
    supaSelect(
      `virais_banco?ativo=eq.true&coletado_em=lt.${seteDias}&views=gte.50000&order=views.desc&limit=50&select=id,youtube_id,vezes_atualizado,nicho`
    ),
  ]);

  // Dedupe por id
  const seen = new Set();
  const rows = [];
  for (const bucket of [bucketA || [], bucketB || [], bucketC || []]) {
    for (const r of bucket) {
      if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
    }
  }
  if (!rows.length) return res.status(200).json({ ok: true, atualizados: 0 });

  // YouTube videos.list aceita max 50 IDs por request = 1 unidade. Pagina em grupos.
  const byId = {};
  let cotaGasta = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const ids = batch.map(r => r.youtube_id).join(',');
    try {
      const detalhes = await youtubeRequest('videos', { part: 'snippet,statistics', id: ids });
      cotaGasta += 1;
      (detalhes.items || []).forEach(v => { byId[v.id] = { stats: v.statistics || {}, snippet: v.snippet || {} }; });
    } catch (e) { console.error('[atualizar-metricas] batch', i, 'erro:', e.message); }
  }

  let atualizados = 0;
  for (const row of rows) {
    const info = byId[row.youtube_id];
    if (!info) continue;
    const st = info.stats;
    const views = Number(st.viewCount || 0);
    const likes = Number(st.likeCount || 0);
    const comentarios = Number(st.commentCount || 0);
    const taxa = views > 0 ? +(((likes + comentarios) / views) * 100).toFixed(4) : 0;
    const patch = {
      views, likes, comentarios,
      taxa_engajamento: taxa,
      atualizado_em: new Date().toISOString(),
      vezes_atualizado: (row.vezes_atualizado || 0) + 1,
    };
    // Auto-backfill de nicho se estiver null
    if (!row.nicho) {
      const nichoInferido = inferirNichoPorCategoria(info.snippet.categoryId);
      if (nichoInferido) patch.nicho = nichoInferido;
    }
    await supaPatch(`virais_banco?id=eq.${row.id}`, patch);
    atualizados++;
  }

  // Recalcula score dos atualizados (ML score_viralidade continua via virais-ml)
  await calcularScoresInterno(300);
  await logColeta('atualizar-metricas',
    { buckets: { velocidade: bucketA?.length || 0, recentes: bucketB?.length || 0, evergreens: bucketC?.length || 0 }, total_refresh: rows.length },
    0, atualizados, cotaGasta, Date.now() - inicio);
  return res.status(200).json({
    ok: true, atualizados, total_refresh: rows.length,
    buckets: { velocidade: bucketA?.length || 0, recentes: bucketB?.length || 0, evergreens: bucketC?.length || 0 },
    cota_gasta: cotaGasta,
  });
}

// ── ACTION: migrar-nicho ────────────────────────────────────────────────────
// Renomeia videos de um nicho pra outro em batch.
// Ex: GET /api/virais-coletor?action=migrar-nicho&de=entretenimento&para=curiosidades
async function migrarNicho(res, req) {
  const inicio = Date.now();
  const de = (req?.query?.de || '').toString().trim();
  const para = (req?.query?.para || '').toString().trim();
  if (!de || !para) return res.status(400).json({ error: 'params de + para obrigatorios' });
  if (de === para) return res.status(400).json({ error: 'de == para, nada pra migrar' });

  // Conta antes
  const antesR = await fetch(
    `${SU}/rest/v1/virais_banco?nicho=eq.${encodeURIComponent(de)}&select=id`,
    { headers: { ...HDR, Prefer: 'count=exact' } }
  );
  const antesTotal = parseInt(antesR.headers.get('content-range')?.split('/')[1] || '0', 10);

  // PATCH em massa via filtro
  const patchR = await fetch(
    `${SU}/rest/v1/virais_banco?nicho=eq.${encodeURIComponent(de)}`,
    {
      method: 'PATCH',
      headers: { ...HDR, Prefer: 'return=minimal' },
      body: JSON.stringify({ nicho: para, atualizado_em: new Date().toISOString() }),
    }
  );

  await logColeta('migrar-nicho', { de, para, total: antesTotal },
    0, antesTotal, 0, Date.now() - inicio, patchR.ok ? null : 'patch_failed');

  return res.status(200).json({
    ok: patchR.ok, action: 'migrar-nicho',
    de, para, atualizados: antesTotal,
    duracao_ms: Date.now() - inicio,
  });
}

// ── ACTION: expandir-canais (#2 Related + #3 Channel expansion) ────────────
// Quando achamos um viral bombado, o canal dele geralmente tem OUTROS
// Shorts bons. Em vez de depender so de trending, expandimos pra canal.
//
// Cada execucao:
// 1. Busca top 3 canais com virais novos (score > 70, ultimas 24h)
// 2. Filtra canais ja expandidos nos ultimos 7 dias (evita duplicar)
// 3. Pra cada canal: search?channelId=X&type=video&order=viewCount&maxResults=50
// 4. Salva videos novos (dedupe por youtube_id)
//
// Custo: 100 unidades por canal = 300 unidades por execucao (3 canais).
// Hit-rate: ~30-50% de videos novos por canal (criadores virais tem +conteudo).
async function expandirCanais(res, req) {
  const maxCanais = Math.min(parseInt(req?.query?.limit || 3), 5);
  const result = await expandirCanaisInterno(maxCanais);
  return res.status(200).json({ ok: true, action: 'expandir-canais', ...result });
}

async function expandirCanaisInterno(maxCanais = 3) {
  const inicio = Date.now();

  // 1) Top canais com virais novos
  const desde24h = new Date(Date.now() - 24 * 3600000).toISOString();
  const candidatos = await supaSelect(
    `virais_banco?ativo=eq.true&coletado_em=gte.${desde24h}&viral_score=gte.50&canal_id=not.is.null&order=viral_score.desc&limit=20&select=canal_id,canal_nome,viral_score`
  ) || [];

  // Agrega por canal (pega o maior score de cada)
  const canais = new Map();
  candidatos.forEach(v => {
    if (!v.canal_id) return;
    if (!canais.has(v.canal_id) || canais.get(v.canal_id).score < v.viral_score) {
      canais.set(v.canal_id, { canal_id: v.canal_id, canal_nome: v.canal_nome, score: v.viral_score });
    }
  });

  // 2) Filtra canais ja expandidos nos ultimos 7d
  const seteDiasAtras = new Date(Date.now() - 7 * 86400000).toISOString();
  const logsR = await supaSelect(
    `virais_coletas_log?tipo_busca=eq.canal-expansion&created_at=gte.${seteDiasAtras}&select=parametros&limit=50`
  ) || [];
  const jaExpandidos = new Set(logsR.map(l => l.parametros?.canal_id).filter(Boolean));
  const paraExpandir = [...canais.values()]
    .filter(c => !jaExpandidos.has(c.canal_id))
    .slice(0, maxCanais);

  if (!paraExpandir.length) {
    return { motivo: 'sem_canais_novos', canais_processados: 0, novos: 0, atualizados: 0, cota_gasta: 0 };
  }

  let totalNovos = 0, totalAtualizados = 0, cota = 0, canaisOK = 0;
  for (const canal of paraExpandir) {
    try {
      const search = await youtubeRequest('search', {
        part: 'snippet',
        channelId: canal.canal_id,
        type: 'video',
        videoDuration: 'short',
        order: 'viewCount',
        maxResults: 50,
      });
      cota += 100;

      const ids = (search.items || []).map(v => v.id?.videoId).filter(Boolean);
      if (!ids.length) continue;

      // 50 IDs de uma vez = 1 unidade
      const detalhes = await youtubeRequest('videos', {
        part: 'snippet,statistics,contentDetails',
        id: ids.join(','),
      });
      cota += 1;

      const r = await salvarVideos(detalhes.items || [], null, 'BR');
      totalNovos += r.novos;
      totalAtualizados += r.atualizados;
      canaisOK++;

      // Log individual pra evitar re-expandir mesmo canal
      await logColeta('canal-expansion', { canal_id: canal.canal_id, canal_nome: canal.canal_nome, encontrados: ids.length },
        r.novos, r.atualizados, 101, 0);

      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      console.error(`[expandir-canais] ${canal.canal_nome}:`, e.message);
    }
  }

  await logColeta('expandir-canais-resumo',
    { canais_processados: canaisOK, canais_alvo: paraExpandir.length },
    totalNovos, totalAtualizados, cota, Date.now() - inicio);

  return {
    canais_processados: canaisOK,
    canais_alvo: paraExpandir.length,
    novos: totalNovos, atualizados: totalAtualizados,
    cota_gasta: cota,
    duracao_ms: Date.now() - inicio,
  };
}

// ── ACTION: backfill-nichos ─────────────────────────────────────────────────
// Pega videos com nicho=null e infere via YouTube API (50 per batch = 1 unit)
// Chamada manual pelo admin ou trigger pontual. Seguro pra rodar varias vezes.
async function backfillNichos(res, req) {
  const inicio = Date.now();
  const limite = Math.min(parseInt(req?.query?.limit || 50), 50); // max 50 = 1 unit

  const rows = await supaSelect(
    `virais_banco?nicho=is.null&ativo=eq.true&order=coletado_em.desc&limit=${limite}&select=id,youtube_id`
  ) || [];
  if (!rows.length) return res.status(200).json({ ok: true, atualizados: 0, motivo: 'todos_com_nicho' });

  const ids = rows.map(r => r.youtube_id).filter(Boolean).join(',');
  const detalhes = await youtubeRequest('videos', { part: 'snippet', id: ids });
  const byId = {};
  (detalhes.items || []).forEach(v => { byId[v.id] = v.snippet?.categoryId; });

  let atualizados = 0, ignorados = 0;
  for (const row of rows) {
    const catId = byId[row.youtube_id];
    const nichoInferido = inferirNichoPorCategoria(catId);
    if (!nichoInferido) { ignorados++; continue; }
    await supaPatch(`virais_banco?id=eq.${row.id}`, { nicho: nichoInferido });
    atualizados++;
  }

  await logColeta('backfill-nichos', { limite }, 0, atualizados, 1, Date.now() - inicio);
  return res.status(200).json({
    ok: true, action: 'backfill-nichos',
    processados: rows.length, atualizados, ignorados,
    duracao_ms: Date.now() - inicio,
  });
}

// ── ACTION: calcular-scores ────────────────────────────────────────────────
async function calcularScores(res) {
  const inicio = Date.now();
  const atualizados = await calcularScoresInterno(500);
  await logColeta('calcular-scores', {}, 0, atualizados, 0, Date.now() - inicio);
  return res.status(200).json({ ok: true, atualizados });
}

async function calcularScoresInterno(limite) {
  const videos = await supaSelect(
    `virais_banco?order=coletado_em.desc&limit=${limite || 500}&select=id,views,likes,comentarios,publicado_em,canal_inscritos`
  ) || [];
  let count = 0;
  for (const v of videos) {
    const horas = v.publicado_em ? Math.max(1, (Date.now() - new Date(v.publicado_em).getTime()) / 3600000) : 24;
    const velocidade = (Number(v.views) || 0) / horas;
    const taxa = (Number(v.views) || 0) > 0 ? ((Number(v.likes) + Number(v.comentarios)) / Number(v.views)) * 100 : 0;
    const ratioViralidade = (Number(v.canal_inscritos) || 0) > 0 ? (Number(v.views) / Number(v.canal_inscritos)) : 1;

    let score = 0;
    score += Math.min(velocidade / 1000, 40);
    score += Math.min(taxa * 2, 30);
    score += Math.min(ratioViralidade * 5, 20);
    if (horas < 6) score += 10;
    else if (horas < 24) score += 5;

    await supaPatch(`virais_banco?id=eq.${v.id}`, {
      velocidade_views: +velocidade.toFixed(2),
      viral_score: +Math.min(score, 100).toFixed(2),
    });
    count++;
  }
  return count;
}

// ── ACTION: status ─────────────────────────────────────────────────────────
async function statusBanco(res) {
  const countHeaders = { ...HDR, Prefer: 'count=exact', Range: '0-0' };

  async function count(path) {
    const r = await fetch(`${SU}/rest/v1/${path}`, { headers: countHeaders });
    if (!r.ok) return 0;
    const cr = r.headers.get('content-range') || '';
    const m = cr.match(/\/(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  }

  const totalVideos = await count('virais_banco?select=id');
  const adicionadosHoje = await count(`virais_banco?select=id&coletado_em=gte.${new Date(Date.now() - 86400000).toISOString()}`);

  // Por nicho
  const porNicho = await supaSelect('virais_banco?nicho=not.is.null&select=nicho&limit=10000') || [];
  const nichoCount = {};
  porNicho.forEach(v => { if (v.nicho) nichoCount[v.nicho] = (nichoCount[v.nicho] || 0) + 1; });

  // Ultimas coletas
  const coletas = await supaSelect('virais_coletas_log?order=created_at.desc&limit=10&select=*') || [];

  return res.status(200).json({
    total_videos: totalVideos,
    adicionados_hoje: adicionadosHoje,
    por_nicho: nichoCount,
    ultimas_coletas: coletas,
  });
}
