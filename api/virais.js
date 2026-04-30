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
  let desdeMs;
  if (periodo === '5h')         desdeMs = 5 * MS_HOUR;
  else if (periodo === '24h')   desdeMs = 1 * MS_24H;
  else if (periodo === '7d')    desdeMs = 7 * MS_24H;
  else                          desdeMs = 30 * MS_24H; // 30d | todos
  const desde = new Date(agora - desdeMs).toISOString();
  parts.push(`publicado_em=gte.${desde}`);

  // ── THRESHOLDS DE VIEWS POR JANELA — APLICADO SEMPRE.
  // "Respeitar filtro": cada janela exige views minimas REAIS de viral.
  //   5h  ≥ 60k  (master only — calibrado pra 147 canais, ~240k/dia ritmo)
  //   24h ≥ 300k
  //   7d  ≥ 2M
  //   30d ≥ 8M
  // Banco legacy abaixo desses thresholds nao aparece — comportamento
  // intencional, ferramenta vira "virais de verdade".
  if (periodo === '5h')       parts.push('views=gte.60000');
  else if (periodo === '24h') parts.push('views=gte.300000');
  else if (periodo === '7d')  parts.push('views=gte.2000000');
  else if (periodo === '30d') parts.push('views=gte.8000000');

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
    limite_horas: Math.round(desdeMs / 3600000),
  });
}
