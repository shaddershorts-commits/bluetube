// api/save-transcript.js
// Saves video URL + transcription to Supabase for agent learning.
// Called automatically after every successful transcription.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { videoId, transcript, lang } = req.body;
  if (!videoId || !transcript) return res.status(400).json({ error: 'Missing fields' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });

  try {
    // Upsert — if same video processed again, just update timestamp
    const r = await fetch(`${SUPABASE_URL}/rest/v1/viral_shorts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        video_id: videoId,
        transcript: transcript.slice(0, 8000),
        lang: lang || 'Português (Brasil)',
        copy_count: 0,
        processed_at: new Date().toISOString()
      })
    });

    if (!r.ok) {
      const err = await r.text();
      console.error('Supabase save error:', err);
      // Don't fail silently — but don't block the user either
      return res.status(200).json({ saved: false });
    }

    return res.status(200).json({ saved: true });
  } catch (err) {
    console.error('Save error:', err);
    return res.status(200).json({ saved: false }); // non-blocking
  }
}
