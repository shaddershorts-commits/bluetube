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

      // Resolve redd.it short links seguindo redirect
      if (url.includes('redd.it') && !url.includes('reddit.com')) {
        try {
          const rd = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA } });
          cleanUrl = rd.url.replace(/\?.*$/, '').replace(/\/$/, '');
        } catch(e) {}
      }

      // Normaliza pra path-only (sem host) pra tentar vários hosts do Reddit
      const pathMatch = cleanUrl.match(/reddit\.com(\/r\/[^?#]+)/i);
      const postPath = pathMatch ? pathMatch[1] : cleanUrl.replace(/^https?:\/\/[^/]+/, '');

      // Headers: User-Agent de browser real (Reddit bloqueia UAs que parecem bot).
      // Adiciona cookie null pra evitar redirect pro login mobile.
      const redditHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/html;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9,pt;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.reddit.com/',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Cache-Control': 'no-cache',
        'DNT': '1',
      };

      // Helper com retry automatico em 429/403 (rate limit Reddit)
      async function fetchRedditRetry(url, maxRetries = 2) {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            const r = await fetch(url, { headers: redditHeaders, redirect: 'follow' });
            if (r.status === 429 || r.status === 403) {
              if (attempt < maxRetries) {
                await new Promise(rs => setTimeout(rs, 700 * (attempt + 1))); // backoff 700, 1400ms
                continue;
              }
            }
            return r;
          } catch (e) {
            if (attempt === maxRetries) throw e;
            await new Promise(rs => setTimeout(rs, 500));
          }
        }
      }

      const sources = [
        `https://old.reddit.com${postPath}.json?raw_json=1`,
        `https://www.reddit.com${postPath}.json?raw_json=1`,
        `https://api.reddit.com${postPath}?raw_json=1`,
      ];

      let post = null;
      let lastDebug = '';
      for (const src of sources) {
        try {
          const r = await fetchRedditRetry(src);
          lastDebug = `${src} → ${r.status}`;
          if (!r.ok) { console.log('[reddit]', lastDebug); continue; }
          const data = await r.json();
          const candidate = Array.isArray(data)
            ? data[0]?.data?.children?.[0]?.data
            : data?.data?.children?.[0]?.data || data?.data || data;
          if (candidate && (candidate.title || candidate.media || candidate.url)) {
            post = candidate;
            break;
          }
        } catch(e) {
          lastDebug = `${src} → ${e.message}`;
        }
      }

      // HTML fallback — old.reddit mantém fallback_url inline no HTML
      if (!post) {
        for (const host of ['old.reddit.com', 'www.reddit.com']) {
          try {
            const r = await fetchRedditRetry(`https://${host}${postPath}`);
            if (!r.ok) continue;
            const html = await r.text();
            const fallback = html.match(/"fallback_url"\s*:\s*"([^"]+)"/);
            if (fallback) {
              const redUrl = fallback[1].replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
              const titleM = html.match(/<title>([^<]+)<\/title>/i);
              const hTitle = titleM ? titleM[1].replace(/ : r\/.*$/, '').trim() : 'Reddit Video';
              return res.status(200).json({ url: proxyWrap(redUrl, 'reddit', hTitle), title: hTitle, platform: 'reddit' });
            }
          } catch(e) {}
        }
      }

      // Fallback EXTREMO: proxy publico pra contornar bloqueio de IP do Reddit.
      // Reddit bloqueia range de IPs AWS/Vercel. Allorigins serve o conteudo
      // dum IP diferente (nao-bloqueado). Tambem tenta mirrors estilo vxtwitter.
      if (!post) {
        const proxies = [
          // allorigins.win: proxy HTTP publico gratuito, retorna contents:
          `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://www.reddit.com${postPath}.json?raw_json=1`)}`,
          `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://old.reddit.com${postPath}.json?raw_json=1`)}`,
          // corsproxy.io: outro publico, as vezes funciona quando allorigins falha
          `https://corsproxy.io/?${encodeURIComponent(`https://www.reddit.com${postPath}.json?raw_json=1`)}`,
          // rxddit direto (mirror tipo vxtwitter)
          `https://rxddit.com${postPath}.json`,
        ];
        for (const src of proxies) {
          try {
            const r = await fetch(src, { headers: { 'User-Agent': redditHeaders['User-Agent'], 'Accept': 'application/json' }, redirect: 'follow' });
            if (!r.ok) { lastDebug = `proxy ${src.slice(0,60)}... → ${r.status}`; continue; }
            const text = await r.text();
            // allorigins as vezes retorna {contents:"..."} se usar /get ao inves de /raw
            let data;
            try {
              data = JSON.parse(text);
              // Se for allorigins com /get, desembala
              if (data.contents && typeof data.contents === 'string') {
                data = JSON.parse(data.contents);
              }
            } catch(e) {
              lastDebug = `proxy ${src.slice(0,60)} parse fail`;
              continue;
            }
            const candidate = Array.isArray(data)
              ? data[0]?.data?.children?.[0]?.data
              : data?.data?.children?.[0]?.data || data?.data || data;
            if (candidate && (candidate.title || candidate.media || candidate.url)) {
              post = candidate;
              console.log('[reddit] sucesso via proxy:', src.slice(0, 60));
              break;
            }
          } catch (e) { lastDebug = `proxy ${src.slice(0,60)} → ${e.message}`; }
        }
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
        if (post.preview?.reddit_video_preview?.fallback_url) {
          const u = post.preview.reddit_video_preview.fallback_url.replace(/\?.*$/, '');
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

      console.log('[reddit] Todas as fontes falharam. Último:', lastDebug);
      // Mensagem amigavel + debug discreto no response pra diagnostico via network tab
      return res.status(502).json({
        error: 'Não foi possível extrair este post do Reddit. Verifique se o link é público (não NSFW/privado) e tente novamente.',
        platform: 'reddit',
        _debug: lastDebug,
        debug: lastDebug,
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
