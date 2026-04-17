// api/virais.js — Feed de Shorts virais lido do banco virais_banco.
// Zero cota YouTube: os crons em /api/virais-coletor alimentam o banco,
// este endpoint apenas le. Usuario Full/Master tem acesso.
//
// Actions:
//   GET ?action=feed&nicho=X&idioma=Y&ordem=Z&cursor=...&token=TOKEN
//   GET ?action=stats&token=TOKEN
//
// NUNCA modifica api/auth.js.

const SU = process.env.SUPABASE_URL;
const SK = process.env.SUPABASE_SERVICE_KEY;
const AK = process.env.SUPABASE_ANON_KEY || SK;

const HDR = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SU || !SK) return res.status(500).json({ error: 'config_missing' });

  const action = req.query.action || 'feed';
  const token = req.query.token;

  // Valida token + plano (Full ou Master) — nao usa auth.js
  if (!token) return res.status(401).json({ error: 'token_obrigatorio' });
  try {
    const uR = await fetch(`${SU}/auth/v1/user`, {
      headers: { apikey: AK, Authorization: 'Bearer ' + token },
    });
    if (!uR.ok) return res.status(401).json({ error: 'token_invalido' });
    const u = await uR.json();
    // Busca plano do subscriber
    const sR = await fetch(
      `${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent((u.email || '').toLowerCase())}&select=plan&limit=1`,
      { headers: HDR }
    );
    const [sub] = sR.ok ? await sR.json() : [];
    const plan = sub?.plan || 'free';
    if (plan !== 'full' && plan !== 'master') {
      return res.status(403).json({ error: 'plano_insuficiente', mensagem: 'Assinatura Full ou Master necessaria.' });
    }
  } catch (e) {
    return res.status(401).json({ error: 'token_invalido' });
  }

  try {
    if (action === 'stats') return await statsFeed(res);
    if (action === 'feed')  return await listFeed(req, res);
    return res.status(400).json({ error: 'action_invalida' });
  } catch (e) {
    console.error('[virais]', action, e.message);
    return res.status(500).json({ error: e.message });
  }
};

async function listFeed(req, res) {
  const nicho = (req.query.nicho || 'todos').toLowerCase();
  const idioma = (req.query.idioma || 'todos').toLowerCase();
  const pais = (req.query.pais || 'BR').toUpperCase(); // default BR
  const ordem = (req.query.ordem || 'coletado').toLowerCase();
  const periodo = (req.query.periodo || 'todos').toLowerCase(); // 24h | 7d | 30d | todos
  const cursor = req.query.cursor || null;
  const limite = Math.min(50, parseInt(req.query.limit || '20', 10));

  const parts = ['ativo=eq.true'];
  if (nicho !== 'todos') parts.push(`nicho=eq.${encodeURIComponent(nicho)}`);
  if (idioma !== 'todos') parts.push(`idioma=eq.${encodeURIComponent(idioma)}`);
  if (pais !== 'TODOS') parts.push(`pais=eq.${encodeURIComponent(pais)}`);

  if (periodo === '24h') parts.push(`publicado_em=gte.${new Date(Date.now() - 86400000).toISOString()}`);
  else if (periodo === '7d')  parts.push(`publicado_em=gte.${new Date(Date.now() - 7*86400000).toISOString()}`);
  else if (periodo === '30d') parts.push(`publicado_em=gte.${new Date(Date.now() - 30*86400000).toISOString()}`);

  // Mapeamento da ordenacao
  const orderMap = {
    viral_score: 'viral_score.desc',
    views: 'views.desc',
    recentes: 'publicado_em.desc',
    engajamento: 'taxa_engajamento.desc',
    coletado: 'coletado_em.desc',
  };
  const orderBy = orderMap[ordem] || orderMap.coletado;
  const [orderCol] = orderBy.split('.');

  // Cursor: valor do orderCol do ultimo item da pagina anterior
  if (cursor) {
    // cursor eh sempre um ISO date ou numero — dependendo da coluna
    if (orderCol === 'views' || orderCol === 'viral_score' || orderCol === 'taxa_engajamento') {
      parts.push(`${orderCol}=lt.${encodeURIComponent(cursor)}`);
    } else {
      parts.push(`${orderCol}=lt.${encodeURIComponent(cursor)}`);
    }
  }

  const select = 'id,youtube_id,titulo,thumbnail_url,url,canal_id,canal_nome,views,likes,comentarios,duracao_segundos,taxa_engajamento,viral_score,velocidade_views,nicho,idioma,pais,hashtags,publicado_em,coletado_em';
  const qs = `${parts.join('&')}&order=${orderBy}&limit=${limite}&select=${select}`;
  const r = await fetch(`${SU}/rest/v1/virais_banco?${qs}`, { headers: HDR });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    return res.status(502).json({ error: 'erro_banco', detalhe: t.slice(0, 200) });
  }
  const videos = await r.json();

  // Proximo cursor eh o valor do orderCol do ultimo item
  const last = videos[videos.length - 1];
  let nextCursor = null;
  if (last && videos.length >= limite) {
    nextCursor = last[orderCol];
  }

  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
  return res.status(200).json({
    videos,
    cursor: nextCursor,
    has_more: !!nextCursor,
    filtros: { nicho, idioma, pais, ordem, periodo },
  });
}

async function statsFeed(res) {
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
  const porNichoR = await fetch(
    `${SU}/rest/v1/virais_banco?nicho=not.is.null&select=nicho&limit=10000`,
    { headers: HDR }
  );
  const porNicho = porNichoR.ok ? await porNichoR.json() : [];
  const nichoCount = {};
  porNicho.forEach(v => { if (v.nicho) nichoCount[v.nicho] = (nichoCount[v.nicho] || 0) + 1; });

  // Ultima coleta
  const ultR = await fetch(
    `${SU}/rest/v1/virais_coletas_log?order=created_at.desc&limit=1&select=created_at`,
    { headers: HDR }
  );
  const [ult] = ultR.ok ? await ultR.json() : [];

  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
  return res.status(200).json({
    total_videos: totalVideos,
    adicionados_hoje: adicionadosHoje,
    por_nicho: nichoCount,
    ultima_atualizacao: ult?.created_at || null,
  });
}
