// api/og-video.js — Pagina publica de video (/v/:videoId).
// HTML com meta tags OG completas (preview no WhatsApp mostra thumbnail
// grande com play) + CTA pro /blue/v/:videoId.

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
  const videoId = (req.query.v || req.query.video_id || '').trim();
  if (!videoId || !/^[a-zA-Z0-9-]{6,64}$/.test(videoId)) {
    return sendHtml(res, 400, notFoundHtml('Video invalido'));
  }

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return sendHtml(res, 500, errorHtml());

  const h = { apikey: SK, Authorization: 'Bearer ' + SK };

  try {
    const vr = await fetch(
      `${SU}/rest/v1/blue_videos?id=eq.${encodeURIComponent(videoId)}&select=id,title,description,thumbnail_url,video_url,views,likes,comments,user_id,created_at,status&limit=1`,
      { headers: h }
    );
    if (!vr.ok) return sendHtml(res, 502, errorHtml());
    const rows = await vr.json();
    const video = Array.isArray(rows) ? rows[0] : null;
    if (!video || video.status !== 'active') return sendHtml(res, 404, notFoundHtml('Video nao encontrado'));

    let criador = null;
    if (video.user_id) {
      const cr = await fetch(
        `${SU}/rest/v1/blue_profiles?user_id=eq.${video.user_id}&select=username,display_name,avatar_url,verificado&limit=1`,
        { headers: h }
      );
      if (cr.ok) {
        const cprofs = await cr.json();
        criador = Array.isArray(cprofs) ? cprofs[0] : null;
      }
    }

    return sendHtml(res, 200, videoHtml(video, criador));
  } catch (e) {
    return sendHtml(res, 500, errorHtml());
  }
};

function sendHtml(res, status, html) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  res.status(status).send(html);
}

function videoHtml(v, c) {
  const url = `https://bluetubeviral.com/v/${v.id}`;
  const titulo = v.title
    ? `${v.title.slice(0, 80)}${v.title.length > 80 ? '…' : ''} — Blue`
    : `Video de @${c?.username || 'blue'} — Blue`;
  const desc = (v.description || v.title || `Assista no Blue — a nova rede social de videos do Brasil`).slice(0, 200);
  const img = v.thumbnail_url || c?.avatar_url || 'https://bluetubeviral.com/og-default.png';

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(titulo)}</title>
<meta name="description" content="${esc(desc)}"/>
<link rel="canonical" href="${url}"/>
<meta property="og:type" content="video.other"/>
<meta property="og:url" content="${url}"/>
<meta property="og:title" content="${esc(titulo)}"/>
<meta property="og:description" content="${esc(desc)}"/>
<meta property="og:image" content="${esc(img)}"/>
<meta property="og:image:width" content="1080"/>
<meta property="og:image:height" content="1920"/>
<meta property="og:site_name" content="Blue"/>
<meta property="og:locale" content="pt_BR"/>
${v.video_url ? `<meta property="og:video" content="${esc(v.video_url)}"/>
<meta property="og:video:type" content="video/mp4"/>` : ''}
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${esc(titulo)}"/>
<meta name="twitter:description" content="${esc(desc)}"/>
<meta name="twitter:image" content="${esc(img)}"/>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%231a6bff'/><path d='M12 8l12 8-12 8V8z' fill='white'/></svg>"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#020817;color:#e8f4ff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.wrap{max-width:420px;margin:0 auto;padding:28px 20px;text-align:center}
.logo{font-size:22px;font-weight:900;background:linear-gradient(135deg,#3b82f6,#60a5fa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;display:inline-block;margin-bottom:20px}
.thumb{width:100%;aspect-ratio:9/16;background:#0a1628;border-radius:18px;background-size:cover;background-position:center;position:relative;overflow:hidden;margin-bottom:18px}
.play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.25)}
.play-btn{width:72px;height:72px;border-radius:50%;background:rgba(26,107,255,.9);display:flex;align-items:center;justify-content:center;font-size:28px;color:#fff;box-shadow:0 10px 30px rgba(0,0,0,.4)}
.creator{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:10px}
.cav{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#1a6bff,#00aaff);overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:900}
.cav img{width:100%;height:100%;object-fit:cover;display:block}
.cname{font-weight:700;font-size:15px}
.verif{color:#3b82f6;font-size:14px;margin-left:2px}
.legenda{color:rgba(232,244,255,.75);font-size:14px;line-height:1.5;margin:10px auto;max-width:360px}
.stats{display:flex;gap:20px;justify-content:center;margin:14px 0 22px;color:rgba(232,244,255,.55);font-size:13px}
.cta{display:block;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;font-weight:700;font-size:15px;padding:14px;border-radius:14px;margin-bottom:10px;text-align:center}
.ghost{display:block;background:none;color:rgba(232,244,255,.5);border:1px solid rgba(232,244,255,.1);font-size:13px;padding:11px;border-radius:14px;text-align:center}
</style>
</head>
<body>
  <div class="wrap">
    <a class="logo" href="/blue">Blue</a>
    <div class="thumb"${v.thumbnail_url ? ` style="background-image:url('${esc(v.thumbnail_url)}')"` : ''}>
      <div class="play"><div class="play-btn">▶</div></div>
    </div>
    ${c ? `<div class="creator">
      <div class="cav">${c.avatar_url ? `<img src="${esc(c.avatar_url)}" alt=""/>` : esc((c.display_name || c.username || '?').charAt(0).toUpperCase())}</div>
      <div class="cname">@${esc(c.username || 'blue')}${c.verificado ? '<span class="verif">✓</span>' : ''}</div>
    </div>` : ''}
    ${v.title || v.description ? `<div class="legenda">${esc((v.title || v.description || '').slice(0, 160))}</div>` : ''}
    <div class="stats">
      <span>❤️ ${fmtCount(v.likes)}</span>
      <span>💬 ${fmtCount(v.comments)}</span>
      <span>▶ ${fmtCount(v.views)}</span>
    </div>
    <a class="cta" href="/blue/v/${esc(v.id)}">▶ Assistir no Blue</a>
    <a class="ghost" href="/blue">Explorar o Blue</a>
  </div>
</body>
</html>`;
}

function notFoundHtml(titulo) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"/>
<title>${esc(titulo)} — Blue</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta property="og:title" content="${esc(titulo)}"/>
<meta property="og:description" content="Este video nao existe no Blue."/>
<meta property="og:image" content="https://bluetubeviral.com/og-default.png"/>
<style>html,body{background:#020817;color:#e8f4ff;font-family:system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center}a{color:#3b82f6;text-decoration:none;margin-top:16px;display:inline-block}</style>
</head><body><div>
<h1 style="font-size:26px;margin-bottom:8px">${esc(titulo)}</h1>
<p style="opacity:.6">Este video pode ter sido removido ou esta indisponivel.</p>
<a href="/blue">Ir pro Blue →</a>
</div></body></html>`;
}

function errorHtml() {
  return notFoundHtml('Algo deu errado');
}
