// api/blue-render-test.js — ONE-TIME test endpoint, DELETE after testing
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).end();

  // Simple secret protection
  if (req.body?.secret !== 'test-render-2026') return res.status(403).json({ error: 'forbidden' });

  const SHOTSTACK_KEY = process.env.SHOTSTACK_API_KEY;
  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SHOTSTACK_KEY || !SU || !SK) return res.status(500).json({ error: 'Config missing' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const SHOTSTACK_URL = 'https://api.shotstack.io/edit/stage';
  const CALLBACK_URL = 'https://www.bluetubeviral.com/api/blue-render-webhook';

  const base_video_url = req.body.base_video_url || 'https://pokpfvjrccviwgguwuck.supabase.co/storage/v1/object/public/blue-videos/96b12651-0c6e-4826-8f18-afecf2ec525a/ssstik.io_@olhomagico_1775330649036.mp4';
  const job_id = req.body.job_id;

  // Fetch variations
  const varR = await fetch(
    `${SU}/rest/v1/blue_variations?job_id=eq.${job_id}&safety_approved=eq.true&order=variation_index.asc&select=*&limit=3`,
    { headers: h }
  );
  const variations = varR.ok ? await varR.json() : [];
  if (!variations.length) return res.status(400).json({ error: 'No variations', job_id });

  const styleColors = { white_bold: '#FFFFFF', yellow_bold: '#FFD700', cyan_clean: '#00D4FF', outline: '#FFFFFF', white_clean: '#F0F0F0' };
  const results = [];

  // Only render first 2 for quick test
  for (const v of variations.slice(0, 2)) {
    const idx = v.variation_index || 1;
    const color = styleColors[v.caption_style] || '#FFFFFF';
    const hookPosition = idx === 1 ? 'bottom' : 'top';
    const hookOffsetY = idx === 1 ? 0.15 : -0.15;

    const timeline = {
      timeline: {
        tracks: [
          {
            clips: [
              {
                asset: { type: 'title', text: v.hook_text || 'Hook Test', style: 'minimal', color, size: 'medium', background: 'transparent' },
                start: 0, length: 3, position: hookPosition, offset: { y: hookOffsetY }
              },
              {
                asset: { type: 'title', text: v.cta_text || 'CTA Test', style: 'minimal', color, size: 'small', background: 'transparent' },
                start: 27, length: 3, position: 'bottom', offset: { y: 0.08 }
              }
            ]
          },
          {
            clips: [
              { asset: { type: 'video', src: base_video_url }, start: 0, length: 30 }
            ]
          }
        ]
      },
      output: { format: 'mp4', resolution: 'sd', size: { width: 480, height: 854 } },
      callback: CALLBACK_URL
    };

    try {
      const rR = await fetch(`${SHOTSTACK_URL}/render`, {
        method: 'POST',
        headers: { 'x-api-key': SHOTSTACK_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(timeline)
      });
      const rD = await rR.json();
      const renderId = rD.response?.id;

      if (rR.ok && renderId) {
        // Save to DB
        await fetch(`${SU}/rest/v1/blue_variations?id=eq.${v.id}`, {
          method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
          body: JSON.stringify({ shotstack_render_id: renderId, render_status: 'rendering' })
        });
        results.push({ idx, hook: v.hook_text?.slice(0, 40), render_id: renderId, color, position: hookPosition, status: 'submitted' });
      } else {
        results.push({ idx, hook: v.hook_text?.slice(0, 40), error: JSON.stringify(rD).slice(0, 300), http: rR.status });
      }
    } catch(e) {
      results.push({ idx, error: e.message });
    }
  }

  return res.status(200).json({ results, callback_url: CALLBACK_URL, variations_count: variations.length });
};
