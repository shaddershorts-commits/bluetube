// api/bluetendencias.js
// BlueTendencias v1 — dashboard de tendencias exclusivo do plano Master.
// Usa virais_banco como fonte de dados + cache em tendencias_analise.
// Crons pre-calculam analises pra minimizar custo operacional.

const { youtubeRequest, getChannelInfo } = require('./_helpers/youtube.js');

const NICHOS_PADRAO = [
  'financas', 'tecnologia', 'saude', 'educacao', 'beleza', 'lifestyle',
  'culinaria', 'games', 'humor', 'musica', 'esportes', 'pets', 'viagens', 'automotivo'
];

// Stop words PT-BR pra analise de titulos
const STOP_WORDS = new Set([
  'a','o','as','os','de','da','do','das','dos','em','no','na','nos','nas',
  'um','uma','uns','umas','e','é','são','foi','ser','ter','tem','com','para',
  'por','que','se','ou','mas','não','sim','eu','você','meu','minha','seu',
  'sua','isso','este','esta','ele','ela','eles','elas','mais','menos','como',
  'quando','onde','qual','quais','muito','muita','pouco','pouca','todo','toda',
  'the','and','or','of','in','on','at','to','a','an','is','are','was','were'
]);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });
  const h = { apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json' };

  const action = req.method === 'GET' ? req.query.action : (req.body && req.body.action);
  const ctx = { SU, SK, AK, h };

  // Crons — sem auth (Vercel protege com x-vercel-cron)
  if (action === 'atualizar-tendencias')   return cronAtualizarTendencias(req, res, ctx);
  if (action === 'detectar-emergentes')    return cronDetectarEmergentes(req, res, ctx);
  if (action === 'analisar-titulos')       return cronAnalisarTitulos(req, res, ctx);
  if (action === 'notificar-oportunidades')return cronNotificarOportunidades(req, res, ctx);

  // Actions com auth Master
  if (action === 'dashboard')       return actionDashboard(req, res, ctx);
  if (action === 'analise-titulos') return actionAnaliseTitulos(req, res, ctx);
  if (action === 'emergentes')      return actionEmergentes(req, res, ctx);
  if (action === 'conectar-canal')  return actionConectarCanal(req, res, ctx);
  if (action === 'meu-canal')       return actionMeuCanal(req, res, ctx);
  if (action === 'sugestoes')       return actionSugestoes(req, res, ctx);
  if (action === 'alertas')         return actionAlertas(req, res, ctx);
  if (action === 'marcar-alerta-visto') return actionMarcarAlertaVisto(req, res, ctx);
  if (action === 'por-nicho')       return actionPorNicho(req, res, ctx);
  if (action === 'probabilidade-roteiro') return actionProbabilidadeRoteiro(req, res, ctx);
  if (action === 'status-ml')       return actionStatusML(req, res, ctx);
  if (action === 'insights-ml')     return actionInsightsML(req, res, ctx);

  return res.status(400).json({ error: 'action invalida' });
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers comuns
// ─────────────────────────────────────────────────────────────────────────────
async function getUser(ctx, token) {
  if (!token) return null;
  try {
    const r = await fetch(`${ctx.SU}/auth/v1/user`, {
      headers: { apikey: ctx.AK, Authorization: `Bearer ${token}` },
    });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

// Verifica plano Master. Retorna { ok, user, plan } ou { ok:false, error, status }
async function requireMaster(ctx, token) {
  const user = await getUser(ctx, token);
  if (!user?.email) return { ok: false, status: 401, error: 'Token invalido' };
  const sr = await fetch(
    `${ctx.SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(user.email)}&select=plan,plan_expires_at&limit=1`,
    { headers: ctx.h }
  );
  const [sub] = sr.ok ? await sr.json() : [];
  const plan = sub?.plan || 'free';
  // Plano master ativo: plan=master e (sem expiracao OU expiracao no futuro)
  const expired = sub?.plan_expires_at && new Date(sub.plan_expires_at) < new Date();
  if (plan !== 'master' || expired) {
    return { ok: false, status: 403, error: 'master_required', plan };
  }
  return { ok: true, user, plan };
}

// Le cache da analise. Retorna dados ou null se expirou/nao existe.
async function lerCache(ctx, tipo, nicho = null) {
  const nichoClause = nicho ? `&nicho=eq.${nicho}` : '&nicho=is.null';
  const r = await fetch(
    `${ctx.SU}/rest/v1/tendencias_analise?tipo=eq.${tipo}${nichoClause}&valido_ate=gte.${new Date().toISOString()}&order=created_at.desc&limit=1&select=dados,created_at,valido_ate`,
    { headers: ctx.h }
  );
  const [row] = r.ok ? await r.json() : [];
  return row?.dados || null;
}

// Salva cache (apaga entradas antigas do mesmo tipo/nicho pra nao acumular)
async function salvarCache(ctx, tipo, nicho, dados, validoAte) {
  const nichoClause = nicho ? `&nicho=eq.${nicho}` : '&nicho=is.null';
  // Limpa expirados antigos pra economizar espaco
  await fetch(`${ctx.SU}/rest/v1/tendencias_analise?tipo=eq.${tipo}${nichoClause}&valido_ate=lt.${new Date(Date.now() - 24*3600*1000).toISOString()}`, {
    method: 'DELETE', headers: ctx.h,
  }).catch(() => {});
  // Insere novo
  await fetch(`${ctx.SU}/rest/v1/tendencias_analise`, {
    method: 'POST', headers: { ...ctx.h, Prefer: 'return=minimal' },
    body: JSON.stringify({ tipo, nicho, dados, valido_ate: validoAte.toISOString() }),
  });
}

// Tokeniza titulo pra analise — retorna palavras significativas lowercased
function tokenize(titulo) {
  if (!titulo) return [];
  return titulo
    .toLowerCase()
    .replace(/[^\w\sáàâãéêíóôõúçñü]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

// Extrai emojis de um titulo
function extrairEmojis(titulo) {
  if (!titulo) return [];
  const rx = /\p{Extended_Pictographic}/gu;
  return titulo.match(rx) || [];
}

// Keyword chave (primeiras 2-3 palavras significativas)
function keywordChave(titulo) {
  const tokens = tokenize(titulo);
  return tokens.slice(0, 3).join(' ');
}

async function lerRPM(ctx) {
  const r = await fetch(`${ctx.SU}/rest/v1/tendencias_rpm_nichos?select=*&order=nicho.asc`, { headers: ctx.h });
  return r.ok ? await r.json() : [];
}

// Call Claude Haiku helper (via ai.js). Retorna string (texto) ou '' em erro.
async function callClaude(prompt, systemPrompt, maxTokens = 800) {
  try {
    const { callAI } = require('./_helpers/ai.js');
    const out = await callAI(prompt, systemPrompt, maxTokens, 'claude');
    return out?.result || '';
  } catch (e) {
    console.error('[bluetendencias callClaude] erro:', e.message);
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: dashboard — tudo o que a pagina precisa pra renderizar de cara
// ─────────────────────────────────────────────────────────────────────────────
async function actionDashboard(req, res, ctx) {
  const auth = await requireMaster(ctx, req.query.token);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, plan: auth.plan });

  try {
    // Top virais (ultimos 7 dias, por viral_score)
    const desde = new Date(Date.now() - 7*24*3600*1000).toISOString();
    const tr = await fetch(
      `${ctx.SU}/rest/v1/virais_banco?ativo=eq.true&coletado_em=gte.${desde}&order=viral_score.desc&limit=12&select=id,youtube_id,titulo,thumbnail_url,url,canal_nome,canal_thumbnail,views,likes,comentarios,duracao_segundos,taxa_engajamento,velocidade_views,viral_score,nicho,publicado_em,coletado_em`,
      { headers: ctx.h }
    );
    const topVirais = tr.ok ? await tr.json() : [];

    // Emergentes — prioriza ML, cai pra heuristica
    const emergentesML = (await lerCache(ctx, 'emergentes-ml')) || [];
    const emergentesHeur = (await lerCache(ctx, 'emergentes')) || [];
    const emergentes = emergentesML.length > 0 ? emergentesML : emergentesHeur;

    // Saturando — prioriza ML
    const saturandoML = (await lerCache(ctx, 'saturando-ml')) || [];
    const saturandoHeur = (await lerCache(ctx, 'saturando')) || [];
    const saturando = saturandoML.length > 0 ? saturandoML : saturandoHeur;

    // RPM por nicho
    const rpmRows = await lerRPM(ctx);

    // Meu canal
    const cr = await fetch(
      `${ctx.SU}/rest/v1/tendencias_canais_conectados?user_id=eq.${auth.user.id}&ativo=eq.true&select=*&limit=1`,
      { headers: ctx.h }
    );
    const [meuCanal] = cr.ok ? await cr.json() : [];

    // Alertas nao lidos
    const ar = await fetch(
      `${ctx.SU}/rest/v1/tendencias_alertas?user_id=eq.${auth.user.id}&visualizado=eq.false&order=created_at.desc&limit=10&select=*`,
      { headers: ctx.h }
    );
    const alertas = ar.ok ? await ar.json() : [];

    return res.status(200).json({
      tendencias_hoje: topVirais,
      emergentes,
      saturando,
      rpm_por_nicho: rpmRows,
      meu_canal: meuCanal || null,
      alertas,
      ultima_atualizacao: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[dashboard] erro:', e.message);
    return res.status(500).json({ error: 'erro ao carregar dashboard', detalhe: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: analise-titulos — padroes de titulo no nicho
// ─────────────────────────────────────────────────────────────────────────────
async function actionAnaliseTitulos(req, res, ctx) {
  const auth = await requireMaster(ctx, req.query.token);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, plan: auth.plan });
  const nicho = (req.query.nicho || '').toLowerCase();
  if (!nicho) return res.status(400).json({ error: 'nicho obrigatorio' });

  // Tenta cache
  const cached = await lerCache(ctx, 'titulos', nicho);
  if (cached) return res.status(200).json(cached);

  // Calcula agora
  const dados = await calcularAnaliseTitulos(ctx, nicho);
  const validoAte = new Date(Date.now() + 24*3600*1000);
  await salvarCache(ctx, 'titulos', nicho, dados, validoAte);
  return res.status(200).json(dados);
}

async function calcularAnaliseTitulos(ctx, nicho) {
  const desde = new Date(Date.now() - 30*24*3600*1000).toISOString();
  const r = await fetch(
    `${ctx.SU}/rest/v1/virais_banco?ativo=eq.true&nicho=eq.${nicho}&coletado_em=gte.${desde}&order=viral_score.desc&limit=100&select=titulo,thumbnail_url,youtube_id,canal_nome,views,viral_score`,
    { headers: ctx.h }
  );
  const videos = r.ok ? await r.json() : [];
  if (!videos.length) return { palavras_mais_usadas: [], estrutura_comum: '', tamanho_ideal: 0, emojis_que_funcionam: [], exemplos_top: [] };

  // Palavras mais usadas
  const freq = new Map();
  videos.forEach(v => tokenize(v.titulo).forEach(w => freq.set(w, (freq.get(w) || 0) + 1)));
  const palavras_mais_usadas = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([palavra, qtd]) => ({ palavra, qtd }));

  // Tamanho ideal (mediana)
  const tamanhos = videos.map(v => v.titulo?.length || 0).filter(x => x > 0).sort((a, b) => a - b);
  const tamanho_ideal = tamanhos[Math.floor(tamanhos.length / 2)] || 0;

  // Emojis
  const emojiFreq = new Map();
  videos.forEach(v => extrairEmojis(v.titulo).forEach(e => emojiFreq.set(e, (emojiFreq.get(e) || 0) + 1)));
  const emojis_que_funcionam = [...emojiFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([e, q]) => ({ emoji: e, qtd: q }));

  // Estrutura comum — heuristica: % que comecam com numero, com emoji, com pergunta, caps lock, etc
  let comNumero = 0, comEmoji = 0, comPergunta = 0, comCaps = 0;
  videos.forEach(v => {
    const t = (v.titulo || '').trim();
    if (/^\d/.test(t)) comNumero++;
    if (/^\p{Extended_Pictographic}/u.test(t)) comEmoji++;
    if (t.includes('?')) comPergunta++;
    const letras = t.replace(/[^a-zA-Z]/g, '');
    if (letras.length > 5 && letras === letras.toUpperCase()) comCaps++;
  });
  const pct = x => Math.round((x / videos.length) * 100);
  const estrutura_comum = [
    comNumero > videos.length*0.2 ? `${pct(comNumero)}% começa com número` : null,
    comEmoji > videos.length*0.2 ? `${pct(comEmoji)}% começa com emoji` : null,
    comPergunta > videos.length*0.2 ? `${pct(comPergunta)}% usa pergunta` : null,
    comCaps > videos.length*0.1 ? `${pct(comCaps)}% usa CAPS LOCK` : null,
  ].filter(Boolean).join(' · ') || 'Titulos mistos, sem padrao dominante';

  // Top 5 exemplos
  const exemplos_top = videos.slice(0, 5).map(v => ({
    titulo: v.titulo, thumbnail: v.thumbnail_url, youtube_id: v.youtube_id,
    canal: v.canal_nome, views: v.views,
  }));

  return { palavras_mais_usadas, estrutura_comum, tamanho_ideal, emojis_que_funcionam, exemplos_top, total_analisados: videos.length, nicho };
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: emergentes — tendencias crescendo rapido
// ─────────────────────────────────────────────────────────────────────────────
async function actionEmergentes(req, res, ctx) {
  const auth = await requireMaster(ctx, req.query.token);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, plan: auth.plan });
  const nicho = (req.query.nicho || '').toLowerCase() || null;

  // Prioriza cache ML (emergentes-ml); cai pra heuristica (emergentes) se vazio
  const mlCached = (await lerCache(ctx, 'emergentes-ml')) || [];
  const heurCached = (await lerCache(ctx, 'emergentes')) || [];
  const combined = mlCached.length > 0 ? mlCached : heurCached;
  const tendencias = nicho ? combined.filter(t => t.nicho === nicho) : combined;
  return res.status(200).json({ tendencias, fonte: mlCached.length > 0 ? 'ml' : 'heuristica' });
}

async function calcularEmergentes(ctx) {
  // Busca videos publicados nas ultimas 48h com alto viral_score
  const desde = new Date(Date.now() - 48*3600*1000).toISOString();
  const r = await fetch(
    `${ctx.SU}/rest/v1/virais_banco?ativo=eq.true&publicado_em=gte.${desde}&order=velocidade_views.desc&limit=300&select=id,youtube_id,titulo,thumbnail_url,url,canal_nome,views,velocidade_views,viral_score,nicho,publicado_em`,
    { headers: ctx.h }
  );
  const videos = r.ok ? await r.json() : [];
  if (!videos.length) return [];

  // Agrupa por keyword (2-3 primeiras palavras significativas do titulo)
  const clusters = new Map();
  videos.forEach(v => {
    const k = keywordChave(v.titulo);
    if (!k || k.length < 3) return;
    if (!clusters.has(k)) clusters.set(k, { tema: k, videos: [], nichos: new Set() });
    const c = clusters.get(k);
    c.videos.push(v);
    if (v.nicho) c.nichos.add(v.nicho);
  });

  // Filtra: 5+ videos similares com velocidade alta
  const rpmMap = new Map((await lerRPM(ctx)).map(r => [r.nicho, r]));
  const emergentes = [];
  for (const c of clusters.values()) {
    if (c.videos.length < 5) continue;
    const velocidadeMedia = c.videos.reduce((s, v) => s + (parseFloat(v.velocidade_views) || 0), 0) / c.videos.length;
    const viralScoreMedio = c.videos.reduce((s, v) => s + (parseFloat(v.viral_score) || 0), 0) / c.videos.length;
    // Heuristica de crescimento: velocidade_views / 10000 como base percentual
    const crescimentoEstimado = Math.round(velocidadeMedia / 100);
    if (crescimentoEstimado < 50 && viralScoreMedio < 50) continue;

    const criadoresUnicos = new Set(c.videos.map(v => v.canal_nome)).size;
    const nichoPrincipal = [...c.nichos][0] || null;
    const rpm = nichoPrincipal ? rpmMap.get(nichoPrincipal) : null;

    emergentes.push({
      tema: c.tema,
      nicho: nichoPrincipal,
      videos_exemplo: c.videos.slice(0, 4).map(v => ({
        youtube_id: v.youtube_id, titulo: v.titulo,
        thumbnail: v.thumbnail_url, canal: v.canal_nome, views: v.views,
      })),
      criadores_no_formato: criadoresUnicos,
      total_videos: c.videos.length,
      crescimento_percentual: crescimentoEstimado,
      velocidade_media: Math.round(velocidadeMedia),
      viral_score_medio: Math.round(viralScoreMedio),
      janela_estimada_dias: Math.max(3, 14 - Math.floor(c.videos.length / 3)),
      rpm_estimado: rpm ? { min: parseFloat(rpm.rpm_minimo), medio: parseFloat(rpm.rpm_medio), max: parseFloat(rpm.rpm_maximo) } : null,
    });
  }
  // Ordena por crescimento × low concorrencia
  emergentes.sort((a, b) => (b.crescimento_percentual / Math.max(1, b.criadores_no_formato)) - (a.crescimento_percentual / Math.max(1, a.criadores_no_formato)));
  return emergentes.slice(0, 15);
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: conectar-canal
// ─────────────────────────────────────────────────────────────────────────────
async function actionConectarCanal(req, res, ctx) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST apenas' });
  const { token, canal_youtube } = req.body || {};
  const auth = await requireMaster(ctx, token);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, plan: auth.plan });
  if (!canal_youtube) return res.status(400).json({ error: 'canal_youtube obrigatorio' });

  try {
    // Extrai handle/id do input (aceita @handle, URL, ou ID direto)
    const raw = canal_youtube.trim();
    let params = null;
    if (raw.startsWith('UC') && raw.length === 24) {
      params = { id: raw, part: 'snippet,statistics,contentDetails' };
    } else {
      const handle = raw.replace(/.*\//, '').replace(/^@/, '');
      params = { forHandle: '@' + handle, part: 'snippet,statistics,contentDetails' };
    }

    const data = await youtubeRequest('channels', params);
    const ch = data?.items?.[0];
    if (!ch) return res.status(404).json({ error: 'Canal nao encontrado no YouTube' });

    const canalId = ch.id;
    const canalNome = ch.snippet?.title || '';
    const canalThumb = ch.snippet?.thumbnails?.default?.url || null;
    const inscritos = parseInt(ch.statistics?.subscriberCount || 0);
    const viewsTotais = parseInt(ch.statistics?.viewCount || 0);
    const uploadsPlaylist = ch.contentDetails?.relatedPlaylists?.uploads;

    // Busca ultimos 20 videos do canal
    let ultimosVideos = [];
    if (uploadsPlaylist) {
      try {
        const pl = await youtubeRequest('playlistItems', { playlistId: uploadsPlaylist, part: 'snippet,contentDetails', maxResults: 20 });
        const videoIds = (pl?.items || []).map(i => i.contentDetails?.videoId).filter(Boolean);
        if (videoIds.length) {
          const vd = await youtubeRequest('videos', { id: videoIds.join(','), part: 'snippet,statistics,contentDetails' });
          ultimosVideos = (vd?.items || []).map(v => ({
            id: v.id, titulo: v.snippet?.title,
            publicado: v.snippet?.publishedAt,
            views: parseInt(v.statistics?.viewCount || 0),
            likes: parseInt(v.statistics?.likeCount || 0),
            duracao_iso: v.contentDetails?.duration,
          }));
        }
      } catch (e) { console.error('[conectar-canal] erro fetching videos:', e.message); }
    }

    // Detecta nicho via Claude Haiku (fallback: snippet tags)
    let nichoPrincipal = null;
    const titulosConcat = ultimosVideos.map(v => v.titulo).slice(0, 15).join(' | ');
    if (titulosConcat) {
      const prompt = `Analise esses titulos de videos de YouTube e me diga em UMA palavra qual eh o nicho principal. Responda APENAS com uma dessas opcoes: financas, tecnologia, saude, educacao, beleza, lifestyle, culinaria, games, humor, musica, esportes, pets, viagens, automotivo, geral.\n\nTitulos:\n${titulosConcat}\n\nNicho:`;
      const r = await callClaude(prompt, 'Voce e um classificador de nichos de YouTube. Responda em uma palavra apenas.', 20);
      const match = r.toLowerCase().match(/\b(financas|tecnologia|saude|educacao|beleza|lifestyle|culinaria|games|humor|musica|esportes|pets|viagens|automotivo)\b/);
      nichoPrincipal = match ? match[1] : 'geral';
    }

    // Upsert (deleta e insere pra simplicidade — 1 canal por usuario)
    await fetch(`${ctx.SU}/rest/v1/tendencias_canais_conectados?user_id=eq.${auth.user.id}`, {
      method: 'DELETE', headers: ctx.h,
    });
    const insR = await fetch(`${ctx.SU}/rest/v1/tendencias_canais_conectados`, {
      method: 'POST', headers: { ...ctx.h, Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: auth.user.id, canal_id: canalId, canal_nome: canalNome, canal_thumbnail: canalThumb,
        nicho_principal: nichoPrincipal, inscritos, views_totais: viewsTotais,
        ultimo_sync: new Date().toISOString(),
        dados_canal: { ultimos_videos: ultimosVideos, snippet: ch.snippet },
      }),
    });
    const [row] = insR.ok ? await insR.json() : [];

    return res.status(200).json({
      canal: { nome: canalNome, thumbnail: canalThumb, inscritos, views_totais: viewsTotais },
      nicho_detectado: nichoPrincipal, videos_analisados: ultimosVideos.length,
      id: row?.id || null,
    });
  } catch (e) {
    console.error('[conectar-canal] erro:', e.message);
    return res.status(500).json({ error: 'Erro ao conectar canal', detalhe: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: meu-canal — analise comparativa
// ─────────────────────────────────────────────────────────────────────────────
async function actionMeuCanal(req, res, ctx) {
  const auth = await requireMaster(ctx, req.query.token);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, plan: auth.plan });

  const cr = await fetch(
    `${ctx.SU}/rest/v1/tendencias_canais_conectados?user_id=eq.${auth.user.id}&ativo=eq.true&select=*&limit=1`,
    { headers: ctx.h }
  );
  const [canal] = cr.ok ? await cr.json() : [];
  if (!canal) return res.status(404).json({ error: 'Canal nao conectado' });

  const videos = canal.dados_canal?.ultimos_videos || [];
  const nicho = canal.nicho_principal;

  // Stats do canal
  function parseDuracao(iso) {
    const m = (iso || '').match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
    return (parseInt(m?.[1] || 0) * 60) + parseInt(m?.[2] || 0);
  }
  const viewsArr = videos.map(v => v.views || 0);
  const viewsMedia = viewsArr.length ? Math.round(viewsArr.reduce((a,b) => a+b, 0) / viewsArr.length) : 0;
  const duracoes = videos.map(v => parseDuracao(v.duracao_iso)).filter(x => x > 0);
  const duracaoMedia = duracoes.length ? Math.round(duracoes.reduce((a,b) => a+b, 0) / duracoes.length) : 0;

  // Frequencia de postagens
  const dts = videos.map(v => new Date(v.publicado)).sort((a,b) => b-a);
  let postsSemana = 0;
  if (dts.length >= 2) {
    const rangeDias = (dts[0] - dts[dts.length-1]) / 86400000;
    if (rangeDias > 0) postsSemana = Math.round((dts.length / rangeDias) * 7 * 10) / 10;
  }

  // vs Mercado (pega duracao ideal e views media do nicho)
  let vsMercado = null;
  if (nicho && nicho !== 'geral') {
    const desde = new Date(Date.now() - 30*24*3600*1000).toISOString();
    const mr = await fetch(
      `${ctx.SU}/rest/v1/virais_banco?ativo=eq.true&nicho=eq.${nicho}&coletado_em=gte.${desde}&order=viral_score.desc&limit=100&select=views,duracao_segundos`,
      { headers: ctx.h }
    );
    const rows = mr.ok ? await mr.json() : [];
    if (rows.length) {
      const viewsMed = rows.reduce((s, v) => s + (v.views || 0), 0) / rows.length;
      const duracoesNicho = rows.map(r => r.duracao_segundos).filter(x => x > 0).sort((a,b) => a-b);
      const duracaoIdeal = duracoesNicho[Math.floor(duracoesNicho.length/2)] || 0;
      vsMercado = {
        views_acima_media: viewsMedia > viewsMed,
        views_media_nicho: Math.round(viewsMed),
        duracao_ideal_nicho: duracaoIdeal,
        diferenca_duracao: duracaoMedia - duracaoIdeal,
      };
    }
  }

  // Recomendacoes heuristicas
  const recs = [];
  if (vsMercado) {
    if (vsMercado.diferenca_duracao > 10) recs.push(`Reduza a duracao dos Shorts para ~${vsMercado.duracao_ideal_nicho}s (voce posta ${duracaoMedia}s, mercado prefere ${vsMercado.duracao_ideal_nicho}s).`);
    if (vsMercado.diferenca_duracao < -10) recs.push(`Aumente um pouco a duracao — videos entre ${vsMercado.duracao_ideal_nicho-5}-${vsMercado.duracao_ideal_nicho+5}s viralizam mais no seu nicho.`);
    if (!vsMercado.views_acima_media) recs.push(`Sua media de views (${viewsMedia.toLocaleString('pt-BR')}) esta abaixo da media do nicho (${vsMercado.views_media_nicho.toLocaleString('pt-BR')}). Foque nos formatos das tendencias emergentes.`);
  }
  if (postsSemana < 3) recs.push(`Aumente frequencia: poste ao menos 3x por semana (voce posta ${postsSemana}x).`);
  if (recs.length === 0) recs.push('Seu canal esta com bons fundamentos! Monitore as tendencias emergentes abaixo pra acelerar o crescimento.');

  return res.status(200).json({
    canal: {
      id: canal.canal_id, nome: canal.canal_nome, thumbnail: canal.canal_thumbnail,
      inscritos: canal.inscritos, views_totais: canal.views_totais,
      ultimo_sync: canal.ultimo_sync,
    },
    nicho_detectado: nicho,
    estatisticas: {
      views_media: viewsMedia,
      duracao_media_segundos: duracaoMedia,
      postagens_por_semana: postsSemana,
      total_videos_analisados: videos.length,
    },
    vs_mercado: vsMercado,
    recomendacoes: recs,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: sugestoes — 3 ideias personalizadas geradas pela IA
// ─────────────────────────────────────────────────────────────────────────────
async function actionSugestoes(req, res, ctx) {
  const auth = await requireMaster(ctx, req.query.token);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, plan: auth.plan });

  const cr = await fetch(
    `${ctx.SU}/rest/v1/tendencias_canais_conectados?user_id=eq.${auth.user.id}&ativo=eq.true&select=*&limit=1`,
    { headers: ctx.h }
  );
  const [canal] = cr.ok ? await cr.json() : [];
  if (!canal) return res.status(400).json({ error: 'Conecte seu canal primeiro', need_channel: true });

  const nicho = canal.nicho_principal || 'geral';
  const viewsMedia = (canal.dados_canal?.ultimos_videos || []).reduce((s,v) => s + (v.views||0), 0) / Math.max(1, (canal.dados_canal?.ultimos_videos || []).length);

  // Le tendencias emergentes do nicho
  const allEmerg = (await lerCache(ctx, 'emergentes')) || [];
  const emergentesNicho = allEmerg.filter(e => e.nicho === nicho).slice(0, 6);
  const temas = emergentesNicho.map(e => e.tema).join(', ') || 'nenhuma emergente especifica';

  const rpmMap = new Map((await lerRPM(ctx)).map(r => [r.nicho, r]));
  const rpm = rpmMap.get(nicho);
  const rpmStr = rpm ? `R$${rpm.rpm_minimo}-${rpm.rpm_maximo}` : 'R$2-5';

  const prompt = `Voce eh especialista em YouTube Shorts viral no Brasil. Meu canal eh de nicho "${nicho}", com media de ${Math.round(viewsMedia).toLocaleString('pt-BR')} views por video.

Tendencias emergentes no meu nicho agora: ${temas}

Sugira EXATAMENTE 3 ideias de Shorts com alta chance de viralizar. Responda em JSON valido com esse formato:

{"sugestoes":[{"titulo":"...","hook_3s":"...","formato":"...","potencial_views":"50k-200k","por_que_funciona":"..."}]}

Regras:
- titulo: max 60 caracteres, inclua emoji
- hook_3s: primeira frase que prende nos 3 primeiros segundos
- formato: POV / Tutorial / Lista / Reacao / Experiencia
- potencial_views: estimativa em formato "X-Yk"
- por_que_funciona: 1 frase explicando por que a ideia alinha com as tendencias

Responda SO o JSON, nada mais.`;

  let ideias = [];
  try {
    const raw = await callClaude(prompt, 'Voce retorna APENAS JSON valido. Sem texto antes ou depois.', 1200);
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      ideias = parsed.sugestoes || [];
    }
  } catch (e) {
    console.error('[sugestoes] parse erro:', e.message);
  }

  // Enriquece com RPM
  const sugestoes = ideias.map(s => ({
    ...s,
    rpm_estimado: rpmStr,
    nicho,
  }));

  return res.status(200).json({
    sugestoes,
    baseado_em: { canal: canal.canal_nome, nicho, emergentes_usadas: emergentesNicho.length },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: alertas
// ─────────────────────────────────────────────────────────────────────────────
async function actionAlertas(req, res, ctx) {
  const auth = await requireMaster(ctx, req.query.token);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, plan: auth.plan });

  const r = await fetch(
    `${ctx.SU}/rest/v1/tendencias_alertas?user_id=eq.${auth.user.id}&order=created_at.desc&limit=30&select=*`,
    { headers: ctx.h }
  );
  const alertas = r.ok ? await r.json() : [];
  return res.status(200).json({ alertas });
}

async function actionMarcarAlertaVisto(req, res, ctx) {
  const auth = await requireMaster(ctx, req.query.token);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id obrigatorio' });
  await fetch(`${ctx.SU}/rest/v1/tendencias_alertas?id=eq.${id}&user_id=eq.${auth.user.id}`, {
    method: 'PATCH', headers: ctx.h,
    body: JSON.stringify({ visualizado: true }),
  });
  return res.status(200).json({ ok: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: por-nicho — explora virais e padroes por nicho
// ─────────────────────────────────────────────────────────────────────────────
async function actionPorNicho(req, res, ctx) {
  const auth = await requireMaster(ctx, req.query.token);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, plan: auth.plan });
  const nicho = (req.query.nicho || '').toLowerCase();
  if (!nicho) return res.status(400).json({ error: 'nicho obrigatorio' });

  const desde = new Date(Date.now() - 7*24*3600*1000).toISOString();
  const vr = await fetch(
    `${ctx.SU}/rest/v1/virais_banco?ativo=eq.true&nicho=eq.${nicho}&coletado_em=gte.${desde}&order=viral_score.desc&limit=20&select=id,youtube_id,titulo,thumbnail_url,url,canal_nome,views,likes,duracao_segundos,viral_score,publicado_em`,
    { headers: ctx.h }
  );
  const videos = vr.ok ? await vr.json() : [];

  // Le analise de titulos do cache
  const titulos = await lerCache(ctx, 'titulos', nicho);

  // RPM
  const rpmMap = new Map((await lerRPM(ctx)).map(r => [r.nicho, r]));
  const rpm = rpmMap.get(nicho);

  // Duracao ideal (mediana dos top)
  const duracoes = videos.map(v => v.duracao_segundos).filter(x => x > 0).sort((a,b) => a-b);
  const duracaoIdeal = duracoes[Math.floor(duracoes.length/2)] || 0;

  return res.status(200).json({
    nicho,
    top_virais: videos,
    padroes_titulo: titulos,
    rpm: rpm ? { min: parseFloat(rpm.rpm_minimo), medio: parseFloat(rpm.rpm_medio), max: parseFloat(rpm.rpm_maximo) } : null,
    duracao_ideal_segundos: duracaoIdeal,
    total_virais: videos.length,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CRONS
// ─────────────────────────────────────────────────────────────────────────────
async function cronAtualizarTendencias(req, res, ctx) {
  try {
    const desde = new Date(Date.now() - 7*24*3600*1000).toISOString();
    // Global top 12 (sem nicho)
    const tr = await fetch(
      `${ctx.SU}/rest/v1/virais_banco?ativo=eq.true&coletado_em=gte.${desde}&order=viral_score.desc&limit=12&select=*`,
      { headers: ctx.h }
    );
    const topGlobal = tr.ok ? await tr.json() : [];
    await salvarCache(ctx, 'top_global', null, topGlobal, new Date(Date.now() + 4*3600*1000));

    // Top por nicho
    let salvos = 0;
    for (const nicho of NICHOS_PADRAO) {
      const r = await fetch(
        `${ctx.SU}/rest/v1/virais_banco?ativo=eq.true&nicho=eq.${nicho}&coletado_em=gte.${desde}&order=viral_score.desc&limit=12&select=id,youtube_id,titulo,thumbnail_url,url,canal_nome,views,viral_score,publicado_em`,
        { headers: ctx.h }
      );
      const videos = r.ok ? await r.json() : [];
      await salvarCache(ctx, 'nichos_top', nicho, videos, new Date(Date.now() + 4*3600*1000));
      salvos++;
    }
    return res.status(200).json({ ok: true, global: topGlobal.length, nichos: salvos });
  } catch (e) {
    console.error('[cron atualizar-tendencias] erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

async function cronDetectarEmergentes(req, res, ctx) {
  try {
    const emergentes = await calcularEmergentes(ctx);
    await salvarCache(ctx, 'emergentes', null, emergentes, new Date(Date.now() + 2*3600*1000));

    // Detecta saturando: keywords com muitos criadores mas velocidade em queda
    const desde = new Date(Date.now() - 14*24*3600*1000).toISOString();
    const antes = new Date(Date.now() - 48*3600*1000).toISOString();
    const r = await fetch(
      `${ctx.SU}/rest/v1/virais_banco?ativo=eq.true&publicado_em=gte.${desde}&publicado_em=lt.${antes}&order=velocidade_views.desc&limit=200&select=titulo,canal_nome,velocidade_views,nicho`,
      { headers: ctx.h }
    );
    const velhos = r.ok ? await r.json() : [];
    const clustersVelhos = new Map();
    velhos.forEach(v => {
      const k = keywordChave(v.titulo);
      if (!k || k.length < 3) return;
      if (!clustersVelhos.has(k)) clustersVelhos.set(k, { tema: k, videos: [], nicho: v.nicho });
      clustersVelhos.get(k).videos.push(v);
    });
    const saturando = [...clustersVelhos.values()]
      .filter(c => c.videos.length >= 10)
      .map(c => ({
        tema: c.tema, nicho: c.nicho,
        total_videos: c.videos.length,
        criadores: new Set(c.videos.map(v => v.canal_nome)).size,
      }))
      .sort((a, b) => b.total_videos - a.total_videos)
      .slice(0, 10);
    await salvarCache(ctx, 'saturando', null, saturando, new Date(Date.now() + 2*3600*1000));

    return res.status(200).json({ ok: true, emergentes: emergentes.length, saturando: saturando.length });
  } catch (e) {
    console.error('[cron detectar-emergentes] erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

async function cronAnalisarTitulos(req, res, ctx) {
  try {
    let calc = 0;
    for (const nicho of NICHOS_PADRAO) {
      const dados = await calcularAnaliseTitulos(ctx, nicho);
      await salvarCache(ctx, 'titulos', nicho, dados, new Date(Date.now() + 24*3600*1000));
      calc++;
    }
    return res.status(200).json({ ok: true, nichos_analisados: calc });
  } catch (e) {
    console.error('[cron analisar-titulos] erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

async function cronNotificarOportunidades(req, res, ctx) {
  try {
    const emergentes = (await lerCache(ctx, 'emergentes')) || [];
    if (emergentes.length === 0) return res.status(200).json({ ok: true, notificados: 0 });

    // Pega todos usuarios com canal conectado (Master)
    const cr = await fetch(
      `${ctx.SU}/rest/v1/tendencias_canais_conectados?ativo=eq.true&select=user_id,nicho_principal,canal_nome`,
      { headers: ctx.h }
    );
    const canais = cr.ok ? await cr.json() : [];

    let notif = 0;
    const hojeStart = new Date(); hojeStart.setHours(0,0,0,0);

    for (const canal of canais) {
      const nicho = canal.nicho_principal;
      if (!nicho || nicho === 'geral') continue;

      // Checa se ja foi notificado hoje (evita spam)
      const jaR = await fetch(
        `${ctx.SU}/rest/v1/tendencias_alertas?user_id=eq.${canal.user_id}&created_at=gte.${hojeStart.toISOString()}&select=id&limit=1`,
        { headers: ctx.h }
      );
      const jaNotificouHoje = jaR.ok && ((await jaR.json()).length > 0);
      if (jaNotificouHoje) continue;

      // Pega emergente alinhada ao nicho
      const emergNicho = emergentes.filter(e => e.nicho === nicho).slice(0, 1)[0];
      if (!emergNicho) continue;

      // Cria alerta
      await fetch(`${ctx.SU}/rest/v1/tendencias_alertas`, {
        method: 'POST', headers: { ...ctx.h, Prefer: 'return=minimal' },
        body: JSON.stringify({
          user_id: canal.user_id,
          tipo: 'emergente',
          titulo: `Oportunidade no seu nicho: "${emergNicho.tema}"`,
          descricao: `${emergNicho.crescimento_percentual}% de crescimento · ${emergNicho.criadores_no_formato} criadores · janela estimada ${emergNicho.janela_estimada_dias} dias`,
          dados: { tema: emergNicho.tema, nicho, ...emergNicho },
        }),
      });

      // Envia push (best-effort)
      try {
        const { sendPushToUser } = require('./_helpers/push.js');
        await sendPushToUser(canal.user_id, {
          title: '🚨 Oportunidade no seu nicho!',
          body: `"${emergNicho.tema}" esta crescendo ${emergNicho.crescimento_percentual}% — toque pra ver`,
          data: { route: '/bluetendencias', tipo: 'emergente', tema: emergNicho.tema },
          priority: 'high',
        });
      } catch (e) {}
      notif++;
    }
    return res.status(200).json({ ok: true, notificados: notif, total_canais: canais.length });
  } catch (e) {
    console.error('[cron notificar-oportunidades] erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: probabilidade-roteiro — usado por /roteirizar no momento da geracao
// Proxy pra virais-ml?action=predizer-viralidade em modo what-if (sem video_id)
// ─────────────────────────────────────────────────────────────────────────────
async function actionProbabilidadeRoteiro(req, res, ctx) {
  const auth = await requireMaster(ctx, req.query.token);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, plan: auth.plan });

  const titulo = req.query.titulo;
  const duracao = req.query.duracao_segundos || '30';
  const nicho = req.query.nicho || '';
  if (!titulo) return res.status(400).json({ error: 'titulo obrigatorio' });

  // Delega pro virais-ml (dentro da mesma funcao serverless pra nao fazer round-trip)
  try {
    const handler = require('./virais-ml.js');
    // Monta mock req
    const mockReq = { query: { action: 'predizer-viralidade', titulo, duracao_segundos: duracao, nicho }, method: 'GET' };
    let resolve, responseData = null, statusCode = 200;
    const mockRes = {
      setHeader: () => mockRes,
      status(c) { statusCode = c; return mockRes; },
      json(d) { responseData = d; if (resolve) resolve({ statusCode, body: d }); return mockRes; },
      end() { if (resolve) resolve({ statusCode, body: responseData }); return mockRes; },
    };
    const p = new Promise(r => { resolve = r; });
    await handler(mockReq, mockRes);
    const out = await p;
    return res.status(out.statusCode).json(out.body);
  } catch (e) {
    console.error('[probabilidade-roteiro] erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: status-ml — dados do modelo pra exibir no painel
// ─────────────────────────────────────────────────────────────────────────────
async function actionStatusML(req, res, ctx) {
  const auth = await requireMaster(ctx, req.query.token);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, plan: auth.plan });

  try {
    // Total videos
    const hR = await fetch(`${ctx.SU}/rest/v1/virais_banco?select=id`, { headers: { ...ctx.h, Prefer: 'count=exact' } });
    const totalVideos = parseInt(hR.headers.get('content-range')?.split('/')[1] || 0);

    // Clusters ativos
    const cR = await fetch(`${ctx.SU}/rest/v1/virais_clusters?ativo=eq.true&select=tipo,taxa_viralizacao,saturacao_percentual,janela_oportunidade_dias,nicho,nome`, { headers: ctx.h });
    const clusters = cR.ok ? await cR.json() : [];
    const formatos = clusters.filter(c => c.tipo === 'formato');
    const temas = clusters.filter(c => c.tipo === 'tema');

    // Ultima validacao
    const logR = await fetch(`${ctx.SU}/rest/v1/virais_modelo_log?order=executado_em.desc&limit=1&select=*`, { headers: ctx.h });
    const [log] = logR.ok ? await logR.json() : [];

    // Predicoes total
    const pR = await fetch(`${ctx.SU}/rest/v1/virais_predicoes?select=id`, { headers: { ...ctx.h, Prefer: 'count=exact' } });
    const totalPred = parseInt(pR.headers.get('content-range')?.split('/')[1] || 0);

    // Top 5 clusters tema emergentes (baixa saturacao, alta taxa)
    const topTemas = temas
      .filter(c => parseFloat(c.saturacao_percentual || 0) < 40)
      .sort((a, b) => parseFloat(b.taxa_viralizacao || 0) - parseFloat(a.taxa_viralizacao || 0))
      .slice(0, 5);

    return res.status(200).json({
      total_videos: totalVideos,
      clusters_formato: formatos.length,
      clusters_tema: temas.length,
      total_predicoes: totalPred,
      acuracia_atual: log?.acuracia ? parseFloat(log.acuracia) : null,
      ultima_validacao: log?.executado_em || null,
      top_temas_emergentes: topTemas,
    });
  } catch (e) {
    console.error('[status-ml] erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: insights-ml — recomendacoes personalizadas (proxy pro virais-ml)
// ─────────────────────────────────────────────────────────────────────────────
async function actionInsightsML(req, res, ctx) {
  const auth = await requireMaster(ctx, req.query.token);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, plan: auth.plan });

  try {
    const handler = require('./virais-ml.js');
    const mockReq = { query: { action: 'insights-para-usuario', token: req.query.token }, method: 'GET' };
    let resolve, statusCode = 200;
    const mockRes = {
      setHeader: () => mockRes,
      status(c) { statusCode = c; return mockRes; },
      json(d) { if (resolve) resolve({ statusCode, body: d }); return mockRes; },
      end() { if (resolve) resolve({ statusCode, body: null }); return mockRes; },
    };
    const p = new Promise(r => { resolve = r; });
    await handler(mockReq, mockRes);
    const out = await p;
    return res.status(out.statusCode).json(out.body);
  } catch (e) {
    console.error('[insights-ml] erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
