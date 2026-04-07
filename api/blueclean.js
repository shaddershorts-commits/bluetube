// api/blueclean.js — BlueClean: remove overlays via Replicate
// Master plan only, 10/month limit

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

  // ── AUTH (all actions require auth) ────────────────────────────────────────
  let userId = null, userEmail = null, userPlan = 'free';
  if (token) {
    try {
      const ur = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (ur.ok) {
        const u = await ur.json(); userId = u.id; userEmail = u.email;
        const pr = await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(userEmail)}&select=plan,plan_expires_at,is_manual`, { headers: H });
        if (pr.ok) { const sub = (await pr.json())[0]; if (sub?.plan !== 'free') { const v = sub.is_manual || !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date(); if (v) userPlan = sub.plan; } }
      }
    } catch(e) {}
  }
  if (!userId) return res.status(401).json({ error: 'Login necessário.' });
  if (userPlan !== 'master') return res.status(403).json({ error: 'BlueClean é exclusivo do plano Master.', upgrade: true });

  const month = new Date().toISOString().slice(0, 7);
  const LIMIT = 10;

  // ── GET-UPLOAD-URL: signed URL for direct upload to Storage ────────────────
  if (action === 'get-upload-url') {
    const ts = Date.now();
    const filename = req.body?.filename || 'input.mp4';
    const ext = filename.split('.').pop() || 'mp4';
    const vPath = `blueclean/${userId}/${ts}/input.${ext}`;
    const mPath = `blueclean/${userId}/${ts}/mask.png`;

    // Upload via service key (POST directly with service auth)
    return res.status(200).json({
      supabase_url: SU,
      service_key: SK, // service key for upload — only exposed to authenticated Master users
      video_path: vPath,
      mask_path: mPath,
      video_public_url: `${SU}/storage/v1/object/public/blue-videos/${vPath}`,
      mask_public_url: `${SU}/storage/v1/object/public/blue-videos/${mPath}`
    });
  }

  // ── USAGE ──────────────────────────────────────────────────────────────────
  if (action === 'usage') {
    const ur = await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}&select=count`, { headers: H });
    const used = ur.ok ? ((await ur.json())[0]?.count || 0) : 0;
    return res.status(200).json({ used, limit: LIMIT, remaining: Math.max(0, LIMIT - used) });
  }

  // ── HISTORY ────────────────────────────────────────────────────────────────
  if (action === 'history') {
    const jr = await fetch(`${SU}/rest/v1/blueclean_jobs?user_id=eq.${userId}&order=created_at.desc&limit=20&select=*`, { headers: H });
    return res.status(200).json({ jobs: jr.ok ? await jr.json() : [] });
  }

  // ── STATUS ─────────────────────────────────────────────────────────────────
  if (action === 'status') {
    const jobId = req.query?.job_id || req.body?.job_id;
    if (!jobId) return res.status(400).json({ error: 'job_id required' });
    const jr = await fetch(`${SU}/rest/v1/blueclean_jobs?id=eq.${jobId}&user_id=eq.${userId}&select=*`, { headers: H });
    const job = jr.ok ? (await jr.json())[0] : null;
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (job.status === 'processing' && job.replicate_id && REPLICATE) {
      try {
        const rr = await fetch(`https://api.replicate.com/v1/predictions/${job.replicate_id}`, { headers: { Authorization: 'Token ' + REPLICATE } });
        if (rr.ok) {
          const pred = await rr.json();
          if (pred.status === 'succeeded' && pred.output) {
            const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
            await fetch(`${SU}/rest/v1/blueclean_jobs?id=eq.${jobId}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'completed', output_url: out, updated_at: new Date().toISOString() }) });
            return res.status(200).json({ ...job, status: 'completed', output_url: out });
          }
          if (pred.status === 'failed') {
            await fetch(`${SU}/rest/v1/blueclean_jobs?id=eq.${jobId}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'failed', error_message: pred.error || 'Failed', updated_at: new Date().toISOString() }) });
            // Refund
            const ur2 = await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}&select=count`, { headers: H });
            const c = ur2.ok ? ((await ur2.json())[0]?.count || 0) : 0;
            if (c > 0) await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ count: c - 1 }) });
            return res.status(200).json({ ...job, status: 'failed', error_message: pred.error });
          }
          return res.status(200).json({ ...job, status: 'processing', progress: Math.min(80, (pred.logs || '').split('\n').length * 3) });
        }
      } catch(e) {}
    }
    return res.status(200).json(job);
  }

  // ── START ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'start') {
    if (!REPLICATE) return res.status(500).json({ error: 'Replicate não configurado.' });

    const { video_url, mask_url, mode } = req.body;
    if (!video_url) return res.status(400).json({ error: 'video_url obrigatório' });

    // Check limit BEFORE anything
    const ur = await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}&select=count`, { headers: H });
    const used = ur.ok ? ((await ur.json())[0]?.count || 0) : 0;
    if (used >= LIMIT) return res.status(429).json({ error: `Limite atingido (${LIMIT}/${LIMIT}).` });

    // Both modes use video-text-remover — manual mode uses 'hybrid' method for stronger removal
    const modelName = 'hjunior29/video-text-remover';
    console.log('[blueclean] Start:', mode, 'user:', userEmail);

    try {
      let ver = null;
      const vr = await fetch(`https://api.replicate.com/v1/models/${modelName}/versions`, { headers: { Authorization: 'Token ' + REPLICATE } });
      if (vr.ok) { const vd = await vr.json(); ver = vd.results?.[0]?.id; }
      if (!ver) return res.status(500).json({ error: 'Modelo indisponível.' });

      // Standard: hybrid (context-aware TELEA) — best quality for complex backgrounds
      // Aggressive: hybrid + lower thresholds + larger margin + every frame detection
      const input = mode === 'mask'
        ? { video: video_url, method: 'hybrid', conf_threshold: 0.08, iou_threshold: 0.15, margin: 20, resolution: 'original', detection_interval: 1 }
        : { video: video_url, method: 'hybrid', conf_threshold: 0.20, iou_threshold: 0.35, margin: 10, resolution: 'original', detection_interval: 3 };

      console.log('[blueclean] Input:', JSON.stringify(input).slice(0, 200));

      const rr = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: { Authorization: 'Token ' + REPLICATE, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: ver, input, webhook: 'https://bluetubeviral.com/api/blueclean-webhook', webhook_events_filter: ['completed'] })
      });
      const pred = await rr.json();
      console.log('[blueclean] Replicate:', rr.status, JSON.stringify(pred).slice(0, 200));
      if (!rr.ok) return res.status(500).json({ error: 'Replicate: ' + (pred.detail || 'Erro') });

      // Save job + increment usage
      const crypto = require('crypto');
      const jobId = crypto.randomUUID();
      await fetch(`${SU}/rest/v1/blueclean_jobs`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ id: jobId, user_id: userId, replicate_id: pred.id, status: 'processing', input_url: video_url, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });

      const ex = await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}&select=count`, { headers: H });
      const exd = ex.ok ? (await ex.json())[0] : null;
      if (exd) await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ count: (exd.count || 0) + 1 }) });
      else await fetch(`${SU}/rest/v1/blueclean_usage`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ user_id: userId, month, count: 1 }) });

      return res.status(200).json({ job_id: jobId, replicate_id: pred.id, status: 'processing' });
    } catch(e) {
      console.error('[blueclean] Error:', e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Invalid action' });
};
