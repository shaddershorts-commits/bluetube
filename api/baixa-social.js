// api/baixa-social.js — Download de vídeos do Reddit, Twitter/X e Facebook
// Usa APIs públicas gratuitas sem chave
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

  try {
    // ── REDDIT ────────────────────────────────────────────────────────────────
    if (url.includes('reddit.com') || url.includes('redd.it')) {
      // Clean URL
      let cleanUrl = url.replace(/\?.*$/, '').replace(/\/$/, '');
      if (url.includes('redd.it') && !url.includes('reddit.com')) {
        try { const rd = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA } }); cleanUrl = rd.url.replace(/\?.*$/, '').replace(/\/$/, ''); } catch(e) {}
      }

      // Try .json API directly
      const jsonUrl = cleanUrl + '.json';
      let post = null;
      try {
        const r = await fetch(jsonUrl, { headers: { 'User-Agent': 'web:bluetube:v1 (by /u/bluetube)' }, redirect: 'follow' });
        if (r.ok) {
          const data = await r.json();
          post = Array.isArray(data) ? data[0]?.data?.children?.[0]?.data : data?.data?.children?.[0]?.data;
        }
      } catch(e) {}

      // Fallback: try scraping the page for the video URL
      if (!post) {
        try {
          const r = await fetch(cleanUrl, { headers: { 'User-Agent': UA, 'Accept': 'text/html' }, redirect: 'follow' });
          if (r.ok) {
            const html = await r.text();
            // Look for v.redd.it URLs in the page
            const vrm = html.match(/https:\/\/v\.redd\.it\/[a-z0-9]+\/DASH_[0-9]+\.mp4/gi);
            const fallbackUrl = html.match(/https:\/\/v\.redd\.it\/[a-z0-9]+\/HLSPlaylist\.m3u8/i);
            const packshot = html.match(/"fallback_url"\s*:\s*"([^"]+)"/);

            if (vrm && vrm.length > 0) {
              return res.status(200).json({ url: vrm[0], title: 'Reddit Video', platform: 'reddit' });
            }
            if (packshot) {
              return res.status(200).json({ url: packshot[1].replace(/\\u0026/g, '&'), title: 'Reddit Video', platform: 'reddit' });
            }
          }
        } catch(e) {}
      }

      if (post) {
        const title = post.title || 'Reddit Video';
        const thumbnail = post.thumbnail && post.thumbnail.startsWith('http') ? post.thumbnail : null;

        if (post.is_video && post.media?.reddit_video?.fallback_url) {
          return res.status(200).json({ url: post.media.reddit_video.fallback_url.replace(/\?.*$/, ''), title, thumbnail, platform: 'reddit' });
        }
        if (post.crosspost_parent_list?.[0]?.media?.reddit_video?.fallback_url) {
          return res.status(200).json({ url: post.crosspost_parent_list[0].media.reddit_video.fallback_url.replace(/\?.*$/, ''), title, thumbnail, platform: 'reddit' });
        }
        if (post.url && (post.url.includes('.gif') || post.url.includes('gifv'))) {
          return res.status(200).json({ url: post.url.replace('.gifv', '.mp4'), title, thumbnail, platform: 'reddit' });
        }
        if (post.url_overridden_by_dest) {
          return res.status(200).json({ url: post.url_overridden_by_dest, title, thumbnail, platform: 'reddit' });
        }
        return res.status(400).json({ error: 'Este post do Reddit não contém um vídeo hospedado.' });
      }

      return res.status(400).json({ error: 'Não foi possível acessar o Reddit. O servidor pode estar bloqueado. Tente novamente mais tarde.' });
    }

    // ── TWITTER/X ─────────────────────────────────────────────────────────────
    if (url.includes('twitter.com') || url.includes('x.com')) {
      // Extract tweet ID
      const tweetMatch = url.match(/status\/(\d+)/);
      if (!tweetMatch) return res.status(400).json({ error: 'Link inválido. Use o formato: x.com/user/status/ID' });
      const tweetId = tweetMatch[1];

      // Strategy 1: Twitter syndication API (public embed)
      let videoUrl = null;
      let title = '';
      let thumbnail = null;
      try {
        const r = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=0`, {
          headers: { 'User-Agent': UA }
        });
        if (r.ok) {
          const data = await r.json();
          title = data.text || '';
          // Find video in media
          const videos = data.mediaDetails?.filter(m => m.type === 'video') || [];
          if (videos.length > 0) {
            const variants = videos[0].video_info?.variants?.filter(v => v.content_type === 'video/mp4') || [];
            // Pick highest quality
            variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
            if (variants.length > 0) videoUrl = variants[0].url;
            thumbnail = videos[0].media_url_https || null;
          }
          // Check for GIF
          const gifs = data.mediaDetails?.filter(m => m.type === 'animated_gif') || [];
          if (!videoUrl && gifs.length > 0) {
            const gv = gifs[0].video_info?.variants?.find(v => v.content_type === 'video/mp4');
            if (gv) videoUrl = gv.url;
            thumbnail = gifs[0].media_url_https || null;
          }
        }
      } catch(e) { console.error('Twitter syndication:', e.message); }

      // Strategy 2: RapidAPI fallback
      if (!videoUrl) {
        const rapidKey = process.env.RAPIDAPI_KEY;
        if (rapidKey) {
          try {
            const r = await fetch(`https://twitter-video-downloader10.p.rapidapi.com/?url=${encodeURIComponent(url)}`, {
              headers: { 'x-rapidapi-key': rapidKey, 'x-rapidapi-host': 'twitter-video-downloader10.p.rapidapi.com' }
            });
            if (r.ok) {
              const d = await r.json();
              const variants = d.media_url_https || d.variants || [];
              videoUrl = Array.isArray(variants) ? variants.find(v => v.content_type === 'video/mp4')?.url : variants;
              title = title || d.text || 'Twitter/X';
            }
          } catch(e) {}
        }
      }

      if (videoUrl) {
        return res.status(200).json({ url: videoUrl, title: title || 'Twitter/X Video', thumbnail, platform: 'twitter' });
      }
      return res.status(400).json({ error: 'Não foi possível extrair o vídeo. O tweet pode não ter vídeo ou ser privado.' });
    }

    // ── FACEBOOK ──────────────────────────────────────────────────────────────
    if (url.includes('facebook.com') || url.includes('fb.watch') || url.includes('fb.com')) {
      let videoUrl = null;
      let title = 'Facebook Video';
      let thumbnail = null;

      // Follow redirects for fb.watch
      let finalUrl = url;
      if (url.includes('fb.watch')) {
        try { const rd = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA } }); finalUrl = rd.url; } catch(e) {}
      }

      // Scrape the public page
      try {
        const r = await fetch(finalUrl, {
          headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
          redirect: 'follow'
        });
        if (r.ok) {
          const html = await r.text();
          // Try multiple patterns
          const patterns = [
            /"hd_src":"([^"]+)"/,
            /"sd_src":"([^"]+)"/,
            /"playable_url_quality_hd":"([^"]+)"/,
            /"playable_url":"([^"]+)"/,
            /content="(https:\/\/[^"]*\.mp4[^"]*)"/,
            /<meta\s+property="og:video(?::url)?"\s+content="([^"]+)"/i,
          ];
          for (const p of patterns) {
            const m = html.match(p);
            if (m) { videoUrl = m[1].replace(/\\\//g, '/').replace(/&amp;/g, '&'); break; }
          }
          const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
          if (ogTitle) title = ogTitle[1].replace(/&amp;/g, '&');
          const ogImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
          if (ogImage) thumbnail = ogImage[1].replace(/&amp;/g, '&');
        }
      } catch(e) {}

      // RapidAPI fallback
      if (!videoUrl) {
        const rapidKey = process.env.RAPIDAPI_KEY;
        if (rapidKey) {
          try {
            const r = await fetch('https://facebook-reel-and-video-downloader.p.rapidapi.com/app/main.php?url=' + encodeURIComponent(url), {
              headers: { 'x-rapidapi-key': rapidKey, 'x-rapidapi-host': 'facebook-reel-and-video-downloader.p.rapidapi.com' }
            });
            if (r.ok) {
              const d = await r.json();
              if (d.success && d.media) {
                videoUrl = d.media.find(m => m.quality === 'hd')?.url || d.media[0]?.url;
                title = d.title || title;
              }
            }
          } catch(e) {}
        }
      }

      if (videoUrl) {
        return res.status(200).json({ url: videoUrl, title, thumbnail, platform: 'facebook' });
      }
      return res.status(400).json({ error: 'Não foi possível extrair o vídeo do Facebook. O vídeo pode ser privado.' });
    }

    return res.status(400).json({ error: 'Plataforma não suportada. Use YouTube, Twitter/X, Reddit ou Facebook.' });

  } catch(e) {
    console.error('baixa-social error:', e.message);
    return res.status(500).json({ error: 'Erro interno: ' + e.message });
  }
};
