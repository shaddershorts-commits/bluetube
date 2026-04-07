// api/blueclean.js — BlueClean: remove overlays from videos via Replicate
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

  // ── GET-UPLOAD-URL (no auth needed for this, just returns Supabase config) ──
  if (action === 'get-upload-url') {
    if (!token) return res.status(401).json({ error: 'Login necessário.' });
    return res.status(200).json({ supabase_url: SU, anon_key: AK });
  }

  // ── AUTH ───────────────────────────────────────────────────────────────────
  let userId = null, userEmail = null, userPlan = 'free';
  if (token) {
    try {
      const ur = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (ur.ok) {
        const u = await ur.json();
        userId = u.id; userEmail = u.email;
        console.log('[blueclean] User:', userEmail, 'ID:', userId);
        const pr = await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(userEmail)}&select=plan,plan_expires_at,is_manual`, { headers: H });
        if (pr.ok) {
          const sub = (await pr.json())[0];
          if (sub?.plan && sub.plan !== 'free') {
            const valid = sub.is_manual || !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date();
            if (valid) userPlan = sub.plan;
          }
        }
        console.log('[blueclean] Plan:', userPlan);
      }
    } catch(e) { console.error('[blueclean] Auth error:', e.message); }
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
    return res.status(200).json({ jobs: jr.ok ? await jr.json() : [] });
  }

  // ── STATUS ────────────────────────────────────────────────────────────────
  if (action === 'status') {
    const jobId = req.query?.job_id || req.body?.job_id;
    if (!jobId) return res.status(400).json({ error: 'job_id required' });

    const jr = await fetch(`${SU}/rest/v1/blueclean_jobs?id=eq.${jobId}&user_id=eq.${userId}&select=*`, { headers: H });
    const job = jr.ok ? (await jr.json())[0] : null;
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (job.status === 'processing' && job.replicate_id && REPLICATE) {
      try {
        const rr = await fetch(`https://api.replicate.com/v1/predictions/${job.replicate_id}`, {
          headers: { Authorization: 'Token ' + REPLICATE }
        });
        if (rr.ok) {
          const pred = await rr.json();
          console.log('[blueclean] Poll status:', pred.status, 'for job:', jobId);
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
            // Refund
            const ur2 = await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}&select=count`, { headers: H });
            const c = ur2.ok ? ((await ur2.json())[0]?.count || 0) : 0;
            if (c > 0) await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}`, {
              method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ count: c - 1 })
            });
            return res.status(200).json({ ...job, status: 'failed', error_message: pred.error });
          }
          return res.status(200).json({ ...job, status: 'processing', progress: Math.min(80, (pred.logs || '').split('\n').length * 3) });
        }
      } catch(e) { console.error('[blueclean] Poll error:', e.message); }
    }
    return res.status(200).json(job);
  }

  // ── START ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'start') {
    if (!REPLICATE) return res.status(500).json({ error: 'Replicate não configurado. Adicione REPLICATE_API_TOKEN no Vercel.' });

    const { video_url, video_duration, video_width, video_height } = req.body;
    if (!video_url) return res.status(400).json({ error: 'video_url obrigatório' });

    // Validations BEFORE consuming credit
    if (video_duration && video_duration > 60) {
      return res.status(400).json({ error: 'Vídeo muito longo. Máximo 60 segundos.' });
    }
    if (video_width && video_width > 1920) {
      return res.status(400).json({ error: 'Resolução muito alta. Máximo 1920px de largura.' });
    }

    console.log('[blueclean] Starting job for:', userEmail, 'video:', video_url.slice(0, 80), 'duration:', video_duration || '?', 'mode:', req.body.mode || 'auto');

    // Check limit
    const ur = await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}&select=count`, { headers: H });
    const used = ur.ok ? ((await ur.json())[0]?.count || 0) : 0;
    console.log('[blueclean] Usage:', used, '/', LIMIT);
    if (used >= LIMIT) return res.status(429).json({ error: `Limite mensal atingido (${LIMIT}/${LIMIT}).` });

    const crypto = require('crypto');
    const jobId = crypto.randomUUID();
    const mode = req.body.mode || 'auto';
    const mask_url = req.body.mask_url;

    try {
      // Choose model based on mode
      const modelName = (mode === 'mask' && mask_url) ? 'jd7h/propainter' : 'hjunior29/video-text-remover';
      console.log('[blueclean] Mode:', mode, 'Model:', modelName, 'Mask:', mask_url ? 'yes' : 'no');

      // Get latest version
      let versionHash = null;
      try {
        const vr = await fetch(`https://api.replicate.com/v1/models/${modelName}/versions`, {
          headers: { Authorization: 'Token ' + REPLICATE }
        });
        if (vr.ok) {
          const vd = await vr.json();
          versionHash = vd.results?.[0]?.id;
          console.log('[blueclean] Version:', versionHash);
        } else {
          console.error('[blueclean] Version fetch failed:', vr.status);
        }
      } catch(e) { console.error('[blueclean] Version error:', e.message); }

      if (!versionHash) {
        return res.status(500).json({ error: 'Modelo indisponível. Verifique REPLICATE_API_TOKEN.' });
      }

      // Build input based on mode
      let input;
      if (mode === 'mask' && mask_url) {
        // ProPainter with user mask — optimized params
        input = {
          video: video_url,
          mask: mask_url,
          width: 640,
          height: 360,
          neighbor_length: 20,
          ref_stride: 5,
          raft_iter: 20,
          subvideo_length: 60,
          fp16: false,
          mask_dilation: 8
        };
      } else {
        // Auto mode — video-text-remover with better params
        input = {
          video: video_url,
          method: 'inpaint',
          conf_threshold: 0.15,     // lower = more aggressive detection
          iou_threshold: 0.3,
          margin: 15,               // extra margin around detected text
          resolution: 'original',
          detection_interval: 1     // check every frame
        };
      }

      const replicateBody = {
        version: versionHash,
        input,
        webhook: 'https://bluetubeviral.com/api/blueclean-webhook',
        webhook_events_filter: ['completed']
      };
      console.log('[blueclean] Replicate payload:', JSON.stringify(replicateBody).slice(0, 400));

      const rr = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: { Authorization: 'Token ' + REPLICATE, 'Content-Type': 'application/json' },
        body: JSON.stringify(replicateBody)
      });

      const pred = await rr.json();
      console.log('[blueclean] Replicate response:', rr.status, JSON.stringify(pred).slice(0, 300));

      if (!rr.ok) {
        return res.status(500).json({ error: 'Replicate: ' + (pred.detail || pred.title || 'Erro desconhecido'), replicate_status: rr.status });
      }

      // Save job
      const jr = await fetch(`${SU}/rest/v1/blueclean_jobs`, {
        method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({
          id: jobId, user_id: userId, replicate_id: pred.id,
          status: 'processing', input_url: video_url,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString()
        })
      });
      console.log('[blueclean] Job saved:', jr.status);

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
      console.error('[blueclean] Fatal error:', e.message, e.stack);
      return res.status(500).json({ error: 'Erro: ' + e.message });
    }
  }

  return res.status(400).json({ error: 'Invalid action' });
};
