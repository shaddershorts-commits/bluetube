// api/storage-admin.js — inspecao/ajuste de buckets do Storage (admin only).
// Uso: GET  ?action=info&bucket=blue-videos&admin_secret=...
//      POST ?action=set-limit&bucket=blue-videos&limit=null|524288000&admin_secret=...
module.exports = async function handler(req, res) {
  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const ADMIN = process.env.ADMIN_SECRET;
  if (!SU || !SK) return res.status(500).json({ error: 'config' });
  const secret = req.query.admin_secret || req.body?.admin_secret;
  if (!ADMIN || secret !== ADMIN) return res.status(401).json({ error: 'unauthorized' });

  const bucket = (req.query.bucket || req.body?.bucket || 'blue-videos').replace(/[^a-z0-9-]/gi, '');
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const action = req.query.action || req.body?.action;

  try {
    if (action === 'info') {
      const r = await fetch(`${SU}/storage/v1/bucket/${bucket}`, { headers: h });
      const d = await r.json();
      return res.status(r.status).json(d);
    }
    if (action === 'set-limit') {
      const raw = req.query.limit ?? req.body?.limit;
      const limit = (raw === 'null' || raw == null) ? null : parseInt(raw, 10);
      const r = await fetch(`${SU}/storage/v1/bucket/${bucket}`, {
        method: 'PUT',
        headers: h,
        body: JSON.stringify({ public: true, file_size_limit: limit }),
      });
      const d = await r.json().catch(() => ({}));
      // le de volta pra confirmar
      const r2 = await fetch(`${SU}/storage/v1/bucket/${bucket}`, { headers: h });
      const d2 = await r2.json();
      return res.status(200).json({ update_status: r.status, update_body: d, bucket_now: d2 });
    }
    return res.status(400).json({ error: 'action invalida (info | set-limit)' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
