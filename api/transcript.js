// api/transcript.js — Vercel Serverless Function
// Hides the Supadata API key on the server side.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { applyRateLimit } = require('./helpers/rate-limit.js');
const { cacheKey, getCache, setCache } = require('./helpers/cache.js');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit
  if (await applyRateLimit(req, res)) return;

  const { videoId } = req.query;

  if (!videoId || typeof videoId !== 'string') {
    return res.status(400).json({ error: 'Link do vídeo é obrigatório.' });
  }

  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
    return res.status(400).json({ error: 'Link inválido. Use um link de YouTube Shorts.' });
  }

  // Check cache
  const ck = cacheKey(['transcript', videoId]);
  const cached = await getCache(ck, process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  if (cached) return res.status(200).json(cached);

  const SUPADATA_KEY = process.env.SUPADATA_API_KEY;
  if (!SUPADATA_KEY) {
    return res.status(500).json({ error: 'Serviço temporariamente indisponível.' });
  }

  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const supaRes = await fetch(
      `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(ytUrl)}`,
      { headers: { 'x-api-key': SUPADATA_KEY }, signal: controller.signal }
    );
    clearTimeout(timer);

    const data = await supaRes.json();

    // 202 = async job for long videos
    if (supaRes.status === 202 && data.jobId) {
      // Poll up to 15x with 3s interval (45s max)
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const pollRes = await fetch(
          `https://api.supadata.ai/v1/transcript/${data.jobId}`,
          { headers: { 'x-api-key': SUPADATA_KEY } }
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

    // Cache successful response for 24h
    setCache(ck, data, 24, process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY).catch(() => {});

    return res.status(200).json(data);

  } catch (err) {
    console.error('Transcript proxy error:', err);
    if (err.name === 'AbortError') return res.status(504).json({ error: 'A requisição demorou muito. Tente novamente.' });
    return res.status(500).json({ error: 'Algo deu errado. Já fomos notificados e estamos corrigindo.' });
  }
}
