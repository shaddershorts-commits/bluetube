// api/_helpers/instagram.js — Acesso à API interna web do Instagram (2026-07-25)
// =============================================================================
// Usado pela ferramenta Instagram Virais (api/instagram-virais.js).
//
// Como funciona: o site do Instagram (logado) consome uma API interna
// (instagram.com/api/v1/*). Com os cookies de uma CONTA DESCARTÁVEL logada
// (env IG_COOKIES_B64), fazemos as mesmas chamadas que o navegador faria:
//   - media info  → título, autor, VIEWS (play_count), likes, comentários, thumb
//   - clips/user  → Reels recentes de um perfil (com views), paginado
//   - web_profile_info → resolve username → user_pk (rate-limit agressivo!)
//
// Validado 2026-07-25 (IP residencial): media ✅ views ✅ clips ✅.
// web_profile_info toma 429 fácil em conta nova — sempre trate como best-effort
// e ofereça fallback (resolver autor via URL de um Reel do perfil).
//
// BLINDAGEM (pedido do user): este helper é SÓ o braço coletor. O banco
// (instagram_virais) é a fonte da verdade do que aparece pro usuário — se a
// conta cair, NADA aqui deleta ou esconde vídeo já coletado.
//
// IG_COOKIES_B64: base64 de um arquivo Netscape cookies.txt (export da conta
// descartável) OU de uma string "chave=valor; chave=valor". Setar via CLI
// (vercel env add) — nunca colar em painel web (valor grande some silencioso).

const IG_APP_ID = '936619743392459'; // app id fixo do site web do Instagram
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;

// ── Cookies ──────────────────────────────────────────────────────────────────
function parseCookiesEnv() {
  const b64 = process.env.IG_COOKIES_B64 || '';
  if (!b64) return null;
  let raw;
  try { raw = Buffer.from(b64, 'base64').toString('utf8'); } catch (e) { return null; }
  const jar = {};
  if (raw.includes('\t')) {
    // Formato Netscape: domínio \t flag \t path \t secure \t expiry \t nome \t valor
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const p = line.split('\t');
      if (p.length >= 7 && p[0].includes('instagram.com')) jar[p[5]] = p[6].trim();
    }
  } else {
    // Formato header: "k=v; k2=v2"
    for (const pair of raw.split(';')) {
      const eq = pair.indexOf('=');
      if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  return Object.keys(jar).length ? jar : null;
}

function igHeaders(referer) {
  const jar = parseCookiesEnv();
  if (!jar) return null; // sem cookies configurados
  return {
    'Cookie': Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
    'User-Agent': UA,
    'X-IG-App-ID': IG_APP_ID,
    'X-CSRFToken': jar.csrftoken || '',
    'Accept': '*/*',
    'Referer': referer || 'https://www.instagram.com/',
  };
}

function temCookies() { return !!parseCookiesEnv(); }

// ── Shortcode ────────────────────────────────────────────────────────────────
// URL aceita: instagram.com/p/CODE, /reel/CODE, /reels/CODE, /tv/CODE
function parseShortcode(url) {
  const m = String(url || '').match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,20})/i);
  return m ? m[1] : null;
}

// shortcode (base64url custom do IG) → media_pk numérico
const SC_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function shortcodeToPk(shortcode) {
  let pk = 0n;
  for (const ch of shortcode) {
    const v = SC_ALPHA.indexOf(ch);
    if (v < 0) return null;
    pk = pk * 64n + BigInt(v);
  }
  return pk.toString();
}

// ── Fetch com timeout + erro estruturado ────────────────────────────────────
async function igFetch(url, opts = {}) {
  const H = igHeaders(opts.referer);
  if (!H) { const e = new Error('cookies_nao_configurados'); e.status = 0; throw e; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let r;
  try {
    r = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.body ? { ...H, 'Content-Type': 'application/x-www-form-urlencoded' } : H,
      body: opts.body || undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const err = new Error('rede: ' + e.message);
    err.status = 0;
    throw err;
  }
  clearTimeout(timer);
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`instagram_http_${r.status}`);
    err.status = r.status;
    err.body = text.slice(0, 200);
    throw err;
  }
  try { return JSON.parse(text); } catch (e) {
    // 200 com HTML = provável checkpoint/login wall (conta caiu ou sessão inválida)
    const err = new Error('resposta_nao_json (sessão inválida ou checkpoint?)');
    err.status = 200;
    err.body = text.slice(0, 200);
    throw err;
  }
}

// ── Normalização de um item de mídia da API interna ─────────────────────────
function normalizarMedia(m) {
  if (!m) return null;
  const cap = (m.caption && m.caption.text) || '';
  const thumb = m.image_versions2 && m.image_versions2.candidates && m.image_versions2.candidates[0]
    ? m.image_versions2.candidates[0].url : null;
  return {
    shortcode: m.code || null,
    media_pk: m.pk ? String(m.pk) : null,
    author_handle: (m.user && m.user.username) || null,
    author_name: (m.user && m.user.full_name) || null,
    author_pk: (m.user && (m.user.pk || m.user.pk_id)) ? String(m.user.pk || m.user.pk_id) : null,
    caption: cap.slice(0, 500),
    views_count: m.play_count || m.ig_play_count || m.view_count || 0,
    likes_count: m.like_count || 0,
    comments_count: m.comment_count || 0,
    duration_sec: m.video_duration || null,
    ig_created_at: m.taken_at ? new Date(m.taken_at * 1000).toISOString() : null,
    thumbnail_origem: thumb,
    is_video: m.media_type === 2, // 1=foto, 2=vídeo, 8=carrossel
    media_type: m.media_type,
  };
}

// ── API pública do helper ────────────────────────────────────────────────────

// Metadata completa de um post/Reel (inclui VIEWS). shortcode ou URL.
async function mediaInfo(shortcodeOuUrl) {
  const sc = parseShortcode(shortcodeOuUrl) || String(shortcodeOuUrl).trim();
  const pk = shortcodeToPk(sc);
  if (!pk) { const e = new Error('shortcode_invalido'); e.status = 400; throw e; }
  const j = await igFetch(`https://www.instagram.com/api/v1/media/${pk}/info/`, {
    referer: `https://www.instagram.com/reel/${sc}/`,
  });
  const item = j.items && j.items[0];
  if (!item) { const e = new Error('media_vazia (post deletado ou privado?)'); e.status = 404; throw e; }
  const n = normalizarMedia(item);
  if (!n.shortcode) n.shortcode = sc;
  return n;
}

// Reels recentes de um perfil (com views). Retorna { items, next_max_id }.
async function clipsDoPerfil(userPk, { pageSize = 12, maxId = null } = {}) {
  let body = `target_user_id=${encodeURIComponent(userPk)}&page_size=${pageSize}&include_feed_video=true`;
  if (maxId) body += `&max_id=${encodeURIComponent(maxId)}`;
  const j = await igFetch('https://www.instagram.com/api/v1/clips/user/', {
    method: 'POST', body,
    referer: 'https://www.instagram.com/',
  });
  const items = (j.items || []).map((w) => normalizarMedia(w.media || w)).filter(Boolean);
  return {
    items,
    next_max_id: (j.paging_info && j.paging_info.max_id) || null,
    more: !!(j.paging_info && j.paging_info.more_available),
  };
}

// username → { user_pk, username, full_name }. RATE-LIMIT AGRESSIVO (429 fácil
// em conta nova) — chamar com moderação e sempre com fallback.
async function resolverUsername(username) {
  const u = String(username || '').replace(/^@/, '').trim().toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(u)) { const e = new Error('username_invalido'); e.status = 400; throw e; }
  const j = await igFetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`, {
    referer: `https://www.instagram.com/${u}/`,
  });
  const user = j.data && j.data.user;
  if (!user || !user.id) { const e = new Error('perfil_nao_encontrado'); e.status = 404; throw e; }
  return { user_pk: String(user.id), username: user.username || u, full_name: user.full_name || null };
}

// username a partir de uma URL de perfil ("instagram.com/spreen/" → "spreen").
// Exclui rotas conhecidas (p/, reel/, reels/...) SÓ quando seguidas de "/" —
// um perfil chamado @reelsoficial continua válido.
function parseUsernameDePerfil(url) {
  const m = String(url || '').match(/instagram\.com\/(?!(?:p|reel|reels|tv|api|explore|accounts|stories|direct)\/)@?([A-Za-z0-9._]{1,30})/i);
  return m ? m[1].toLowerCase() : null;
}

module.exports = {
  temCookies,
  parseShortcode,
  shortcodeToPk,
  parseUsernameDePerfil,
  mediaInfo,
  clipsDoPerfil,
  resolverUsername,
};
