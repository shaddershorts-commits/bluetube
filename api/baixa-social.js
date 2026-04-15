// api/baixa-social.js — Download de vídeos do Reddit, Twitter/X e Facebook
// Usa APIs públicas gratuitas + fallback para serviços externos
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });

  const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

  // Helper: envolve a URL de CDN no Railway /proxy-download pra permitir
  // fetch-to-blob cross-origin no browser (CDNs como twimg, fbcdn, redd.it
  // não mandam Access-Control-Allow-Origin).
  const RAILWAY_FFMPEG = process.env.RAILWAY_FFMPEG_URL;
  function proxyWrap(rawUrl, platform, title) {
    if (!rawUrl || !RAILWAY_FFMPEG) return rawUrl;
    if (rawUrl.includes('supabase.co')) return rawUrl; // já tem CORS
    const safeName = (title || platform || 'video').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    return `${RAILWAY_FFMPEG.replace(/\/$/, '')}/proxy-download?url=${encodeURIComponent(rawUrl)}&filename=BaixaBlue_${platform}_${safeName}.mp4`;
  }

  // Helper: tenta Cobalt self-hosted como fonte primária. Cobalt suporta
  // Twitter, Facebook, Reddit, TikTok, etc — geralmente mais confiável que
  // scraping caseiro. Retorna null se falhar.
  const COBALT_URL = process.env.COBALT_API_URL;
  const COBALT_KEY = process.env.COBALT_API_KEY;
  async function tryCobalt(targetUrl) {
    if (!COBALT_URL) return null;
    try {
      const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
      if (COBALT_KEY) headers['Authorization'] = 'Api-Key ' + COBALT_KEY;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const cR = await fetch(COBALT_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ url: targetUrl }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!cR.ok) return null;
      const cD = await cR.json();
      // Cobalt status: tunnel, redirect, picker, stream
      let mediaUrl = null;
      if (cD.status === 'tunnel' || cD.status === 'redirect') mediaUrl = cD.url;
      else if (cD.status === 'picker') mediaUrl = cD.picker?.[0]?.url;
      else if (cD.url) mediaUrl = cD.url;
      if (!mediaUrl) return null;
      return { url: mediaUrl, filename: cD.filename || null };
    } catch (e) {
      console.log('[baixa-social] Cobalt failed:', e.message);
      return null;
    }
  }

  try {
    // ── TWITTER/X ─────────────────────────────────────────────────────────────
    if (url.includes('twitter.com') || url.includes('x.com')) {
      // 1º: Cobalt self-hosted (mais confiável que Twitter API guest token)
      const cobalt = await tryCobalt(url);
      if (cobalt?.url) {
        return res.status(200).json({
          url: proxyWrap(cobalt.url, 'twitter', cobalt.filename || 'Twitter_X_Video'),
          title: cobalt.filename?.replace(/\.[^.]+$/, '') || 'Twitter/X Video',
          thumbnail: null,
          platform: 'twitter'
        });
      }

      // 2º: Fallback — Twitter v1.1 guest token API (pode falhar se Twitter mudar)
      const tweetMatch = url.match(/status\/(\d+)/);
      if (!tweetMatch) return res.status(400).json({ error: 'Link inválido. Use: x.com/user/status/ID' });
      const tweetId = tweetMatch[1];

      let guestToken = '';
      try {
        const gt = await fetch('https://api.twitter.com/1.1/guest/activate.json', {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + BEARER }
        });
        const gtd = await gt.json();
        guestToken = gtd.guest_token || '';
      } catch(e) {}

      if (guestToken) {
        try {
          const r = await fetch(`https://api.twitter.com/1.1/statuses/show/${tweetId}.json?tweet_mode=extended&include_entities=true`, {
            headers: { 'Authorization': 'Bearer ' + BEARER, 'x-guest-token': guestToken, 'User-Agent': UA }
          });
          if (r.ok) {
            const d = await r.json();
            const media = d.extended_entities?.media || d.entities?.media || [];
            const vid = media.find(m => m.type === 'video' || m.type === 'animated_gif');
            if (vid?.video_info?.variants) {
              const mp4s = vid.video_info.variants.filter(v => v.content_type === 'video/mp4');
              mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
              if (mp4s.length > 0) {
                const twTitle = (d.full_text || d.text || 'Twitter/X Video').slice(0, 100);
                return res.status(200).json({
                  url: proxyWrap(mp4s[0].url, 'twitter', twTitle),
                  title: twTitle,
                  thumbnail: vid.media_url_https || null,
                  platform: 'twitter'
                });
              }
            }
          }
        } catch(e) {}
      }

      // Todos falharam: erro explícito, sem fallback externo
      return res.status(502).json({
        error: 'Não foi possível extrair este tweet. Verifique se o link é público e tente novamente.',
        platform: 'twitter'
      });
    }

    // ── REDDIT ────────────────────────────────────────────────────────────────
    if (url.includes('reddit.com') || url.includes('redd.it')) {
      // 1º: Cobalt self-hosted
      const cobalt = await tryCobalt(url);
      if (cobalt?.url) {
        return res.status(200).json({
          url: proxyWrap(cobalt.url, 'reddit', cobalt.filename || 'Reddit_Video'),
          title: cobalt.filename?.replace(/\.[^.]+$/, '') || 'Reddit Video',
          thumbnail: null,
          platform: 'reddit'
        });
      }

      let cleanUrl = url.replace(/\?.*$/, '').replace(/\/$/, '');

      // Follow redd.it redirects
      if (url.includes('redd.it') && !url.includes('reddit.com')) {
        try { const rd = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA } }); cleanUrl = rd.url.replace(/\?.*$/, '').replace(/\/$/, ''); } catch(e) {}
      }

      // Try .json API
      let post = null;
      try {
        const r = await fetch(cleanUrl + '.json', { headers: { 'User-Agent': 'web:bluetube:v1.0 (by /u/bluetube)' }, redirect: 'follow' });
        if (r.ok) {
          const data = await r.json();
          post = Array.isArray(data) ? data[0]?.data?.children?.[0]?.data : data?.data?.children?.[0]?.data;
        }
      } catch(e) {}

      // Try HTML scraping fallback
      if (!post) {
        try {
          const r = await fetch(cleanUrl, { headers: { 'User-Agent': UA, 'Accept': 'text/html' }, redirect: 'follow' });
          if (r.ok) {
            const html = await r.text();
            const fallback = html.match(/"fallback_url"\s*:\s*"([^"]+)"/);
            if (fallback) {
              const redUrl = fallback[1].replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
              return res.status(200).json({ url: proxyWrap(redUrl, 'reddit', 'Reddit_Video'), title: 'Reddit Video', platform: 'reddit' });
            }
          }
        } catch(e) {}
      }

      if (post) {
        const title = post.title || 'Reddit Video';
        const thumbnail = post.thumbnail?.startsWith('http') ? post.thumbnail : null;

        if (post.is_video && post.media?.reddit_video?.fallback_url) {
          const u = post.media.reddit_video.fallback_url.replace(/\?.*$/, '');
          return res.status(200).json({ url: proxyWrap(u, 'reddit', title), title, thumbnail, platform: 'reddit' });
        }
        if (post.crosspost_parent_list?.[0]?.media?.reddit_video?.fallback_url) {
          const u = post.crosspost_parent_list[0].media.reddit_video.fallback_url.replace(/\?.*$/, '');
          return res.status(200).json({ url: proxyWrap(u, 'reddit', title), title, thumbnail, platform: 'reddit' });
        }
        if (post.url && (post.url.includes('.gif') || post.url.includes('gifv'))) {
          const u = post.url.replace('.gifv', '.mp4');
          return res.status(200).json({ url: proxyWrap(u, 'reddit', title), title, thumbnail, platform: 'reddit' });
        }
        if (post.url_overridden_by_dest) {
          return res.status(200).json({ url: proxyWrap(post.url_overridden_by_dest, 'reddit', title), title, thumbnail, platform: 'reddit' });
        }
      }

      // Todos falharam: erro explícito
      return res.status(502).json({
        error: 'Não foi possível extrair este post do Reddit. Verifique se o link é público.',
        platform: 'reddit'
      });
    }

    // ── FACEBOOK ──────────────────────────────────────────────────────────────
    if (url.includes('facebook.com') || url.includes('fb.watch') || url.includes('fb.com')) {
      // 1º: Cobalt self-hosted (mais confiável que scraping HTML do Facebook)
      const cobalt = await tryCobalt(url);
      if (cobalt?.url) {
        return res.status(200).json({
          url: proxyWrap(cobalt.url, 'facebook', cobalt.filename || 'Facebook_Video'),
          title: cobalt.filename?.replace(/\.[^.]+$/, '') || 'Facebook Video',
          thumbnail: null,
          platform: 'facebook'
        });
      }

      let finalUrl = url;
      if (url.includes('fb.watch')) {
        try { const rd = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA } }); finalUrl = rd.url; } catch(e) {}
      }

      // Scrape page
      try {
        const r = await fetch(finalUrl, { headers: { 'User-Agent': UA, 'Accept': 'text/html' }, redirect: 'follow' });
        if (r.ok) {
          const html = await r.text();
          const patterns = [
            /"hd_src":"([^"]+)"/, /"sd_src":"([^"]+)"/,
            /"playable_url_quality_hd":"([^"]+)"/, /"playable_url":"([^"]+)"/,
            /<meta\s+property="og:video(?::url)?"\s+content="([^"]+)"/i,
          ];
          for (const p of patterns) {
            const m = html.match(p);
            if (m) {
              const videoUrl = m[1].replace(/\\\//g, '/').replace(/&amp;/g, '&');
              const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
              const fbTitle = ogTitle?.[1] || 'Facebook Video';
              return res.status(200).json({ url: proxyWrap(videoUrl, 'facebook', fbTitle), title: fbTitle, platform: 'facebook' });
            }
          }
        }
      } catch(e) {}

      // Todos falharam: erro explícito
      return res.status(502).json({
        error: 'Não foi possível extrair este vídeo do Facebook. Verifique se o link é público e tente novamente.',
        platform: 'facebook'
      });
    }

    return res.status(400).json({ error: 'Plataforma não suportada.' });
  } catch(e) {
    console.error('baixa-social error:', e.message);
    return res.status(500).json({ error: 'Erro interno: ' + e.message });
  }
};
