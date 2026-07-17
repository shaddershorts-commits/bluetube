// api/blueclean.js — BlueClean v2: remoção de texto/marca-dágua com chunking.
// Master only. O pipeline pesado roda 100% no Railway (/blueclean-process):
// divide o vídeo em trechos curtos, e em cada um faz detecção de texto →
// máscara blend-diff PTS-aligned + faixa da marca d'água → preenchimento deep
// (ProPainter) → reconcatena + recola áudio. Aqui é só orquestração fina:
// START dispara o job único no Railway; STATUS faz proxy do progresso.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  const REPLICATE = process.env.REPLICATE_API_TOKEN;
  const RW = process.env.RAILWAY_FFMPEG_URL;
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
    } catch (e) {}
  }
  if (!userId) return res.status(401).json({ error: 'Login necessário.' });
  if (userPlan !== 'master') return res.status(403).json({ error: 'BlueClean é exclusivo do plano Master.', upgrade: true });

  const month = new Date().toISOString().slice(0, 7);
  const LIMIT = 999999; // Ilimitado para Master

  const getUsed = async () => {
    const ur = await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}&select=count`, { headers: H });
    return ur.ok ? ((await ur.json())[0]?.count || 0) : 0;
  };
  const incUsage = async () => {
    const ex = await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}&select=count`, { headers: H });
    const exd = ex.ok ? (await ex.json())[0] : null;
    if (exd) await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ count: (exd.count || 0) + 1 }) });
    else await fetch(`${SU}/rest/v1/blueclean_usage`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ user_id: userId, month, count: 1 }) });
  };
  const refundUsage = async () => {
    const c = await getUsed();
    if (c > 0) await fetch(`${SU}/rest/v1/blueclean_usage?user_id=eq.${userId}&month=eq.${month}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ count: c - 1 }) });
  };

  // ── GET-UPLOAD-URL: signed URL for direct upload to Storage ────────────────
  if (action === 'get-upload-url') {
    const ts = Date.now();
    const filename = req.body?.filename || 'input.mp4';
    const ext = filename.split('.').pop() || 'mp4';
    const vPath = `blueclean/${userId}/${ts}/input.${ext}`;
    return res.status(200).json({
      supabase_url: SU,
      service_key: SK, // service key for upload — only exposed to authenticated Master users
      video_path: vPath,
      video_public_url: `${SU}/storage/v1/object/public/blue-videos/${vPath}`,
    });
  }

  // ── USAGE ──────────────────────────────────────────────────────────────────
  if (action === 'usage') {
    const used = await getUsed();
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
    if (job.status !== 'processing' || !RW || !job.railway_id) return res.status(200).json(job);

    const patch = (obj) => fetch(`${SU}/rest/v1/blueclean_jobs?id=eq.${jobId}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ ...obj, updated_at: new Date().toISOString() }),
    });
    const fail = async (msg) => {
      await patch({ status: 'failed', error_message: msg });
      await refundUsage();
      return res.status(200).json({ ...job, status: 'failed', error_message: msg });
    };

    try {
      const sr = await fetch(RW.replace(/\/$/, '') + '/status/' + job.railway_id);
      if (sr.status === 404) return fail('Processamento expirou (serviço reiniciou). Tente de novo.');
      const sd = sr.ok ? await sr.json() : null;
      if (!sd) return res.status(200).json({ ...job, status: 'processing', progress: job.progress || 10 });
      if (sd.status === 'error') return fail('Limpeza falhou: ' + (sd.error || ''));
      if (sd.status === 'done' && sd.output_url) {
        await patch({ status: 'completed', output_url: sd.output_url });
        return res.status(200).json({ ...job, status: 'completed', output_url: sd.output_url });
      }
      return res.status(200).json({ ...job, status: 'processing', progress: sd.progress || 10, stage: sd.stage || 'processando' });
    } catch (e) { console.error('[blueclean:status]', e.message); }
    return res.status(200).json(job);
  }

  // ── START ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'start') {
    if (!REPLICATE) return res.status(500).json({ error: 'Replicate não configurado.' });
    if (!RW) return res.status(500).json({ error: 'Railway não configurado.' });

    const { video_url, boxes } = req.body;
    const engine = req.body.engine === 'guided' ? 'guided' : undefined;
    if (!video_url) return res.status(400).json({ error: 'video_url obrigatório' });
    if (engine === 'guided' && !(Array.isArray(boxes) && boxes.length)) {
      return res.status(400).json({ error: 'Marque pelo menos uma área pra remover.' });
    }

    const used = await getUsed();
    if (used >= LIMIT) return res.status(429).json({ error: `Limite atingido (${LIMIT}/${LIMIT}).` });

    console.log('[blueclean] Start pipeline v2 (chunking+boxes), user:', userEmail, 'boxes:', Array.isArray(boxes) ? boxes.length : 0);

    try {
      const outPath = `blueclean/${userId}/${Date.now()}/clean.mp4`;
      const rr = await fetch(RW.replace(/\/$/, '') + '/blueclean-process', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_url, output_path: outPath, supabase_url: SU, supabase_key: SK,
          replicate_token: REPLICATE, boxes: Array.isArray(boxes) ? boxes : [],
          ...(engine ? { engine } : {}),
        }),
      });
      const rd = await rr.json().catch(() => ({}));
      if (!rr.ok || !rd.job_id) return res.status(502).json({ error: 'Falha ao iniciar processamento.' });

      const crypto = require('crypto');
      const jobId = crypto.randomUUID();
      await fetch(`${SU}/rest/v1/blueclean_jobs`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ id: jobId, user_id: userId, railway_id: rd.job_id, stage: 'processing', status: 'processing', input_url: video_url, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
      await incUsage();

      return res.status(200).json({ job_id: jobId, status: 'processing' });
    } catch (e) {
      console.error('[blueclean] Error:', e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Invalid action' });
};
