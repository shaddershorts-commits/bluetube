// api/transcript.js — Vercel Serverless Function
// Hides the Supadata API key on the server side.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit (inline for ESM compatibility)
  {
    const rlIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
    const SU = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY;
    if (SU && SK && rlIp) {
      try {
        const windowStart = new Date(Date.now() - 60000).toISOString();
        const cr = await fetch(`${SU}/rest/v1/rate_limits?ip=eq.${encodeURIComponent(rlIp)}&endpoint=eq.${encodeURIComponent('/api/transcript')}&window_start=gte.${windowStart}&select=count`, {
          headers: { 'apikey': SK, 'Authorization': `Bearer ${SK}` }, signal: AbortSignal.timeout(3000)
        });
        if (cr.ok) { const cd = await cr.json(); if ((cd?.length || 0) >= 10) { res.setHeader('Retry-After','60'); return res.status(429).json({ error:'Muitas requisições. Aguarde 1 minuto.', retry_after:60 }); } }
        fetch(`${SU}/rest/v1/rate_limits`, { method:'POST', headers:{'Content-Type':'application/json','apikey':SK,'Authorization':`Bearer ${SK}`,'Prefer':'return=minimal'}, body:JSON.stringify({ip:rlIp,endpoint:'/api/transcript',count:1,window_start:new Date().toISOString()}) }).catch(()=>{});
      } catch(e){}
    }
  }

  // Aceita ?videoId=YT_ID (compat YouTube antigo) OU ?url=URL_COMPLETA
  // (multiplatforma — TikTok/Instagram/X/YouTube). Supadata aceita URL direta.
  const { videoId: queryVideoId, url: queryUrl } = req.query;

  let videoId = '';
  let targetUrl = '';
  let cacheKeyInput = '';
  let platform = 'youtube';

  if (queryUrl && typeof queryUrl === 'string') {
    // Modo URL — valida + detecta plataforma + canonicaliza
    try {
      const u = new URL(queryUrl);
      const host = u.hostname.replace(/^www\./, '').toLowerCase();
      if (/youtube\.com|youtu\.be/i.test(host) || host.endsWith('.youtube.com')) {
        platform = 'youtube';
        const m = queryUrl.match(/(?:shorts\/|v=|youtu\.be\/)([a-zA-Z0-9_-]{6,20})/);
        if (m) {
          videoId = m[1];
          targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
          cacheKeyInput = 'transcript|' + videoId; // compat key
        }
      } else if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
        platform = 'tiktok';
      } else if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
        platform = 'instagram';
      } else if (/twitter\.com|x\.com/i.test(host)) {
        platform = 'x';
      } else {
        return res.status(400).json({ error: 'URL não suportada. Use YouTube, TikTok, Instagram ou X (Twitter).' });
      }
      if (platform !== 'youtube') {
        // Canonicaliza URL pra cache key estavel (remove query params irrelevantes)
        const keep = ['v', 'list'];
        const newParams = new URLSearchParams();
        for (const [k, v] of u.searchParams) if (keep.includes(k)) newParams.set(k, v);
        u.search = newParams.toString();
        u.hash = '';
        targetUrl = u.toString();
        cacheKeyInput = 'transcript|url|' + targetUrl;
      }
    } catch (_) {
      return res.status(400).json({ error: 'URL inválida.' });
    }
    if (!targetUrl) return res.status(400).json({ error: 'URL inválida ou plataforma não detectada.' });
  } else if (queryVideoId && typeof queryVideoId === 'string') {
    // Modo videoId (compat) — assume YouTube
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(queryVideoId)) {
      return res.status(400).json({ error: 'Link inválido. Use um link de YouTube Shorts.' });
    }
    videoId = queryVideoId;
    targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
    cacheKeyInput = 'transcript|' + videoId; // compat key
    platform = 'youtube';
  } else {
    return res.status(400).json({ error: 'Link do vídeo é obrigatório.' });
  }

  // Check cache
  const crypto = await import('crypto');
  const ck = crypto.createHash('md5').update(cacheKeyInput).digest('hex');
  const SU = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY;
  if (SU && SK) {
    try {
      const cr = await fetch(`${SU}/rest/v1/api_cache?cache_key=eq.${ck}&expires_at=gt.${new Date().toISOString()}&select=value&limit=1`, {
        headers: { 'apikey': SK, 'Authorization': `Bearer ${SK}` }, signal: AbortSignal.timeout(3000)
      });
      if (cr.ok) { const cd = await cr.json(); if (cd?.[0]?.value) return res.status(200).json(cd[0].value); }
    } catch(e){}
  }

  // Chaves Supadata em ordem (primária → fallback). Fallback so dispara se
  // primaria der 401/403/429 ou erro de rede. Demais respostas (200/202/404
  // /etc) sao consideradas validas e NAO mudam de chave.
  const SUPADATA_KEYS = [process.env.SUPADATA_API_KEY, process.env.SUPADATA_API_KEY_FALLBACK].filter(Boolean);
  if (!SUPADATA_KEYS.length) {
    return res.status(500).json({ error: 'Serviço temporariamente indisponível.' });
  }

  // ytUrl = mantido o nome por historia, mas pode ser URL de qualquer plataforma agora
  const ytUrl = targetUrl;

  try {
    let supaRes = null;
    let data = null;
    let usedKey = null;

    for (let i = 0; i < SUPADATA_KEYS.length; i++) {
      const key = SUPADATA_KEYS[i];
      const isLast = i === SUPADATA_KEYS.length - 1;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        const r = await fetch(
          `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(ytUrl)}`,
          { headers: { 'x-api-key': key }, signal: controller.signal }
        );
        clearTimeout(timer);

        // 401/403/429 = problema da chave (auth/credits/rate). Tenta proxima.
        if ([401, 403, 429].includes(r.status) && !isLast) {
          console.warn(`[transcript] chave #${i+1} retornou ${r.status}, tentando fallback`);
          continue;
        }
        supaRes = r;
        data = await r.json();
        usedKey = key;
        break;
      } catch (err) {
        if (isLast) throw err;
        console.warn(`[transcript] chave #${i+1} falhou (${err.message}), tentando fallback`);
      }
    }

    // 202 = async job for long videos
    if (supaRes.status === 202 && data.jobId) {
      // Poll up to 15x with 3s interval (45s max) — usa a chave que originou o job
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const pollRes = await fetch(
          `https://api.supadata.ai/v1/transcript/${data.jobId}`,
          { headers: { 'x-api-key': usedKey } }
        );
        const pollData = await pollRes.json();
        if (pollData.content || pollData.status === 'completed') {
          return res.status(200).json(pollData);
        }
        if (pollData.status === 'failed') {
          return res.status(422).json({ error: 'Transcription failed for this video.' });
        }
      }
      return res.status(408).json({ error: 'Transcription timed out. Try a shorter video.' });
    }

    if (supaRes.status === 401 || supaRes.status === 403) {
      return res.status(502).json({ error: 'Serviço temporariamente indisponível. Tente novamente.' });
    }
    if (supaRes.status === 404) {
      return res.status(404).json({ error: 'Este vídeo não tem legenda disponível. Tente outro Short.' });
    }
    if (supaRes.status === 429) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'Serviço sobrecarregado. Tente novamente em 1 minuto.', retry_after: 60 });
    }
    if (!supaRes.ok) {
      return res.status(supaRes.status).json({ error: data.message || 'Erro na transcrição. Tente novamente.' });
    }

    // Cache successful response for 30 days (transcricao de Short nao muda)
    if (SU && SK) {
      fetch(`${SU}/rest/v1/api_cache?cache_key=eq.${ck}`, { method:'DELETE', headers:{'apikey':SK,'Authorization':`Bearer ${SK}`} }).catch(()=>{});
      fetch(`${SU}/rest/v1/api_cache`, { method:'POST', headers:{'Content-Type':'application/json','apikey':SK,'Authorization':`Bearer ${SK}`,'Prefer':'return=minimal'},
        body:JSON.stringify({cache_key:ck,value:data,created_at:new Date().toISOString(),expires_at:new Date(Date.now()+30*24*3600*1000).toISOString()})
      }).catch(()=>{});
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error('Transcript proxy error:', err);
    if (err.name === 'AbortError') return res.status(504).json({ error: 'A requisição demorou muito. Tente novamente.' });
    return res.status(500).json({ error: 'Algo deu errado. Já fomos notificados e estamos corrigindo.' });
  }
}
