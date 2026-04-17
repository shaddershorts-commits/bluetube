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
  const pagina = Math.max(1, parseInt(req.query.pagina || '1', 10) || 1);
  const limite = 20;
  const offset = (pagina - 1) * limite;

  const parts = ['ativo=eq.true'];
  if (nicho  && nicho  !== 'todos' && nicho  !== '') parts.push(`nicho=eq.${encodeURIComponent(nicho)}`);
  if (idioma && idioma !== 'todos' && idioma !== '') parts.push(`idioma=eq.${encodeURIComponent(idioma)}`);
  if (pais   && pais   !== 'todos' && pais   !== '') parts.push(`pais=eq.${encodeURIComponent(pais.toUpperCase())}`);

  const orderMap = {
    views: 'views.desc',
    engajamento: 'taxa_engajamento.desc',
    score: 'viral_score.desc',
    recentes: 'coletado_em.desc',
  };
  const orderBy = orderMap[ordem] || orderMap.recentes;

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

  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
  return res.status(200).json({
    videos: videos || [],
    total,
    pagina,
    total_paginas,
    tem_mais: offset + limite < total,
  });
}
