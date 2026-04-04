// api/blue-render-webhook.js — Webhook do Shotstack quando vídeo fica pronto
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Always return 200 so Shotstack doesn't retry
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) { console.error('webhook: config missing'); return res.status(200).end(); }
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  try {
    const body = req.body || {};
    const renderId = body.id;
    const status = body.status;
    const videoUrl = body.response?.url || body.url || null;

    console.log('blue-render-webhook:', renderId, status, videoUrl?.slice(0, 80));

    if (!renderId) return res.status(200).json({ ok: true, message: 'no render id' });

    // Find the variation with this render_id
    const vR = await fetch(
      `${SU}/rest/v1/blue_variations?shotstack_render_id=eq.${renderId}&select=id,job_id`,
      { headers: h }
    );
    const vars = vR.ok ? await vR.json() : [];
    if (!vars.length) {
      console.warn('webhook: no variation found for render', renderId);
      return res.status(200).json({ ok: true, message: 'variation not found' });
    }

    const variation = vars[0];

    if (status === 'done' && videoUrl) {
      // Update variation with the rendered video URL
      await fetch(`${SU}/rest/v1/blue_variations?id=eq.${variation.id}`, {
        method: 'PATCH',
        headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({
          video_url: videoUrl,
          render_status: 'done'
        })
      });
      console.log('webhook: variation', variation.id, 'render done');
    } else if (status === 'failed') {
      await fetch(`${SU}/rest/v1/blue_variations?id=eq.${variation.id}`, {
        method: 'PATCH',
        headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ render_status: 'failed' })
      });
      console.log('webhook: variation', variation.id, 'render failed');
    }

    return res.status(200).json({ ok: true });
  } catch(e) {
    console.error('webhook error:', e.message);
    return res.status(200).json({ ok: true, error: e.message });
  }
};
