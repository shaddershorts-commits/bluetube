// api/baixa-generic.js — Download generico pra plataformas nao-principais.
//
// Fluxo:
// 1) Deteca a plataforma pelo dominio do URL
// 2) Tenta Cobalt self-hosted (se COBALT_API_URL setado) — suporta 20+ plataformas
//    extras (Vimeo, Twitch, Streamable, Bluesky, Bilibili, Tumblr, etc)
// 3) Se falhar, registra a URL em solicitacoes_plataforma pro admin ver
//    quais plataformas usuarios mais pedem
// 4) Retorna mensagem amigavel em vez de erro tecnico

const COBALT_URL = process.env.COBALT_API_URL;
const COBALT_KEY = process.env.COBALT_API_KEY;
const RAILWAY_FFMPEG = process.env.RAILWAY_FFMPEG_URL;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Plataformas que Cobalt suporta (lista de referencia — Cobalt tenta mesmo assim)
const COBALT_SUPPORTED = [
  'vimeo.com', 'twitch.tv', 'streamable.com', 'bilibili.com', 'bsky.app',
  'dailymotion.com', 'loom.com', 'ok.ru', 'rutube.ru', 'snapchat.com',
  'soundcloud.com', 'tumblr.com', 'vk.com', 'pinterest.com',
];

function detectPlatform(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    // Verifica se e uma das plataformas que Cobalt suporta
    const cobaltSupported = COBALT_SUPPORTED.some(p => host === p || host.endsWith('.' + p));
    return { host, name: host.split('.')[0], cobaltSupported };
  } catch (e) {
    return { host: 'desconhecido', name: 'desconhecido', cobaltSupported: false };
  }
}

async function tryCobalt(targetUrl) {
  if (!COBALT_URL) return null;
  try {
    const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
    if (COBALT_KEY) headers['Authorization'] = 'Api-Key ' + COBALT_KEY;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    const r = await fetch(COBALT_URL, {
      method: 'POST', headers,
      body: JSON.stringify({ url: targetUrl }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const d = await r.json();
    let mediaUrl = null;
    if (d.status === 'tunnel' || d.status === 'redirect') mediaUrl = d.url;
    else if (d.status === 'picker') mediaUrl = d.picker?.[0]?.url;
    else if (d.url) mediaUrl = d.url;
    return mediaUrl ? { url: mediaUrl, filename: d.filename || null } : null;
  } catch (e) { return null; }
}

async function logSolicitacao(url, platform, motivo) {
  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return;
  try {
    await fetch(`${SU}/rest/v1/solicitacoes_plataforma`, {
      method: 'POST',
      headers: { apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        url: url.slice(0, 500),
        plataforma_host: platform.host,
        plataforma_nome: platform.name,
        motivo: motivo.slice(0, 200),
        created_at: new Date().toISOString(),
      }),
    });
  } catch (e) { /* best-effort */ }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = (req.query.url || '').toString().trim();
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'URL invalido', _friendly: true });
  }

  const platform = detectPlatform(url);

  // 1) Tenta Cobalt (serve pra muitas plataformas alem das principais)
  const cobalt = await tryCobalt(url);
  if (cobalt?.url) {
    const safeName = (cobalt.filename || platform.name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    let finalUrl = cobalt.url;
    // Wrap no Railway proxy-download pra contornar CORS/CDN restrictions
    if (RAILWAY_FFMPEG && !cobalt.url.includes('supabase.co')) {
      finalUrl = `${RAILWAY_FFMPEG.replace(/\/$/, '')}/proxy-download?url=${encodeURIComponent(cobalt.url)}&filename=BaixaBlue_${platform.name}_${safeName}.mp4`;
    }
    return res.status(200).json({
      url: finalUrl,
      title: cobalt.filename?.replace(/\.[^.]+$/, '') || `Video de ${platform.name}`,
      thumbnail: null,
      platform: platform.name,
      proxied: !!(RAILWAY_FFMPEG && !cobalt.url.includes('supabase.co')),
    });
  }

  // 2) Cobalt nao deu — registra pra analise e retorna mensagem amigavel
  await logSolicitacao(url, platform, 'cobalt_falhou');

  return res.status(200).json({
    unavailable: true, // frontend detecta essa flag e exibe mensagem amigavel
    platform: platform.name,
    host: platform.host,
    _friendly: true,
    // Mensagem com tom de "em breve" em vez de erro tecnico
    title: `${platform.name.charAt(0).toUpperCase() + platform.name.slice(1)} chegando em breve`,
    message: `Ainda estamos finalizando o suporte a ${platform.host}. Registramos sua solicitação — assim que liberarmos, vamos avisar.`,
    sugestao: 'Enquanto isso, experimente com YouTube, TikTok, Instagram, Facebook, Twitter/X ou Reddit.',
  });
};
