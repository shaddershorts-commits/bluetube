// api/og-perfil.js — Pagina publica de criador (/@username).
// Renderiza HTML completo com meta tags Open Graph pra preview em
// WhatsApp/Twitter/Google + interface de redirect pro /blue/@username.
// Cacheado na edge do Vercel por 5min (s-maxage=300).

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtCount(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K';
  return (n / 1_000_000).toFixed(1) + 'M';
}

module.exports = async function handler(req, res) {
  const username = (req.query.u || req.query.username || '').trim();
  if (!username || !/^[a-zA-Z0-9._-]{1,40}$/.test(username)) {
    return sendHtml(res, 400, notFoundHtml(username || '?', 'Perfil invalido'));
  }

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return sendHtml(res, 500, errorHtml());

  const h = { apikey: SK, Authorization: 'Bearer ' + SK };

  try {
    const pr = await fetch(
      `${SU}/rest/v1/blue_profiles?username=eq.${encodeURIComponent(username)}&select=user_id,username,display_name,bio,avatar_url,verificado&limit=1`,
      { headers: h }
    );
    if (!pr.ok) return sendHtml(res, 502, errorHtml());
    const rows = await pr.json();
    const perfil = Array.isArray(rows) ? rows[0] : null;
    if (!perfil) return sendHtml(res, 404, notFoundHtml(username, 'Perfil nao encontrado'));

    const [vr, fr] = await Promise.all([
      fetch(
        `${SU}/rest/v1/blue_videos?user_id=eq.${perfil.user_id}&status=eq.active&select=id,thumbnail_url,views&order=created_at.desc&limit=6`,
        { headers: h }
      ),
      fetch(
        `${SU}/rest/v1/blue_follows?following_id=eq.${perfil.user_id}&select=id`,
        { headers: { ...h, Prefer: 'count=exact', Range: '0-0' } }
      ),
    ]);

    const videos = vr.ok ? await vr.json() : [];
    let seguidores = 0;
    if (fr.ok) {
      const cr = fr.headers.get('content-range') || '';
      const m = cr.match(/\/(\d+)$/);
      if (m) seguidores = parseInt(m[1], 10) || 0;
    }

    return sendHtml(res, 200, perfilHtml(perfil, videos, seguidores));
  } catch (e) {
    return sendHtml(res, 500, errorHtml());
  }
};

function sendHtml(res, status, html) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  res.status(status).send(html);
}

function perfilHtml(p, videos, seguidores) {
  const url = `https://bluetubeviral.com/@${p.username}`;
  const titulo = `${p.display_name || p.username} — Blue`;
  const desc = (p.bio || `Veja os videos de @${p.username} no Blue — a nova rede social de videos do Brasil`).slice(0, 200);
  const img = p.avatar_url || 'https://bluetubeviral.com/og-default.png';
  const initial = (p.display_name || p.username || '?').charAt(0).toUpperCase();

  const vidsGrid = videos.length
    ? `<div class="grid">${videos.map(v =>
        `<a href="/blue/v/${esc(v.id)}" class="vid"${v.thumbnail_url ? ` style="background-image:url('${esc(v.thumbnail_url)}')"` : ''} aria-label="Video">` +
        `<span class="vid-v">▶ ${fmtCount(v.views)}</span></a>`
      ).join('')}</div>`
    : '';

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(titulo)}</title>
<meta name="description" content="${esc(desc)}"/>
<link rel="canonical" href="${url}"/>
<meta property="og:type" content="profile"/>
<meta property="og:url" content="${url}"/>
<meta property="og:title" content="${esc(titulo)}"/>
<meta property="og:description" content="${esc(desc)}"/>
<meta property="og:image" content="${esc(img)}"/>
<meta property="og:image:width" content="400"/>
<meta property="og:image:height" content="400"/>
<meta property="og:site_name" content="Blue"/>
<meta property="og:locale" content="pt_BR"/>
<meta property="profile:username" content="${esc(p.username)}"/>
<meta name="twitter:card" content="summary"/>
<meta name="twitter:title" content="${esc(titulo)}"/>
<meta name="twitter:description" content="${esc(desc)}"/>
<meta name="twitter:image" content="${esc(img)}"/>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%231a6bff'/><path d='M12 8l12 8-12 8V8z' fill='white'/></svg>"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#020817;color:#e8f4ff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.wrap{max-width:560px;margin:0 auto;padding:36px 20px;text-align:center}
.logo{font-size:22px;font-weight:900;background:linear-gradient(135deg,#3b82f6,#60a5fa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;display:inline-block;margin-bottom:32px}
.av{width:120px;height:120px;border-radius:50%;border:3px solid #1a6bff;overflow:hidden;margin:0 auto 16px;background:linear-gradient(135deg,#1a6bff,#00aaff);display:flex;align-items:center;justify-content:center;font-size:44px;font-weight:900;color:#fff}
.av img{width:100%;height:100%;object-fit:cover;display:block}
h1{font-size:26px;font-weight:900;margin-bottom:2px;letter-spacing:-.3px}
.uname{color:rgba(232,244,255,.5);font-size:14px;margin-bottom:10px}
.verif{display:inline-block;background:#1a6bff;color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:100px;margin-bottom:10px}
.bio{color:rgba(232,244,255,.75);font-size:14px;line-height:1.55;margin:12px auto;max-width:400px}
.stats{display:flex;gap:36px;justify-content:center;margin:20px 0 26px}
.stat-n{font-size:22px;font-weight:900;display:block}
.stat-l{font-size:11px;color:rgba(232,244,255,.5);text-transform:uppercase;letter-spacing:.5px;margin-top:2px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-bottom:28px}
.vid{aspect-ratio:9/16;background:#0a1628;border-radius:6px;background-size:cover;background-position:center;position:relative;display:block;overflow:hidden;cursor:pointer}
.vid-v{position:absolute;bottom:6px;left:6px;font-size:10px;font-weight:700;background:rgba(0,0,0,.55);padding:2px 6px;border-radius:4px;color:#fff}
.cta{display:block;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;font-weight:700;font-size:15px;padding:14px;border-radius:14px;margin-bottom:10px;cursor:pointer;border:none;width:100%;text-align:center}
.ghost{display:block;background:none;color:rgba(232,244,255,.5);border:1px solid rgba(232,244,255,.1);font-size:13px;padding:11px;border-radius:14px;text-align:center}
</style>
</head>
<body>
  <div class="wrap">
    <a class="logo" href="/blue">Blue</a>
    <div class="av">${p.avatar_url ? `<img src="${esc(p.avatar_url)}" alt="${esc(p.username)}"/>` : esc(initial)}</div>
    <h1>${esc(p.display_name || p.username)}</h1>
    <div class="uname">@${esc(p.username)}</div>
    ${p.verificado ? '<div class="verif">✓ Verificado</div>' : ''}
    ${p.bio ? `<div class="bio">${esc(p.bio)}</div>` : ''}
    <div class="stats">
      <div><span class="stat-n">${fmtCount(seguidores)}</span><span class="stat-l">seguidores</span></div>
      <div><span class="stat-n">${fmtCount(videos.length)}</span><span class="stat-l">videos</span></div>
    </div>
    ${vidsGrid}
    <a class="cta" href="/blue/@${esc(p.username)}">Ver no Blue →</a>
    <a class="ghost" href="/blue">Explorar o Blue</a>
  </div>
</body>
</html>`;
}

function notFoundHtml(username, titulo) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"/>
<title>${esc(titulo)} — Blue</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta property="og:title" content="${esc(titulo)}"/>
<meta property="og:description" content="Este perfil nao existe no Blue."/>
<meta property="og:image" content="https://bluetubeviral.com/og-default.png"/>
<style>html,body{background:#020817;color:#e8f4ff;font-family:system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center}a{color:#3b82f6;text-decoration:none;margin-top:16px;display:inline-block}</style>
</head><body><div>
<h1 style="font-size:26px;margin-bottom:8px">${esc(titulo)}</h1>
<p style="opacity:.6">O perfil @${esc(username)} nao existe no Blue.</p>
<a href="/blue">Ir pro Blue →</a>
</div></body></html>`;
}

function errorHtml() {
  return notFoundHtml('', 'Algo deu errado');
}
