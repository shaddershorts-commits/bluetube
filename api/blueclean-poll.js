// api/blueclean-poll.js — Cron: */2 * * * * — fallback for webhook
module.exports = async function handler(req, res) {
  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const REPLICATE = process.env.REPLICATE_API_TOKEN;
  if (!SU || !SK || !REPLICATE) return res.status(200).json({ ok: false });

  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  let updated = 0;

  try {
    const oneMinAgo = new Date(Date.now() - 60000).toISOString();
    const thirtyMinAgo = new Date(Date.now() - 30 * 60000).toISOString();

    const jr = await fetch(`${SU}/rest/v1/blueclean_jobs?status=eq.processing&updated_at=lt.${oneMinAgo}&select=*&limit=20`, { headers: H });
    const jobs = jr.ok ? await jr.json() : [];

    for (const job of jobs) {
      // Stuck for 30+ min → fail
      if (new Date(job.created_at) < new Date(thirtyMinAgo)) {
        await fetch(`${SU}/rest/v1/blueclean_jobs?id=eq.${job.id}`, {
          method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'failed', error_message: 'Timeout (30min)', updated_at: new Date().toISOString() })
        });
        updated++;
        continue;
      }

      if (!job.replicate_id) continue;

      try {
        const rr = await fetch(`https://api.replicate.com/v1/predictions/${job.replicate_id}`, {
          headers: { Authorization: 'Token ' + REPLICATE }
        });
        if (!rr.ok) continue;
        const pred = await rr.json();

        if (pred.status === 'succeeded' && pred.output) {
          const outputUrl = Array.isArray(pred.output) ? pred.output[0] : pred.output;
          await fetch(`${SU}/rest/v1/blueclean_jobs?id=eq.${job.id}`, {
            method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'completed', output_url: outputUrl, updated_at: new Date().toISOString() })
          });
          updated++;
        } else if (pred.status === 'failed') {
          await fetch(`${SU}/rest/v1/blueclean_jobs?id=eq.${job.id}`, {
            method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'failed', error_message: pred.error || 'Failed', updated_at: new Date().toISOString() })
          });
          // Refund
          const month = new Date().toISOString().slice(0, 7);
          const ur = await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${job.user_id}&month=eq.${month}&select=count`, { headers: H });
          const c = ur.ok ? ((await ur.json())[0]?.count || 0) : 0;
          if (c > 0) await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${job.user_id}&month=eq.${month}`, {
            method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ count: c - 1 })
          });
          updated++;
        }
      } catch(e) {}
    }

    return res.status(200).json({ ok: true, checked: jobs.length, updated });
  } catch(e) { return res.status(200).json({ ok: false, error: e.message }); }
};
