// api/_helpers/tiktok-download.js — Cadeia de download TikTok (2026-07-27)
// =============================================================================
// MOTIVO: as 2 APIs pagas do RapidAPI estouraram a cota mensal no mesmo mês e o
// BaixaBlue ficou SEM TikTok pra todo mundo. Descoberta do diagnóstico: o
// `tiktok-scraper7` que pagávamos É o TikWM (o próprio erro do RapidAPI aponta
// pra tikwm-tikwm-default) — e o TikWM tem API PÚBLICA GRATUITA, sem chave.
//
// DESENHO (não depender de fornecedor único, nunca mais cair por cota):
//   1. TikWM público  — 2 hosts (www.tikwm.com / tikwm.com) × 2 formas de
//                       consulta (URL completa e ID puro) = 4 tentativas grátis
//   2. Cobalt         — nosso self-hosted no Railway (grátis, já pago)
//   3. Railway yt-dlp — /snapchat-extract (genérico, allowlist inclui tiktok)
//   4. RapidAPI       — ÚLTIMO recurso, só se a cota voltar (não bloqueia nada)
//
// Cada provedor tem timeout curto e é isolado: falhou, o próximo assume. A
// função devolve QUAL provedor resolveu (telemetria pro health/admin saber
// quando um caminho começa a degradar ANTES do usuário reclamar).

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const TIMEOUT_PADRAO = 12000;

function extrairId(url) {
  const m = String(url || '').match(/\/video\/(\d{6,})/) || String(url || '').match(/\/photo\/(\d{6,})/) || String(url || '').match(/\b(\d{15,25})\b/);
  return m ? m[1] : null;
}

async function fetchJson(url, { timeout = TIMEOUT_PADRAO, headers = {}, method = 'GET', body = null } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      method,
      headers: { 'User-Agent': UA_DESKTOP, 'Accept': 'application/json', ...headers },
      body: body || undefined,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const txt = await r.text();
    try { return { ok: r.ok, status: r.status, json: JSON.parse(txt) }; }
    catch (e) { return { ok: false, status: r.status, json: null, raw: txt.slice(0, 200) }; }
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, json: null, erro: e.message };
  }
}

// ── 1) TikWM público (grátis, sem chave) ────────────────────────────────────
// Redundância: 2 hosts × 2 formas de consulta. hdplay > play > wmplay.
async function viaTikwm(url) {
  const id = extrairId(url);
  const alvos = [];
  for (const host of ['https://www.tikwm.com', 'https://tikwm.com']) {
    alvos.push(`${host}/api/?url=${encodeURIComponent(url)}&hd=1`);
    if (id) alvos.push(`${host}/api/?url=${id}&hd=1`);
  }
  for (const alvo of alvos) {
    const r = await fetchJson(alvo, { timeout: 12000 });
    const d = r.json && (r.json.data || null);
    const link = d && (d.hdplay || d.play || d.wmplay);
    if (link) {
      // caminho relativo (/video/...) → completa com o host do TikWM
      const full = link.startsWith('http') ? link : 'https://www.tikwm.com' + link;
      return {
        downloadUrl: full,
        title: d.title || 'TikTok',
        thumbnail: d.cover || d.origin_cover || null,
        provider: 'tikwm',
      };
    }
  }
  return null;
}

// ── 2) Cobalt self-hosted (nosso Railway) ───────────────────────────────────
async function viaCobalt(url) {
  const CU = process.env.COBALT_API_URL;
  if (!CU) return null;
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.COBALT_API_KEY) headers.Authorization = 'Api-Key ' + process.env.COBALT_API_KEY;
  const r = await fetchJson(CU, {
    method: 'POST', headers, timeout: 15000,
    body: JSON.stringify({ url, videoQuality: '720' }),
  });
  const d = r.json;
  const link = d && (d.url || (d.picker && d.picker[0] && d.picker[0].url));
  if (link) return { downloadUrl: link, title: (d.filename || 'TikTok').replace(/\.[a-z0-9]+$/i, ''), thumbnail: null, provider: 'cobalt' };
  return null;
}

// ── 3) Railway yt-dlp (endpoint genérico já existente) ──────────────────────
async function viaRailway(url) {
  const RW = process.env.RAILWAY_FFMPEG_URL;
  if (!RW) return null;
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.SNAPCHAT_PROCESS_KEY) headers['x-internal-token'] = process.env.SNAPCHAT_PROCESS_KEY;
  const r = await fetchJson(`${RW}/snapchat-extract`, {
    method: 'POST', headers, timeout: 22000,
    body: JSON.stringify({ url }),
  });
  const d = r.json;
  if (d && d.ok && d.url) return { downloadUrl: d.url, title: d.title || 'TikTok', thumbnail: null, provider: 'railway-ytdlp' };
  return null;
}

// ── 4) RapidAPI (último recurso — só funciona se houver cota) ───────────────
async function viaRapidApi(url) {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return null;
  const tentativas = [
    { host: 'tiktok-scraper7.p.rapidapi.com', url: `https://tiktok-scraper7.p.rapidapi.com/?url=${encodeURIComponent(url)}&hd=1` },
    { host: 'tiktok-download-without-watermark4.p.rapidapi.com', url: `https://tiktok-download-without-watermark4.p.rapidapi.com/tiktok?url=${encodeURIComponent(url)}` },
  ];
  for (const t of tentativas) {
    const r = await fetchJson(t.url, { timeout: 12000, headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': t.host } });
    const d = r.json && (r.json.data || r.json.result || r.json);
    const link = d && (d.hdplay || d.play || d.wmplay || (d.video && (d.video.noWatermark || d.video.play)));
    if (r.ok && link) return { downloadUrl: link, title: d.title || d.desc || 'TikTok', thumbnail: d.cover || d.thumbnail || null, provider: 'rapidapi' };
  }
  return null;
}

// ── Orquestrador ────────────────────────────────────────────────────────────
// Retorna { downloadUrl, title, thumbnail, provider, tentativas } ou null.
// `tentativas` = trilha do que falhou (log/diagnóstico sem adivinhação).
async function baixarTiktok(url) {
  const cadeia = [
    ['tikwm', viaTikwm],
    ['cobalt', viaCobalt],
    ['railway-ytdlp', viaRailway],
    ['rapidapi', viaRapidApi],
  ];
  const tentativas = [];
  for (const [nome, fn] of cadeia) {
    try {
      const r = await fn(url);
      if (r && r.downloadUrl) {
        console.log(`[tiktok-dl] ✓ ${nome}`, tentativas.length ? `(após ${tentativas.join(', ')})` : '');
        return { ...r, tentativas };
      }
      tentativas.push(nome + ':vazio');
    } catch (e) {
      tentativas.push(nome + ':erro');
      console.warn(`[tiktok-dl] ${nome} falhou:`, e.message);
    }
  }
  console.error('[tiktok-dl] TODOS os provedores falharam:', tentativas.join(', '));
  return null;
}

module.exports = { baixarTiktok, extrairId, viaTikwm };
