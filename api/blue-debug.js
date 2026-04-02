// api/blue-debug.js — Diagnóstico do Blue (remover em produção)
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return res.status(200).json({ error: 'Env vars missing: SUPABASE_URL ou SERVICE_KEY não configuradas no Vercel' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK };
  const results = {};

  // 1. Testa conexão
  try {
    const r = await fetch(`${SU}/rest/v1/blue_videos?limit=1`, { headers: h });
    results.table_exists = r.ok;
    results.table_status = r.status;
    if (r.ok) {
      const d = await r.json();
      results.sample = d;
    } else {
      results.table_error = await r.text();
    }
  } catch(e) { results.connection_error = e.message; }

  // 2. Conta total de vídeos
  try {
    const r = await fetch(`${SU}/rest/v1/blue_videos?select=id,title,video_url,status,created_at`, { headers: { ...h, Prefer: 'count=exact' } });
    results.count_status = r.status;
    const count = r.headers.get('content-range');
    results.total_videos = count;
    if (r.ok) results.all_videos = await r.json();
  } catch(e) { results.count_error = e.message; }

  // 3. Testa bucket storage
  try {
    const r = await fetch(`${SU}/storage/v1/bucket/blue-videos`, { headers: h });
    results.bucket_exists = r.ok;
    results.bucket_status = r.status;
    if (r.ok) results.bucket_info = await r.json();
    else results.bucket_error = await r.text();
  } catch(e) { results.bucket_error = e.message; }

  return res.status(200).json(results);
};
