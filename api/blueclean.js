// api/blueclean.js — BlueClean: remove overlays from videos via Replicate ProPainter
// Exclusive to Master plan, 10 videos/month limit

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  const REPLICATE = process.env.REPLICATE_API_TOKEN;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });

  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const action = req.method === 'GET' ? req.query.action : req.body?.action;
  const token = req.method === 'GET' ? req.query.token : req.body?.token;

  // Auth
  let userId = null, userEmail = null, userPlan = 'free';
  if (token) {
    try {
      const ur = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (ur.ok) {
        const u = await ur.json();
        userId = u.id; userEmail = u.email;
        // Get plan
        const pr = await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(userEmail)}&select=plan,plan_expires_at,is_manual`, { headers: H });
        if (pr.ok) {
          const sub = (await pr.json())[0];
          if (sub?.plan && sub.plan !== 'free') {
            const valid = sub.is_manual || !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date();
            if (valid) userPlan = sub.plan;
          }
        }
      }
    } catch(e) {}
  }

  if (!userId) return res.status(401).json({ error: 'Login necessário.' });
  if (userPlan !== 'master') return res.status(403).json({ error: 'BlueClean é exclusivo do plano Master.', upgrade: true });

  const month = new Date().toISOString().slice(0, 7);
  const LIMIT = 10;

  // ── USAGE ─────────────────────────────────────────────────────────────────
  if (action === 'usage') {
    const ur = await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}&select=count`, { headers: H });
    const used = ur.ok ? ((await ur.json())[0]?.count || 0) : 0;
    return res.status(200).json({ used, limit: LIMIT, remaining: Math.max(0, LIMIT - used) });
  }

  // ── HISTORY ───────────────────────────────────────────────────────────────
  if (action === 'history') {
    const jr = await fetch(`${SU}/rest/v1/blueclean_jobs?user_id=eq.${userId}&order=created_at.desc&limit=20&select=*`, { headers: H });
    const jobs = jr.ok ? await jr.json() : [];
    return res.status(200).json({ jobs });
  }

  // ── STATUS ────────────────────────────────────────────────────────────────
  if (action === 'status') {
    const jobId = req.query.job_id || req.body?.job_id;
    if (!jobId) return res.status(400).json({ error: 'job_id required' });

    const jr = await fetch(`${SU}/rest/v1/blueclean_jobs?id=eq.${jobId}&user_id=eq.${userId}&select=*`, { headers: H });
    const job = jr.ok ? (await jr.json())[0] : null;
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // If processing, check Replicate
    if (job.status === 'processing' && job.replicate_id && REPLICATE) {
      try {
        const rr = await fetch(`https://api.replicate.com/v1/predictions/${job.replicate_id}`, {
          headers: { Authorization: 'Token ' + REPLICATE }
        });
        if (rr.ok) {
          const pred = await rr.json();
          if (pred.status === 'succeeded' && pred.output) {
            const outputUrl = Array.isArray(pred.output) ? pred.output[0] : pred.output;
            await fetch(`${SU}/rest/v1/blueclean_jobs?id=eq.${jobId}`, {
              method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
              body: JSON.stringify({ status: 'completed', output_url: outputUrl, updated_at: new Date().toISOString() })
            });
            return res.status(200).json({ ...job, status: 'completed', output_url: outputUrl });
          }
          if (pred.status === 'failed') {
            await fetch(`${SU}/rest/v1/blueclean_jobs?id=eq.${jobId}`, {
              method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
              body: JSON.stringify({ status: 'failed', error_message: pred.error || 'Processing failed', updated_at: new Date().toISOString() })
            });
            // Refund usage
            const ur2 = await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}&select=count`, { headers: H });
            const c = ur2.ok ? ((await ur2.json())[0]?.count || 0) : 0;
            if (c > 0) {
              await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}`, {
                method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
                body: JSON.stringify({ count: Math.max(0, c - 1) })
              });
            }
            return res.status(200).json({ ...job, status: 'failed', error_message: pred.error });
          }
          // Still processing
          const progress = pred.logs ? Math.min(90, pred.logs.split('\n').length * 5) : 30;
          return res.status(200).json({ ...job, status: 'processing', progress });
        }
      } catch(e) {}
    }

    return res.status(200).json(job);
  }

  // ── START ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'start') {
    if (!REPLICATE) return res.status(500).json({ error: 'Replicate não configurado. Adicione REPLICATE_API_TOKEN no Vercel.' });

    const { video_url } = req.body;
    if (!video_url) return res.status(400).json({ error: 'video_url obrigatório' });

    // Check limit
    const ur = await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}&select=count`, { headers: H });
    const used = ur.ok ? ((await ur.json())[0]?.count || 0) : 0;
    if (used >= LIMIT) return res.status(429).json({ error: `Limite mensal atingido (${LIMIT}/${LIMIT}). Renova no próximo mês.` });

    // Create job
    const crypto = require('crypto');
    const jobId = crypto.randomUUID();

    // Call Replicate
    try {
      const rr = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: { Authorization: 'Token ' + REPLICATE, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 'a23f0db2ab3b0e7b5cdd4c3ad55ce0ecc5a4d97f29150041a10e4e4753cb5097',
          input: {
            video: video_url,
            fp16: true,
            subvideo_length: 80
          },
          webhook: 'https://bluetubeviral.com/api/blueclean-webhook',
          webhook_events_filter: ['completed', 'failed']
        })
      });

      if (!rr.ok) {
        const err = await rr.json().catch(() => ({}));
        console.error('[blueclean] Replicate error:', err);
        return res.status(500).json({ error: 'Falha ao iniciar processamento. Tente novamente.' });
      }

      const pred = await rr.json();

      // Save job
      await fetch(`${SU}/rest/v1/blueclean_jobs`, {
        method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({
          id: jobId, user_id: userId, replicate_id: pred.id,
          status: 'processing', input_url: video_url,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString()
        })
      });

      // Increment usage
      const existR = await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}&select=count`, { headers: H });
      const exist = existR.ok ? (await existR.json())[0] : null;
      if (exist) {
        await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}`, {
          method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
          body: JSON.stringify({ count: (exist.count || 0) + 1, updated_at: new Date().toISOString() })
        });
      } else {
        await fetch(`${SU}/rest/v1/blueclean_usage`, {
          method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
          body: JSON.stringify({ user_id: userId, month, count: 1 })
        });
      }

      return res.status(200).json({
        job_id: jobId, replicate_id: pred.id,
        status: 'processing', estimated_time: '2-5 minutos'
      });
    } catch(e) {
      console.error('[blueclean] Error:', e);
      return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
    }
  }

  return res.status(400).json({ error: 'Invalid action' });
};
