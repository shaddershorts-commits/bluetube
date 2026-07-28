// api/baixa-tiktok.js — Download de TikTok com cadeia de provedores GRATUITOS
// =============================================================================
// Criado em 2026-07-27 depois do TikTok cair inteiro no BaixaBlue: as 2 APIs
// pagas do RapidAPI (usadas dentro do api/auth.js) estouraram a cota mensal no
// mesmo mês e não havia plano B. Aqui o TikTok ganha caminho PRÓPRIO, isolado
// do auth.js (que é ESM e intocável — mexer lá arrisca o login inteiro).
//
// A lógica de provedores vive em _helpers/tiktok-download.js:
//   TikWM público (4 tentativas, grátis) → Cobalt self-hosted → Railway yt-dlp
//   → RapidAPI (último recurso, se a cota voltar)
//
// Resposta compatível com o que o baixaBlue.html já espera do endpoint antigo:
//   { downloadUrl, title, thumbnail, platform, provider }
//
// GET  ?url=...              — download
// GET  ?action=health        — diagnóstico da cadeia (admin_secret) pro painel

const { baixarTiktok, viaTikwm } = require('./_helpers/tiktok-download');

const URL_VALIDA = /^https?:\/\/([a-z0-9-]+\.)*(tiktok\.com|douyin\.com)\//i;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  // ── HEALTH (admin): a cadeia está de pé? qual provedor responde? ─────────
  // Evita descobrir queda só quando o usuário reclama (foi o que aconteceu).
  if (action === 'health') {
    if (req.query.admin_secret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    // Vídeo de referência público e estável (TikTok oficial)
    const alvo = req.query.url || 'https://www.tiktok.com/@tiktok/video/7106594312292453675';
    const t0 = Date.now();
    const r = await baixarTiktok(alvo).catch(() => null);
    return res.status(200).json({
      ok: !!r,
      provider_ativo: r ? r.provider : null,
      falhas_antes: r ? r.tentativas : ['todos'],
      ms: Date.now() - t0,
      status: r ? (r.provider === 'tikwm' ? 'OK' : 'DEGRADED_' + String(r.provider).toUpperCase()) : 'DOWN',
      timestamp: new Date().toISOString(),
    });
  }

  const url = String(req.query.url || (req.body && req.body.url) || '').trim();
  if (!url) return res.status(400).json({ error: 'url obrigatória' });
  if (!URL_VALIDA.test(url)) {
    return res.status(400).json({ error: 'Link inválido. Use um link do TikTok (tiktok.com/@usuario/video/...).' });
  }
  // Só o domínio ou um perfil = não é vídeo. Mensagem específica em vez do
  // genérico "não foi possível extrair" (que parece falha nossa).
  try {
    const caminho = new URL(url).pathname.replace(/\/+$/, '');
    if (!caminho || caminho === '/') {
      return res.status(400).json({
        error: 'Você colou só o endereço do TikTok, sem o vídeo. Abra o vídeo, toque em Compartilhar → Copiar link e cole aqui.',
        exemplo: 'https://www.tiktok.com/@usuario/video/123456789',
        platform: 'tiktok',
      });
    }
    if (/^\/@[^/]+$/.test(caminho)) {
      return res.status(400).json({
        error: 'Esse link é o perfil de um usuário, não um vídeo. Abra um vídeo desse perfil e copie o link dele.',
        exemplo: 'https://www.tiktok.com/@usuario/video/123456789',
        platform: 'tiktok',
      });
    }
  } catch (e) { /* URL exótica: deixa passar — o backend tenta */ }

  try {
    const r = await baixarTiktok(url);
    if (!r || !r.downloadUrl) {
      return res.status(400).json({
        error: 'Não foi possível extrair o vídeo.',
        platform: 'tiktok',
        hint: 'O vídeo pode ser privado, ter sido removido ou estar com restrição regional. Tente outro link.',
      });
    }
    // Proxy do Railway: CDN do TikTok bloqueia download direto do browser
    // (CORS). MESMA lógica do endpoint legado — o frontend espera `url`.
    const title = (r.title || 'TikTok').slice(0, 200);
    const RAILWAY = process.env.RAILWAY_FFMPEG_URL;
    const needsProxy = !!RAILWAY && !r.downloadUrl.includes('supabase.co');
    let finalUrl = r.downloadUrl;
    if (needsProxy) {
      const safeName = title.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      finalUrl = `${RAILWAY.replace(/\/$/, '')}/proxy-download?url=${encodeURIComponent(r.downloadUrl)}&filename=BaixaBlue_tiktok_${safeName}.mp4`;
    }

    return res.status(200).json({
      url: finalUrl,
      title,
      thumbnail: r.thumbnail || null,
      platform: 'tiktok',
      proxied: needsProxy,
      provider: r.provider,
    });
  } catch (e) {
    console.error('[baixa-tiktok]', e && e.message);
    return res.status(500).json({ error: 'Erro ao processar o download.', detalhe: (e && e.message || '').slice(0, 120) });
  }
};
