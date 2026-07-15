// api/blueclean.js — BlueClean v2: remoção de texto/marca-dágua em 3 estágios
// Master only. Pipeline: (1) DETECÇÃO texto (modelo black) → (2) MÁSCARA
// (Railway blend-diff PTS-aligned) → (3) PREENCHIMENTO deep (ProPainter).
// Orquestração poll-driven pelo action=status (frontend já faz polling).

// Dispara uma prediction no Replicate (resolve última versão). Retorna id ou null.
async function startReplicate(token, model, input) {
  try {
    const vr = await fetch(`https://api.replicate.com/v1/models/${model}/versions`, { headers: { Authorization: 'Token ' + token } });
    if (!vr.ok) return null;
    const ver = (await vr.json()).results?.[0]?.id;
    if (!ver) return null;
    const rr = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST', headers: { Authorization: 'Token ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: ver, input }),
    });
    const pred = await rr.json();
    return rr.ok ? pred.id : null;
  } catch (e) { return null; }
}

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
  const LIMIT = 999999; // Ilimitado para Master

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

    if (job.status !== 'processing' || !REPLICATE) return res.status(200).json(job);

    const RW = process.env.RAILWAY_FFMPEG_URL;
    const stage = job.stage || 'detect';
    const patch = (obj) => fetch(`${SU}/rest/v1/blueclean_jobs?id=eq.${jobId}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ ...obj, updated_at: new Date().toISOString() }),
    });
    const fail = async (msg) => {
      await patch({ status: 'failed', error_message: msg });
      const ur2 = await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}&select=count`, { headers: H });
      const c = ur2.ok ? ((await ur2.json())[0]?.count || 0) : 0;
      if (c > 0) await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ count: c - 1 }) });
      return res.status(200).json({ ...job, status: 'failed', error_message: msg });
    };
    const checkPred = async (id) => {
      try { const rr = await fetch(`https://api.replicate.com/v1/predictions/${id}`, { headers: { Authorization: 'Token ' + REPLICATE } }); return rr.ok ? await rr.json() : null; }
      catch (e) { return null; }
    };

    try {
      // ── ESTÁGIO 1: DETECÇÃO (modelo black) ──────────────────────────────
      if (stage === 'detect' && job.replicate_id) {
        const pred = await checkPred(job.replicate_id);
        if (!pred) return res.status(200).json({ ...job, status: 'processing', progress: 15 });
        if (pred.status === 'failed') return fail('Detecção falhou: ' + (pred.error || ''));
        if (pred.status === 'succeeded' && pred.output) {
          if (!RW) return fail('Railway não configurado.');
          const blackUrl = Array.isArray(pred.output) ? pred.output[0] : pred.output;
          const outPath = `blueclean/${userId}/${Date.now()}/mask.mp4`;
          const mr = await fetch(RW.replace(/\/$/, '') + '/blueclean-mask', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ original_url: job.input_url, black_url: blackUrl, output_path: outPath, supabase_url: SU, supabase_key: SK }),
          });
          const md = await mr.json().catch(() => ({}));
          if (!mr.ok || !md.job_id) return fail('Falha ao gerar máscara.');
          await patch({ stage: 'mask', black_url: blackUrl, railway_mask_id: md.job_id });
          return res.status(200).json({ ...job, status: 'processing', stage: 'mask', progress: 45 });
        }
        return res.status(200).json({ ...job, status: 'processing', stage: 'detect', progress: Math.min(30, 15 + (pred.logs || '').split('\n').length) });
      }

      // ── ESTÁGIO 2: MÁSCARA (Railway) ────────────────────────────────────
      if (stage === 'mask' && job.railway_mask_id && RW) {
        const sr = await fetch(RW.replace(/\/$/, '') + '/status/' + job.railway_mask_id);
        const sd = sr.ok ? await sr.json() : null;
        if (sd?.status === 'error') return fail('Máscara falhou: ' + (sd.error || ''));
        if (sd?.status === 'done' && sd.mask_url) {
          const fillId = await startReplicate(REPLICATE, 'jd7h/propainter', { video: job.input_url, mask: sd.mask_url, fp16: true, mask_dilation: 4 });
          if (!fillId) return fail('Falha ao iniciar preenchimento.');
          await patch({ stage: 'fill', mask_url: sd.mask_url, replicate_id: fillId });
          return res.status(200).json({ ...job, status: 'processing', stage: 'fill', progress: 60 });
        }
        return res.status(200).json({ ...job, status: 'processing', stage: 'mask', progress: 50 });
      }

      // ── ESTÁGIO 3: PREENCHIMENTO (ProPainter) ───────────────────────────
      if (stage === 'fill' && job.replicate_id) {
        const pred = await checkPred(job.replicate_id);
        if (!pred) return res.status(200).json({ ...job, status: 'processing', progress: 70 });
        if (pred.status === 'failed') return fail('Preenchimento falhou: ' + (pred.error || ''));
        if (pred.status === 'succeeded' && pred.output) {
          const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
          await patch({ status: 'completed', output_url: out });
          return res.status(200).json({ ...job, status: 'completed', stage: 'fill', output_url: out });
        }
        return res.status(200).json({ ...job, status: 'processing', stage: 'fill', progress: Math.min(95, 60 + (pred.logs || '').split('\n').length * 2) });
      }
    } catch (e) { console.error('[blueclean:status]', e.message); }
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

    console.log('[blueclean] Start pipeline v2, user:', userEmail);

    try {
      // ── ESTÁGIO 1: DETECÇÃO — modelo em modo 'black' pinta texto+marca de
      // preto (conf baixa pra pegar marca d'água). Máscara e fill vêm depois.
      const detectId = await startReplicate(REPLICATE, 'hjunior29/video-text-remover', {
        video: video_url, method: 'black', conf_threshold: 0.08, iou_threshold: 0.15, margin: 8, resolution: 'original', detection_interval: 1,
      });
      if (!detectId) return res.status(500).json({ error: 'Falha ao iniciar detecção.' });

      // Save job (stage=detect) + increment usage
      const crypto = require('crypto');
      const jobId = crypto.randomUUID();
      await fetch(`${SU}/rest/v1/blueclean_jobs`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ id: jobId, user_id: userId, replicate_id: detectId, stage: 'detect', status: 'processing', input_url: video_url, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });

      const ex = await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}&select=count`, { headers: H });
      const exd = ex.ok ? (await ex.json())[0] : null;
      if (exd) await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ count: (exd.count || 0) + 1 }) });
      else await fetch(`${SU}/rest/v1/blueclean_usage`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ user_id: userId, month, count: 1 }) });

      return res.status(200).json({ job_id: jobId, status: 'processing', stage: 'detect' });
    } catch(e) {
      console.error('[blueclean] Error:', e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Invalid action' });
};
