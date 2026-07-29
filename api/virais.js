// api/virais.js — Complemento cirurgico ao algoritmo original em
// api/auth.js?action=viral-shorts (que NAO modificamos). Apenas 2 actions:
//
//   POST ?action=indexar   — cliente dispara fire-and-forget apos cada busca
//                            bem-sucedida; salva videos no banco virais_banco
//                            pra historico acumulativo.
//   GET  ?action=historico — le do banco com paginacao. Mesmos filtros que
//                            o cliente usa na busca ativa (nicho, idioma,
//                            pais, ordem).
//
// Nao interfere no fluxo original de /api/auth?action=viral-shorts.
// Se qualquer erro aqui, a busca ativa do usuario segue funcionando.
// Uses fetch direto no Supabase REST (sem @supabase/supabase-js).

const SU = process.env.SUPABASE_URL;
const SK = process.env.SUPABASE_SERVICE_KEY;
const HDR = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SU || !SK) return res.status(500).json({ error: 'config_missing' });

  const action = (req.query.action || req.body?.action || '').toLowerCase();

  try {
    if (req.method === 'POST' && action === 'indexar') return await indexarAction(req, res);
    if (req.method === 'GET'  && action === 'historico') return await historicoAction(req, res);
    return res.status(400).json({ error: 'action_invalida' });
  } catch (e) {
    console.error('[virais]', action, e.message);
    // Fail-soft: nao propaga erro pro cliente (fire-and-forget no indexar)
    return res.status(200).json({ ok: false, erro: e.message });
  }
};

// ── INDEXAR: cliente manda os videos da busca pra salvar no banco ────────
async function indexarAction(req, res) {
  const { videos, filtros } = req.body || {};
  if (!Array.isArray(videos) || !videos.length) {
    return res.status(200).json({ ok: true, salvos: 0 });
  }

  const rows = [];
  for (const v of videos) {
    const youtubeId = v.id || v.youtube_id;
    if (!youtubeId) continue;
    rows.push({
      youtube_id: youtubeId,
      titulo: (v.titulo || v.title || '').slice(0, 500),
      thumbnail_url: v.thumbnail || v.thumbnail_url || null,
      url: v.url || `https://youtube.com/shorts/${youtubeId}`,
      canal_nome: v.canal || v.channel || v.canal_nome || null,
      canal_id: v.canal_id || null,
      views: Number(v.views || 0) || 0,
      likes: Number(v.likes || 0) || 0,
      comentarios: Number(v.comentarios || v.comments || 0) || 0,
      duracao_segundos: Number(v.duracao || v.duration || 0) || 0,
      nicho: filtros?.nicho && filtros.nicho !== 'todos' ? filtros.nicho : null,
      idioma: filtros?.idioma || 'pt',
      pais: (filtros?.pais || filtros?.region || 'BR').toUpperCase(),
      hashtags: Array.isArray(v.hashtags) ? v.hashtags.slice(0, 10) : [],
      publicado_em: v.publicado_em || v.publishedAt || null,
      atualizado_em: new Date().toISOString(),
      ativo: true,
    });
  }

  if (!rows.length) return res.status(200).json({ ok: true, salvos: 0 });

  // Upsert em batch (cada chamada do cliente salva todos os videos de uma vez)
  const r = await fetch(`${SU}/rest/v1/virais_banco?on_conflict=youtube_id`, {
    method: 'POST',
    headers: { ...HDR, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    return res.status(200).json({ ok: false, salvos: 0, erro: txt.slice(0, 200) });
  }
  return res.status(200).json({ ok: true, salvos: rows.length });
}

// ── HISTORICO: le do banco com paginacao ─────────────────────────────────
async function historicoAction(req, res) {
  const nicho  = (req.query.nicho  || '').toString().trim();
  const idioma = (req.query.idioma || '').toString().trim();
  const pais   = (req.query.pais   || '').toString().trim();
  const ordem  = (req.query.ordem  || 'recentes').toLowerCase();
  const periodo = (req.query.periodo || 'todos').toString().toLowerCase(); // 5h | 24h | 7d | 30d | todos
  const pagina = Math.max(1, parseInt(req.query.pagina || '1', 10) || 1);
  const limite = 20;
  const offset = (pagina - 1) * limite;

  // ── FILTRO 5h: EXCLUSIVO MASTER (anti-bypass via curl/console) ─────────
  // Front bloqueia o botao Master-only, mas se alguem chamar a URL direto
  // sem ser master, retorna 403. Token Supabase e obrigatorio aqui.
  if (periodo === '5h') {
    const token = req.query.token || '';
    if (!token) {
      return res.status(401).json({ error: 'token_obrigatorio_filtro_5h' });
    }
    try {
      const uR = await fetch(`${SU}/auth/v1/user`, {
        headers: { apikey: process.env.SUPABASE_ANON_KEY || SK, Authorization: `Bearer ${token}` }
      });
      if (!uR.ok) return res.status(401).json({ error: 'token_invalido' });
      const user = await uR.json();
      if (!user?.email) return res.status(401).json({ error: 'sem_email' });
      // Resolve plano usando MESMA logica de get-plan (is_manual + plan_expires_at)
      const subR = await fetch(
        `${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(user.email)}&select=plan,plan_expires_at,is_manual&limit=1`,
        { headers: HDR }
      );
      const sub = subR.ok ? (await subR.json())?.[0] : null;
      const isManual = sub?.is_manual === true;
      const notExpired = !sub?.plan_expires_at || new Date(sub.plan_expires_at) > new Date();
      const planoEfetivo = (sub?.plan && sub.plan !== 'free' && (isManual || notExpired)) ? sub.plan : 'free';
      if (planoEfetivo !== 'master') {
        return res.status(403).json({
          error: 'master_only',
          message: 'Filtro 5h exclusivo do plano Master',
          current_plan: planoEfetivo,
        });
      }
    } catch (e) {
      console.error('[virais] validacao master 5h falhou:', e.message);
      return res.status(500).json({ error: 'auth_check_failed' });
    }
  }

  // Filtro de idioma agrupado: en cobre US/GB/AU, pt cobre BR/PT, es cobre ES/MX
  // (Felipe pediu UI com 1 opcao por idioma, sem variantes regionais).
  // Aceita tambem `pais` legacy (compat) — converte pra mesmo formato.
  const lang = (req.query.lang || '').toString().trim().toLowerCase();
  const LANG_AGRUPADO = {
    pt: ['BR', 'PT'],
    en: ['US', 'GB', 'AU'],
    es: ['ES', 'MX'],
    fr: ['FR'], de: ['DE'], it: ['IT'],
    ja: ['JP'], ko: ['KR'], zh: ['CN'], ru: ['RU'],
  };

  const parts = ['ativo=eq.true'];
  if (nicho  && nicho  !== 'todos' && nicho  !== '') parts.push(`nicho=eq.${encodeURIComponent(nicho)}`);
  if (idioma && idioma !== 'todos' && idioma !== '') parts.push(`idioma=eq.${encodeURIComponent(idioma)}`);

  // Resolucao: lang novo > pais legacy
  if (lang && lang !== 'todos' && LANG_AGRUPADO[lang]) {
    const paises = LANG_AGRUPADO[lang];
    if (paises.length === 1) parts.push(`pais=eq.${paises[0]}`);
    else parts.push(`pais=in.(${paises.join(',')})`);
  } else if (pais && pais !== 'todos' && pais !== '') {
    // Compat: frontend antigo ou legacy ainda passa `pais=XX`
    parts.push(`pais=eq.${encodeURIComponent(pais.toUpperCase())}`);
  }

  // Filtro por periodo de publicacao — janelas: 5h, 24h, 7d, 30d, todos.
  // 5h eh filtro MASTER-only (validado acima). Captura virais explodindo
  // em quase real-time. Demais janelas: comportamento original.
  const MS_HOUR = 3600000;
  const MS_24H = 86400000;
  const agora = Date.now();

  // ── FAIXAS, NÃO JANELAS ACUMULADAS (2026-07-29) ──────────────────────────
  // Antes cada filtro era "publicado nos últimos X" — cumulativo. Resultado:
  // um vídeo de 3 horas satisfazia TODOS os filtros ao mesmo tempo, e aparecia
  // no de 24h junto com o de 5h. Como o 5h é exclusivo do Master, a
  // exclusividade não existia na prática: quem não era Master via o mesmo
  // vídeo fresco na aba de 24h.
  //
  // Agora cada filtro é uma FAIXA fechada, e o vídeo só sai dela depois de uma
  // FOLGA (some do 5h com 6h de vida, do 24h com 26h, do 7d com 8 dias, do 30d
  // com 31). A folga existe pra ninguém "cair no vão" na virada da janela.
  //
  // Efeito colateral bom: como cada faixa termina depois do nome que carrega,
  // a regra nova é MAIS permissiva em toda idade — vídeo de 7,5 dias com 600k
  // era invisível (passava do 7d e não alcançava o piso do 30d) e agora aparece.
  const FAIXAS = {
    '5h':  { de: 6 * MS_HOUR,  ate: 0 },
    '24h': { de: 26 * MS_HOUR, ate: 6 * MS_HOUR },
    '7d':  { de: 8 * MS_24H,   ate: 26 * MS_HOUR },
    '30d': { de: 31 * MS_24H,  ate: 8 * MS_24H },
  };
  const faixa = FAIXAS[periodo];
  if (faixa) {
    parts.push(`publicado_em=gte.${new Date(agora - faixa.de).toISOString()}`);
    // o mais novo da faixa: o 5h não tem teto (é o topo da escada)
    if (faixa.ate) parts.push(`publicado_em=lt.${new Date(agora - faixa.ate).toISOString()}`);
  } else {
    // 'todos' segue cumulativo de propósito: é a válvula de escape pra ver o
    // acervo inteiro do mês sem piso de views.
    parts.push(`publicado_em=gte.${new Date(agora - 31 * MS_24H).toISOString()}`);
  }

  // ── THRESHOLDS DE VIEWS POR JANELA — APLICADO SEMPRE.
  // "Respeitar filtro": cada janela exige views minimas REAIS de viral.
  // Histórico de calibrações:
  //   Original (lançamento):    5h=60k    24h=300k   7d=2M    30d=8M
  //   2026-06-25 (user):        5h=40k    24h=180k   7d=900k  30d=3M
  //   2026-06-29 (user):        5h=30k    24h=100k   7d=500k  30d=1M
  //   2026-07-29 (user):        5h=25k    24h=100k   7d=500k  30d=1M
//   2026-07-29 (user, ATUAL): 5h=8k     24h=40k    7d=250k  30d=500k
//     Recalibrado por RITMO, nao por numero solto. Os pisos antigos exigiam
//     velocidades incoerentes entre si: 8,3 mil views/h no filtro de 5h contra
//     2,1 mil/h no de 30 dias — o filtro premium era o mais rigoroso, e por isso
//     mostrava 6 videos. Como o piso e em views ABSOLUTAS dentro de uma faixa que
//     dura horas ou dias, ele punia quem chegava cedo na faixa: um video com 999k
//     em 8,7 dias (4,8 mil/h) ficava oculto por 883 views. Agora todos os filtros
//     miram ~2,5 mil views/hora. Medido no banco: 2.237 -> 3.578 videos exibidos.
  // Banco legacy abaixo desses thresholds não aparece — comportamento intencional.
  // Cada ajuste pra baixo expõe vídeos já coletados que estavam ocultos
  // (não precisa re-coleta — o banco já tem o conteúdo).
  if (periodo === '5h')       parts.push('views=gte.8000');
  else if (periodo === '24h') parts.push('views=gte.40000');
  else if (periodo === '7d')  parts.push('views=gte.250000');
  else if (periodo === '30d') parts.push('views=gte.500000');

  // Hard limit de duracao: so Shorts ≤90s (sempre)
  parts.push('duracao_segundos=lte.90');

  // ── MODO CURADO (opt-in extra): so canais monitorados pelo Felipe.
  // Filtro adicional EM CIMA dos thresholds. Default false (mostra
  // legacy + curados se ambos baterem threshold).
  const apenasCurados = (req.query.apenas_curados || 'false').toString() === 'true';
  if (apenasCurados) parts.push('fonte=eq.canal_curado');

  const orderMap = {
    views: 'views.desc',
    engajamento: 'taxa_engajamento.desc',
    score: 'viral_score.desc',
    recentes: 'coletado_em.desc',
    // 'bombando' (default novo): combina score_viralidade do ML +
    // velocidade_views_24h pra mostrar o que esta crescendo AGORA em vez do
    // que ja foi coletado. score_viralidade.nullslast garante que videos
    // ainda nao processados pelo ML caem pro fim (nao polua o topo).
    bombando: 'score_viralidade.desc.nullslast,velocidade_views_24h.desc.nullslast,coletado_em.desc',
  };
  // Default = 'bombando' pra re-ranking inteligente. EXCECAO: filtro 5h
  // forca sort por views.desc — janela apertada, user quer ver MAIORES
  // primeiro (vídeo com 800k aparece antes do com 70k).
  const ordemEfetiva = (periodo === '5h' && !req.query.ordem) ? 'views' : ordem;
  const orderBy = orderMap[ordemEfetiva] || orderMap.bombando;

  const select = 'id,youtube_id,titulo,thumbnail_url,url,canal_nome,views,likes,comentarios,duracao_segundos,taxa_engajamento,viral_score,nicho,idioma,pais,publicado_em,coletado_em';
  const qs = `${parts.join('&')}&order=${orderBy}&select=${select}`;

  // Pedir count total + paginacao via Range header
  const headers = {
    ...HDR,
    Prefer: 'count=exact',
    Range: `${offset}-${offset + limite - 1}`,
    'Range-Unit': 'items',
  };

  const r = await fetch(`${SU}/rest/v1/virais_banco?${qs}`, { headers });
  if (!r.ok) {
    return res.status(200).json({ videos: [], total: 0, pagina, total_paginas: 0, tem_mais: false });
  }

  const videos = await r.json();
  const cr = r.headers.get('content-range') || '';
  const m = cr.match(/\/(\d+)$/);
  const total = m ? parseInt(m[1], 10) : videos.length;
  const total_paginas = Math.max(1, Math.ceil(total / limite));

  res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
  return res.status(200).json({
    videos: videos || [],
    total,
    pagina,
    total_paginas,
    tem_mais: offset + limite < total,
    periodo_aplicado: periodo,
    // bordas da faixa em horas de idade do vídeo (o mais novo e o mais velho
    // que este filtro aceita) — antes era um número só, quando a janela ainda
    // era cumulativa
    faixa_horas: faixa
      ? { entra_com: Math.round(faixa.ate / 3600000), sai_com: Math.round(faixa.de / 3600000) }
      : { entra_com: 0, sai_com: 31 * 24 },
  });
}
