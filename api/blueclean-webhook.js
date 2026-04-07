// api/blueclean-webhook.js — Receives Replicate webhook when job completes
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const RESEND = process.env.RESEND_API_KEY;
  if (!SU || !SK) return res.status(200).json({ ok: false });

  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const body = req.body || {};
  const replicateId = body.id;
  const status = body.status;

  if (!replicateId) return res.status(200).json({ ok: false });

  try {
    // Find job
    const jr = await fetch(`${SU}/rest/v1/blueclean_jobs?replicate_id=eq.${replicateId}&select=*`, { headers: H });
    const job = jr.ok ? (await jr.json())[0] : null;
    if (!job) return res.status(200).json({ ok: false, error: 'Job not found' });

    // Get user email
    let userEmail = null;
    try {
      const sr = await fetch(`${SU}/rest/v1/subscribers?select=email&limit=500`, { headers: H });
      // Can't easily get email from user_id without auth table access — skip email for now
    } catch(e) {}

    if (status === 'succeeded' && body.output) {
      const outputUrl = Array.isArray(body.output) ? body.output[0] : body.output;
      await fetch(`${SU}/rest/v1/blueclean_jobs?id=eq.${job.id}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'completed', output_url: outputUrl, updated_at: new Date().toISOString() })
      });
      console.log(`[blueclean] ✅ Job completed: ${job.id}`);
    }

    if (status === 'failed') {
      await fetch(`${SU}/rest/v1/blueclean_jobs?id=eq.${job.id}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'failed', error_message: body.error || 'Processing failed', updated_at: new Date().toISOString() })
      });
      // Refund usage
      const month = new Date().toISOString().slice(0, 7);
      const ur = await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${job.user_id}&month=eq.${month}&select=count`, { headers: H });
      const c = ur.ok ? ((await ur.json())[0]?.count || 0) : 0;
      if (c > 0) {
        await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${job.user_id}&month=eq.${month}`, {
          method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
          body: JSON.stringify({ count: Math.max(0, c - 1) })
        });
      }
      console.log(`[blueclean] ❌ Job failed: ${job.id} — ${body.error}`);
    }

    return res.status(200).json({ ok: true });
  } catch(e) {
    console.error('[blueclean-webhook]', e);
    return res.status(200).json({ ok: false });
  }
};
