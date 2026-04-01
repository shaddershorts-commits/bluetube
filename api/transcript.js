// api/transcript.js — Vercel Serverless Function
// Hides the Supadata API key on the server side.
// The browser calls /api/transcript?videoId=XXX and this function
// forwards the request to Supadata with the secret key.

export default async function handler(req, res) {
  // CORS — allow any origin so the frontend can call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { videoId } = req.query;

  if (!videoId || typeof videoId !== 'string') {
    return res.status(400).json({ error: 'Missing videoId parameter' });
  }

  // Sanitize — only allow valid YouTube video IDs (11 alphanumeric chars)
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId format' });
  }

  const SUPADATA_KEY = process.env.SUPADATA_API_KEY;
  if (!SUPADATA_KEY) {
    return res.status(500).json({ error: 'Server misconfigured — API key missing' });
  }

  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const supaRes = await fetch(
      `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(ytUrl)}`,
      { headers: { 'x-api-key': SUPADATA_KEY } }
    );

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
      return res.status(502).json({ error: 'Upstream API authentication failed.' });
    }
    if (supaRes.status === 404) {
      return res.status(404).json({ error: 'No transcript found. Video may be private or have no captions.' });
    }
    if (supaRes.status === 429) {
      return res.status(429).json({ error: 'Rate limit reached. Please try again in a moment.' });
    }
    if (!supaRes.ok) {
      return res.status(supaRes.status).json({ error: data.message || 'Transcription service error.' });
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error('Transcript proxy error:', err);
    return res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
}
