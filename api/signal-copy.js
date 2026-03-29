// api/signal-copy.js
// Called when user clicks "Copy" on a generated script.
// Increments copy_count — this is the quality signal for the learning loop.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'Missing videoId' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(200).json({ ok: false });

  try {
    // Use Supabase RPC to safely increment without race conditions
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_copy_count`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify({ p_video_id: videoId })
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Signal error:', err);
    return res.status(200).json({ ok: false });
  }
}
