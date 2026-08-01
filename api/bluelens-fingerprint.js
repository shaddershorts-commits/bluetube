// api/bluelens-fingerprint.js — v4 (2026-06-23) — SerpAPI-only, sem Railway.
//
// MUDANÇA HISTÓRICA: removido extract-fingerprint do Railway. Razão:
//   - Problema recorrente de cookies YouTube expirando (manutenção contínua)
//   - Race conditions de webhooks afetando download
//   - Custos Vercel pra paralelizar extract de 5 candidatos
//
// Pipeline v4 (curto e estável):
//   1. PARALELO: fetchVideoMeta (YouTube Data API) + getSerpAPICandidates (Google Lens)
//   2. enrichVideoDetails (videos.list — title/duration/views dos candidatos)
//   3. Heurística pra ordenar e atribuir score "confiança aparente" (não é match pixel-real):
//      - Base 30
//      - +30 se duração ±20% do user
//      - +20 se SerpAPI rank top 3, +10 se top 10
//      - +10 se canal != user (mais provável repost)
//      - +10 se imagem aparece TAMBÉM em outras plataformas (sinal forte)
//      - Cap 95 (nunca afirma 100% sem fingerprint pixel)
//   4. Retorna top 10 candidatos YouTube + lista cross-platform (web_matches)
//
// Fallbacks:
//   - Cache hit: retorna em <500ms (Supabase bluelens_cache TTL 7d)
//   - SerpAPI down: retorna response mínima com só video_meta + mensagem clara
//   - YouTube API down: candidatos vêm sem enrich (só video_id+url)
//   - Cross-platform vazio: ainda mostra YouTube se houver
//
// Custos:
//   - SerpAPI Google Lens: 1 chamada (Starter $25/mês = 1000 análises)
//   - YouTube Data API: ~5 unidades por análise
//   - Railway: ZERO (removido)
//
// Schema response (compatível com frontend blueLens.html que já existe):
//   { ok, url, video_meta, matches:[{video_id,title,thumbnail,channel,views,duration,
//     published_at,score,confidence_pct}], web_matches:[...], serpapi:{...}, engine, cached }

// Env lido no momento do uso, não na carga do módulo (mesma lição do
// roteiro-chat): capturar no import quebra teste e depende de ordem de boot.
const cfg = () => {
  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
  return {
    SUPA_URL, SUPA_KEY,
    supaH: SUPA_KEY ? { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY } : null,
    SERPAPI_KEY: process.env.SERPAPI_KEY,
  };
};

// ── ROTAÇÃO DE CHAVES YOUTUBE (2026-07-30) ──────────────────────────────────
// Antes: YT_KEY = KEY_5 || KEY_1, fixo. Em 30/07 a KEY_5 estava SUSPENSA e a
// KEY_1 nem existia — toda análise saía "metadata indisponível" e a heurística
// perdia duração e canal (os critérios que mais pesam), enquanto a KEY_3 vivia
// ociosa. Agora:
//   1º BLUELENS_YT_KEY* — chaves DEDICADAS (pedido do user: sair do balde da
//      Virais, que já viveu apagão de quota)
//   2º YOUTUBE_API_KEY* — pool compartilhado, só como fallback
// ytFetch tenta a partir da última que funcionou; 403/quota pula pra próxima.
function listYtKeys() {
  const dedicadas = [], pool = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (/^BLUELENS_YT_KEY(_\d+)?$/.test(k)) dedicadas.push(v);
    else if (/^YOUTUBE_API_KEY(_\d+)?$/.test(k)) pool.push(v);
  }
  return [...dedicadas.sort(), ...pool.sort()];
}
let _ytIdx = 0; // lembra a última chave boa (vive enquanto a função está quente)

async function ytFetch(pathAndQuery, timeoutMs) {
  const keys = listYtKeys();
  if (!keys.length) return null;
  for (let tent = 0; tent < keys.length; tent++) {
    const key = keys[(_ytIdx + tent) % keys.length];
    try {
      const r = await fetch(
        `https://www.googleapis.com/youtube/v3/${pathAndQuery}&key=${key}`,
        { signal: AbortSignal.timeout(timeoutMs || 10000) }
      );
      if (r.ok) { _ytIdx = (_ytIdx + tent) % keys.length; return r; }
      // 403 = suspensa/quota, 400 = chave inválida → tenta a próxima
      if (r.status === 403 || r.status === 400) continue;
      return r; // outros erros (404, 5xx) não são culpa da chave
    } catch { continue; }   // timeout/rede: tenta a próxima
  }
  return null;
}

const MAX_CANDIDATES = 10;        // mostra mais agora (sem custo Railway)
const CACHE_TTL_DAYS = 7;

function extractYouTubeId(url) {
  try {
    const m = url.match(/(?:shorts\/|v=|youtu\.be\/|ytimg\.com\/vi\/)([a-zA-Z0-9_-]{6,20})/);
    return m?.[1] || null;
  } catch { return null; }
}

function detectPlatform(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (host.includes('youtube.com') || host.includes('youtu.be')) return 'youtube';
    if (host === 'i.ytimg.com' || host.endsWith('.ytimg.com')) return 'youtube_thumb';
    if (host.includes('tiktok.com')) return 'tiktok';
    if (host.includes('instagram.com')) return 'instagram';
    if (host === 'twitter.com' || host === 'x.com') return 'twitter';
    if (host.includes('facebook.com') || host.includes('fbsbx.com')) return 'facebook';
    if (host.includes('kwai')) return 'kwai';
    if (host.includes('reddit.com')) return 'reddit';
    if (host.includes('pinterest.com') || host.includes('pinimg.com')) return 'pinterest';
    return 'other';
  } catch { return 'unknown'; }
}

// Cache 7d — economiza SerpAPI quota se mesma URL é re-analisada.
async function getCachedAnalysis(youtubeId) {
  const { SUPA_URL, supaH } = cfg();
  if (!supaH || !SUPA_URL) return null;
  try {
    const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 86400 * 1000).toISOString();
    const r = await fetch(
      `${SUPA_URL}/rest/v1/bluelens_cache?youtube_id=eq.${encodeURIComponent(youtubeId)}&created_at=gt.${cutoff}&select=response,hits,created_at&limit=1`,
      { headers: supaH, signal: AbortSignal.timeout(3000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    if (!d?.[0]?.response) return null;
    fetch(`${SUPA_URL}/rest/v1/bluelens_cache?youtube_id=eq.${encodeURIComponent(youtubeId)}`, {
      method: 'PATCH',
      headers: { ...supaH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hits: (d[0].hits || 1) + 1, last_hit_at: new Date().toISOString() }),
    }).catch(() => {});
    return { response: d[0].response, created_at: d[0].created_at };
  } catch { return null; }
}

async function saveCachedAnalysis(youtubeId, response) {
  const { SUPA_URL, supaH } = cfg();
  if (!supaH || !SUPA_URL) return { ok: false, error: 'no supabase' };
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/bluelens_cache?on_conflict=youtube_id`, {
      method: 'POST',
      headers: { ...supaH, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({
        youtube_id: youtubeId,
        response,
        matches_count: (response.matches || []).length,
        web_matches_count: (response.web_matches || []).length,
        hits: 1,
        created_at: new Date().toISOString(),
        last_hit_at: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ok: false, error: `HTTP ${r.status}: ${txt.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e.message || '').slice(0, 200) };
  }
}

async function fetchVideoMeta(videoId) {
  if (!videoId) return null;
  try {
    const r = await ytFetch(`videos?part=snippet,contentDetails,statistics&id=${videoId}`, 10000);
    if (!r || !r.ok) return null;
    const d = await r.json();
    const item = d.items?.[0];
    if (!item) return null;
    const dur = item.contentDetails?.duration || '';
    const dm = dur.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
    const seconds = (parseInt(dm?.[1] || 0) * 60) + parseInt(dm?.[2] || 0);
    return {
      title: item.snippet?.title || '',
      channel: item.snippet?.channelTitle || '',
      thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || '',
      published_at: item.snippet?.publishedAt,
      views: parseInt(item.statistics?.viewCount || 0),
      duration: seconds,
    };
  } catch { return null; }
}

// SerpAPI Google Lens com a thumbnail. Retorna {youtube_ids, other_platforms, error}.
async function getSerpAPICandidates(youtubeId, thumbnailUrl) {
  const empty = { youtube_ids: [], other_platforms: [], total_visual_matches: 0, error: null };
  const { SERPAPI_KEY } = cfg();
  if (!SERPAPI_KEY) return { ...empty, error: 'SERPAPI_KEY ausente' };
  if (!thumbnailUrl) return { ...empty, error: 'thumbnail ausente' };
  try {
    const serpUrl = `https://serpapi.com/search?engine=google_lens&url=${encodeURIComponent(thumbnailUrl)}&api_key=${SERPAPI_KEY}`;
    const r = await fetch(serpUrl, { signal: AbortSignal.timeout(45000) });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ...empty, error: `SerpAPI HTTP ${r.status}: ${txt.slice(0, 200)}` };
    }
    const d = await r.json();
    if (d.error) return { ...empty, error: `SerpAPI: ${String(d.error).slice(0, 200)}` };

    const allMatches = d.visual_matches || [];
    const youtubeIds = [];          // mantém ordem do SerpAPI (rank)
    const seenIds = new Set();
    const otherPlatforms = [];

    for (const m of allMatches) {
      const link = m.link;
      if (!link) continue;
      const ytId = extractYouTubeId(link);
      if (ytId && ytId !== youtubeId && !seenIds.has(ytId)) {
        seenIds.add(ytId);
        youtubeIds.push(ytId);
        continue;
      }
      const platform = detectPlatform(link);
      if (platform !== 'youtube' && platform !== 'youtube_thumb' && platform !== 'other' && platform !== 'unknown') {
        otherPlatforms.push({
          url: link,
          title: m.title || '',
          thumbnail: m.thumbnail || '',
          source: m.source || '',
          platform,
        });
      }
    }

    return { youtube_ids: youtubeIds, other_platforms: otherPlatforms, total_visual_matches: allMatches.length, error: null };
  } catch (e) {
    return { ...empty, error: `exception: ${(e.message || '').slice(0, 200)}` };
  }
}

// Enriquece candidatos com snippet+duration+views via YouTube Data API.
async function enrichVideoDetails(candidates) {
  if (!candidates.length) return candidates;
  const ids = candidates.map(c => c.id).filter(Boolean).join(',');
  if (!ids) return candidates;
  try {
    const r = await ytFetch(`videos?part=snippet,contentDetails,statistics&id=${ids}`, 15000);
    if (!r || !r.ok) return candidates;
    const d = await r.json();
    const map = new Map();
    for (const item of (d.items || [])) {
      const dur = item.contentDetails?.duration || '';
      const dm = dur.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
      const seconds = (parseInt(dm?.[1] || 0) * 60) + parseInt(dm?.[2] || 0);
      map.set(item.id, {
        duration: seconds,
        views: parseInt(item.statistics?.viewCount || 0),
        title: item.snippet?.title || '',
        channel: item.snippet?.channelTitle || '',
        thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || '',
        published_at: item.snippet?.publishedAt,
      });
    }
    return candidates
      .map(c => {
        const e = map.get(c.id);
        if (!e) return c;
        return {
          ...c,
          duration: c.duration ?? e.duration,
          views: c.views ?? e.views,
          title: c.title || e.title,
          channel: c.channel || e.channel,
          thumbnail: c.thumbnail || e.thumbnail,
          published_at: c.published_at || e.published_at,
        };
      })
      .filter(c => map.has(c.id)); // pula videos que YouTube nao retornou (privados/deletados)
  } catch { return candidates; }
}

// ═══ v5 (2026-08-01): PRECISÃO POR INTERSEÇÃO DE DOIS QUADROS ═══════════════
// Probe de 31/07 no viral VWRvqntRefM: a busca pela CAPA e a busca por um
// QUADRO REAL do vídeo devolveram 7+7 candidatos SEM UM ÚNICO em comum.
// Uma imagem sozinha mede "se parece", não "é o mesmo vídeo" — era a origem
// dos "vídeos aleatórios" reportados pelo user. A v5 busca em dois momentos
// e trata presença nas DUAS buscas como o sinal forte.

function extractTikTokId(url) {
  try {
    const m = String(url).match(/tiktok\.com\/(?:@[^/]+\/video|v|embed\/v2|embed)\/(\d{8,})/);
    return m?.[1] || null;
  } catch { return null; }
}

// chave canônica pra reconhecer o MESMO match web nas duas buscas
function canonWeb(m) {
  const tk = extractTikTokId(m.url);
  if (tk) return 'tiktok:' + tk;
  try {
    const u = new URL(m.url);
    return (u.hostname.replace(/^www\./, '') + u.pathname).toLowerCase().replace(/\/$/, '');
  } catch { return String(m.url).toLowerCase(); }
}

// Funde as duas buscas. frames=2 → apareceu na capa E no quadro real.
function mergeSerpResults(resA, resB) {
  const yt = new Map(), web = new Map();
  const addYt = (ids) => (ids || []).forEach((id, idx) => {
    const e = yt.get(id) || { id, frames: 0, bestRank: 99 };
    e.frames += 1; e.bestRank = Math.min(e.bestRank, idx);
    yt.set(id, e);
  });
  const addWeb = (list) => (list || []).forEach((m, idx) => {
    const k = canonWeb(m);
    const e = web.get(k) || { ...m, canon: k, frames: 0, bestRank: 99 };
    e.frames += 1; e.bestRank = Math.min(e.bestRank, idx);
    if (!e.title && m.title) e.title = m.title;
    web.set(k, e);
  });
  addYt(resA?.youtube_ids); addWeb(resA?.other_platforms);
  if (resB) { addYt(resB.youtube_ids); addWeb(resB.other_platforms); }
  return { youtube: [...yt.values()], web: [...web.values()] };
}

// ── SCORE v5 — interseção pesa, e conflito SUBTRAI ─────────────────────────
// O random típico (1 quadro, rank bom, canal diferente, duração desconhecida)
// soma 20+15+5 = 40 e fica ABAIXO do piso de exibição. No v4 ele saía com 60%
// porque duração conflitante só "deixava de somar" — nunca subtraía.
const PISO_EXIBICAO = 55;

function scoreV5(c, userMeta) {
  let s = 20;
  if ((c.frames || 0) >= 2) s += 40;                       // confirmado nos 2 quadros
  const dU = userMeta?.duration || 0, dC = c.duration || 0;
  if (dU > 0 && dC > 0) {
    const abs = Math.abs(dU - dC);
    const rel = abs / Math.max(dU, dC);
    if (abs <= 2) s += 35;                                  // mesma duração = quase prova
    else if (rel <= 0.10) s += 25;
    else if (rel <= 0.20) s += 12;
    else if (rel > 0.50) s -= 25;                           // conflito PUNE
  }
  // (v5.2) TEXTO NÃO PARTICIPA DE NADA — lei do user: só quadro e sinais de vídeo
  if (typeof c.bestRank === 'number') {
    if (c.bestRank < 3) s += 15;
    else if (c.bestRank < 10) s += 8;
  }
  if (userMeta?.channel && c.channel && userMeta.channel.toLowerCase() !== c.channel.toLowerCase()) s += 5;
  return Math.min(95, Math.max(5, s));
}

// ── TikTok: enriquecer via TikAPI pra poder PONTUAR ────────────────────────
// O Lens já ACHA os links de TikTok; sem duração/título eles saíam crus, sem
// confiança. Com o TikAPI (mesma chave da Virais TikTok) entram na régua.
// Falhou/sem chave → ficam como antes. Nunca derruba a análise.
async function enrichTikTok(webList, maxCalls) {
  const KEY = process.env.TIKAPI_KEY;   // opcional: só o fallback usa
  const alvos = (webList || [])
    .filter(w => w.platform === 'tiktok' && extractTikTokId(w.url))
    .sort((a, b) => (b.frames - a.frames) || (a.bestRank - b.bestRank))
    .slice(0, maxCalls || 5);
  await Promise.all(alvos.map(async (w) => {
    const id = extractTikTokId(w.url);
    // 1º TikWM — GRÁTIS, sem chave (mesma engine que o BaixaBlue usa pra
    // download). Deixa 100% da cota TikAPI pro coletor da Virais e torna o
    // BlueLens imune a vencimento de assinatura (aconteceu em 31/07).
    try {
      const r = await fetch('https://www.tikwm.com/api/?url=' + encodeURIComponent('https://www.tiktok.com/@v/video/' + id), {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000),
      });
      const d = r.ok ? await r.json() : null;
      const v = d && d.code === 0 ? d.data : null;
      if (v && (Number(v.duration) > 0 || v.title)) {
        if (Number(v.duration) > 0) w.duration = Number(v.duration);
        if (!w.title && v.title) w.title = v.title;
        if (Number(v.play_count) > 0) w.views = Number(v.play_count);
        if (v.author?.unique_id) w.channel = '@' + v.author.unique_id;
        // capas pro estágio de confirmação por quadro (v5.1)
        if (v.origin_cover) w._origin_cover = String(v.origin_cover);
        if (v.cover) w._cover = String(v.cover);
        return;
      }
    } catch {}
    // 2º TikAPI (pago) — só se o TikWM falhar e houver chave ativa
    if (!KEY) return;
    try {
      const r = await fetch('https://api.tikapi.io/public/video?id=' + id, {
        headers: { 'X-API-KEY': KEY, accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return;
      const d = await r.json();
      const item = d?.itemInfo?.itemStruct || d?.itemStruct || d || {};
      const dur = Number(item?.video?.duration || 0);
      if (dur > 0) w.duration = dur;
      if (!w.title && item?.desc) w.title = item.desc;
      const plays = Number(item?.stats?.playCount || 0);
      if (plays > 0) w.views = plays;
      if (item?.author?.uniqueId) w.channel = '@' + item.author.uniqueId;
    } catch {}
  }));
  return webList;
}

// ═══ v5.1 (2026-08-01): CONFIRMAÇÃO POR QUADRO — pixel a pixel ══════════════
// Feedback do user no teste real (MhTfy53ySyQ): o Lens devolve "parecido", não
// "igual" — o quadro do meio tinha flores e vieram 30+ vídeos de flores. A
// única forma confiável é comparar QUADRO contra QUADRO. Sem Railway e sem
// cookies: os quadros do YouTube (hq0-3) e as capas do TikTok (TikWM) são
// imagens públicas; baixamos e comparamos com dHash (hash perceptual) aqui
// mesmo. jpeg-js é JS puro — sem dependência nativa.

const PIXEL_CONFIRMA = 10;   // distância Hamming ≤10 em 64 bits = mesmo quadro
const PIXEL_PROVAVEL = 16;
const PIXEL_REJEITA = 26;    // TODAS as comparações acima disso = só "parecido"

// dHash 8x8 sobre uma REGIÃO fracionária da imagem (média de bloco — estável
// a ruído de compressão). full = quadro inteiro; centro = miolo 70%, imune a
// legenda queimada/seta/moldura nas bordas (o caso de uso central do produto).
function decodeJpeg(buf) {
  try {
    const jpeg = require('jpeg-js');
    const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 32 });
    return (img && img.width && img.height) ? img : null;
  } catch { return null; }
}

function gridHash(img, f0x, f0y, f1x, f1y) {
  const W = 9, H = 8;
  const X0 = Math.floor(img.width * f0x), X1 = Math.ceil(img.width * f1x);
  const Y0 = Math.floor(img.height * f0y), Y1 = Math.ceil(img.height * f1y);
  const cinza = new Float64Array(W * H);
  for (let gy = 0; gy < H; gy++) {
    for (let gx = 0; gx < W; gx++) {
      const x0 = X0 + Math.floor(gx * (X1 - X0) / W), x1 = Math.max(x0 + 1, X0 + Math.floor((gx + 1) * (X1 - X0) / W));
      const y0 = Y0 + Math.floor(gy * (Y1 - Y0) / H), y1 = Math.max(y0 + 1, Y0 + Math.floor((gy + 1) * (Y1 - Y0) / H));
      let soma = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * img.width + x) * 4;
        soma += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
        n++;
      }
      cinza[gy * W + gx] = soma / Math.max(1, n);
    }
  }
  let hash = 0n;
  for (let y = 0; y < H; y++) for (let x = 0; x < W - 1; x++) {
    hash = (hash << 1n) | (cinza[y * W + x] < cinza[y * W + x + 1] ? 1n : 0n);
  }
  return hash;
}

function hashesDuplos(buf) {
  const img = decodeJpeg(buf);
  if (!img) return null;
  return {
    full: gridHash(img, 0, 0, 1, 1),
    centro: gridHash(img, 0.15, 0.15, 0.85, 0.85),
  };
}

// compat: os testes e o histórico usam o hash cheio
function dhashFromJpeg(buf) {
  const h = hashesDuplos(buf);
  return h ? h.full : null;
}

function hamming(a, b) {
  if (a == null || b == null) return 64;
  let x = a ^ b, n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

async function hashesDeUrl(url) {
  const baixar = async (u) => {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      return buf.length < 500 ? null : buf;   // placeholder cinza do ytimg é minúsculo
    } catch { return null; }
  };
  const buf = await baixar(url);
  let h = buf ? hashesDuplos(buf) : null;
  if (!h && buf) {
    // WebP/AVIF (capas de TikTok/IG): transcodifica pra JPEG via weserv
    // (proxy público de imagem). Falhou = neutro, nunca pune.
    const b2 = await baixar('https://images.weserv.nl/?url=' + encodeURIComponent(url) + '&output=jpg&w=480');
    h = b2 ? hashesDuplos(b2) : null;
  }
  return h;
}

const quadrosYt = (id) => [0, 1, 2, 3].map(n =>
  `https://i.ytimg.com/vi/${id}/${n === 0 ? 'hqdefault' : 'hq' + n}.jpg`);

// Decisão pura (testável). full ≤10 = mesmo quadro. Miolo ≤8 = mesmo quadro
// COM overlay nas bordas (legenda queimada/seta/moldura — o caso de uso
// central: achar a versão mais ORIGINAL). O atalho do miolo exige que a
// duração NÃO conflite: miolo parecido + duração incompatível = coincidência.
function aplicarPixel(score, ev) {
  const { minFull = null, minCentro = null, comparacoes = 0, durConflito = false } = ev || {};
  if (comparacoes < 2) return { score, pixel: null };
  if (minFull != null && minFull <= PIXEL_CONFIRMA) return { score: Math.max(score, 92), pixel: 'confirmado' };
  if (minCentro != null && minCentro <= 8 && !durConflito) return { score: Math.max(score, 92), pixel: 'confirmado', via: 'miolo' };
  if (minFull != null && minFull <= PIXEL_PROVAVEL) return { score: Math.min(95, score + 15), pixel: 'provavel' };
  if (minFull != null && minFull > PIXEL_REJEITA && (minCentro == null || minCentro > 20)) return { score: Math.min(score, 35), pixel: 'rejeitado' };
  return { score, pixel: null };
}

// LEI DO FRAME (user, 01/08): na lista "canais que postaram o MESMO vídeo"
// só entra candidato com quadro CONFIRMADO pixel a pixel. "Quase igual"
// (provável) não é prova — cena parecida de casamento passava raspando.
// Quadros do YouTube são sempre públicos, então exigir confirmação não
// depende de sorte de rede pro caso YT.
function filtrarMatchesYt(pontuados, max) {
  const confirmados = pontuados.filter(m => m.pixel === 'confirmado');
  return { matches: confirmados.slice(0, max), descartados: pontuados.length - confirmados.length };
}

// Corte de exibição do cross-platform (o Layer 3 que faltava ali): junk de
// quadro único sem NENHUMA evidência vai pra contagem, não pra lista.
function cortarWeb(webList) {
  const evidencia = (w) =>
    w.pixel === 'confirmado' || w.pixel === 'provavel' ||
    (w.frames || 0) >= 2 || (w.confidence_pct || 0) >= PISO_EXIBICAO;
  const rejeitado = (w) => w.pixel === 'rejeitado';
  const fortes = webList.filter(w => evidencia(w) && !rejeitado(w));
  if (fortes.length) return { mostrar: fortes, ocultos: webList.length - fortes.length };
  // ninguém tem evidência: mostra só o topo pra não parecer quebrado
  const semRejeitados = webList.filter(w => !rejeitado(w));
  return { mostrar: semRejeitados.slice(0, 5), ocultos: webList.length - Math.min(5, semRejeitados.length) };
}

// ═══ ENTRADA MULTI-PLATAFORMA (2026-08-01) ═════════════════════════════════
// O usuário cola link de YouTube, TikTok, Instagram ou Facebook. O pipeline
// (busca 2 quadros → interseção → pixel → corte) é agnóstico; o que muda é
// de onde vêm os quadros e a duração DO VÍDEO COLADO:
//   youtube → thumbs públicos (como sempre; NUNCA baixa — regra dos cookies)
//   tiktok  → TikWM (capas + play) e quadros reais via Railway quando dá
//   ig/fb   → cadeia do BaixaBlue resolve o arquivo → Railway extrai quadros
function resolverEntrada(url) {
  const u = String(url || '');
  if (/youtu\.?be/.test(u)) {
    const id = extractYouTubeId(u);
    return id ? { plataforma: 'youtube', id, cacheKey: id } : null;  // sem prefixo = compat cache antigo
  }
  const tk = extractTikTokId(u);
  if (tk) return { plataforma: 'tiktok', id: tk, cacheKey: 'tt:' + tk };
  if (/(vm|vt)\.tiktok\.com\/|tiktok\.com\/t\//.test(u)) {
    return { plataforma: 'tiktok', id: null, cacheKey: null };       // curto: TikWM resolve
  }
  const ig = u.match(/instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]{5,})/);
  if (ig) return { plataforma: 'instagram', id: ig[1], cacheKey: 'ig:' + ig[1] };
  if (/instagram\.com\//.test(u)) return { plataforma: 'instagram', id: null, cacheKey: null };
  if (/facebook\.com|fb\.watch|fb\.com/.test(u)) {
    const m = u.match(/(?:\/videos\/|[?&]v=)(\d{6,})/) || u.match(/fb\.watch\/([A-Za-z0-9_-]{5,})/) ||
              u.match(/\/(?:share|reel)\/(?:v\/)?([A-Za-z0-9_-]{5,})/);
    const id = m ? m[1] : require('crypto').createHash('md5').update(u).digest('hex').slice(0, 16);
    return { plataforma: 'facebook', id, cacheKey: 'fb:' + id };
  }
  return null;
}

// Railway extrai quadros de um arquivo e sobe pro bucket público (o Lens
// exige URL pública). Falha = null; quem chama degrada com honestidade.
async function framesViaRailway(videoUrl, prefixo) {
  const RW = process.env.RAILWAY_FFMPEG_URL;
  const { SUPA_URL, SUPA_KEY } = cfg();
  if (!RW || !SUPA_URL || !SUPA_KEY || !videoUrl) return null;
  try {
    const r = await fetch(RW.replace(/\/$/, '') + '/lens-frames', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_url: videoUrl,
        storage_prefix: 'bluelens/' + prefixo,
        supabase_url: SUPA_URL,
        supabase_key: SUPA_KEY,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return (d && d.ok && d.frames && d.frames.length) ? { duration: d.duration || 0, frames: d.frames } : null;
  } catch { return null; }
}

// Monta a entrada: meta do vídeo colado + URLs pra busca + URLs pra hash.
async function prepararEntrada(entrada, urlOriginal) {
  if (entrada.plataforma === 'youtube') {
    const meta = await fetchVideoMeta(entrada.id);
    return {
      ok: true, plataforma: 'youtube', cacheKey: entrada.id, selfCanon: null, selfYtId: entrada.id,
      meta, thumb: `https://i.ytimg.com/vi/${entrada.id}/hqdefault.jpg`,
      buscas: [`https://i.ytimg.com/vi/${entrada.id}/hqdefault.jpg`, `https://i.ytimg.com/vi/${entrada.id}/hq2.jpg`],
      quadrosUser: quadrosYt(entrada.id),
    };
  }

  if (entrada.plataforma === 'tiktok') {
    // TikWM aceita a URL crua (inclusive link curto) e devolve id/capas/play
    let v = null;
    try {
      const r = await fetch('https://www.tikwm.com/api/?url=' + encodeURIComponent(urlOriginal), {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000),
      });
      const d = r.ok ? await r.json() : null;
      if (d && d.code === 0 && d.data) v = d.data;
    } catch {}
    if (!v) return { ok: false, motivo: 'Não consegui ler este TikTok agora. Tenta de novo em instantes.' };
    const id = String(v.id || entrada.id || '');
    const capas = [...new Set([v.origin_cover, v.cover].filter(Boolean))];
    // dois momentos REAIS valem mais que duas capas do mesmo instante
    const rw = v.play ? await framesViaRailway(v.play, 'tt-' + id) : null;
    const buscas = rw
      ? [capas[0] || rw.frames[0], rw.frames[1] || rw.frames[0]]
      : capas.slice(0, 2);
    return {
      ok: true, plataforma: 'tiktok', cacheKey: 'tt:' + id, selfCanon: 'tiktok:' + id, selfYtId: null,
      meta: {
        title: v.title || 'Vídeo do TikTok',
        channel: v.author && v.author.unique_id ? '@' + v.author.unique_id : '—',
        thumbnail: capas[0] || '',
        published_at: v.create_time ? new Date(v.create_time * 1000).toISOString() : null,
        views: Number(v.play_count || 0),
        duration: Number(v.duration || (rw && rw.duration) || 0),
      },
      thumb: capas[0] || '',
      buscas: buscas.filter(Boolean).slice(0, 2),
      quadrosUser: [...capas, ...((rw && rw.frames) || [])].slice(0, 5),
    };
  }

  // instagram / facebook: a cadeia do BaixaBlue resolve o arquivo
  const SITE = process.env.SITE_URL || 'https://www.bluetubeviral.com';
  let resolvido = null;
  try {
    const r = await fetch(SITE + '/api/baixa-social?url=' + encodeURIComponent(urlOriginal), {
      signal: AbortSignal.timeout(45000),
    });
    const d = r.ok ? await r.json() : null;
    if (d && d.url) resolvido = d;
  } catch {}
  if (!resolvido) {
    return { ok: false, motivo: 'Não consegui ler este vídeo agora (a rede de origem dificulta). Tenta de novo — ou cola a versão do YouTube ou TikTok se tiver.' };
  }
  const rw = await framesViaRailway(resolvido.url, entrada.plataforma.slice(0, 2) + '-' + entrada.id);
  if (!rw) return { ok: false, motivo: 'Achei o vídeo mas não consegui ler os quadros dele. Tenta de novo em instantes.' };
  return {
    ok: true, plataforma: entrada.plataforma, cacheKey: entrada.cacheKey, selfCanon: null, selfYtId: null,
    meta: {
      title: resolvido.title || (entrada.plataforma === 'instagram' ? 'Vídeo do Instagram' : 'Vídeo do Facebook'),
      channel: '—', thumbnail: rw.frames[0], published_at: null, views: 0, duration: rw.duration,
    },
    thumb: rw.frames[0],
    buscas: [rw.frames[0], rw.frames[2] || rw.frames[1] || rw.frames[0]].slice(0, 2),
    quadrosUser: rw.frames,
  };
}

// Compara os quadros do USER contra as imagens de cada candidato, por região
// (full×full e miolo×miolo — nunca cruzado).
async function confirmarPorQuadro(quadrosUserUrls, candYt, candWeb, userDur) {
  const hashesUser = (await Promise.all((quadrosUserUrls || []).map(hashesDeUrl))).filter(h => h != null);
  if (hashesUser.length === 0) return;

  const medir = async (urls) => {
    const hs = (await Promise.all(urls.map(hashesDeUrl))).filter(h => h != null);
    let minFull = null, minCentro = null;
    for (const hc of hs) for (const hu of hashesUser) {
      const df = hamming(hc.full, hu.full);
      const dc = hamming(hc.centro, hu.centro);
      if (minFull == null || df < minFull) minFull = df;
      if (minCentro == null || dc < minCentro) minCentro = dc;
    }
    return { minFull, minCentro, comparacoes: hs.length * hashesUser.length };
  };

  const conflita = (dC) => !!(userDur > 0 && dC > 0 && Math.abs(userDur - dC) / Math.max(userDur, dC) > 0.5);

  await Promise.all([
    ...candYt.map(async (c) => {
      const ev = await medir(quadrosYt(c.video_id));
      ev.durConflito = conflita(c.duration || 0);
      const r = aplicarPixel(c.confidence_pct, ev);
      c.confidence_pct = r.score; c.score = r.score / 100;
      if (r.pixel) c.pixel = r.pixel;
      if (r.via) c.pixel_via = r.via;
    }),
    ...candWeb.map(async (w) => {
      const urls = [w._cover, w._origin_cover, w.thumbnail].filter(Boolean).slice(0, 2);
      if (!urls.length) return;
      const ev = await medir(urls);
      ev.durConflito = conflita(w.duration || 0);
      const base = w.confidence_pct != null ? w.confidence_pct : 30;
      const r = aplicarPixel(base, ev);
      if (r.pixel) { w.pixel = r.pixel; w.confidence_pct = r.score; if (r.via) w.pixel_via = r.via; }
    }),
  ]);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const url = req.query?.url;
  if (!url) return res.status(400).json({ error: 'url obrigatorio' });
  if (!cfg().SERPAPI_KEY) return res.status(500).json({ error: 'SERPAPI_KEY nao configurada' });
  // Sem chave YouTube NÃO é fatal: o safeMeta cobre (desenho v4). Antes isso
  // devolvia 500 e derrubava a feature inteira por falta do opcional.

  // ── PORTÃO FULL/MASTER (2026-07-30) ─────────────────────────────────────
  // A página sempre exigiu Full/Master, mas a API aceitava qualquer um com a
  // URL — e cada chamada queima 1 busca SerpAPI (plano de 250/mês). Sem cota
  // por usuário (decisão do user): assinante usa à vontade; só fecha a porta
  // pra quem não é cliente.
  {
    const { SUPA_URL, SUPA_KEY, supaH } = cfg();
    const AK = process.env.SUPABASE_ANON_KEY || SUPA_KEY;
    const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query?.token;
    let plano = null;
    if (token && SUPA_URL) {
      try {
        const ur = await fetch(`${SUPA_URL}/auth/v1/user`, {
          headers: { apikey: AK, Authorization: 'Bearer ' + token },
          signal: AbortSignal.timeout(5000),
        });
        if (ur.ok) {
          const u = await ur.json();
          if (u?.email) {
            const pr = await fetch(
              `${SUPA_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(u.email)}&select=plan,plan_expires_at,is_manual`,
              { headers: supaH, signal: AbortSignal.timeout(5000) }
            );
            const sub = pr.ok ? (await pr.json())[0] : null;
            if (sub && (sub.plan === 'full' || sub.plan === 'master')) {
              const vivo = sub.is_manual || !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date();
              if (vivo) plano = sub.plan;
            }
          }
        }
      } catch {}
    }
    if (!plano) {
      return res.status(403).json({
        error: 'O BlueLens é exclusivo dos planos Full e Master.',
        upgrade: true,
      });
    }
  }

  const entrada = resolverEntrada(url);
  if (!entrada) return res.status(400).json({ error: 'Cole um link de vídeo do YouTube, TikTok, Instagram ou Facebook.' });

  const startTs = Date.now();
  const skipCache = req.query?.force === 'true';

  // ── CACHE CHECK (TTL 7d) ──────────────────────────────────────────────────
  if (!skipCache && entrada.cacheKey) {
    const cached = await getCachedAnalysis(entrada.cacheKey);
    if (cached?.response) {
      const cacheAgeDays = (Date.now() - new Date(cached.created_at).getTime()) / 86400000;
      return res.status(200).json({
        ...cached.response,
        cached: true,
        cache_age_days: Math.round(cacheAgeDays * 10) / 10,
        timing: { total_ms: Date.now() - startTs, source: 'cache' },
      });
    }
  }

  try {
    const prep = await prepararEntrada(entrada, url);
    if (!prep.ok) {
      // honestidade: não conseguiu LER o vídeo colado — não é "sem repost"
      return res.status(200).json({
        ok: true, url, plataforma: entrada.plataforma,
        video_meta: { title: 'Vídeo (' + entrada.plataforma + ')', channel: '—', thumbnail: '', published_at: null, views: 0, duration: 0, _meta_unavailable: true },
        serpapi: { total_visual_matches: 0, youtube_ids_found: 0, error: prep.motivo },
        candidates_searched: 0, candidates_filtered: 0, matches: [], web_matches: [],
        engine: 'entrada_indisponivel', message: prep.motivo, cached: false,
        timing: { total_ms: Date.now() - startTs },
      });
    }
    // link curto resolvido agora: confere o cache com a chave real
    if (!skipCache && !entrada.cacheKey && prep.cacheKey) {
      const cached = await getCachedAnalysis(prep.cacheKey);
      if (cached?.response) {
        const cacheAgeDays = (Date.now() - new Date(cached.created_at).getTime()) / 86400000;
        return res.status(200).json({ ...cached.response, cached: true, cache_age_days: Math.round(cacheAgeDays * 10) / 10, timing: { total_ms: Date.now() - startTs, source: 'cache' } });
      }
    }

    const meta = prep.meta;
    const serpResult = await getSerpAPICandidates(prep.selfYtId, prep.buscas[0]);

    // FALLBACK: meta pode estar null se YouTube Data API tá sem quota.
    // Não bloqueia o flow — segue com metadata mínima e tenta SerpAPI mesmo assim.
    // (Cenário visto em 2026-06-23: todas YT_KEYs com quota_exceeded simultaneamente.)
    const safeMeta = meta && meta.title ? meta : {
      title: 'Vídeo (metadata indisponível)',
      channel: '—',
      thumbnail: prep.thumb,
      published_at: null,
      views: 0,
      duration: 0,
      _meta_unavailable: true,
    };
    if (!meta || !meta.title) {
      console.warn(`[bluelens v4] ${youtubeId}: YouTube Data API falhou — seguindo com meta mínima (quota esgotada?)`);
    }

    // FALLBACK: SerpAPI quebrou — retorna resposta mínima com meta only,
    // sem matches mas sem erro fatal (UI mostra "tentativa falhou" graceful).
    if (serpResult.error && serpResult.youtube_ids.length === 0 && serpResult.other_platforms.length === 0) {
      const fallbackResponse = {
        ok: true,
        url,
        youtube_id: youtubeId,
        video_meta: safeMeta,
        serpapi: {
          total_visual_matches: 0,
          youtube_ids_found: 0,
          error: serpResult.error,
        },
        candidates_searched: 0,
        candidates_filtered: 0,
        matches: [],
        web_matches: [],
        engine: 'serpapi_v4_fallback_empty',
        message: 'Busca visual temporariamente indisponivel: ' + serpResult.error,
        cached: false,
        timing: { total_ms: Date.now() - startTs },
      };
      // Não cacheia erro
      return res.status(200).json(fallbackResponse);
    }

    // ── BUSCA 2 (quadro real) — ADAPTATIVA ──────────────────────────────────
    // Só gasta a 2ª busca SerpAPI se a 1ª achou candidato. Análise que não
    // achou nada não paga confirmação. Se a 2ª falhar, degrada pra 1 quadro
    // (sem bônus de interseção) em vez de derrubar a análise.
    let serpB = null;
    if (serpResult.youtube_ids.length + serpResult.other_platforms.length > 0
        && prep.buscas[1] && prep.buscas[1] !== prep.buscas[0]) {
      const b = await getSerpAPICandidates(prep.selfYtId, prep.buscas[1]);
      if (!b.error || b.youtube_ids.length || b.other_platforms.length) serpB = b;
    }

    const fundido = mergeSerpResults(serpResult, serpB);
    if (prep.selfCanon) fundido.web = fundido.web.filter(w => w.canon !== prep.selfCanon);

    // ── Enrich YouTube (até 15 ids em UMA chamada videos.list) ──────────────
    let candidates = fundido.youtube.slice(0, 15).map(c => ({
      ...c,
      url: `https://www.youtube.com/watch?v=${c.id}`,
      title: '', channel: '', thumbnail: '', published_at: null,
    }));
    candidates = await enrichVideoDetails(candidates);

    // ── Enrich TikTok (o Lens acha; o TikAPI dá duração/título pra pontuar) ─
    await enrichTikTok(fundido.web, 5);

    // ── Score v5 + CORTE HONESTO ────────────────────────────────────────────
    const pontuados = candidates
      .map(c => ({
        url: c.url,
        video_id: c.id,
        title: c.title,
        channel: c.channel,
        thumbnail: c.thumbnail,
        published_at: c.published_at,
        views: c.views,
        duration: c.duration,
        frames_hit: c.frames,
        confidence_pct: scoreV5(c, safeMeta),
      }))
      .map(m => ({ ...m, score: m.confidence_pct / 100 }))
      .sort((a, b) => b.confidence_pct - a.confidence_pct);

    // web: pontua quem tem dado pra isso (TikTok enriquecido ou interseção)
    const webPontuado = fundido.web.map(w => {
      if (w.duration || (w.frames || 0) >= 2) w.confidence_pct = scoreV5(w, safeMeta);
      return w;
    });

    // ── v5.1: CONFIRMAÇÃO POR QUADRO (pixel a pixel) ────────────────────────
    // "A única forma confiável é por frame" (user, 01/08 — e tem razão).
    // Compara os 4 quadros do vídeo do user contra os 4 de cada candidato YT
    // e contra as capas dos TikToks. Igual = 92+; só "parecido" = despenca.
    await confirmarPorQuadro(
      prep.quadrosUser,
      pontuados.slice(0, 8),
      webPontuado.filter(w => w._cover || w._origin_cover || w.thumbnail).slice(0, 10),
      safeMeta.duration || 0
    );
    pontuados.sort((a, b) => b.confidence_pct - a.confidence_pct);

    // Lista vazia honesta vale mais que lista cheia errada (regra de ouro do
    // user no Blublu: primeiro precisão, depois quantidade).
    const fx = filtrarMatchesYt(pontuados, MAX_CANDIDATES);
    const matches = fx.matches;
    const descartados = fx.descartados;

    const corte = cortarWeb(webPontuado);
    const web = corte.mostrar
      .sort((a, b) => (b.confidence_pct || 0) - (a.confidence_pct || 0) || (b.frames - a.frames));
    for (const w of web) { delete w._cover; delete w._origin_cover; }

    const finalResponse = {
      ok: true,
      url,
      plataforma: prep.plataforma,
      youtube_id: prep.selfYtId || prep.cacheKey,
      video_meta: safeMeta,
      serpapi: {
        total_visual_matches: (serpResult.total_visual_matches || 0) + (serpB?.total_visual_matches || 0),
        youtube_ids_found: fundido.youtube.length,
        frames_buscados: serpB ? 2 : 1,
        error: serpResult.error || serpB?.error || null,
      },
      candidates_searched: fundido.youtube.length,
      candidates_filtered: matches.length,
      matches,
      matches_low_confidence: descartados,
      web_matches: web,
      web_matches_hidden: corte.ocultos,
      engine: 'serpapi_v51_pixel',
      message: matches.length === 0
        ? 'Nenhum canal do YouTube tem o MESMO quadro do seu vídeo (comparei pixel a pixel). Parecidos não contam — e prefiro lista vazia a chute.'
        : undefined,
      cached: false,
      timing: { total_ms: Date.now() - startTs },
    };

    const saveResult = await saveCachedAnalysis(prep.cacheKey, finalResponse);
    finalResponse.cache_saved = saveResult.ok;
    return res.status(200).json(finalResponse);
  } catch (e) {
    console.error('[bluelens-fingerprint v4]', e.message);
    return res.status(500).json({ error: e.message, timing: { total_ms: Date.now() - startTs } });
  }
};

// exportados pros testes (tests/unit/bluelens_rotacao.test.mjs)
module.exports.listYtKeys = listYtKeys;
module.exports.ytFetch = ytFetch;
module.exports.scoreV5 = scoreV5;
module.exports.mergeSerpResults = mergeSerpResults;
module.exports.extractTikTokId = extractTikTokId;
module.exports.PISO_EXIBICAO = PISO_EXIBICAO;
module.exports.aplicarPixel = aplicarPixel;
module.exports.cortarWeb = cortarWeb;
module.exports.filtrarMatchesYt = filtrarMatchesYt;
module.exports.dhashFromJpeg = dhashFromJpeg;
module.exports.hashesDuplos = hashesDuplos;
module.exports.resolverEntrada = resolverEntrada;
module.exports.hamming = hamming;
