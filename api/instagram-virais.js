// api/instagram-virais.js — Instagram Virais engine (2026-07-25)
// =============================================================================
// Espelho do tiktok-virais.js, mas com coleta própria (conta descartável +
// API interna web via api/_helpers/instagram.js) em vez de TikAPI.
//
// Actions:
//   adicionar          (admin POST) — cola URL de Reel → metadata completa → upsert
//   adicionar-perfil   (admin POST) — cola link de perfil → resolve id → 1ª coleta
//   coletar-perfis     (cron/admin) — Reels recentes de cada perfil ativo
//   atualizar-metricas (cron/admin) — refresh de views/likes dos mais antigos
//   listar             (público GET) — grid da Virais (padrão: TODOS, recentes)
//   remover            (admin POST) — remove um vídeo do acervo
//   toggle-perfil      (admin POST) — ativa/desativa perfil monitorado
//   listar-perfis      (admin GET)  — perfis monitorados
//   health             (público GET)— status agregado (sem PII)
//
// BLINDAGEM (pedido do user 2026-07-25): o banco é a fonte da verdade.
// Falha de coleta/refresh NUNCA deleta nem esconde vídeo já coletado — no
// pior caso as métricas ficam paradas (last_error registra o motivo) e o
// usuário final não nota nada.

const ig = require('./_helpers/instagram');

const IG_THUMBS_BUCKET = 'instagram-thumbs';
const REFRESH_BATCH = 20;          // vídeos por rodada de atualizar-metricas
const REFRESH_SPACING_MS = 1500;   // pausa entre chamadas ao IG (anti-flag)
const PERFIS_POR_RODADA = 3;       // perfis coletados por rodada do cron
const PERFIL_PAGE_SIZE = 12;       // Reels por perfil por rodada (1 página)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'config_missing' });
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  const action = req.query.action || (req.body && req.body.action);
  const isCron = !!req.headers['x-vercel-cron'];
  const isAdmin = (req.query.admin_secret || (req.body && req.body.admin_secret)) === process.env.ADMIN_SECRET;

  try {
    if (action === 'listar') return await listar(req, res, { SU, h });
    if (action === 'health') return await health(req, res, { SU, h });

    // Daqui pra baixo: cron ou admin
    if (!isCron && !isAdmin) return res.status(401).json({ error: 'unauthorized' });

    if (action === 'adicionar') return await adicionar(req, res, { SU, SK, h });
    if (action === 'adicionar-perfil') return await adicionarPerfil(req, res, { SU, SK, h });
    if (action === 'coletar-perfis') return await coletarPerfis(req, res, { SU, SK, h });
    if (action === 'atualizar-metricas') return await atualizarMetricas(req, res, { SU, h });
    if (action === 'remover') return await remover(req, res, { SU, h });
    if (action === 'toggle-perfil') return await togglePerfil(req, res, { SU, h });
    if (action === 'listar-perfis') return await listarPerfis(req, res, { SU, h });
    return res.status(400).json({ error: 'action_invalida' });
  } catch (e) {
    console.error('[instagram-virais fatal]', e && e.message);
    return res.status(500).json({ error: e && e.message });
  }
};

// ── Thumbnail: cacheia no NOSSO storage (fbcdn expira em dias) ───────────────
// Auto-cria o bucket se não existir (self-healing — dispensa passo manual).
async function cacheThumbnail(origemUrl, shortcode, { SU, SK }) {
  if (!origemUrl || !shortcode) return null;
  if (origemUrl.includes(new URL(SU).hostname)) return origemUrl; // já é nossa
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(origemUrl, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1024 || buf.length > 5 * 1024 * 1024) return null;
    const contentType = r.headers.get('content-type') || 'image/jpeg';
    const ext = contentType.includes('webp') ? 'webp' : contentType.includes('png') ? 'png' : 'jpg';
    const objectPath = `${shortcode}.${ext}`;
    const upload = () => fetch(`${SU}/storage/v1/object/${IG_THUMBS_BUCKET}/${objectPath}`, {
      method: 'POST',
      headers: {
        apikey: SK, Authorization: 'Bearer ' + SK,
        'Content-Type': contentType, 'x-upsert': 'true',
        'cache-control': 'public, max-age=31536000, immutable',
      },
      body: buf,
    });
    let upR = await upload();
    if (!upR.ok) {
      const errText = await upR.text();
      if (/bucket/i.test(errText) && /not.*found/i.test(errText)) {
        // Bucket ainda não existe (SQL não rodado?) — cria e tenta de novo
        await fetch(`${SU}/storage/v1/bucket`, {
          method: 'POST',
          headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: IG_THUMBS_BUCKET, name: IG_THUMBS_BUCKET, public: true }),
        }).catch(() => {});
        upR = await upload();
      }
      if (!upR.ok) {
        console.warn(`[ig-virais thumb] upload ${shortcode}: ${upR.status} ${errText.slice(0, 120)}`);
        return null;
      }
    }
    return `${SU}/storage/v1/object/public/${IG_THUMBS_BUCKET}/${objectPath}`;
  } catch (e) {
    console.warn(`[ig-virais thumb] ${shortcode}:`, e.message);
    return null;
  }
}

// Metadata normalizada → row do banco (thumbnail já cacheada quando possível)
async function mediaParaRow(m, { SU, SK }, extras = {}) {
  const cached = await cacheThumbnail(m.thumbnail_origem, m.shortcode, { SU, SK });
  return {
    shortcode: m.shortcode,
    media_pk: m.media_pk,
    video_url: `https://www.instagram.com/reel/${m.shortcode}/`,
    thumbnail_url: cached || m.thumbnail_origem || null,
    caption: m.caption || null,
    author_handle: m.author_handle,
    author_name: m.author_name,
    author_pk: m.author_pk,
    views_count: m.views_count || 0,
    likes_count: m.likes_count || 0,
    comments_count: m.comments_count || 0,
    duration_sec: m.duration_sec,
    ig_created_at: m.ig_created_at,
    status: 'active',
    last_error: null,
    metrics_updated_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    ...extras,
  };
}

async function upsertRows(rows, { SU, h }) {
  if (!rows.length) return true;
  const r = await fetch(`${SU}/rest/v1/instagram_virais?on_conflict=shortcode`, {
    method: 'POST',
    headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) console.error('[ig-virais upsert]', r.status, (await r.text()).slice(0, 200));
  return r.ok;
}

// ── ADICIONAR (admin cola URL de Reel) ───────────────────────────────────────
async function adicionar(req, res, { SU, SK, h }) {
  const url = (req.body && req.body.url) || req.query.url;
  const shortcode = ig.parseShortcode(url);
  if (!shortcode) return res.status(400).json({ error: 'URL inválida — use instagram.com/reel/CODIGO/ ou /p/CODIGO/' });
  if (!ig.temCookies()) return res.status(500).json({ error: 'IG_COOKIES_B64 não configurado' });

  let m;
  try {
    m = await ig.mediaInfo(shortcode);
  } catch (e) {
    const dica = e.status === 429 ? 'Instagram pediu calma (429) — espere alguns minutos.'
      : e.status === 404 ? 'Post não encontrado (deletado ou privado).'
      : 'Falha ao consultar o Instagram.';
    return res.status(502).json({ error: dica, detalhe: e.message });
  }
  if (m.media_type === 1) return res.status(400).json({ error: 'Esse post é uma FOTO — a Virais só aceita vídeos/Reels.' });

  const row = await mediaParaRow(m, { SU, SK }, { fonte: 'manual' });
  // collected_at só no INSERT (upsert não sobrescreve por não estar no body? PostgREST
  // merge-duplicates sobrescreve TODAS as colunas enviadas — então NÃO enviamos collected_at,
  // deixando o default do banco no insert e o valor antigo no update)
  const ok = await upsertRows([row], { SU, h });
  if (!ok) return res.status(500).json({ error: 'Falha ao salvar no banco' });
  return res.status(200).json({ ok: true, video: row });
}

// ── ADICIONAR PERFIL (admin cola link de perfil) ─────────────────────────────
// Resolve username→user_pk. O endpoint de resolução toma 429 fácil — fallback:
// admin pode mandar junto a URL de um Reel do perfil (reel_url), que dá o
// author_pk sem passar pelo endpoint sensível.
async function adicionarPerfil(req, res, { SU, SK, h }) {
  const body = req.body || {};
  const username = ig.parseUsernameDePerfil(body.url || '') || String(body.username || '').replace(/^@/, '').toLowerCase() || null;
  if (!username) return res.status(400).json({ error: 'Cole o link do perfil (instagram.com/nomedoperfil)' });
  if (!ig.temCookies()) return res.status(500).json({ error: 'IG_COOKIES_B64 não configurado' });

  let perfil = null;
  let aviso = null;
  try {
    perfil = await ig.resolverUsername(username);
  } catch (e) {
    // Fallback: URL de um Reel do perfil → author_pk via media info
    if (body.reel_url) {
      try {
        const m = await ig.mediaInfo(body.reel_url);
        if (m.author_handle && m.author_handle.toLowerCase() !== username) {
          return res.status(400).json({ error: `O Reel enviado é de @${m.author_handle}, não de @${username}` });
        }
        perfil = { user_pk: m.author_pk, username: m.author_handle || username, full_name: m.author_name };
      } catch (e2) {
        return res.status(502).json({ error: 'Falha ao resolver o perfil (e o Reel de apoio também falhou)', detalhe: e2.message });
      }
    } else if (e.status === 429) {
      return res.status(429).json({
        error: 'Instagram limitou a consulta de perfis agora (429). Duas opções: tentar de novo em ~10min, OU colar junto a URL de um Reel qualquer desse perfil (campo reel_url) que eu resolvo por ela.',
      });
    } else {
      return res.status(502).json({ error: 'Perfil não encontrado ou inacessível', detalhe: e.message });
    }
  }

  const upP = await fetch(`${SU}/rest/v1/instagram_perfis?on_conflict=username`, {
    method: 'POST',
    headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ username: perfil.username, user_pk: perfil.user_pk, full_name: perfil.full_name, active: true, last_error: null }]),
  });
  if (!upP.ok) return res.status(500).json({ error: 'Falha ao salvar perfil' });

  // 1ª coleta imediata (página 1) — admin já vê resultado na hora
  let coletados = 0;
  try {
    const page = await ig.clipsDoPerfil(perfil.user_pk, { pageSize: PERFIL_PAGE_SIZE });
    const videos = page.items.filter((m) => m.is_video && m.shortcode);
    const rows = [];
    for (const m of videos) rows.push(await mediaParaRow(m, { SU, SK }, { fonte: 'perfil', source_profile: perfil.username }));
    if (await upsertRows(rows, { SU, h })) coletados = rows.length;
    await fetch(`${SU}/rest/v1/instagram_perfis?username=eq.${encodeURIComponent(perfil.username)}`, {
      method: 'PATCH', headers: h, body: JSON.stringify({ last_collected_at: new Date().toISOString() }),
    });
  } catch (e) {
    aviso = 'Perfil salvo, mas a 1ª coleta falhou (' + e.message + ') — o cron tenta de novo sozinho.';
  }
  return res.status(200).json({ ok: true, perfil, coletados, aviso });
}

// ── COLETAR PERFIS (cron) ────────────────────────────────────────────────────
async function coletarPerfis(req, res, { SU, SK, h }) {
  if (!ig.temCookies()) return res.status(200).json({ ok: false, motivo: 'sem_cookies' });
  const limit = Math.min(10, parseInt(req.query.limit || String(PERFIS_POR_RODADA), 10));
  const r = await fetch(
    `${SU}/rest/v1/instagram_perfis?active=eq.true&user_pk=not.is.null&order=last_collected_at.asc.nullsfirst&limit=${limit}&select=username,user_pk`,
    { headers: h }
  );
  if (!r.ok) return res.status(500).json({ error: 'query_perfis_failed' });
  const perfis = await r.json();
  const resultado = { ok: true, perfis: perfis.length, inseridos: 0, falhas: [] };

  for (const p of perfis) {
    try {
      const page = await ig.clipsDoPerfil(p.user_pk, { pageSize: PERFIL_PAGE_SIZE });
      const videos = page.items.filter((m) => m.is_video && m.shortcode);
      const rows = [];
      for (const m of videos) rows.push(await mediaParaRow(m, { SU, SK }, { fonte: 'perfil', source_profile: p.username }));
      if (await upsertRows(rows, { SU, h })) resultado.inseridos += rows.length;
      await fetch(`${SU}/rest/v1/instagram_perfis?username=eq.${encodeURIComponent(p.username)}`, {
        method: 'PATCH', headers: h, body: JSON.stringify({ last_collected_at: new Date().toISOString(), last_error: null }),
      });
    } catch (e) {
      resultado.falhas.push({ perfil: p.username, erro: e.message });
      await fetch(`${SU}/rest/v1/instagram_perfis?username=eq.${encodeURIComponent(p.username)}`, {
        method: 'PATCH', headers: h, body: JSON.stringify({ last_error: e.message.slice(0, 200) }),
      }).catch(() => {});
      if (e.status === 429) break; // Instagram pediu calma — para a rodada inteira
    }
    await new Promise((rs) => setTimeout(rs, 2500)); // espaçamento anti-flag
  }
  return res.status(200).json(resultado);
}

// ── ATUALIZAR MÉTRICAS (cron) ────────────────────────────────────────────────
// Pega os N com metrics_updated_at mais antigo e re-consulta views/likes.
// Falha NUNCA esconde o vídeo — só registra last_error e segue a vida.
async function atualizarMetricas(req, res, { SU, h }) {
  if (!ig.temCookies()) return res.status(200).json({ ok: false, motivo: 'sem_cookies' });
  const limit = Math.min(50, parseInt(req.query.limit || String(REFRESH_BATCH), 10));
  const r = await fetch(
    `${SU}/rest/v1/instagram_virais?status=eq.active&order=metrics_updated_at.asc.nullsfirst&limit=${limit}&select=shortcode`,
    { headers: h }
  );
  if (!r.ok) return res.status(500).json({ error: 'query_failed' });
  const rows = await r.json();
  const resultado = { ok: true, processados: 0, atualizados: 0, falhas: 0, abortado_429: false };

  for (const row of rows) {
    resultado.processados++;
    try {
      const m = await ig.mediaInfo(row.shortcode);
      await fetch(`${SU}/rest/v1/instagram_virais?shortcode=eq.${encodeURIComponent(row.shortcode)}`, {
        method: 'PATCH', headers: h,
        body: JSON.stringify({
          views_count: m.views_count || 0,
          likes_count: m.likes_count || 0,
          comments_count: m.comments_count || 0,
          metrics_updated_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          last_error: null,
        }),
      });
      resultado.atualizados++;
    } catch (e) {
      resultado.falhas++;
      // Registra o motivo mas NÃO mexe em status — vídeo continua na vitrine
      await fetch(`${SU}/rest/v1/instagram_virais?shortcode=eq.${encodeURIComponent(row.shortcode)}`, {
        method: 'PATCH', headers: h,
        body: JSON.stringify({ metrics_updated_at: new Date().toISOString(), last_error: e.message.slice(0, 200) }),
      }).catch(() => {});
      if (e.status === 429) { resultado.abortado_429 = true; break; }
    }
    await new Promise((rs) => setTimeout(rs, REFRESH_SPACING_MS));
  }
  return res.status(200).json(resultado);
}

// ── LISTAR (grid público) ────────────────────────────────────────────────────
// Padrão do Instagram (decisão do user): TODOS os coletados, mais recentes
// primeiro — sem filtro de views/likes pré-selecionado.
async function listar(req, res, { SU, h }) {
  const period = req.query.period || 'all';
  const sortParam = req.query.sort || 'recent';
  const sort = sortParam === 'views' ? 'views_count.desc'
    : sortParam === 'likes' ? 'likes_count.desc'
    : 'collected_at.desc';
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = Math.max(0, parseInt(req.query.offset) || 0);

  const PERIOD_MS = { '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 };
  let url = `${SU}/rest/v1/instagram_virais?status=eq.active`;
  if (PERIOD_MS[period]) {
    url += `&collected_at=gte.${new Date(Date.now() - PERIOD_MS[period]).toISOString()}`;
  }
  url += `&order=${sort}&limit=${limit}&offset=${offset}`;
  url += '&select=shortcode,video_url,thumbnail_url,caption,author_handle,author_name,views_count,likes_count,comments_count,duration_sec,ig_created_at,fonte,source_profile,collected_at';

  const r = await fetch(url, { headers: { ...h, Prefer: 'count=exact' } });
  const items = r.ok ? await r.json() : [];
  const total = parseInt((r.headers.get('content-range') || '').split('/')[1] || '0') || items.length;
  return res.status(200).json({
    ok: true, period, sort: sortParam, limit, offset, total,
    has_more: offset + items.length < total,
    items,
  });
}

// ── REMOVER (admin) ──────────────────────────────────────────────────────────
async function remover(req, res, { SU, h }) {
  const shortcode = (req.body && req.body.shortcode) || req.query.shortcode;
  if (!shortcode) return res.status(400).json({ error: 'shortcode obrigatorio' });
  const r = await fetch(`${SU}/rest/v1/instagram_virais?shortcode=eq.${encodeURIComponent(shortcode)}`, {
    method: 'DELETE', headers: h,
  });
  return res.status(r.ok ? 200 : 500).json({ ok: r.ok });
}

// ── PERFIS (admin) ───────────────────────────────────────────────────────────
async function togglePerfil(req, res, { SU, h }) {
  const { username, active } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username obrigatorio' });
  const r = await fetch(`${SU}/rest/v1/instagram_perfis?username=eq.${encodeURIComponent(username)}`, {
    method: 'PATCH', headers: h, body: JSON.stringify({ active: !!active }),
  });
  return res.status(r.ok ? 200 : 500).json({ ok: r.ok });
}

async function listarPerfis(req, res, { SU, h }) {
  const r = await fetch(`${SU}/rest/v1/instagram_perfis?select=*&order=added_at.desc`, { headers: h });
  if (!r.ok) return res.status(500).json({ error: 'query_failed' });
  return res.status(200).json({ ok: true, perfis: await r.json() });
}

// ── HEALTH (público, agregado) ───────────────────────────────────────────────
async function health(req, res, { SU, h }) {
  const doisDias = new Date(Date.now() - 2 * 86400000).toISOString();
  const [totalR, staleR, errR, perfisR] = await Promise.all([
    fetch(`${SU}/rest/v1/instagram_virais?select=shortcode&limit=1`, { headers: { ...h, Prefer: 'count=exact' } }),
    fetch(`${SU}/rest/v1/instagram_virais?status=eq.active&metrics_updated_at=lt.${doisDias}&select=shortcode&limit=1`, { headers: { ...h, Prefer: 'count=exact' } }),
    fetch(`${SU}/rest/v1/instagram_virais?last_error=not.is.null&select=shortcode&limit=1`, { headers: { ...h, Prefer: 'count=exact' } }),
    fetch(`${SU}/rest/v1/instagram_perfis?active=eq.true&select=username&limit=1`, { headers: { ...h, Prefer: 'count=exact' } }),
  ]);
  const count = (resp) => parseInt((resp.headers.get('content-range') || '').split('/')[1] || '0', 10);
  const totalVideos = count(totalR);
  const metricasVelhas = count(staleR);
  const comErro = count(errR);
  return res.status(200).json({
    ok: true,
    timestamp: new Date().toISOString(),
    cookies_configurados: ig.temCookies(),
    total_videos: totalVideos,
    perfis_ativos: count(perfisR),
    metricas_atrasadas_48h: metricasVelhas,
    videos_com_erro_recente: comErro,
    // Conta caiu? Vídeos continuam no ar (banco = fonte da verdade); o sinal
    // de problema é metricas_atrasadas subindo + videos_com_erro subindo.
    status: !ig.temCookies() ? 'SEM_COOKIES'
      : totalVideos > 0 && metricasVelhas / totalVideos > 0.5 ? 'DEGRADED_METRICAS_PARADAS'
      : 'OK',
  });
}
