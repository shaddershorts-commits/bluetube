// api/virais-canais.js
//
// Ferramenta Virais — modo CURADO. Felipe escolhe canais YouTube manualmente,
// sistema monitora e coleta Shorts que explodem. Substitui modo aleatorio
// (trending/nichos) que vinha trazendo conteudo indesejado.
//
// Actions:
//   POST   ?action=adicionar           — admin (Bearer): URL + nicho + idioma → INSERT canal
//   DELETE ?action=remover             — admin (Bearer): soft (ativo=false)
//   GET    ?action=listar              — admin (Bearer): lista canais ativos com stats
//   GET    ?action=coletar-curados     — cron a cada 2h: fetch shorts dos canais
//   POST   ?action=toggle-daily-alert  — user Master (token): liga/desliga email diario
//   GET    ?action=alert-status        — user (token): retorna estado do toggle pro UI
//   GET    ?action=daily-alert-master  — cron 7:30 BRT (10:30 UTC): envia email pros opt-in
//
// Quota YouTube por canal/coleta: ~2 units (uploads playlist + batch stats).
// 1000 canais × 12 execucoes/dia = ~24k units (folga: ~96k).

const { youtubeRequest } = require('./_helpers/youtube.js');

const SU = process.env.SUPABASE_URL;
const SK = process.env.SUPABASE_SERVICE_KEY;
const AK = process.env.SUPABASE_ANON_KEY || SK;
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'BlueTube <bluetubeoficial@bluetubeviral.com>';
const SITE_URL = process.env.SITE_URL || 'https://bluetubeviral.com';

const HDR = SK ? { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' } : null;

// ── CONFIG ──────────────────────────────────────────────────────────────────
const LIMITE_CANAIS = 1000;
const NICHO_LIST = ['curiosidades', 'games', 'ia', 'animais', 'artistas', 'pessoas_blogs', 'culinaria', 'esportes', 'educacao'];

// 20 idiomas suportados (alinhado com BlueVoice)
const LANG_BY_CODE = {
  'pt-BR': { flag: '🇧🇷', label: 'Português (Brasil)', pais: 'BR', idioma: 'pt' },
  'pt-PT': { flag: '🇵🇹', label: 'Português (Portugal)', pais: 'PT', idioma: 'pt' },
  'en-US': { flag: '🇺🇸', label: 'English (US)', pais: 'US', idioma: 'en' },
  'en-GB': { flag: '🇬🇧', label: 'English (UK)', pais: 'GB', idioma: 'en' },
  'en-AU': { flag: '🇦🇺', label: 'English (AU)', pais: 'AU', idioma: 'en' },
  'es-ES': { flag: '🇪🇸', label: 'Español (España)', pais: 'ES', idioma: 'es' },
  'es-MX': { flag: '🇲🇽', label: 'Español (México)', pais: 'MX', idioma: 'es' },
  'fr-FR': { flag: '🇫🇷', label: 'Français', pais: 'FR', idioma: 'other' },
  'de-DE': { flag: '🇩🇪', label: 'Deutsch', pais: 'DE', idioma: 'other' },
  'it-IT': { flag: '🇮🇹', label: 'Italiano', pais: 'IT', idioma: 'other' },
  'ja-JP': { flag: '🇯🇵', label: '日本語', pais: 'JP', idioma: 'other' },
  'ko-KR': { flag: '🇰🇷', label: '한국어', pais: 'KR', idioma: 'other' },
  'zh-CN': { flag: '🇨🇳', label: '中文', pais: 'CN', idioma: 'other' },
  'ar':    { flag: '🇸🇦', label: 'العربية', pais: 'SA', idioma: 'other' },
  'tr':    { flag: '🇹🇷', label: 'Türkçe', pais: 'TR', idioma: 'other' },
  'nl-NL': { flag: '🇳🇱', label: 'Nederlands', pais: 'NL', idioma: 'other' },
  'ru-RU': { flag: '🇷🇺', label: 'Русский', pais: 'RU', idioma: 'other' },
  'pl-PL': { flag: '🇵🇱', label: 'Polski', pais: 'PL', idioma: 'other' },
};

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

async function getSubscriberByEmail(email) {
  if (!email) return null;
  try {
    const r = await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=email,plan,virais_daily_alert,name&limit=1`, { headers: HDR });
    if (!r.ok) return null;
    const arr = await r.json();
    return arr[0] || null;
  } catch { return null; }
}

// ── HELPERS SUPABASE ────────────────────────────────────────────────────────
async function supaSelect(path) {
  const r = await fetch(`${SU}/rest/v1/${path}`, { headers: HDR });
  if (!r.ok) return null;
  return r.json();
}
async function supaPost(table, body, opts = {}) {
  return fetch(`${SU}/rest/v1/${table}${opts.qs ? '?' + opts.qs : ''}`, {
    method: 'POST',
    headers: { ...HDR, Prefer: opts.prefer || 'return=representation' },
    body: JSON.stringify(body),
  });
}
async function supaPatch(path, body) {
  return fetch(`${SU}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...HDR, Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
}

// ── PARSER DE URL DO CANAL ──────────────────────────────────────────────────
// Aceita:
//   https://www.youtube.com/@Bubbletm/shorts
//   https://www.youtube.com/@Bubbletm
//   https://youtube.com/channel/UCxxx
//   https://youtube.com/c/Nome
//   @Bubbletm
//   Bubbletm
function parseChannelUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  // channel_id direto
  let m = s.match(/(?:youtube\.com\/channel\/|^)(UC[A-Za-z0-9_-]{20,30})\b/i);
  if (m) return { type: 'id', value: m[1] };
  // @handle (com ou sem URL)
  m = s.match(/@([A-Za-z0-9_.-]+)/);
  if (m) return { type: 'handle', value: '@' + m[1] };
  // /c/Nome ou /user/Nome
  m = s.match(/youtube\.com\/(?:c|user)\/([A-Za-z0-9_.-]+)/i);
  if (m) return { type: 'legacy', value: m[1] };
  // Se vier so o nome (ex: "Bubbletm") trata como handle
  if (/^[A-Za-z0-9_.-]+$/.test(s)) return { type: 'handle', value: '@' + s };
  return null;
}

// Resolve metadata via YouTube API. Retorna {channel_id, name, handle, thumbnail_url, total_inscritos} ou null.
async function resolveChannelMetadata(parsed) {
  try {
    let resp;
    const part = 'id,snippet,statistics';
    if (parsed.type === 'id') {
      resp = await youtubeRequest('channels', { part, id: parsed.value });
    } else if (parsed.type === 'handle') {
      resp = await youtubeRequest('channels', { part, forHandle: parsed.value });
    } else if (parsed.type === 'legacy') {
      // /c/ ou /user/ → tenta forUsername primeiro (legacy username)
      resp = await youtubeRequest('channels', { part, forUsername: parsed.value });
      // Se falhar, sem fallback — Felipe colou URL ruim, retorna null
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
    console.error('[virais-canais] resolveChannelMetadata erro:', e.message);
    return null;
  }
}

// ── COLETOR (helper de duracao reutilizado) ─────────────────────────────────
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
      case 'adicionar':           return await adicionarCanal(req, res);
      case 'remover':             return await removerCanal(req, res);
      case 'listar':              return await listarCanais(req, res);
      case 'coletar-curados':     return await coletarCurados(req, res);
      case 'toggle-daily-alert':  return await toggleDailyAlert(req, res);
      case 'alert-status':        return await alertStatus(req, res);
      case 'daily-alert-master':  return await dailyAlertMaster(req, res);
      default:                    return res.status(400).json({ error: 'action_invalida' });
    }
  } catch (e) {
    console.error('[virais-canais]', action, e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ── ACTION: adicionar canal (admin) ─────────────────────────────────────────
async function adicionarCanal(req, res) {
  if (!assertAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST_apenas' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const url = (body.url || '').trim();
  const nicho = (body.nicho_manual || '').trim().toLowerCase();
  const idioma = (body.idioma_manual || '').trim();

  if (!url) return res.status(400).json({ error: 'url_obrigatorio' });
  if (!NICHO_LIST.includes(nicho)) {
    return res.status(400).json({ error: 'nicho_invalido', valid: NICHO_LIST });
  }
  if (!LANG_BY_CODE[idioma]) {
    return res.status(400).json({ error: 'idioma_invalido', valid: Object.keys(LANG_BY_CODE) });
  }

  // Limite soft de canais ativos pra nao estourar quota
  try {
    const countR = await fetch(`${SU}/rest/v1/virais_canais_curados?ativo=eq.true&select=id`, {
      headers: { ...HDR, Prefer: 'count=exact', Range: '0-0' },
    });
    const cr = countR.headers.get('content-range') || '';
    const m = cr.match(/\/(\d+)$/);
    const total = m ? parseInt(m[1], 10) : 0;
    if (total >= LIMITE_CANAIS) {
      return res.status(400).json({ error: 'limite_canais_atingido', limite: LIMITE_CANAIS, atual: total });
    }
  } catch {}

  // 1. Parse URL
  const parsed = parseChannelUrl(url);
  if (!parsed) return res.status(400).json({ error: 'url_invalida', hint: 'use https://youtube.com/@nome ou /channel/UCxxx' });

  // 2. Resolve metadata via YouTube
  const meta = await resolveChannelMetadata(parsed);
  if (!meta || !meta.channel_id) {
    return res.status(404).json({ error: 'canal_nao_encontrado', parsed });
  }

  // 3. Insert (ON CONFLICT: se ja existir, reativa)
  const payload = {
    channel_id: meta.channel_id,
    channel_handle: meta.handle,
    channel_name: meta.name,
    channel_url: url,
    thumbnail_url: meta.thumbnail_url,
    total_inscritos: meta.total_inscritos,
    nicho_manual: nicho,
    idioma_manual: idioma,
    ativo: true,
  };
  const r = await supaPost('virais_canais_curados', payload, {
    qs: 'on_conflict=channel_id',
    prefer: 'resolution=merge-duplicates,return=representation',
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

// ── ACTION: remover canal (soft) ────────────────────────────────────────────
async function removerCanal(req, res) {
  if (!assertAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const channelId = (body.channel_id || req.query?.channel_id || '').trim();
  if (!channelId) return res.status(400).json({ error: 'channel_id_obrigatorio' });
  const r = await supaPatch(`virais_canais_curados?channel_id=eq.${encodeURIComponent(channelId)}`, { ativo: false });
  if (!r.ok) return res.status(500).json({ error: 'patch_failed', status: r.status });
  return res.status(200).json({ ok: true, channel_id: channelId, ativo: false });
}

// ── ACTION: listar canais (admin) ───────────────────────────────────────────
async function listarCanais(req, res) {
  if (!assertAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  const apenasAtivos = req.query?.ativo !== 'false';
  const filtro = apenasAtivos ? 'ativo=eq.true&' : '';
  const r = await fetch(
    `${SU}/rest/v1/virais_canais_curados?${filtro}order=added_at.desc&select=*`,
    { headers: HDR }
  );
  const items = r.ok ? await r.json() : [];
  return res.status(200).json({ ok: true, total: items.length, canais: items });
}

// ── ACTION: coletar-curados (cron + dispatch manual) ────────────────────────
// Pra cada canal ativo: pega ultimos N videos da playlist de uploads, filtra
// Shorts ≤90s, salva em virais_banco com fonte='canal_curado'. Upsert
// idempotente atualiza views/likes dos videos ja salvos (diagnostico).
//
// Query param `profundidade` (default 20):
//   - cron automatico: 20 (cobre videos novos das ultimas 2h, leve)
//   - dispatch manual via botao "Coletar agora": 60 (revisita historico
//     mais fundo pra atualizar views de videos antigos do mesmo canal)
async function coletarCurados(req, res) {
  // Sem auth obrigatoria (chamada pelo Vercel cron). Pode rodar manual com Bearer.
  const startTs = Date.now();
  const profundidade = Math.min(50, Math.max(5, parseInt(req.query?.profundidade, 10) || 20));
  const log = { canais_processados: 0, videos_novos: 0, videos_atualizados: 0, erros: 0, profundidade };

  try {
    const r = await fetch(
      `${SU}/rest/v1/virais_canais_curados?ativo=eq.true&order=ultimo_check.asc.nullsfirst&select=id,channel_id,channel_handle,channel_name,nicho_manual,idioma_manual&limit=200`,
      { headers: HDR }
    );
    const canais = r.ok ? await r.json() : [];

    for (const canal of canais) {
      try {
        log.canais_processados++;

        // 1. Uploads playlist ID = channel_id com prefixo UU em vez de UC
        const uploadsId = canal.channel_id.replace(/^UC/, 'UU');

        // 2. Pega últimos N itens da playlist (profundidade configuravel)
        const plR = await youtubeRequest('playlistItems', {
          part: 'contentDetails',
          playlistId: uploadsId,
          maxResults: profundidade,
        });
        const ids = (plR?.items || []).map(it => it.contentDetails?.videoId).filter(Boolean);
        if (!ids.length) continue;

        // 3. Batch fetch dos vídeos com snippet+stats+contentDetails
        const vR = await youtubeRequest('videos', {
          part: 'snippet,contentDetails,statistics',
          id: ids.join(','),
          maxResults: 50,
        });
        const items = vR?.items || [];

        // 4. Pra cada video, normaliza e prepara pra upsert
        const langMeta = LANG_BY_CODE[canal.idioma_manual] || LANG_BY_CODE['pt-BR'];
        const rows = [];
        for (const item of items) {
          const duracao = parseDuracao(item.contentDetails?.duration);
          // Defesa em profundidade: rejeita longos E zero-duration (fix bug do !== 0)
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
            views,
            likes,
            comentarios: coment,
            duracao_segundos: duracao,
            taxa_engajamento: taxa,
            nicho: canal.nicho_manual,
            idioma: langMeta.idioma,
            pais: langMeta.pais,
            publicado_em: snippet.publishedAt || null,
            ativo: true,
            fonte: 'canal_curado',
            canal_curado_id: canal.id,
            atualizado_em: new Date().toISOString(),
          });
        }

        // 5. Upsert em virais_banco (idempotente por youtube_id)
        if (rows.length) {
          const upR = await fetch(`${SU}/rest/v1/virais_banco?on_conflict=youtube_id`, {
            method: 'POST',
            headers: { ...HDR, Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(rows),
          });
          if (upR.ok) {
            log.videos_novos += rows.length;
          } else {
            log.erros++;
          }
        }

        // 6. Update canal: ultimo_check + videos_coletados (incremento aproximado)
        await supaPatch(`virais_canais_curados?id=eq.${canal.id}`, {
          ultimo_check: new Date().toISOString(),
          videos_coletados: (canal.videos_coletados || 0) + rows.length,
        });
      } catch (e) {
        log.erros++;
        console.error('[virais-canais:coletar-curados]', canal.channel_id, e.message);
      }
    }

    return res.status(200).json({
      ok: true,
      duracao_ms: Date.now() - startTs,
      ...log,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, ...log });
  }
}

// ── ACTION: toggle-daily-alert (user master) ────────────────────────────────
async function toggleDailyAlert(req, res) {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const token = body.token || req.query?.token;
  const enable = body.enable !== false; // default: ligar (true)
  if (!token) return res.status(401).json({ error: 'token_obrigatorio' });

  const user = await getUserFromToken(token);
  if (!user || !user.email) return res.status(401).json({ error: 'token_invalido' });

  const sub = await getSubscriberByEmail(user.email);
  if (!sub) return res.status(404).json({ error: 'subscriber_nao_encontrado' });

  // SO Master pode ativar — Free/Full recebem 403 amigavel
  if (sub.plan !== 'master') {
    return res.status(403).json({
      error: 'plano_master_necessario',
      message: 'Recurso exclusivo Master. Faça upgrade pra receber alertas diários.',
      current_plan: sub.plan,
    });
  }

  const r = await supaPatch(`subscribers?email=eq.${encodeURIComponent(user.email)}`, {
    virais_daily_alert: !!enable,
    updated_at: new Date().toISOString(),
  });
  if (!r.ok) return res.status(500).json({ error: 'patch_failed' });

  return res.status(200).json({ ok: true, virais_daily_alert: !!enable });
}

// ── ACTION: alert-status (qualquer user logado, pra UI saber estado) ────────
async function alertStatus(req, res) {
  const token = req.query?.token;
  if (!token) return res.status(401).json({ error: 'token_obrigatorio' });
  const user = await getUserFromToken(token);
  if (!user || !user.email) return res.status(401).json({ error: 'token_invalido' });
  const sub = await getSubscriberByEmail(user.email);
  if (!sub) return res.status(200).json({ ok: true, plan: 'free', virais_daily_alert: false });
  return res.status(200).json({
    ok: true,
    plan: sub.plan || 'free',
    virais_daily_alert: !!sub.virais_daily_alert,
  });
}

// ── ACTION: daily-alert-master (cron 7:30 BRT = 10:30 UTC) ──────────────────
// Manda email pros Masters opt-in com top 5 shorts >1M views nas ultimas 24h.
async function dailyAlertMaster(req, res) {
  if (!RESEND_KEY) return res.status(500).json({ error: 'resend_nao_configurado' });

  // 1. Top 5 shorts virais (filtro EXATO conforme Felipe)
  const desde24h = new Date(Date.now() - 86400000).toISOString();
  const tR = await fetch(
    `${SU}/rest/v1/virais_banco?fonte=eq.canal_curado&duracao_segundos=lte.90&views=gte.1000000&publicado_em=gte.${desde24h}&ativo=eq.true&order=views.desc&limit=5&select=youtube_id,titulo,thumbnail_url,url,canal_nome,views,publicado_em,nicho`,
    { headers: HDR }
  );
  const shorts = tR.ok ? await tR.json() : [];

  if (!shorts.length) {
    return res.status(200).json({ ok: true, skipped: 'sem_shorts_qualificados', totals: { shorts: 0, masters: 0, enviados: 0 } });
  }

  // 2. Lista Masters opt-in
  const mR = await fetch(
    `${SU}/rest/v1/subscribers?plan=eq.master&virais_daily_alert=eq.true&select=email,name`,
    { headers: HDR }
  );
  const masters = mR.ok ? await mR.json() : [];

  // 3. Pra cada master, dispara email Resend
  let enviados = 0;
  let falhas = 0;
  for (const m of masters) {
    try {
      const html = renderEmailHtml(m.name || 'criador', shorts);
      const subject = '🔥 5 Shorts explodindo agora (24h)';
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM_EMAIL, to: m.email, subject, html }),
      });
      if (r.ok) enviados++; else falhas++;
    } catch (e) {
      falhas++;
      console.error('[daily-alert] erro envio:', m.email, e.message);
    }
  }

  return res.status(200).json({
    ok: true,
    totals: { shorts: shorts.length, masters: masters.length, enviados, falhas },
  });
}

// ── HTML do email (texto exato pedido pelo Felipe) ──────────────────────────
function renderEmailHtml(userName, shorts) {
  const safeName = String(userName || 'criador').replace(/[<>"&]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' }[c]));
  const cards = shorts.map((s, i) => {
    const viewsFmt = (s.views || 0).toLocaleString('pt-BR');
    const titSafe = String(s.titulo || '').replace(/[<>"&]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' }[c]));
    const canalSafe = String(s.canal_nome || '').replace(/[<>"&]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' }[c]));
    return `
      <tr><td style="padding:14px 0;border-bottom:1px solid #1a2740">
        <table cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td valign="top" width="120" style="padding-right:14px">
              <a href="${s.url}" style="text-decoration:none">
                <img src="${s.thumbnail_url || ''}" width="110" alt="" style="border-radius:8px;display:block;width:110px;height:auto"/>
              </a>
            </td>
            <td valign="top" style="font-family:Arial,sans-serif;color:#fff">
              <div style="font-size:12px;color:#7d92b8;margin-bottom:4px">#${i + 1} · ${canalSafe}</div>
              <div style="font-size:15px;font-weight:700;line-height:1.3;margin-bottom:6px"><a href="${s.url}" style="color:#fff;text-decoration:none">${titSafe}</a></div>
              <div style="font-size:13px;color:#22c55e;font-weight:700">🔥 ${viewsFmt} views em 24h</div>
            </td>
          </tr>
        </table>
      </td></tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#020817;font-family:Arial,sans-serif;color:#fff">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#020817">
  <tr><td align="center" style="padding:30px 16px">
    <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#0a1220;border-radius:16px;border:1px solid #1a2740;overflow:hidden">
      <tr><td style="padding:24px 24px 8px">
        <div style="font-size:22px;font-weight:800;color:#1a6bff;letter-spacing:-0.5px">BlueTube Virais</div>
      </td></tr>
      <tr><td style="padding:0 24px 16px">
        <div style="font-size:18px;color:#fff;margin-bottom:6px">Bom dia criador (${safeName}),</div>
        <div style="font-size:14px;color:#cbd5e1;line-height:1.5">eu pessoalmente separei pra você 5 shorts que explodiram nas últimas 24horas.</div>
      </td></tr>
      <tr><td style="padding:0 24px">
        <table cellpadding="0" cellspacing="0" border="0" width="100%">${cards}</table>
      </td></tr>
      <tr><td style="padding:18px 24px 22px;font-size:14px;color:#fbbf24;font-weight:700">
        Corre, que tá fresquinho e ninguém usou ainda!
      </td></tr>
      <tr><td style="padding:14px 24px 22px;font-size:11px;color:#7d92b8;border-top:1px solid #1a2740;line-height:1.6">
        Você ativou alertas diários em <a href="${SITE_URL}/virais.html" style="color:#1a6bff">/virais</a>.
        Pra desativar, abra a ferramenta e clique no sino novamente.
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;
}
