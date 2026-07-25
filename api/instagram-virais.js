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
// Régua de qualidade da coleta AUTOMÁTICA (decisão do user 2026-07-25):
// só mega virais entram sozinhos — 3M+ views E 1M+ likes. Ajustável por env.
// Adição MANUAL (admin cola URL) ignora a régua: decisão explícita do admin.
const MIN_VIEWS_AUTO = parseInt(process.env.IG_MIN_VIEWS, 10) || 3_000_000;
const MIN_LIKES_AUTO = parseInt(process.env.IG_MIN_LIKES, 10) || 1_000_000;
const passaRegua = (m) => (m.views_count || 0) >= MIN_VIEWS_AUTO && (m.likes_count || 0) >= MIN_LIKES_AUTO;

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

    // Crons (GH Actions com admin_secret; header x-vercel-cron aceito por
    // compatibilidade) — só ações de coleta, que nunca destroem nada
    if (action === 'coletar-perfis' || action === 'atualizar-metricas') {
      if (!isCron && !isAdmin) return res.status(401).json({ error: 'unauthorized' });
      if (action === 'coletar-perfis') return await coletarPerfis(req, res, { SU, SK, h });
      return await atualizarMetricas(req, res, { SU, h });
    }

    // Daqui pra baixo: SÓ admin explícito (header de cron NÃO basta — 'remover'
    // deleta acervo; blindagem exige que nada externo consiga apagar vídeo)
    if (!isAdmin) return res.status(401).json({ error: 'unauthorized' });

    if (action === 'adicionar') return await adicionar(req, res, { SU, SK, h });
    if (action === 'adicionar-perfil') return await adicionarPerfil(req, res, { SU, SK, h });
    if (action === 'remover') return await remover(req, res, { SU, h });
    if (action === 'toggle-perfil') return await togglePerfil(req, res, { SU, h });
    if (action === 'listar-perfis') return await listarPerfis(req, res, { SU, h });
    if (action === 'salvar-cookies') return await salvarCookies(req, res, { SU, h });
    if (action === 'testar-conexao') return res.status(200).json(await ig.validarSessao());
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
    duration_sec: m.duration_sec,
    ig_created_at: m.ig_created_at,
    // Métrica zerada NÃO entra no row: se o IG esconder play_count numa
    // resposta 200 (payload degenerado), o upsert preservaria o valor bom já
    // salvo em vez de zerar. No insert, o default 0 do banco cobre.
    ...(m.views_count > 0 ? { views_count: m.views_count } : {}),
    ...(m.likes_count > 0 ? { likes_count: m.likes_count } : {}),
    ...(m.comments_count > 0 ? { comments_count: m.comments_count } : {}),
    // status NUNCA vai no upsert: insert usa o default 'active' do banco, e
    // update PRESERVA o valor atual — Reel removido pelo admin (tombstone
    // status='removed') não ressuscita quando o coletor re-encontra ele.
    last_error: null,
    metrics_updated_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    ...extras,
  };
}

async function upsertRows(rows, { SU, h }) {
  if (!rows.length) return true;
  // PostgREST exige chaves uniformes por lote; como métricas zeradas ficam de
  // fora do row (guarda anti-zeramento), agrupamos por assinatura de chaves.
  const grupos = new Map();
  for (const row of rows) {
    const sig = Object.keys(row).sort().join(',');
    if (!grupos.has(sig)) grupos.set(sig, []);
    grupos.get(sig).push(row);
  }
  let ok = true;
  for (const lote of grupos.values()) {
    const r = await fetch(`${SU}/rest/v1/instagram_virais?on_conflict=shortcode`, {
      method: 'POST',
      headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(lote),
    });
    if (!r.ok) { console.error('[ig-virais upsert]', r.status, (await r.text()).slice(0, 200)); ok = false; }
  }
  return ok;
}

// ── ADICIONAR (admin cola URL de Reel) ───────────────────────────────────────
async function adicionar(req, res, { SU, SK, h }) {
  const url = (req.body && req.body.url) || req.query.url;
  const shortcode = ig.parseShortcode(url);
  if (!shortcode) return res.status(400).json({ error: 'URL inválida — use instagram.com/reel/CODIGO/ ou /p/CODIGO/' });
  if (!(await ig.temCookies())) return res.status(500).json({ error: 'Cookies não configurados — salve no painel (campo Cookies da conta)' });

  let m;
  try {
    m = await ig.mediaInfo(shortcode);
  } catch (e) {
    const dica = e.status === 429 ? 'Instagram pediu calma (429) — espere alguns minutos.'
      : e.status === 404 ? 'Post não encontrado (deletado ou privado).'
      : 'Falha ao consultar o Instagram.';
    return res.status(502).json({ error: dica, detalhe: e.message });
  }
  if (!m.is_video) {
    const tipo = m.media_type === 8 ? 'um CARROSSEL' : 'uma FOTO';
    return res.status(400).json({ error: `Esse post é ${tipo} — a Virais só aceita vídeos/Reels.` });
  }

  // status:'active' explícito AQUI (e só aqui): admin colar a URL de novo é
  // intenção clara de reativar um Reel que estava com tombstone 'removed'
  const row = await mediaParaRow(m, { SU, SK }, { fonte: 'manual', status: 'active' });
  // collected_at só no INSERT (upsert não sobrescreve por não estar no body? PostgREST
  // merge-duplicates sobrescreve TODAS as colunas enviadas — então NÃO enviamos collected_at,
  // deixando o default do banco no insert e o valor antigo no update)
  const ok = await upsertRows([row], { SU, h });
  if (!ok) return res.status(500).json({ error: 'Falha ao salvar no banco' });
  // Manual entra mesmo abaixo da régua (decisão do admin), mas avisamos
  return res.status(200).json({ ok: true, video: row, abaixo_da_regua: !passaRegua(m) });
}

// ── ADICIONAR PERFIL (admin cola link de perfil) ─────────────────────────────
// Resolve username→user_pk. O endpoint de resolução toma 429 fácil — fallback:
// admin pode mandar junto a URL de um Reel do perfil (reel_url), que dá o
// author_pk sem passar pelo endpoint sensível.
async function adicionarPerfil(req, res, { SU, SK, h }) {
  const body = req.body || {};
  const username = ig.parseUsernameDePerfil(body.url || '') || String(body.username || '').replace(/^@/, '').toLowerCase() || null;
  if (!username) return res.status(400).json({ error: 'Cole o link do perfil (instagram.com/nomedoperfil)' });
  if (!(await ig.temCookies())) return res.status(500).json({ error: 'Cookies não configurados — salve no painel (campo Cookies da conta)' });

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
        if (!m.author_pk) {
          // Sem user_pk o coletor nunca conseguiria buscar esse perfil —
          // melhor falhar claro agora do que salvar um perfil morto
          return res.status(502).json({ error: 'O Instagram não retornou o id do autor nesse Reel — tente outro Reel do mesmo perfil.' });
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
  let coletados = 0, avaliados = 0;
  try {
    const page = await ig.clipsDoPerfil(perfil.user_pk, { pageSize: PERFIL_PAGE_SIZE });
    const candidatos = page.items.filter((m) => m.is_video && m.shortcode);
    avaliados = candidatos.length;
    const videos = candidatos.filter(passaRegua);
    const rows = [];
    for (const m of videos) rows.push(await mediaParaRow(m, { SU, SK }, { fonte: 'perfil', source_profile: perfil.username }));
    if (await upsertRows(rows, { SU, h })) coletados = rows.length;
    await fetch(`${SU}/rest/v1/instagram_perfis?username=eq.${encodeURIComponent(perfil.username)}`, {
      method: 'PATCH', headers: h, body: JSON.stringify({ last_collected_at: new Date().toISOString() }),
    });
  } catch (e) {
    aviso = 'Perfil salvo, mas a 1ª coleta falhou (' + e.message + ') — o cron tenta de novo sozinho.';
  }
  if (!aviso && avaliados > coletados) {
    aviso = `${avaliados - coletados} Reels do perfil ficaram FORA da régua (${(MIN_VIEWS_AUTO / 1e6)}M+ views e ${(MIN_LIKES_AUTO / 1e6)}M+ likes).`;
  }
  return res.status(200).json({ ok: true, perfil, coletados, avaliados, aviso });
}

// ── COLETAR PERFIS (cron) ────────────────────────────────────────────────────
async function coletarPerfis(req, res, { SU, SK, h }) {
  if (!(await ig.temCookies())) return res.status(200).json({ ok: false, motivo: 'sem_cookies' });
  const limit = Math.min(10, parseInt(req.query.limit, 10) || PERFIS_POR_RODADA);
  const r = await fetch(
    `${SU}/rest/v1/instagram_perfis?active=eq.true&user_pk=not.is.null&order=last_collected_at.asc.nullsfirst&limit=${limit}&select=username,user_pk`,
    { headers: h }
  );
  if (!r.ok) return res.status(500).json({ error: 'query_perfis_failed' });
  const perfis = await r.json();
  const resultado = { ok: true, perfis: perfis.length, inseridos: 0, avaliados: 0, fora_da_regua: 0, falhas: [] };

  for (const p of perfis) {
    try {
      const page = await ig.clipsDoPerfil(p.user_pk, { pageSize: PERFIL_PAGE_SIZE });
      const candidatos = page.items.filter((m) => m.is_video && m.shortcode);
      resultado.avaliados += candidatos.length;
      const videos = candidatos.filter(passaRegua);
      resultado.fora_da_regua += candidatos.length - videos.length;
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
  if (!(await ig.temCookies())) return res.status(200).json({ ok: false, motivo: 'sem_cookies' });
  const limit = Math.min(50, parseInt(req.query.limit, 10) || REFRESH_BATCH);
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
      // Guarda anti-zeramento: métrica que veio 0 numa resposta 200 não
      // sobrescreve o valor bom já salvo (IG às vezes esconde play_count)
      const body = {
        metrics_updated_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        last_error: null,
      };
      if (m.views_count > 0) body.views_count = m.views_count;
      if (m.likes_count > 0) body.likes_count = m.likes_count;
      if (m.comments_count > 0) body.comments_count = m.comments_count;
      await fetch(`${SU}/rest/v1/instagram_virais?shortcode=eq.${encodeURIComponent(row.shortcode)}`, {
        method: 'PATCH', headers: h, body: JSON.stringify(body),
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
// Tombstone em vez de DELETE: status='removed' tira da vitrine/Blublu mas a
// linha fica — o coletor de perfis pode re-encontrar o shortcode e o upsert
// (que não envia status) preserva a remoção. DELETE físico ressuscitava.
async function remover(req, res, { SU, h }) {
  const shortcode = (req.body && req.body.shortcode) || req.query.shortcode;
  if (!shortcode) return res.status(400).json({ error: 'shortcode obrigatorio' });
  const r = await fetch(`${SU}/rest/v1/instagram_virais?shortcode=eq.${encodeURIComponent(shortcode)}`, {
    method: 'PATCH', headers: h, body: JSON.stringify({ status: 'removed' }),
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

// ── SALVAR COOKIES (admin, self-service) ─────────────────────────────────────
// Admin cola o cookies.txt no painel → validamos, salvamos em site_kv (sem
// redeploy) e testamos a sessão na hora. A env IG_COOKIES_B64 vira só fallback.
async function salvarCookies(req, res, { SU, h }) {
  const txt = (req.body && req.body.cookies_txt) || '';
  if (!txt.trim()) return res.status(400).json({ error: 'Cole o conteúdo do cookies.txt' });
  const b64 = Buffer.from(txt, 'utf8').toString('base64');
  const jar = ig.parseCookiesB64(b64);
  if (!jar || !jar.sessionid) {
    return res.status(400).json({ error: 'Cookies inválidos — precisa ser o cookies.txt exportado LOGADO (tem que conter "sessionid")' });
  }
  const upR = await fetch(`${SU}/rest/v1/site_kv?on_conflict=key`, {
    method: 'POST',
    headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ key: 'ig_cookies_b64', value: b64 }]),
  });
  if (!upR.ok) return res.status(500).json({ error: 'Falha ao salvar no banco: ' + upR.status });
  ig.limparCacheCookies();
  const teste = await ig.validarSessao();
  return res.status(200).json({ ok: true, salvo: true, sessao: teste });
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
  const temCk = await ig.temCookies();
  return res.status(200).json({
    ok: true,
    timestamp: new Date().toISOString(),
    cookies_configurados: temCk,
    total_videos: totalVideos,
    perfis_ativos: count(perfisR),
    metricas_atrasadas_48h: metricasVelhas,
    videos_com_erro_recente: comErro,
    // Conta caiu? Vídeos continuam no ar (banco = fonte da verdade). Dois
    // sinais de problema independentes: last_error acumulando (refresh RODA
    // mas falha — sessão morta/checkpoint; o refresh renova metrics_updated_at
    // até em falha, então SÓ o erro detecta isso) e métricas atrasadas
    // (cron parou de rodar).
    status: !temCk ? 'SEM_COOKIES'
      : totalVideos >= 5 && comErro / totalVideos > 0.3 ? 'DEGRADED_REFRESH_FALHANDO'
      : totalVideos > 0 && metricasVelhas / totalVideos > 0.5 ? 'DEGRADED_METRICAS_PARADAS'
      : 'OK',
  });
}
