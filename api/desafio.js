// api/desafio.js — Desafio BlueTube: competição de views entre criadores.
//
// Actions:
//   POST ?action=adicionar-canal   — admin: inscreve canal no desafio
//   POST ?action=remover-canal     — admin: remove canal (soft delete)
//   GET  ?action=listar-canais     — admin: lista participantes
//   GET  ?action=coletar           — cron 30min: busca shorts dos participantes
//   GET  ?action=atualizar-metricas— cron 5min: refresh views/likes
//   GET  ?action=ranking           — público: top 20 por views (7 dias)
//   GET  ?action=config            — público: datas/prêmio/status do desafio
//
// Usa pool 'virais' do YouTube helper (mesmas chaves). Poucos canais = quota mínima.

const { youtubeRequest } = require('./_helpers/youtube.js');

const SU = process.env.SUPABASE_URL;
const SK = process.env.SUPABASE_SERVICE_KEY;
const HDR = SK ? { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' } : null;

// ── CONFIG DO DESAFIO (alterar pra cada edição) ────────────────────────────
const DESAFIO_CONFIG = {
  nome: 'Desafio BlueTube #1',
  descricao: 'O Shorts com mais views em 7 dias leva R$500 no Pix!',
  premio: 'R$ 500,00',
  premio_valor: 500,
  inicio: '2026-05-12T00:00:00-03:00',  // segunda-feira
  fim: '2026-05-18T23:59:59-03:00',      // domingo
  max_ranking: 20,
};

function desafioAtivo() {
  const now = Date.now();
  return now >= new Date(DESAFIO_CONFIG.inicio).getTime() && now <= new Date(DESAFIO_CONFIG.fim).getTime();
}

function desafioEncerrado() {
  return Date.now() > new Date(DESAFIO_CONFIG.fim).getTime();
}

function assertAdmin(req) {
  const auth = (req.headers && req.headers.authorization) || '';
  const secret = process.env.ADMIN_SECRET || '';
  return secret && auth === `Bearer ${secret}`;
}

function parseDuracao(duration) {
  if (!duration) return 0;
  const m = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!SU || !SK) return res.status(500).json({ error: 'config_missing' });

  const action = req.query?.action || (req.body && req.body.action) || '';

  try {
    switch (action) {
      case 'adicionar-canal':    return await adicionarCanal(req, res);
      case 'remover-canal':      return await removerCanal(req, res);
      case 'listar-canais':      return await listarCanais(req, res);
      case 'coletar':            return await coletar(req, res);
      case 'atualizar-metricas': return await atualizarMetricas(req, res);
      case 'ranking':            return await ranking(req, res);
      case 'config':             return await configAction(req, res);
      default:                   return res.status(400).json({ error: 'action_invalida' });
    }
  } catch (e) {
    console.error('[desafio]', action, e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ── CONFIG (público) ────────────────────────────────────────────────────────
async function configAction(req, res) {
  const now = Date.now();
  const inicio = new Date(DESAFIO_CONFIG.inicio).getTime();
  const fim = new Date(DESAFIO_CONFIG.fim).getTime();
  let status = 'aguardando';
  if (now >= inicio && now <= fim) status = 'ativo';
  else if (now > fim) status = 'encerrado';

  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
  return res.status(200).json({
    ...DESAFIO_CONFIG,
    status,
    restante_ms: status === 'ativo' ? fim - now : 0,
    server_time: new Date().toISOString(),
  });
}

// ── ADICIONAR CANAL (admin) ─────────────────────────────────────────────────
async function adicionarCanal(req, res) {
  if (!assertAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  const body = req.body || {};
  const url = (body.url || '').trim();
  if (!url) return res.status(400).json({ error: 'url_obrigatorio' });

  // Parse URL do canal (reutiliza lógica do virais-canais)
  let channelId = null, handle = null;

  // Tenta extrair channel ID direto
  let m = url.match(/(?:youtube\.com\/channel\/|^)(UC[A-Za-z0-9_-]{20,30})\b/i);
  if (m) { channelId = m[1]; }
  else {
    // @handle
    let decoded = url;
    try { decoded = decodeURIComponent(url); } catch {}
    m = decoded.match(/@([\wÀ-￿.-]+)/);
    if (m) handle = '@' + m[1];
    else {
      m = decoded.match(/youtube\.com\/(?:c|user)\/([\wÀ-￿.-]+)/i);
      if (m) handle = m[1];
      else if (/^[\wÀ-￿.-]+$/.test(decoded)) handle = '@' + decoded;
    }
  }

  if (!channelId && !handle) return res.status(400).json({ error: 'url_invalida' });

  // Resolve metadata via YouTube API
  const part = 'id,snippet,statistics';
  let resp;
  if (channelId) resp = await youtubeRequest('channels', { part, id: channelId });
  else resp = await youtubeRequest('channels', { part, forHandle: handle });

  const item = resp?.items?.[0];
  if (!item) return res.status(404).json({ error: 'canal_nao_encontrado' });

  const payload = {
    channel_id: item.id,
    channel_handle: item.snippet?.customUrl ? '@' + item.snippet.customUrl.replace(/^@/, '') : handle,
    channel_name: item.snippet?.title || null,
    channel_thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || null,
    total_inscritos: parseInt(item.statistics?.subscriberCount || 0, 10) || 0,
    ativo: true,
  };

  const r = await fetch(`${SU}/rest/v1/desafio_participantes`, {
    method: 'POST',
    headers: { ...HDR, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    // Tenta upsert se já existe
    const r2 = await fetch(`${SU}/rest/v1/desafio_participantes?channel_id=eq.${encodeURIComponent(item.id)}`, {
      method: 'PATCH',
      headers: { ...HDR, Prefer: 'return=representation' },
      body: JSON.stringify({ ...payload, ativo: true }),
    });
    if (!r2.ok) return res.status(500).json({ error: 'erro_salvar' });
    const saved = await r2.json();
    return res.status(200).json({ ok: true, canal: Array.isArray(saved) ? saved[0] : saved, reativado: true });
  }

  const saved = await r.json();
  return res.status(200).json({ ok: true, canal: Array.isArray(saved) ? saved[0] : saved });
}

// ── REMOVER CANAL (admin) ───────────────────────────────────────────────────
async function removerCanal(req, res) {
  if (!assertAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  const body = req.body || {};
  const channelId = (body.channel_id || req.query?.channel_id || '').trim();
  if (!channelId) return res.status(400).json({ error: 'channel_id_obrigatorio' });
  await fetch(`${SU}/rest/v1/desafio_participantes?channel_id=eq.${encodeURIComponent(channelId)}`, {
    method: 'PATCH', headers: HDR,
    body: JSON.stringify({ ativo: false }),
  });
  return res.status(200).json({ ok: true });
}

// ── LISTAR CANAIS (admin) ───────────────────────────────────────────────────
async function listarCanais(req, res) {
  if (!assertAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  const r = await fetch(`${SU}/rest/v1/desafio_participantes?order=adicionado_em.desc&select=*`, { headers: HDR });
  const items = r.ok ? await r.json() : [];
  return res.status(200).json({ ok: true, total: items.length, participantes: items });
}

// ── COLETAR (cron 30min) ────────────────────────────────────────────────────
// Busca últimos 50 vídeos de cada participante ativo, filtra Shorts ≤90s
// publicados dentro do período do desafio, upsert em desafio_videos.
async function coletar(req, res) {
  // Skip se desafio já encerrou (não gasta quota à toa)
  if (desafioEncerrado()) return res.status(200).json({ ok: true, skipped: 'desafio_encerrado' });

  const inicio = new Date(DESAFIO_CONFIG.inicio);
  const fim = new Date(DESAFIO_CONFIG.fim);
  const log = { participantes: 0, videos_novos: 0, erros: 0 };

  const r = await fetch(
    `${SU}/rest/v1/desafio_participantes?ativo=eq.true&select=id,channel_id,channel_name&limit=100`,
    { headers: HDR }
  );
  const participantes = r.ok ? await r.json() : [];

  for (const p of participantes) {
    try {
      log.participantes++;
      const uploadsId = p.channel_id.replace(/^UC/, 'UU');

      const plR = await youtubeRequest('playlistItems', {
        part: 'contentDetails',
        playlistId: uploadsId,
        maxResults: 50,
      });
      const ids = (plR?.items || []).map(it => it.contentDetails?.videoId).filter(Boolean);
      if (!ids.length) continue;

      const vR = await youtubeRequest('videos', {
        part: 'snippet,contentDetails,statistics',
        id: ids.join(','),
        maxResults: 50,
      });
      const items = vR?.items || [];

      const rows = [];
      for (const item of items) {
        const duracao = parseDuracao(item.contentDetails?.duration);
        if (duracao === 0 || duracao > 90) continue;
        const snippet = item.snippet || {};
        const stats = item.statistics || {};
        const pubDate = snippet.publishedAt ? new Date(snippet.publishedAt) : null;
        // Só vídeos publicados dentro do período do desafio
        if (!pubDate || pubDate < inicio || pubDate > fim) continue;

        rows.push({
          youtube_id: item.id,
          participante_id: p.id,
          titulo: (snippet.title || '').slice(0, 500),
          thumbnail_url: snippet.thumbnails?.maxres?.url || snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || null,
          url: `https://youtube.com/shorts/${item.id}`,
          canal_nome: snippet.channelTitle || p.channel_name,
          canal_id: p.channel_id,
          views: Number(stats.viewCount || 0),
          likes: Number(stats.likeCount || 0),
          comentarios: Number(stats.commentCount || 0),
          duracao_segundos: duracao,
          publicado_em: snippet.publishedAt,
          atualizado_em: new Date().toISOString(),
          ativo: true,
        });
      }

      if (rows.length) {
        const upR = await fetch(`${SU}/rest/v1/desafio_videos?on_conflict=youtube_id`, {
          method: 'POST',
          headers: { ...HDR, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows),
        });
        if (upR.ok) log.videos_novos += rows.length;
        else log.erros++;
      }
    } catch (e) {
      log.erros++;
      console.error('[desafio:coletar]', p.channel_id, e.message);
    }
  }

  return res.status(200).json({ ok: true, ...log });
}

// ── ATUALIZAR MÉTRICAS (cron 5min) ──────────────────────────────────────────
// Refresh views/likes de TODOS os vídeos do desafio (poucos = barato).
async function atualizarMetricas(req, res) {
  if (desafioEncerrado()) return res.status(200).json({ ok: true, skipped: 'desafio_encerrado' });
  const r = await fetch(
    `${SU}/rest/v1/desafio_videos?ativo=eq.true&select=youtube_id&limit=500`,
    { headers: HDR }
  );
  const videos = r.ok ? await r.json() : [];
  if (!videos.length) return res.status(200).json({ ok: true, atualizados: 0 });

  // Batch de 50 por chamada YouTube
  let atualizados = 0;
  for (let i = 0; i < videos.length; i += 50) {
    const batch = videos.slice(i, i + 50);
    const ids = batch.map(v => v.youtube_id).join(',');

    try {
      const vR = await youtubeRequest('videos', {
        part: 'statistics',
        id: ids,
        maxResults: 50,
      });
      const items = vR?.items || [];

      for (const item of items) {
        const stats = item.statistics || {};
        await fetch(`${SU}/rest/v1/desafio_videos?youtube_id=eq.${item.id}`, {
          method: 'PATCH', headers: HDR,
          body: JSON.stringify({
            views: Number(stats.viewCount || 0),
            likes: Number(stats.likeCount || 0),
            comentarios: Number(stats.commentCount || 0),
            atualizado_em: new Date().toISOString(),
          }),
        });
        atualizados++;
      }
    } catch (e) {
      console.error('[desafio:atualizar-metricas]', e.message);
    }
  }

  return res.status(200).json({ ok: true, atualizados });
}

// ── RANKING (público) ───────────────────────────────────────────────────────
async function ranking(req, res) {
  const limite = DESAFIO_CONFIG.max_ranking;

  // Busca top vídeos publicados dentro do período do desafio
  const inicio = new Date(DESAFIO_CONFIG.inicio).toISOString();
  const fim = new Date(DESAFIO_CONFIG.fim).toISOString();
  const r = await fetch(
    `${SU}/rest/v1/desafio_videos?ativo=eq.true&publicado_em=gte.${inicio}&publicado_em=lte.${fim}&order=views.desc&limit=${limite}&select=youtube_id,titulo,thumbnail_url,url,canal_nome,canal_id,views,likes,comentarios,duracao_segundos,publicado_em,atualizado_em`,
    { headers: HDR }
  );
  const videos = r.ok ? await r.json() : [];

  // Enriquece com thumbnail do canal
  const canalIds = [...new Set(videos.map(v => v.canal_id).filter(Boolean))];
  let canaisMap = {};
  if (canalIds.length) {
    const cR = await fetch(
      `${SU}/rest/v1/desafio_participantes?channel_id=in.(${canalIds.join(',')})&select=channel_id,channel_name,channel_handle,channel_thumbnail,total_inscritos`,
      { headers: HDR }
    );
    if (cR.ok) {
      (await cR.json()).forEach(c => { canaisMap[c.channel_id] = c; });
    }
  }

  const ranked = videos.map((v, i) => ({
    posicao: i + 1,
    ...v,
    canal_thumbnail: canaisMap[v.canal_id]?.channel_thumbnail || null,
    canal_handle: canaisMap[v.canal_id]?.channel_handle || null,
    canal_inscritos: canaisMap[v.canal_id]?.total_inscritos || 0,
  }));

  res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=30');
  return res.status(200).json({
    desafio: {
      nome: DESAFIO_CONFIG.nome,
      premio: DESAFIO_CONFIG.premio,
      inicio: DESAFIO_CONFIG.inicio,
      fim: DESAFIO_CONFIG.fim,
      status: desafioEncerrado() ? 'encerrado' : desafioAtivo() ? 'ativo' : 'aguardando',
    },
    videos: ranked,
    total: ranked.length,
    atualizado_em: new Date().toISOString(),
  });
}
