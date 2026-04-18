// api/virais-ml.js
// Pipeline de ML para virais_banco. Enriquece com features, clusteriza por
// formato/tema, detecta emergentes, prediz viralidade e valida o modelo.
//
// Filosofia: ZERO dependencias externas de ML. Tudo roda em JS puro dentro da
// Vercel serverless. NLP via regex + TF-IDF, clustering via K-means em JS.
// Claude Haiku eh usado apenas opcionalmente pra nomear clusters.

const CONFIG = {
  BATCH_SIZE_VELOCIDADES: 500,
  BATCH_SIZE_SCORES: 1000,
  BATCH_SIZE_TITULOS: 500,
  CLUSTER_SAMPLE_SIZE: 1500,       // top N virais pra clusterizar
  K_FORMATOS: 8,                    // nro de clusters K-means formatos
  MIN_CLUSTER_SIZE: 5,              // minimo de videos por cluster tema
  EMERGENTE_CRESCIMENTO_PCT: 200,   // % crescimento pra flagar emergente
  EMERGENTE_MAX_VIDEOS: 30,
  SATURANDO_MIN_VIDEOS: 100,
  PESOS_DEFAULT: {
    velocidade_24h: 0.40,
    ratio_like: 0.25,
    ratio_comment: 0.20,
    aceleracao: 0.15,
  },
};

// Stop words PT-BR + EN
const STOP_WORDS = new Set([
  'a','o','as','os','de','da','do','das','dos','em','no','na','nos','nas',
  'um','uma','uns','umas','e','é','são','foi','ser','ter','tem','com','para',
  'por','que','se','ou','mas','não','sim','eu','você','meu','minha','seu',
  'sua','isso','este','esta','ele','ela','eles','elas','mais','menos','como',
  'quando','onde','qual','quais','muito','muita','pouco','pouca','todo','toda',
  'the','and','or','of','in','on','at','to','an','is','are','was','were',
  'ao','aos','às','até','pelo','pela','pelos','pelas','sobre','entre','sem',
]);

// Palavras-gatilho que aparecem em viraux
const PALAVRAS_GATILHO = new Set([
  'segredo','truque','impressionante','chocante','insano','louco','melhor',
  'pior','revelado','descubra','descobri','nunca','sempre','antes','depois',
  'transformacao','transformação','mudanca','mudança','revelacao','revelação',
  'exclusivo','incrivel','incrível','inacreditavel','inacreditável','viral',
  'vira','virando','viralizou','perfeito','errado','certo','proibido',
  'escondido','oculto','verdade','mentira','fatos','surpreendente',
]);

const EMOJI_REGEX_G = /\p{Extended_Pictographic}/gu; // pra match()
const EMOJI_REGEX_FIRST = /^\p{Extended_Pictographic}/u; // pra test() sem state

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });
  const h = { apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json' };

  const action = req.query.action;
  const ctx = { SU, SK, AK, h };

  try {
    if (action === 'enriquecer-velocidades') return res.status(200).json(await enriquecerVelocidades(ctx, req));
    if (action === 'calcular-scores')        return res.status(200).json(await calcularScores(ctx, req));
    if (action === 'analisar-titulos')       return res.status(200).json(await analisarTitulos(ctx, req));
    if (action === 'clusterizar-formatos')   return res.status(200).json(await clusterizarFormatos(ctx));
    if (action === 'clusterizar-temas')      return res.status(200).json(await clusterizarTemas(ctx));
    if (action === 'detectar-emergentes-ml') return res.status(200).json(await detectarEmergentesML(ctx));
    if (action === 'predizer-viralidade')    return res.status(200).json(await predizerViralidade(ctx, req));
    if (action === 'insights-para-usuario')  return res.status(200).json(await insightsParaUsuario(ctx, req));
    if (action === 'validar-predicoes')      return res.status(200).json(await validarPredicoes(ctx));
    if (action === 'status')                 return res.status(200).json(await statusModelo(ctx));
    if (action === 'pipeline-diario')        return res.status(200).json(await pipelineDiario(ctx));
    return res.status(400).json({ error: 'action invalida', valid: [
      'enriquecer-velocidades','calcular-scores','analisar-titulos',
      'clusterizar-formatos','clusterizar-temas','detectar-emergentes-ml',
      'predizer-viralidade','insights-para-usuario','validar-predicoes','status'
    ]});
  } catch (e) {
    console.error(`[virais-ml ${action}] erro:`, e.message, e.stack?.slice(0, 300));
    return res.status(500).json({ error: e.message, action });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// 1) ENRIQUECER VELOCIDADES
// Calcula velocidade_views por intervalo + aceleracao + ratios + dia/hora
// ═════════════════════════════════════════════════════════════════════════════
async function enriquecerVelocidades(ctx, req) {
  const limit = Math.min(parseInt(req.query.limit || CONFIG.BATCH_SIZE_VELOCIDADES), 2000);
  // Pega videos com publicado_em recente OU velocidades ainda zeradas
  const r = await fetch(
    `${ctx.SU}/rest/v1/virais_banco?ativo=eq.true&order=coletado_em.desc&limit=${limit}&select=id,views,likes,comentarios,publicado_em,coletado_em,velocidade_views_24h`,
    { headers: ctx.h }
  );
  if (!r.ok) throw new Error(`read failed: ${r.status}`);
  const videos = await r.json();

  let atualizados = 0;
  for (const v of videos) {
    if (!v.publicado_em) continue;
    const publicado = new Date(v.publicado_em);
    const agora = new Date();
    const horasDesdePost = Math.max(1, (agora - publicado) / 3600000);

    const views = parseFloat(v.views) || 0;
    const likes = parseFloat(v.likes) || 0;
    const comms = parseFloat(v.comentarios) || 0;

    // Velocidades por janela — proxy: views/hora vezes janela
    const viewsPorHora = views / horasDesdePost;
    const vel6h  = parseFloat((viewsPorHora * 6).toFixed(2));
    const vel24h = parseFloat((viewsPorHora * 24).toFixed(2));
    const vel48h = parseFloat((viewsPorHora * 48).toFixed(2));

    // Aceleracao: quanto mais recente o post, mais peso pro fato de ter crescido rapido
    // Proxy: views/horas². Normaliza dividindo por 1000 pra escala amigavel.
    const aceleracao = parseFloat((views / (horasDesdePost * horasDesdePost) / 1000).toFixed(4));

    const ratioLike = views > 0 ? parseFloat((likes / views).toFixed(6)) : 0;
    const ratioComm = views > 0 ? parseFloat((comms / views).toFixed(6)) : 0;

    const diaSemana = publicado.getUTCDay(); // 0-6
    const horaDia = publicado.getUTCHours();

    await fetch(`${ctx.SU}/rest/v1/virais_banco?id=eq.${v.id}`, {
      method: 'PATCH', headers: { ...ctx.h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        velocidade_views_6h: vel6h,
        velocidade_views_24h: vel24h,
        velocidade_views_48h: vel48h,
        aceleracao,
        ratio_like_view: ratioLike,
        ratio_comment_view: ratioComm,
        dia_da_semana_post: diaSemana,
        hora_do_dia_post: horaDia,
      }),
    });
    atualizados++;
  }

  return { ok: true, action: 'enriquecer-velocidades', processados: videos.length, atualizados };
}

// ═════════════════════════════════════════════════════════════════════════════
// 2) CALCULAR SCORE_VIRALIDADE
// Normaliza features (max por nicho) e aplica pesos ponderados
// ═════════════════════════════════════════════════════════════════════════════
async function calcularScores(ctx, req) {
  const limit = Math.min(parseInt(req.query.limit || CONFIG.BATCH_SIZE_SCORES), 5000);
  // Pega videos recentes (ultima semana) com features preenchidas
  const desde = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const r = await fetch(
    `${ctx.SU}/rest/v1/virais_banco?ativo=eq.true&coletado_em=gte.${desde}&order=coletado_em.desc&limit=${limit}&select=id,nicho,velocidade_views_24h,ratio_like_view,ratio_comment_view,aceleracao,views`,
    { headers: ctx.h }
  );
  if (!r.ok) throw new Error(`read failed: ${r.status}`);
  const videos = await r.json();
  if (videos.length === 0) return { ok: true, action: 'calcular-scores', atualizados: 0 };

  // Agrupa por nicho pra normalizar dentro do nicho (compara laranja com laranja)
  const porNicho = new Map();
  videos.forEach(v => {
    const n = v.nicho || 'geral';
    if (!porNicho.has(n)) porNicho.set(n, []);
    porNicho.get(n).push(v);
  });

  const pesos = CONFIG.PESOS_DEFAULT;
  let atualizados = 0;
  const viralizouUpdates = [];

  for (const [nicho, lista] of porNicho.entries()) {
    // Maximos por feature (pra normalizar 0-100)
    const max = {
      vel: Math.max(...lista.map(v => parseFloat(v.velocidade_views_24h) || 0), 1),
      like: Math.max(...lista.map(v => parseFloat(v.ratio_like_view) || 0), 0.001),
      comm: Math.max(...lista.map(v => parseFloat(v.ratio_comment_view) || 0), 0.0001),
      accel: Math.max(...lista.map(v => parseFloat(v.aceleracao) || 0), 1),
      views: Math.max(...lista.map(v => parseFloat(v.views) || 0), 1),
    };
    // Percentil 90 de views (label pra viralizou)
    const viewsSorted = lista.map(v => parseFloat(v.views) || 0).sort((a, b) => a - b);
    const p90 = viewsSorted[Math.floor(viewsSorted.length * 0.9)] || 0;

    for (const v of lista) {
      const normVel  = Math.min(1, (parseFloat(v.velocidade_views_24h) || 0) / max.vel);
      const normLike = Math.min(1, (parseFloat(v.ratio_like_view) || 0) / max.like);
      const normComm = Math.min(1, (parseFloat(v.ratio_comment_view) || 0) / max.comm);
      const normAccel= Math.min(1, (parseFloat(v.aceleracao) || 0) / max.accel);

      const score = 100 * (
        normVel * pesos.velocidade_24h +
        normLike * pesos.ratio_like +
        normComm * pesos.ratio_comment +
        normAccel * pesos.aceleracao
      );
      const scoreRounded = parseFloat(score.toFixed(2));
      const viralizou = (parseFloat(v.views) || 0) >= p90 && p90 > 0;

      await fetch(`${ctx.SU}/rest/v1/virais_banco?id=eq.${v.id}`, {
        method: 'PATCH', headers: { ...ctx.h, Prefer: 'return=minimal' },
        body: JSON.stringify({ score_viralidade: scoreRounded, viralizou }),
      });
      atualizados++;
    }
  }

  return { ok: true, action: 'calcular-scores', nichos_processados: porNicho.size, atualizados };
}

// ═════════════════════════════════════════════════════════════════════════════
// 3) ANALISAR TITULOS — features NLP extraidas via regex
// ═════════════════════════════════════════════════════════════════════════════
async function analisarTitulos(ctx, req) {
  const limit = Math.min(parseInt(req.query.limit || CONFIG.BATCH_SIZE_TITULOS), 3000);
  // Pega videos sem titulo_features preenchido. Usa check em uma chave
  // especifica — se 'tipo_hook' existe, ja foi analisado.
  const r = await fetch(
    `${ctx.SU}/rest/v1/virais_banco?titulo_features->>tipo_hook=is.null&ativo=eq.true&order=coletado_em.desc&limit=${limit}&select=id,titulo`,
    { headers: ctx.h }
  );
  if (!r.ok) {
    // Fallback: pega os mais recentes e processa (idempotente)
    const r2 = await fetch(
      `${ctx.SU}/rest/v1/virais_banco?ativo=eq.true&order=coletado_em.desc&limit=${limit}&select=id,titulo`,
      { headers: ctx.h }
    );
    if (!r2.ok) throw new Error(`read failed: ${r2.status}`);
    const videos = await r2.json();
    return processTitulos(ctx, videos);
  }
  const videos = await r.json();
  return processTitulos(ctx, videos);
}

async function processTitulos(ctx, videos) {
  let atualizados = 0;
  for (const v of videos) {
    const feats = extractTituloFeatures(v.titulo);
    await fetch(`${ctx.SU}/rest/v1/virais_banco?id=eq.${v.id}`, {
      method: 'PATCH', headers: { ...ctx.h, Prefer: 'return=minimal' },
      body: JSON.stringify({ titulo_features: feats }),
    });
    atualizados++;
  }
  return { ok: true, action: 'analisar-titulos', atualizados };
}

function extractTituloFeatures(titulo) {
  if (!titulo) return {};
  const t = titulo.trim();
  const tLower = t.toLowerCase();
  const palavras = t.split(/\s+/).filter(Boolean);
  const emojis = (t.match(EMOJI_REGEX_G) || []);
  const tokens = tokenizar(t);

  // Palavras-gatilho que aparecem no titulo
  const gatilhos = [...new Set(tokens.filter(w => PALAVRAS_GATILHO.has(w.toLowerCase())))];

  // Sentimento heuristico (simples mas util)
  const positivas = new Set(['melhor','incrivel','incrível','otimo','ótimo','perfeito','amor','amei','feliz','sucesso','ganhei','consegui','fácil','fácil','rapido','rápido','descubra','aprenda','dica']);
  const negativas = new Set(['pior','ruim','errado','odio','ódio','triste','fracasso','perdi','dificil','difícil','impossivel','impossível','chocante','absurdo','proibido']);
  let pos = 0, neg = 0;
  tokens.forEach(w => {
    if (positivas.has(w)) pos++;
    if (negativas.has(w)) neg++;
  });
  const sentimento = pos > neg ? 'positivo' : neg > pos ? 'negativo' : 'neutro';

  // Tipo de hook
  let tipo_hook = 'afirmacao';
  if (/^\s*\d/.test(t)) tipo_hook = 'numero';
  else if (t.includes('?')) tipo_hook = 'pergunta';
  else if (gatilhos.length > 0) tipo_hook = 'curiosidade';

  // Detecta CAPS (words inteiras em maiúsculo)
  const capsWords = palavras.filter(w => {
    const letras = w.replace(/[^a-zA-ZÀ-ÿ]/g, '');
    return letras.length >= 3 && letras === letras.toUpperCase();
  }).length;

  return {
    tem_numero: /\d/.test(t),
    comeca_com_numero: /^\d/.test(t),
    tem_pergunta: t.includes('?'),
    tem_exclamacao: t.includes('!'),
    tem_reticencias: /\.{3}|…/.test(t),
    emojis: emojis.slice(0, 10),
    emojis_count: emojis.length,
    comeca_com_emoji: EMOJI_REGEX_FIRST.test(t),
    palavras_gatilho: gatilhos,
    sentimento,
    tipo_hook,
    tamanho_palavras: palavras.length,
    tamanho_caracteres: t.length,
    caps_words: capsWords,
    tem_parenteses: /\(.+?\)/.test(t),
    tem_bracket: /\[.+?\]/.test(t),
    tokens_significativos: tokens.slice(0, 20),
  };
}

function tokenizar(s) {
  if (!s) return [];
  return s.toLowerCase()
    .replace(/[^\w\sáàâãéêíóôõúçñü]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

// ═════════════════════════════════════════════════════════════════════════════
// 4) CLUSTERIZAR FORMATOS (K-means sobre features numericas)
// ═════════════════════════════════════════════════════════════════════════════
async function clusterizarFormatos(ctx) {
  // Pega top virais por score (limit adaptativo — usa todos se amostra pequena)
  const r = await fetch(
    `${ctx.SU}/rest/v1/virais_banco?ativo=eq.true&order=score_viralidade.desc&limit=${CONFIG.CLUSTER_SAMPLE_SIZE}&select=id,duracao_segundos,ratio_like_view,ratio_comment_view,hora_do_dia_post,dia_da_semana_post,nicho,titulo,score_viralidade`,
    { headers: ctx.h }
  );
  if (!r.ok) throw new Error(`read failed: ${r.status}`);
  const videos = await r.json();
  if (videos.length < CONFIG.MIN_CLUSTER_SIZE) {
    return { ok: true, action: 'clusterizar-formatos', clusters: 0, motivo: 'amostra insuficiente' };
  }

  // Constroi matriz de features normalizadas
  const feat = videos.map(v => [
    (parseInt(v.duracao_segundos) || 30) / 60,           // minutos
    (parseFloat(v.ratio_like_view) || 0) * 1000,
    (parseFloat(v.ratio_comment_view) || 0) * 10000,
    (parseInt(v.hora_do_dia_post) || 12) / 23,           // normalizado 0-1
    (parseInt(v.dia_da_semana_post) || 0) / 6,
  ]);

  // K-means
  const k = Math.min(CONFIG.K_FORMATOS, Math.floor(videos.length / CONFIG.MIN_CLUSTER_SIZE));
  const { labels, centroids } = kMeans(feat, k, 20);

  // Desativa clusters antigos
  await fetch(`${ctx.SU}/rest/v1/virais_clusters?tipo=eq.formato`, {
    method: 'PATCH', headers: ctx.h,
    body: JSON.stringify({ ativo: false, updated_at: new Date().toISOString() }),
  }).catch(() => {});

  // Salva novos clusters + atualiza videos
  const clustersCriados = [];
  for (let ci = 0; ci < k; ci++) {
    const membros = videos.filter((_, idx) => labels[idx] === ci);
    if (membros.length < CONFIG.MIN_CLUSTER_SIZE) continue;

    const duracaoMed = mediana(membros.map(m => parseInt(m.duracao_segundos) || 0));
    const horaMed = mediana(membros.map(m => parseInt(m.hora_do_dia_post) || 0));
    const viralizouRate = membros.filter(m => parseFloat(m.score_viralidade || 0) >= 70).length / membros.length;
    const nichoMaisComum = maisComum(membros.map(m => m.nicho).filter(Boolean));

    const nome = `Formato ${ci + 1}: ${duracaoMed}s · ${horaMed}h · ${nichoMaisComum || 'multi-nicho'}`;
    const descricao = `${membros.length} videos · ${Math.round(viralizouRate*100)}% viralizam`;

    const insR = await fetch(`${ctx.SU}/rest/v1/virais_clusters`, {
      method: 'POST', headers: { ...ctx.h, Prefer: 'return=representation' },
      body: JSON.stringify({
        tipo: 'formato', nome, descricao, nicho: nichoMaisComum || null,
        centroide: { features: centroids[ci], duracao_segundos: duracaoMed, hora_do_dia: horaMed },
        exemplos: membros.slice(0, 5).map(m => ({ id: m.id, titulo: m.titulo })),
        total_videos: membros.length,
        taxa_viralizacao: parseFloat((viralizouRate * 100).toFixed(2)),
        ativo: true,
      }),
    });
    const [cluster] = insR.ok ? await insR.json() : [];
    if (!cluster) continue;
    clustersCriados.push({ id: cluster.id, tamanho: membros.length });

    // Atualiza videos com cluster_formato
    for (const m of membros) {
      await fetch(`${ctx.SU}/rest/v1/virais_banco?id=eq.${m.id}`, {
        method: 'PATCH', headers: { ...ctx.h, Prefer: 'return=minimal' },
        body: JSON.stringify({ cluster_formato: cluster.id }),
      });
    }
  }

  return { ok: true, action: 'clusterizar-formatos', clusters_criados: clustersCriados.length, detalhes: clustersCriados };
}

// ═════════════════════════════════════════════════════════════════════════════
// 5) CLUSTERIZAR TEMAS (TF-IDF + hierarchical clustering sobre titulos)
// ═════════════════════════════════════════════════════════════════════════════
async function clusterizarTemas(ctx) {
  const r = await fetch(
    `${ctx.SU}/rest/v1/virais_banco?ativo=eq.true&order=score_viralidade.desc&limit=${CONFIG.CLUSTER_SAMPLE_SIZE}&select=id,titulo,nicho,titulo_features,score_viralidade`,
    { headers: ctx.h }
  );
  if (!r.ok) throw new Error(`read failed: ${r.status}`);
  const videos = await r.json();
  if (videos.length < CONFIG.MIN_CLUSTER_SIZE) {
    return { ok: true, action: 'clusterizar-temas', clusters: 0, motivo: 'amostra insuficiente' };
  }

  // TF-IDF dos tokens
  const docs = videos.map(v => tokenizar(v.titulo || '').slice(0, 15));
  const { vectors, vocab } = computeTfIdf(docs);

  // Clustering: agrupa por similaridade de cosseno >= 0.35
  const clusters = hierarchicalClusterCosine(vectors, 0.35);

  // Desativa temas antigos
  await fetch(`${ctx.SU}/rest/v1/virais_clusters?tipo=eq.tema`, {
    method: 'PATCH', headers: ctx.h,
    body: JSON.stringify({ ativo: false, updated_at: new Date().toISOString() }),
  }).catch(() => {});

  const criados = [];
  for (const cl of clusters) {
    if (cl.length < CONFIG.MIN_CLUSTER_SIZE) continue;
    const membros = cl.map(idx => videos[idx]);
    // Tokens mais frequentes no cluster = "tema"
    const tokenFreq = new Map();
    cl.forEach(idx => docs[idx].forEach(t => tokenFreq.set(t, (tokenFreq.get(t) || 0) + 1)));
    const topTokens = [...tokenFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(e => e[0]);
    const tema = topTokens.join(' ');
    const nichoMaisComum = maisComum(membros.map(m => m.nicho).filter(Boolean));

    const insR = await fetch(`${ctx.SU}/rest/v1/virais_clusters`, {
      method: 'POST', headers: { ...ctx.h, Prefer: 'return=representation' },
      body: JSON.stringify({
        tipo: 'tema', nome: tema, descricao: `${membros.length} videos virais neste tema`,
        nicho: nichoMaisComum || null,
        centroide: { tokens: topTokens },
        exemplos: membros.slice(0, 5).map(m => ({ id: m.id, titulo: m.titulo })),
        total_videos: membros.length,
        ativo: true,
      }),
    });
    const [cluster] = insR.ok ? await insR.json() : [];
    if (!cluster) continue;
    criados.push({ id: cluster.id, tema, tamanho: membros.length });

    for (const m of membros) {
      await fetch(`${ctx.SU}/rest/v1/virais_banco?id=eq.${m.id}`, {
        method: 'PATCH', headers: { ...ctx.h, Prefer: 'return=minimal' },
        body: JSON.stringify({ cluster_tema: cluster.id }),
      });
    }
  }

  return { ok: true, action: 'clusterizar-temas', clusters_criados: criados.length, temas: criados.map(c => c.tema).slice(0, 10) };
}

// ═════════════════════════════════════════════════════════════════════════════
// 6) DETECTAR EMERGENTES via ML (compara janelas de tempo por cluster_tema)
// ═════════════════════════════════════════════════════════════════════════════
async function detectarEmergentesML(ctx) {
  // Pega clusters tema ativos
  const cR = await fetch(
    `${ctx.SU}/rest/v1/virais_clusters?tipo=eq.tema&ativo=eq.true&select=*`,
    { headers: ctx.h }
  );
  const clusters = cR.ok ? await cR.json() : [];
  if (clusters.length === 0) return { ok: true, action: 'detectar-emergentes-ml', emergentes: 0, motivo: 'sem clusters' };

  const now = Date.now();
  const desde7d = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  const entre14e7 = new Date(now - 14 * 24 * 3600 * 1000).toISOString();

  const emergentes = [];
  const saturando = [];

  for (const c of clusters) {
    // Contagem ultima semana
    const r1 = await fetch(
      `${ctx.SU}/rest/v1/virais_banco?cluster_tema=eq.${c.id}&publicado_em=gte.${desde7d}&select=id,youtube_id,titulo,thumbnail_url,canal_nome,views,viral_score,score_viralidade&order=score_viralidade.desc&limit=20`,
      { headers: ctx.h }
    );
    const semanaAtual = r1.ok ? await r1.json() : [];

    // Contagem semana anterior
    const r2 = await fetch(
      `${ctx.SU}/rest/v1/virais_banco?cluster_tema=eq.${c.id}&publicado_em=gte.${entre14e7}&publicado_em=lt.${desde7d}&select=id`,
      { headers: ctx.h }
    );
    const semanaAnterior = r2.ok ? await r2.json() : [];

    const atual = semanaAtual.length;
    const antes = semanaAnterior.length;
    const crescimento = antes > 0 ? Math.round(((atual - antes) / antes) * 100) : (atual > 0 ? 999 : 0);

    // Total historico (pra detectar saturacao)
    const r3 = await fetch(
      `${ctx.SU}/rest/v1/virais_banco?cluster_tema=eq.${c.id}&select=id`,
      { headers: ctx.h }
    );
    const totalHist = r3.ok ? (await r3.json()).length : 0;

    // Atualiza cluster com metricas
    const saturacao = totalHist > 0 ? Math.min(100, (atual / totalHist) * 100) : 0;
    const janelaDias = Math.max(3, 21 - Math.floor(totalHist / 10));
    await fetch(`${ctx.SU}/rest/v1/virais_clusters?id=eq.${c.id}`, {
      method: 'PATCH', headers: ctx.h,
      body: JSON.stringify({
        saturacao_percentual: parseFloat(saturacao.toFixed(2)),
        janela_oportunidade_dias: janelaDias,
        updated_at: new Date().toISOString(),
      }),
    }).catch(() => {});

    // Classifica
    if (crescimento >= CONFIG.EMERGENTE_CRESCIMENTO_PCT && totalHist <= CONFIG.EMERGENTE_MAX_VIDEOS && atual >= 3) {
      emergentes.push({
        cluster_id: c.id,
        tema: c.nome,
        nicho: c.nicho,
        crescimento_percentual: crescimento,
        total_videos: totalHist,
        videos_semana: atual,
        videos_exemplo: semanaAtual.slice(0, 4).map(v => ({
          youtube_id: v.youtube_id, titulo: v.titulo,
          thumbnail: v.thumbnail_url, canal: v.canal_nome, views: v.views,
        })),
        criadores_no_formato: new Set(semanaAtual.map(v => v.canal_nome)).size,
        janela_estimada_dias: janelaDias,
      });
    }
    if (totalHist >= CONFIG.SATURANDO_MIN_VIDEOS) {
      saturando.push({ cluster_id: c.id, tema: c.nome, nicho: c.nicho, total_videos: totalHist });
    }
  }

  // Salva na tendencias_analise pro bluetendencias consumir
  await fetch(`${ctx.SU}/rest/v1/tendencias_analise?tipo=eq.emergentes-ml&nicho=is.null`, {
    method: 'DELETE', headers: ctx.h,
  }).catch(() => {});
  await fetch(`${ctx.SU}/rest/v1/tendencias_analise`, {
    method: 'POST', headers: { ...ctx.h, Prefer: 'return=minimal' },
    body: JSON.stringify({
      tipo: 'emergentes-ml', nicho: null, dados: emergentes,
      valido_ate: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
    }),
  });
  await fetch(`${ctx.SU}/rest/v1/tendencias_analise?tipo=eq.saturando-ml&nicho=is.null`, {
    method: 'DELETE', headers: ctx.h,
  }).catch(() => {});
  await fetch(`${ctx.SU}/rest/v1/tendencias_analise`, {
    method: 'POST', headers: { ...ctx.h, Prefer: 'return=minimal' },
    body: JSON.stringify({
      tipo: 'saturando-ml', nicho: null, dados: saturando,
      valido_ate: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
    }),
  });

  return { ok: true, action: 'detectar-emergentes-ml', emergentes: emergentes.length, saturando: saturando.length, total_clusters: clusters.length };
}

// ═════════════════════════════════════════════════════════════════════════════
// 7) PREDIZER VIRALIDADE de um video especifico
// ═════════════════════════════════════════════════════════════════════════════
async function predizerViralidade(ctx, req) {
  const videoId = req.query.video_id;
  const inlineTitulo = req.query.titulo; // permite predicao "what-if" pra roteiros
  const inlineDuracao = parseInt(req.query.duracao_segundos);
  const inlineNicho = req.query.nicho;

  let video;
  if (videoId) {
    const r = await fetch(
      `${ctx.SU}/rest/v1/virais_banco?id=eq.${videoId}&select=*&limit=1`,
      { headers: ctx.h }
    );
    const rows = r.ok ? await r.json() : [];
    video = rows[0];
    if (!video) return { ok: false, error: 'video nao encontrado' };
  } else if (inlineTitulo) {
    // Predicao what-if — usa titulo + duracao + nicho pra estimar
    video = {
      titulo: inlineTitulo,
      duracao_segundos: inlineDuracao || 30,
      nicho: inlineNicho || 'geral',
      titulo_features: extractTituloFeatures(inlineTitulo),
      hora_do_dia_post: new Date().getUTCHours(),
      dia_da_semana_post: new Date().getUTCDay(),
    };
  } else {
    return { ok: false, error: 'video_id ou titulo obrigatorio' };
  }

  // Fatores preditivos
  const fatores = [];
  let score = 0.3; // baseline
  let confianca = 0.5;

  const feats = video.titulo_features || {};
  if (feats.tem_numero || feats.comeca_com_numero) { score += 0.08; fatores.push('titulo com numero'); }
  if (feats.tem_pergunta) { score += 0.07; fatores.push('hook em pergunta'); }
  if (feats.emojis_count >= 1) { score += 0.06; fatores.push(`${feats.emojis_count} emoji(s)`); }
  if ((feats.palavras_gatilho || []).length > 0) { score += 0.10; fatores.push(`palavras-gatilho: ${feats.palavras_gatilho.slice(0,3).join(', ')}`); }
  if (feats.tamanho_palavras >= 5 && feats.tamanho_palavras <= 10) { score += 0.05; fatores.push('tamanho ideal do titulo'); }

  const dur = parseInt(video.duracao_segundos) || 30;
  if (dur >= 15 && dur <= 45) { score += 0.08; fatores.push('duracao ideal pra Shorts'); }
  else if (dur < 10 || dur > 60) { score -= 0.08; fatores.push('duracao longe da mediana'); }

  // Hora de post
  const hora = parseInt(video.hora_do_dia_post);
  if (hora >= 18 && hora <= 22) { score += 0.05; fatores.push('horario nobre'); }

  // Se tem cluster identificado, usa taxa historica dele
  let clusterSimilar = null;
  if (video.cluster_tema) {
    const cR = await fetch(`${ctx.SU}/rest/v1/virais_clusters?id=eq.${video.cluster_tema}&select=nome,taxa_viralizacao,saturacao_percentual,janela_oportunidade_dias`, { headers: ctx.h });
    const [cl] = cR.ok ? await cR.json() : [];
    if (cl) {
      clusterSimilar = cl.nome;
      const tx = parseFloat(cl.taxa_viralizacao) / 100;
      if (tx > 0) { score = score * 0.6 + tx * 0.4; confianca = 0.75; fatores.push(`cluster "${cl.nome}" viraliza em ${Math.round(tx*100)}%`); }
      if (cl.saturacao_percentual > 60) { score -= 0.10; fatores.push('tema saturando — evite'); }
    }
  } else {
    // Tenta achar cluster similar pelo titulo (match por tokens)
    const tokensVideo = new Set(tokenizar(video.titulo || ''));
    if (tokensVideo.size > 0) {
      const cR = await fetch(`${ctx.SU}/rest/v1/virais_clusters?tipo=eq.tema&ativo=eq.true&select=id,nome,centroide,taxa_viralizacao&limit=50`, { headers: ctx.h });
      const clusters = cR.ok ? await cR.json() : [];
      let melhor = null, melhorScore = 0;
      for (const c of clusters) {
        const clTokens = new Set(c.centroide?.tokens || []);
        const inter = [...tokensVideo].filter(t => clTokens.has(t)).length;
        if (inter > melhorScore) { melhorScore = inter; melhor = c; }
      }
      if (melhor && melhorScore >= 2) {
        clusterSimilar = melhor.nome;
        fatores.push(`similar a cluster "${melhor.nome}"`);
        confianca = 0.65;
      }
    }
  }

  score = Math.max(0.05, Math.min(0.95, score));
  const probabilidade = parseFloat(score.toFixed(3));
  const janelaEstimada = 7;

  // Salva a predicao (so pra videos ja no banco)
  if (videoId) {
    await fetch(`${ctx.SU}/rest/v1/virais_predicoes`, {
      method: 'POST', headers: { ...ctx.h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        video_id: videoId,
        probabilidade_viral: probabilidade,
        confianca: parseFloat(confianca.toFixed(3)),
        cluster_previsto: video.cluster_tema || null,
        janela_estimada_dias: janelaEstimada,
        features_relevantes: { fatores, titulo_features: feats },
      }),
    }).catch(() => {});
  }

  return {
    ok: true,
    probabilidade,
    confianca: parseFloat(confianca.toFixed(3)),
    razoes: fatores,
    janela_estimada_dias: janelaEstimada,
    cluster_similar: clusterSimilar,
    pct: Math.round(probabilidade * 100),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 8) INSIGHTS PARA USUARIO (Master com canal conectado)
// ═════════════════════════════════════════════════════════════════════════════
async function insightsParaUsuario(ctx, req) {
  const token = req.query.token;
  if (!token) return { ok: false, error: 'token obrigatorio' };

  // Valida token + plan master (reusa logica do requireMaster do bluetendencias)
  const uR = await fetch(`${ctx.SU}/auth/v1/user`, { headers: { apikey: ctx.AK, Authorization: `Bearer ${token}` } });
  if (!uR.ok) return { ok: false, error: 'Token invalido', status: 401 };
  const user = await uR.json();
  if (!user?.email) return { ok: false, error: 'Token invalido', status: 401 };

  const sR = await fetch(`${ctx.SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(user.email)}&select=plan,plan_expires_at&limit=1`, { headers: ctx.h });
  const [sub] = sR.ok ? await sR.json() : [];
  if (sub?.plan !== 'master') return { ok: false, error: 'master_required', status: 403 };

  // Canal conectado
  const cR = await fetch(`${ctx.SU}/rest/v1/tendencias_canais_conectados?user_id=eq.${user.id}&ativo=eq.true&select=*&limit=1`, { headers: ctx.h });
  const [canal] = cR.ok ? await cR.json() : [];
  const nicho = canal?.nicho_principal || null;

  // Emergentes do nicho
  const emRow = await fetch(`${ctx.SU}/rest/v1/tendencias_analise?tipo=eq.emergentes-ml&valido_ate=gte.${new Date().toISOString()}&order=created_at.desc&limit=1&select=dados`, { headers: ctx.h });
  const [em] = emRow.ok ? await emRow.json() : [];
  const todosEmergentes = em?.dados || [];
  const emergentesNicho = nicho ? todosEmergentes.filter(e => e.nicho === nicho) : todosEmergentes.slice(0, 6);

  // Top clusters do nicho com maior taxa_viralizacao
  const clR = await fetch(
    `${ctx.SU}/rest/v1/virais_clusters?ativo=eq.true&tipo=eq.tema${nicho ? `&nicho=eq.${nicho}` : ''}&order=taxa_viralizacao.desc&limit=5&select=id,nome,descricao,taxa_viralizacao,saturacao_percentual,janela_oportunidade_dias,exemplos`,
    { headers: ctx.h }
  );
  const topClusters = clR.ok ? await clR.json() : [];

  // Padroes de titulo recentes (do cache ou calc)
  const tR = await fetch(`${ctx.SU}/rest/v1/tendencias_analise?tipo=eq.titulos${nicho ? `&nicho=eq.${nicho}` : ''}&valido_ate=gte.${new Date().toISOString()}&order=created_at.desc&limit=1&select=dados`, { headers: ctx.h });
  const [t] = tR.ok ? await tR.json() : [];

  // Ranking: qual formato tentar AGORA
  const ranking = topClusters.map(c => {
    let acaoScore = parseFloat(c.taxa_viralizacao || 0);
    if (parseFloat(c.saturacao_percentual || 0) < 30) acaoScore += 20; // baixa saturacao = boa janela
    if (parseFloat(c.saturacao_percentual || 0) > 60) acaoScore -= 30; // alta saturacao = evite
    return { ...c, acao_score: parseFloat(acaoScore.toFixed(2)) };
  }).sort((a, b) => b.acao_score - a.acao_score);

  return {
    ok: true,
    canal_conectado: !!canal,
    nicho,
    emergentes: emergentesNicho.slice(0, 6),
    top_clusters_acionar: ranking,
    padroes_titulo: t?.dados || null,
    recomendacao_principal: ranking[0] ? {
      tema: ranking[0].nome,
      motivo: ranking[0].saturacao_percentual < 30 ? 'Baixa saturacao — muita janela' : 'Alta taxa de viralizacao no nicho',
      janela_dias: ranking[0].janela_oportunidade_dias,
    } : null,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 9) VALIDAR PREDICOES (cron semanal)
// ═════════════════════════════════════════════════════════════════════════════
async function validarPredicoes(ctx) {
  const seteDiasAtras = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const r = await fetch(
    `${ctx.SU}/rest/v1/virais_predicoes?created_at=lt.${seteDiasAtras}&predicao_correta=is.null&select=id,video_id,probabilidade_viral&limit=500`,
    { headers: ctx.h }
  );
  const predicoes = r.ok ? await r.json() : [];
  if (predicoes.length === 0) {
    // Log sem ajuste
    await fetch(`${ctx.SU}/rest/v1/virais_modelo_log`, {
      method: 'POST', headers: { ...ctx.h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        total_predicoes: 0, total_validadas: 0, acertos: 0,
        pesos_atuais: CONFIG.PESOS_DEFAULT,
        observacoes: 'sem predicoes pra validar',
      }),
    }).catch(() => {});
    return { ok: true, action: 'validar-predicoes', total: 0 };
  }

  let acertos = 0, validadas = 0;
  for (const p of predicoes) {
    const vR = await fetch(`${ctx.SU}/rest/v1/virais_banco?id=eq.${p.video_id}&select=viralizou&limit=1`, { headers: ctx.h });
    const [v] = vR.ok ? await vR.json() : [];
    if (!v) continue;
    const prevedeu = parseFloat(p.probabilidade_viral || 0) >= 0.5;
    const correto = prevedeu === (v.viralizou === true);
    await fetch(`${ctx.SU}/rest/v1/virais_predicoes?id=eq.${p.id}`, {
      method: 'PATCH', headers: ctx.h,
      body: JSON.stringify({ predicao_correta: correto, validado_em: new Date().toISOString() }),
    }).catch(() => {});
    if (correto) acertos++;
    validadas++;
  }

  const acuracia = validadas > 0 ? parseFloat((acertos / validadas).toFixed(4)) : null;

  await fetch(`${ctx.SU}/rest/v1/virais_modelo_log`, {
    method: 'POST', headers: { ...ctx.h, Prefer: 'return=minimal' },
    body: JSON.stringify({
      total_predicoes: predicoes.length,
      total_validadas: validadas,
      acertos,
      acuracia,
      pesos_atuais: CONFIG.PESOS_DEFAULT,
      observacoes: acuracia !== null && acuracia < 0.7 ? 'acuracia abaixo de 70% — considerar ajuste manual' : 'dentro do esperado',
    }),
  }).catch(() => {});

  return { ok: true, action: 'validar-predicoes', total: predicoes.length, validadas, acertos, acuracia };
}

// ═════════════════════════════════════════════════════════════════════════════
// PIPELINE DIARIO — executa scores + analisar-titulos + clusterizar-formatos
// em sequencia (consolida 3 crons em 1 pra ficar dentro do limite Vercel)
// ═════════════════════════════════════════════════════════════════════════════
async function pipelineDiario(ctx) {
  const resultados = {};
  try { resultados.scores = await calcularScores(ctx, { query: {} }); } catch (e) { resultados.scores = { error: e.message }; }
  try { resultados.titulos = await analisarTitulos(ctx, { query: {} }); } catch (e) { resultados.titulos = { error: e.message }; }
  try { resultados.formatos = await clusterizarFormatos(ctx); } catch (e) { resultados.formatos = { error: e.message }; }
  return { ok: true, action: 'pipeline-diario', resultados };
}

// ═════════════════════════════════════════════════════════════════════════════
// STATUS — expoe estatisticas do modelo pra frontend
// ═════════════════════════════════════════════════════════════════════════════
async function statusModelo(ctx) {
  // Total de videos no banco
  const hR = await fetch(`${ctx.SU}/rest/v1/virais_banco?select=id`, { headers: { ...ctx.h, Prefer: 'count=exact' } });
  const totalVideos = parseInt(hR.headers.get('content-range')?.split('/')[1] || 0);

  // Clusters ativos
  const cR = await fetch(`${ctx.SU}/rest/v1/virais_clusters?ativo=eq.true&select=tipo,total_videos,taxa_viralizacao`, { headers: ctx.h });
  const clusters = cR.ok ? await cR.json() : [];
  const formatos = clusters.filter(c => c.tipo === 'formato').length;
  const temas = clusters.filter(c => c.tipo === 'tema').length;

  // Ultima validacao
  const logR = await fetch(`${ctx.SU}/rest/v1/virais_modelo_log?order=executado_em.desc&limit=1&select=*`, { headers: ctx.h });
  const [log] = logR.ok ? await logR.json() : [];

  // Predicoes validadas (total historico)
  const pR = await fetch(`${ctx.SU}/rest/v1/virais_predicoes?select=predicao_correta`, { headers: { ...ctx.h, Prefer: 'count=exact' } });
  const totalPred = parseInt(pR.headers.get('content-range')?.split('/')[1] || 0);

  return {
    ok: true,
    total_videos: totalVideos,
    clusters_formato: formatos,
    clusters_tema: temas,
    total_clusters: clusters.length,
    total_predicoes: totalPred,
    ultima_validacao: log || null,
    acuracia_atual: log?.acuracia ? parseFloat(log.acuracia) : null,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS DE ML (K-means, TF-IDF, cosine, etc)
// ═════════════════════════════════════════════════════════════════════════════

function mediana(arr) {
  const a = [...arr].filter(x => x != null && !isNaN(x)).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
}

function maisComum(arr) {
  const freq = new Map();
  arr.forEach(x => freq.set(x, (freq.get(x) || 0) + 1));
  let melhor = null, melhorC = 0;
  freq.forEach((c, k) => { if (c > melhorC) { melhor = k; melhorC = c; } });
  return melhor;
}

// K-means simples em JS — data = matriz [n][dims], retorna { labels, centroids }
function kMeans(data, k, maxIter = 20) {
  if (!data.length || k < 1) return { labels: [], centroids: [] };
  const dims = data[0].length;
  // Seed: K pontos aleatorios distintos
  const centroids = [];
  const usados = new Set();
  while (centroids.length < k) {
    const idx = Math.floor(Math.random() * data.length);
    if (usados.has(idx)) continue;
    usados.add(idx);
    centroids.push([...data[idx]]);
  }
  let labels = new Array(data.length).fill(0);

  for (let it = 0; it < maxIter; it++) {
    // Assign
    let changed = false;
    for (let i = 0; i < data.length; i++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = euclideanSq(data[i], centroids[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (labels[i] !== best) { labels[i] = best; changed = true; }
    }
    if (!changed) break;

    // Update centroids
    const sums = Array.from({ length: k }, () => new Array(dims).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < data.length; i++) {
      const c = labels[i];
      counts[c]++;
      for (let d = 0; d < dims; d++) sums[c][d] += data[i][d];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      for (let d = 0; d < dims; d++) centroids[c][d] = sums[c][d] / counts[c];
    }
  }
  return { labels, centroids };
}

function euclideanSq(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return s;
}

// TF-IDF: docs = array de arrays de tokens. Retorna { vectors, vocab }
function computeTfIdf(docs) {
  const vocab = new Map();
  // Conta document frequency
  const df = new Map();
  for (const doc of docs) {
    const unicos = new Set(doc);
    for (const w of unicos) {
      df.set(w, (df.get(w) || 0) + 1);
      if (!vocab.has(w)) vocab.set(w, vocab.size);
    }
  }
  const N = docs.length;
  // Constroi vetores esparsos: { [wordIdx]: tfidf }
  const vectors = docs.map(doc => {
    const tf = new Map();
    for (const w of doc) tf.set(w, (tf.get(w) || 0) + 1);
    const vec = {};
    const docLen = doc.length || 1;
    for (const [w, count] of tf.entries()) {
      const idx = vocab.get(w);
      const tfn = count / docLen;
      const idf = Math.log((N + 1) / ((df.get(w) || 0) + 1)) + 1;
      vec[idx] = tfn * idf;
    }
    return vec;
  });
  return { vectors, vocab };
}

function cosineSparse(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const k in a) { dot += (a[k] || 0) * (b[k] || 0); na += a[k] * a[k]; }
  for (const k in b) { nb += b[k] * b[k]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

// Hierarchical clustering simples com threshold de similaridade
// (nao scalable para 10K+, mas ok pra 1500 do nosso sample)
function hierarchicalClusterCosine(vectors, threshold) {
  const n = vectors.length;
  const clusters = Array.from({ length: n }, (_, i) => [i]);
  // Calcula matriz de similaridade so quando precisa (lazy)
  let changed = true;
  while (changed) {
    changed = false;
    let bestSim = threshold, bestI = -1, bestJ = -1;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        // Avg-link similarity (media dos pares)
        let s = 0, cnt = 0;
        for (const a of clusters[i]) {
          for (const b of clusters[j]) {
            s += cosineSparse(vectors[a], vectors[b]);
            cnt++;
            if (cnt >= 25) break; // cap pra performance
          }
          if (cnt >= 25) break;
        }
        const avg = cnt > 0 ? s / cnt : 0;
        if (avg > bestSim) { bestSim = avg; bestI = i; bestJ = j; }
      }
    }
    if (bestI >= 0) {
      clusters[bestI] = clusters[bestI].concat(clusters[bestJ]);
      clusters.splice(bestJ, 1);
      changed = true;
    }
    if (clusters.length < 5) break; // chega
  }
  return clusters;
}
