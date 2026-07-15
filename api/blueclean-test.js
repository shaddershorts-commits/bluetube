// api/blueclean-test.js — endpoint ISOLADO de teste do motor BlueClean.
// NÃO toca no BlueClean de produção. Guardado por admin_secret.
// Usa o REPLICATE_API_TOKEN que já existe no Vercel (sem expor token).
//
// POST ?action=run&admin_secret=X  body: { model, version?, input }
//   input pode conter data: URIs (Replicate aceita) — sem upload separado.
//   → cria prediction, retorna { id }
// GET  ?action=status&id=X&admin_secret=X → { status, output, error, logs }
module.exports = async function handler(req, res) {
  const ADMIN = process.env.ADMIN_SECRET;
  const REPLICATE = process.env.REPLICATE_API_TOKEN;
  const secret = req.query.admin_secret || req.body?.admin_secret;
  if (!ADMIN || secret !== ADMIN) return res.status(401).json({ error: 'unauthorized' });
  if (!REPLICATE) return res.status(500).json({ error: 'REPLICATE_API_TOKEN ausente' });
  const H = { Authorization: 'Token ' + REPLICATE, 'Content-Type': 'application/json' };
  const action = req.query.action || req.body?.action;

  try {
    if (action === 'run') {
      const { model, version, input } = req.body || {};
      if (!input) return res.status(400).json({ error: 'input obrigatório' });
      let ver = version;
      // Resolve última versão a partir do nome do modelo se version não vier
      if (!ver && model) {
        const vr = await fetch(`https://api.replicate.com/v1/models/${model}/versions`, { headers: H });
        if (vr.ok) ver = (await vr.json()).results?.[0]?.id;
      }
      if (!ver) return res.status(400).json({ error: 'não resolvi a version do modelo', model });
      const rr = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST', headers: H,
        body: JSON.stringify({ version: ver, input }),
      });
      const pred = await rr.json();
      if (!rr.ok) return res.status(rr.status).json({ error: pred.detail || 'replicate erro', pred });
      return res.status(200).json({ id: pred.id, status: pred.status });
    }

    if (action === 'status') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id obrigatório' });
      const rr = await fetch(`https://api.replicate.com/v1/predictions/${id}`, { headers: H });
      const p = await rr.json();
      return res.status(200).json({
        status: p.status, output: p.output, error: p.error,
        metrics: p.metrics, logs: (p.logs || '').slice(-500),
      });
    }

    if (action === 'cancel') {
      const id = req.query.id || req.body?.id;
      if (!id) return res.status(400).json({ error: 'id obrigatório' });
      const rr = await fetch(`https://api.replicate.com/v1/predictions/${id}/cancel`, { method: 'POST', headers: H });
      return res.status(rr.status).json(await rr.json().catch(() => ({})));
    }

    // ── UPLOAD: base64 → Supabase → URL pública (pra alimentar o pipeline) ──
    if (action === 'upload') {
      const SU = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY;
      const b64 = req.body?.b64; const name = req.body?.name || `test_${Date.now()}.mp4`;
      if (!SU || !SK) return res.status(500).json({ error: 'supabase env ausente' });
      if (!b64) return res.status(400).json({ error: 'b64 obrigatório' });
      const buf = Buffer.from(b64, 'base64');
      const objPath = `blueclean/_test/${name}`;
      const up = await fetch(`${SU}/storage/v1/object/blue-videos/${objPath}`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + SK, apikey: SK, 'Content-Type': 'video/mp4', 'x-upsert': 'true' },
        body: buf,
      });
      if (!up.ok) return res.status(502).json({ error: 'upload falhou', detail: await up.text() });
      return res.status(200).json({ url: `${SU}/storage/v1/object/public/blue-videos/${objPath}` });
    }

    // ── PROCESS: dispara o pipeline de chunking completo no Railway ─────────
    if (action === 'process') {
      const SU = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY, RW = process.env.RAILWAY_FFMPEG_URL;
      const { video_url, watermark, chunk_sec } = req.body || {};
      if (!RW) return res.status(500).json({ error: 'RAILWAY_FFMPEG_URL ausente' });
      if (!video_url) return res.status(400).json({ error: 'video_url obrigatório' });
      const outPath = `blueclean/_test/out_${Date.now()}.mp4`;
      const rr = await fetch(RW.replace(/\/$/, '') + '/blueclean-process', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_url, output_path: outPath, supabase_url: SU, supabase_key: SK, replicate_token: REPLICATE, watermark: watermark !== false, chunk_sec }),
      });
      const rd = await rr.json().catch(() => ({}));
      if (!rr.ok) return res.status(rr.status).json({ error: 'railway erro', detail: rd });
      return res.status(200).json({ job_id: rd.job_id, output_path: outPath, output_url: `${SU}/storage/v1/object/public/blue-videos/${outPath}` });
    }

    // ── POLL: status do job do Railway ──────────────────────────────────────
    if (action === 'poll') {
      const RW = process.env.RAILWAY_FFMPEG_URL;
      const id = req.query.id || req.body?.id;
      if (!RW || !id) return res.status(400).json({ error: 'RW/id obrigatório' });
      const rr = await fetch(RW.replace(/\/$/, '') + '/status/' + id);
      const d = await rr.json().catch(() => ({}));
      return res.status(rr.status).json(d);
    }

    return res.status(400).json({ error: 'action inválida (run|status|upload|process|poll)' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
