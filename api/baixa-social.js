// api/baixa-social.js — Download de vídeos do Reddit e Facebook
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });

  const isReddit = url.includes('reddit.com') || url.includes('redd.it');
  const isFacebook = url.includes('facebook.com') || url.includes('fb.watch') || url.includes('fb.com');

  if (!isReddit && !isFacebook) {
    return res.status(400).json({ error: 'Plataforma não suportada por este endpoint. Use /api/auth?action=download para YouTube, TikTok, Instagram e Twitter.' });
  }

  try {
    // ── REDDIT ──────────────────────────────────────────────────────────────
    if (isReddit) {
      // Clean URL and build JSON endpoint
      let cleanUrl = url.replace(/\?.*$/, '').replace(/\/$/, '');
      if (url.includes('redd.it') && !url.includes('reddit.com')) {
        try {
          const redir = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
          cleanUrl = redir.url.replace(/\?.*$/, '').replace(/\/$/, '');
        } catch(e) {}
      }
      const jsonUrl = cleanUrl + '.json';

      // Try multiple approaches — Reddit blocks many server IPs
      let data = null;
      const agents = [
        'web:bluetube:v1.0 (by /u/bluetube)',
        'Mozilla/5.0 (compatible; Googlebot/2.1)',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      ];

      for (const ua of agents) {
        try {
          const r = await fetch(jsonUrl, { headers: { 'User-Agent': ua }, redirect: 'follow' });
          if (r.ok) { data = await r.json(); break; }
        } catch(e) { continue; }
      }

      // RapidAPI fallback for Reddit
      if (!data) {
        const rapidKey = process.env.RAPIDAPI_KEY;
        if (rapidKey) {
          try {
            const rr = await fetch('https://reddit-scraper2.p.rapidapi.com/post_media_content?url=' + encodeURIComponent(url), {
              headers: { 'x-rapidapi-key': rapidKey, 'x-rapidapi-host': 'reddit-scraper2.p.rapidapi.com' }
            });
            if (rr.ok) {
              const rd = await rr.json();
              if (rd.video_url || rd.url) {
                return res.status(200).json({ url: rd.video_url || rd.url, title: rd.title || 'Reddit Video', platform: 'reddit' });
              }
            }
          } catch(e) { console.error('Reddit RapidAPI:', e.message); }
        }
      }

      if (!data) {
        return res.status(400).json({ error: 'Reddit bloqueou o acesso. Tente copiar o link do vídeo diretamente pelo app do Reddit.' });
      }

      const post = Array.isArray(data) ? data[0]?.data?.children?.[0]?.data : data?.data?.children?.[0]?.data;

      if (!post) {
        return res.status(400).json({ error: 'Post do Reddit não encontrado.' });
      }

      const title = post.title || 'Reddit Video';
      const thumbnail = post.thumbnail && post.thumbnail.startsWith('http') ? post.thumbnail : null;

      // Reddit-hosted video
      if (post.is_video && post.media?.reddit_video?.fallback_url) {
        const videoUrl = post.media.reddit_video.fallback_url.replace(/\?.*$/, '');
        // Try to get audio URL
        const audioUrl = videoUrl.replace(/DASH_\d+\.mp4/, 'DASH_audio.mp4').replace(/DASH_\d+/, 'DASH_audio');

        return res.status(200).json({
          url: videoUrl,
          audioUrl,
          title,
          thumbnail,
          platform: 'reddit',
          note: 'O Reddit separa vídeo e áudio. Se o vídeo não tiver som, é normal.'
        });
      }

      // Cross-posted video
      if (post.crosspost_parent_list?.[0]?.media?.reddit_video?.fallback_url) {
        const videoUrl = post.crosspost_parent_list[0].media.reddit_video.fallback_url.replace(/\?.*$/, '');
        return res.status(200).json({ url: videoUrl, title, thumbnail, platform: 'reddit' });
      }

      // External video (YouTube, etc.)
      if (post.url_overridden_by_dest) {
        const extUrl = post.url_overridden_by_dest;
        if (extUrl.includes('youtube.com') || extUrl.includes('youtu.be')) {
          return res.status(200).json({
            error: 'Este post contém um vídeo do YouTube. Cole o link do YouTube diretamente.',
            externalUrl: extUrl,
            platform: 'reddit'
          });
        }
        // Try the external URL directly
        return res.status(200).json({ url: extUrl, title, thumbnail, platform: 'reddit' });
      }

      // GIF/gifv
      if (post.url && (post.url.includes('.gif') || post.url.includes('gifv'))) {
        const mp4Url = post.url.replace('.gifv', '.mp4');
        return res.status(200).json({ url: mp4Url, title, thumbnail, platform: 'reddit' });
      }

      return res.status(400).json({ error: 'Este post do Reddit não contém um vídeo hospedado.' });
    }

    // ── FACEBOOK ─────────────────────────────────────────────────────────────
    if (isFacebook) {
      // Try scraping the public page for og:video
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        redirect: 'follow'
      });

      if (!r.ok) {
        return res.status(400).json({ error: 'Não foi possível acessar este vídeo do Facebook.' });
      }

      const html = await r.text();

      // Try og:video meta tag
      let videoUrl = null;
      let title = 'Facebook Video';

      // Extract og:video
      const ogVideo = html.match(/<meta\s+property="og:video(?::url)?"\s+content="([^"]+)"/i);
      if (ogVideo) videoUrl = ogVideo[1].replace(/&amp;/g, '&');

      // Extract og:title
      const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
      if (ogTitle) title = ogTitle[1].replace(/&amp;/g, '&').replace(/&#039;/g, "'");

      // Extract og:image for thumbnail
      let thumbnail = null;
      const ogImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
      if (ogImage) thumbnail = ogImage[1].replace(/&amp;/g, '&');

      // Try to find HD video URL in page source
      if (!videoUrl) {
        const hdMatch = html.match(/"hd_src":"([^"]+)"/);
        if (hdMatch) videoUrl = hdMatch[1].replace(/\\\//g, '/');
      }
      if (!videoUrl) {
        const sdMatch = html.match(/"sd_src":"([^"]+)"/);
        if (sdMatch) videoUrl = sdMatch[1].replace(/\\\//g, '/');
      }
      if (!videoUrl) {
        const playable = html.match(/"playable_url(?:_quality_hd)?":"([^"]+)"/);
        if (playable) videoUrl = playable[1].replace(/\\\//g, '/');
      }

      // RapidAPI fallback
      if (!videoUrl) {
        const rapidKey = process.env.RAPIDAPI_KEY;
        if (rapidKey) {
          try {
            const fbR = await fetch('https://facebook-reel-and-video-downloader.p.rapidapi.com/app/main.php?url=' + encodeURIComponent(url), {
              headers: {
                'x-rapidapi-key': rapidKey,
                'x-rapidapi-host': 'facebook-reel-and-video-downloader.p.rapidapi.com'
              }
            });
            if (fbR.ok) {
              const fbD = await fbR.json();
              if (fbD.success && fbD.media) {
                videoUrl = fbD.media.find(m => m.quality === 'hd')?.url || fbD.media[0]?.url;
                title = fbD.title || title;
                thumbnail = fbD.thumbnail || thumbnail;
              }
            }
          } catch(e) { console.error('Facebook RapidAPI fallback:', e.message); }
        }
      }

      if (!videoUrl) {
        return res.status(400).json({
          error: 'Não foi possível extrair o vídeo do Facebook. O vídeo pode ser privado ou o Facebook bloqueou o acesso.',
          platform: 'facebook'
        });
      }

      return res.status(200).json({ url: videoUrl, title, thumbnail, platform: 'facebook' });
    }

  } catch(e) {
    console.error('baixa-social error:', e.message);
    return res.status(500).json({ error: 'Erro ao processar: ' + e.message });
  }
};
