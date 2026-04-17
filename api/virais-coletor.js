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
function normalizarVideo(item, nicho) {
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
    nicho: nicho || null,
    idioma: detectarIdioma(snippet),
    pais: 'BR',
    hashtags: extrairHashtags((snippet.description || '') + ' ' + (snippet.title || '')),
    tags: (snippet.tags || []).slice(0, 10),
    publicado_em: snippet.publishedAt || null,
    atualizado_em: new Date().toISOString(),
  };
}

async function salvarVideos(items, nicho) {
  const rows = items.map(it => normalizarVideo(it, nicho)).filter(Boolean);
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
async function coletarTrending(res) {
  const inicio = Date.now();
  let novos = 0, atualizados = 0, cota = 0;

  try {
    // 1) Trending geral BR (Shorts saem junto — filtramos por duracao no normalizar)
    const trending = await youtubeRequest('videos', {
      part: 'snippet,statistics,contentDetails',
      chart: 'mostPopular',
      regionCode: 'BR',
      videoCategoryId: '0',
      maxResults: 50,
      hl: 'pt-BR',
    });
    cota += 1; // videos.list?chart=mostPopular = 1 unit

    // 2) Busca #shorts em alta ultimas 48h
    const shortsSearch = await youtubeRequest('search', {
      part: 'snippet',
      q: '#shorts',
      type: 'video',
      videoDuration: 'short',
      order: 'viewCount',
      regionCode: 'BR',
      relevanceLanguage: 'pt',
      maxResults: 50,
      publishedAfter: new Date(Date.now() - 48 * 3600000).toISOString(),
    });
    cota += 100; // search = 100

    const shortsIds = (shortsSearch.items || []).map(v => v.id?.videoId).filter(Boolean);

    // 3) Busca detalhes completos dos shorts
    let shortsDetalhes = { items: [] };
    if (shortsIds.length) {
      shortsDetalhes = await youtubeRequest('videos', {
        part: 'snippet,statistics,contentDetails',
        id: shortsIds.join(','),
      });
      cota += 1;
    }

    const todos = [...(trending.items || []), ...(shortsDetalhes.items || [])];
    const r = await salvarVideos(todos, null);
    novos = r.novos; atualizados = r.atualizados;

    await logColeta('trending', {}, novos, atualizados, cota, Date.now() - inicio);
    return res.status(200).json({ ok: true, novos, atualizados, cota });
  } catch (e) {
    await logColeta('trending', {}, novos, atualizados, cota, Date.now() - inicio, e.message);
    throw e;
  }
}

// ── ACTION: coletar-nichos ─────────────────────────────────────────────────
const NICHOS = [
  { nome: 'humor',      termos: ['humor',       'engracado',           'comedia',          'meme brasil'] },
  { nome: 'culinaria',  termos: ['receita facil','culinaria brasileira','comida caseira',  'sobremesa'] },
  { nome: 'fitness',    termos: ['treino',      'academia',            'fitness brasil',   'musculacao'] },
  { nome: 'financas',   termos: ['investimento','renda extra',         'ganhar dinheiro',  'bitcoin'] },
  { nome: 'educacao',   termos: ['aprender',    'dica',                'como fazer',       'tutorial'] },
  { nome: 'beleza',     termos: ['maquiagem',   'skincare',            'cabelo',           'beleza'] },
  { nome: 'games',      termos: ['gameplay',    'free fire',           'minecraft brasil', 'gaming'] },
  { nome: 'musica',     termos: ['funk brasil', 'sertanejo',           'pagode',           'mpb'] },
  { nome: 'esportes',   termos: ['futebol',     'gol',                 'fut brasil',       'treino futebol'] },
  { nome: 'tecnologia', termos: ['celular',     'tech brasil',         'review',           'unboxing'] },
  { nome: 'viagens',    termos: ['viagem brasil','turismo',            'vlog viagem',      'praia brasil'] },
  { nome: 'pets',       termos: ['cachorro',    'gato',                'pet brasil',       'animal fofo'] },
];

async function coletarPorNichos(res) {
  const inicio = Date.now();
  let totalNovos = 0, totalAtualizados = 0, cota = 0;

  // Busca o ultimo indice processado pra rotacionar
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
    // 2 termos por nicho por execucao
    for (const termo of nicho.termos.slice(0, 2)) {
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

        const ids = (search.items || []).map(v => v.id?.videoId).filter(Boolean);
        if (!ids.length) continue;

        const detalhes = await youtubeRequest('videos', {
          part: 'snippet,statistics,contentDetails',
          id: ids.join(','),
        });
        cota += 1;

        const r = await salvarVideos(detalhes.items || [], nicho.nome);
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
  // Pega os top videos das ultimas 48h pra refresh
  const rows = await supaSelect(
    `virais_banco?coletado_em=gte.${new Date(Date.now() - 48*3600000).toISOString()}&order=views.desc&limit=50&select=id,youtube_id,vezes_atualizado`
  ) || [];
  if (!rows.length) return res.status(200).json({ ok: true, atualizados: 0 });

  const ids = rows.map(r => r.youtube_id).join(',');
  const detalhes = await youtubeRequest('videos', { part: 'statistics', id: ids });
  const byId = {};
  (detalhes.items || []).forEach(v => { byId[v.id] = v.statistics || {}; });

  let atualizados = 0;
  for (const row of rows) {
    const st = byId[row.youtube_id];
    if (!st) continue;
    const views = Number(st.viewCount || 0);
    const likes = Number(st.likeCount || 0);
    const comentarios = Number(st.commentCount || 0);
    const taxa = views > 0 ? +(((likes + comentarios) / views) * 100).toFixed(4) : 0;
    await supaPatch(`virais_banco?id=eq.${row.id}`, {
      views, likes, comentarios,
      taxa_engajamento: taxa,
      atualizado_em: new Date().toISOString(),
      vezes_atualizado: (row.vezes_atualizado || 0) + 1,
    });
    atualizados++;
  }

  // Recalcula score dos atualizados
  await calcularScoresInterno(200);
  await logColeta('atualizar-metricas', {}, 0, atualizados, 1, Date.now() - inicio);
  return res.status(200).json({ ok: true, atualizados });
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
