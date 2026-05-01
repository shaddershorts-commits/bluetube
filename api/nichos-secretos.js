// api/nichos-secretos.js
//
// Feature MASTER-only "Nichos Secretos" — sistema TOTALMENTE ISOLADO
// da ferramenta Virais normal. Tabelas separadas, endpoint separado,
// pool de chaves YouTube separado. Falha em um nao derruba o outro.
//
// Actions:
//   POST   ?action=adicionar       — admin (Bearer): URL → resolve → INSERT
//   DELETE ?action=remover         — admin (Bearer): soft (ativo=false)
//   GET    ?action=listar          — admin (Bearer): canais com stats
//   GET    ?action=coletar         — cron 3x/dia: fetch profundidade 100 + upsert
//   GET    ?action=historico       — Master only: top virais (>=10M, 45d, ≤90s)
//
// Threshold publico: views >= 10M, publicado_em >= NOW - 45d, duracao ≤ 90s
// Cron: schedule 0 6,14,22 * * * (3x/dia UTC = 3h, 11h, 19h BRT)
// Profundidade: 100 videos/canal por execucao (paginacao automatica via pageToken)
// Pool YouTube: 'secretos' exclusivo (YOUTUBE_API_KEY_SECRETOS_1..3)
// Limite soft: 100 canais ativos.

const { youtubeRequest } = require('./_helpers/youtube.js');

const SU = process.env.SUPABASE_URL;
const SK = process.env.SUPABASE_SERVICE_KEY;
const AK = process.env.SUPABASE_ANON_KEY || SK;

const HDR = SK ? { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' } : null;

const LIMITE_CANAIS = 100;
const POOL_YT = 'secretos'; // pool exclusivo de chaves YouTube
const PROFUNDIDADE_PADRAO = 100;
const THRESHOLD_VIEWS = 10000000; // 10M
const JANELA_DIAS = 45;

// ── HELPERS DE AUTH ─────────────────────────────────────────────────────────
function assertAdmin(req) {
  const auth = (req.headers && req.headers.authorization) || '';
  const secret = process.env.ADMIN_SECRET || '';
  if (!secret) return false;
  return auth === `Bearer ${secret}`;
}

async function getUserFromToken(token) {
  if (!token) return null;
  try {
    const r = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function isMaster(token) {
  const user = await getUserFromToken(token);
  if (!user || !user.email) return { ok: false, reason: 'invalid_token' };
  try {
    const r = await fetch(
      `${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(user.email)}&select=plan,plan_expires_at,is_manual&limit=1`,
      { headers: HDR }
    );
    if (!r.ok) return { ok: false, reason: 'sub_query_failed' };
    const sub = (await r.json())?.[0];
    if (!sub) return { ok: false, reason: 'sub_not_found', plan: 'free' };
    const isManual = sub.is_manual === true;
    const notExpired = !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date();
    const planoEfetivo = (sub.plan && sub.plan !== 'free' && (isManual || notExpired)) ? sub.plan : 'free';
    return { ok: planoEfetivo === 'master', plan: planoEfetivo, email: user.email };
  } catch { return { ok: false, reason: 'auth_check_failed' }; }
}

// ── HELPERS SUPABASE ────────────────────────────────────────────────────────
async function supaSelect(path) {
  const r = await fetch(`${SU}/rest/v1/${path}`, { headers: HDR });
  if (!r.ok) return null;
  return r.json();
}
async function supaPatch(path, body) {
  return fetch(`${SU}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...HDR, Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
}

// ── PARSER URL CANAL (igual virais-canais.js — duplicado pra isolamento) ────
function parseChannelUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  let s = trimmed;
  try {
    const decoded = decodeURIComponent(trimmed);
    if (decoded && decoded !== trimmed) s = decoded;
  } catch {}
  let m = s.match(/(?:youtube\.com\/channel\/|^)(UC[A-Za-z0-9_-]{20,30})\b/i);
  if (m) return { type: 'id', value: m[1] };
  m = s.match(/@([\wÀ-￿.-]+)/);
  if (m) return { type: 'handle', value: '@' + m[1] };
  m = s.match(/youtube\.com\/(?:c|user)\/([\wÀ-￿.-]+)/i);
  if (m) return { type: 'legacy', value: m[1] };
  if (/^[\wÀ-￿.-]+$/.test(s)) return { type: 'handle', value: '@' + s };
  return null;
}

async function resolveChannelMetadata(parsed) {
  try {
    let resp;
    const part = 'id,snippet,statistics';
    if (parsed.type === 'id') {
      resp = await youtubeRequest('channels', { part, id: parsed.value }, { pool: POOL_YT });
    } else if (parsed.type === 'handle') {
      resp = await youtubeRequest('channels', { part, forHandle: parsed.value }, { pool: POOL_YT });
    } else if (parsed.type === 'legacy') {
      resp = await youtubeRequest('channels', { part, forUsername: parsed.value }, { pool: POOL_YT });
    }
    const item = resp?.items?.[0];
    if (!item) return null;
    return {
      channel_id: item.id,
      name: item.snippet?.title || null,
      handle: item.snippet?.customUrl ? '@' + item.snippet.customUrl.replace(/^@/, '') : (parsed.type === 'handle' ? parsed.value : null),
      thumbnail_url: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || null,
      total_inscritos: parseInt(item.statistics?.subscriberCount || 0, 10) || null,
    };
  } catch (e) {
    console.error('[nichos-secretos] resolveChannelMetadata erro:', e.message);
    return null;
  }
}

function parseDuracao(duration) {
  if (!duration) return 0;
  const m = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

// ── HANDLER ─────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (!SU || !SK) return res.status(500).json({ error: 'config_missing' });
  const action = req.query?.action || (req.body && req.body.action) || '';
  try {
    switch (action) {
      case 'adicionar': return await adicionarCanal(req, res);
      case 'remover':   return await removerCanal(req, res);
      case 'listar':    return await listarCanais(req, res);
      case 'coletar':   return await coletarCanaisSecretos(req, res);
      case 'historico': return await historicoSecretos(req, res);
      default:          return res.status(400).json({ error: 'action_invalida' });
    }
  } catch (e) {
    console.error('[nichos-secretos]', action, e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ── adicionar (admin) ──────────────────────────────────────────────────────
async function adicionarCanal(req, res) {
  if (!assertAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST_apenas' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const url = (body.url || '').trim();
  if (!url) return res.status(400).json({ error: 'url_obrigatorio' });

  // Limite soft
  try {
    const countR = await fetch(`${SU}/rest/v1/virais_canais_secretos?ativo=eq.true&select=id`, {
      headers: { ...HDR, Prefer: 'count=exact', Range: '0-0' },
    });
    const cr = countR.headers.get('content-range') || '';
    const m = cr.match(/\/(\d+)$/);
    const total = m ? parseInt(m[1], 10) : 0;
    if (total >= LIMITE_CANAIS) {
      return res.status(400).json({ error: 'limite_canais_atingido', limite: LIMITE_CANAIS, atual: total });
    }
  } catch {}

  const parsed = parseChannelUrl(url);
  if (!parsed) return res.status(400).json({ error: 'url_invalida', hint: 'use https://youtube.com/@nome ou /channel/UCxxx' });

  const meta = await resolveChannelMetadata(parsed);
  if (!meta || !meta.channel_id) {
    return res.status(404).json({ error: 'canal_nao_encontrado', parsed });
  }

  const payload = {
    channel_id: meta.channel_id,
    channel_handle: meta.handle,
    channel_name: meta.name,
    channel_url: url,
    thumbnail_url: meta.thumbnail_url,
    total_inscritos: meta.total_inscritos,
    ativo: true,
  };
  const r = await fetch(`${SU}/rest/v1/virais_canais_secretos?on_conflict=channel_id`, {
    method: 'POST',
    headers: { ...HDR, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    return res.status(500).json({ error: 'insert_failed', detail: txt.slice(0, 200) });
  }
  const saved = await r.json().catch(() => null);
  return res.status(200).json({
    ok: true,
    canal: Array.isArray(saved) ? saved[0] : saved,
    meta,
  });
}

// ── remover (admin) ────────────────────────────────────────────────────────
async function removerCanal(req, res) {
  if (!assertAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const channelId = (body.channel_id || req.query?.channel_id || '').trim();
  if (!channelId) return res.status(400).json({ error: 'channel_id_obrigatorio' });
  const r = await supaPatch(`virais_canais_secretos?channel_id=eq.${encodeURIComponent(channelId)}`, { ativo: false });
  if (!r.ok) return res.status(500).json({ error: 'patch_failed', status: r.status });
  return res.status(200).json({ ok: true, channel_id: channelId, ativo: false });
}

// ── listar (admin) ─────────────────────────────────────────────────────────
async function listarCanais(req, res) {
  if (!assertAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  const apenasAtivos = req.query?.ativo !== 'false';
  const filtro = apenasAtivos ? 'ativo=eq.true&' : '';
  const r = await fetch(
    `${SU}/rest/v1/virais_canais_secretos?${filtro}order=added_at.desc&select=*`,
    { headers: HDR }
  );
  const items = r.ok ? await r.json() : [];
  return res.status(200).json({ ok: true, total: items.length, canais: items });
}

// ── coletar (cron + dispatch manual) ────────────────────────────────────────
// Pra cada canal ativo: pega ate `profundidade` videos via playlist uploads
// (com paginacao se >50), filtra Shorts ≤90s, salva em virais_banco_secretos.
// Pool de chaves: 'secretos' (exclusivo).
async function coletarCanaisSecretos(req, res) {
  const startTs = Date.now();
  const profundidade = Math.min(200, Math.max(20, parseInt(req.query?.profundidade, 10) || PROFUNDIDADE_PADRAO));
  const log = { canais_processados: 0, videos_processados: 0, erros: 0, profundidade, pool: POOL_YT };

  try {
    const r = await fetch(
      `${SU}/rest/v1/virais_canais_secretos?ativo=eq.true&order=ultimo_check.asc.nullsfirst&select=id,channel_id,channel_name&limit=200`,
      { headers: HDR }
    );
    const canais = r.ok ? await r.json() : [];

    for (const canal of canais) {
      try {
        log.canais_processados++;
        const uploadsId = canal.channel_id.replace(/^UC/, 'UU');

        // Paginacao playlistItems pra pegar > 50 videos
        let videoIds = [];
        let pageToken = '';
        const paginas = Math.ceil(profundidade / 50);
        for (let i = 0; i < paginas; i++) {
          const params = { part: 'contentDetails', playlistId: uploadsId, maxResults: 50 };
          if (pageToken) params.pageToken = pageToken;
          const plR = await youtubeRequest('playlistItems', params, { pool: POOL_YT });
          const ids = (plR?.items || []).map(it => it.contentDetails?.videoId).filter(Boolean);
          videoIds = videoIds.concat(ids);
          pageToken = plR?.nextPageToken || '';
          if (!pageToken) break; // canal nao tem mais
          if (videoIds.length >= profundidade) break;
        }
        videoIds = videoIds.slice(0, profundidade);
        if (!videoIds.length) continue;

        // Batch fetch stats — videos aceita ate 50 IDs por chamada
        const items = [];
        for (let i = 0; i < videoIds.length; i += 50) {
          const chunk = videoIds.slice(i, i + 50);
          const vR = await youtubeRequest('videos', {
            part: 'snippet,contentDetails,statistics',
            id: chunk.join(','),
            maxResults: 50,
          }, { pool: POOL_YT });
          items.push(...(vR?.items || []));
        }

        // Normaliza
        const rows = [];
        for (const item of items) {
          const duracao = parseDuracao(item.contentDetails?.duration);
          if (duracao === 0 || duracao > 90) continue;
          const snippet = item.snippet || {};
          const stats = item.statistics || {};
          const yid = item.id;
          if (!yid) continue;
          const views = Number(stats.viewCount || 0);
          const likes = Number(stats.likeCount || 0);
          const coment = Number(stats.commentCount || 0);
          const taxa = views > 0 ? +(((likes + coment) / views) * 100).toFixed(4) : 0;
          rows.push({
            youtube_id: yid,
            titulo: (snippet.title || '').slice(0, 500),
            thumbnail_url: snippet.thumbnails?.maxres?.url || snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || null,
            url: `https://youtube.com/shorts/${yid}`,
            canal_id: snippet.channelId || canal.channel_id,
            canal_nome: snippet.channelTitle || canal.channel_name,
            views, likes, comentarios: coment,
            duracao_segundos: duracao,
            taxa_engajamento: taxa,
            publicado_em: snippet.publishedAt || null,
            ativo: true,
            canal_secreto_id: canal.id,
            atualizado_em: new Date().toISOString(),
          });
        }

        if (rows.length) {
          const upR = await fetch(`${SU}/rest/v1/virais_banco_secretos?on_conflict=youtube_id`, {
            method: 'POST',
            headers: { ...HDR, Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(rows),
          });
          if (upR.ok) {
            log.videos_processados += rows.length;
          } else {
            log.erros++;
          }
        }

        await supaPatch(`virais_canais_secretos?id=eq.${canal.id}`, {
          ultimo_check: new Date().toISOString(),
          videos_coletados: (canal.videos_coletados || 0) + rows.length,
        });
      } catch (e) {
        log.erros++;
        console.error('[nichos-secretos:coletar]', canal.channel_id, e.message);
      }
    }

    return res.status(200).json({ ok: true, duracao_ms: Date.now() - startTs, ...log });
  } catch (e) {
    return res.status(500).json({ error: e.message, ...log });
  }
}

// ── historico (Master only) ─────────────────────────────────────────────────
// Filtros publicos: views >= 10M, publicado_em >= NOW - 45d, duracao ≤ 90s
// Sem filtros de idioma/nicho/periodo (feature DESCOBERTA, nao curadoria).
async function historicoSecretos(req, res) {
  const token = req.query?.token || '';
  if (!token) return res.status(401).json({ error: 'token_obrigatorio' });

  const auth = await isMaster(token);
  if (!auth.ok) {
    return res.status(403).json({
      error: 'master_only',
      message: 'Nichos Secretos exclusivo Master',
      current_plan: auth.plan || 'free',
      reason: auth.reason,
    });
  }

  const pagina = Math.max(1, parseInt(req.query.pagina || '1', 10) || 1);
  const limite = 20;
  const offset = (pagina - 1) * limite;

  const desde = new Date(Date.now() - JANELA_DIAS * 86400000).toISOString();
  const select = 'id,youtube_id,titulo,thumbnail_url,url,canal_nome,views,likes,comentarios,duracao_segundos,taxa_engajamento,publicado_em,coletado_em';
  const qs = [
    'ativo=eq.true',
    `views=gte.${THRESHOLD_VIEWS}`,
    `publicado_em=gte.${desde}`,
    'duracao_segundos=lte.90',
    `order=views.desc`, // sempre ordena por views (maior primeiro)
    `select=${select}`,
  ].join('&');

  const headers = { ...HDR, Prefer: 'count=exact', Range: `${offset}-${offset + limite - 1}`, 'Range-Unit': 'items' };
  const r = await fetch(`${SU}/rest/v1/virais_banco_secretos?${qs}`, { headers });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    console.error('[nichos-secretos:historico] query failed:', r.status, txt.slice(0, 200));
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
    threshold_views: THRESHOLD_VIEWS,
    janela_dias: JANELA_DIAS,
  });
}
