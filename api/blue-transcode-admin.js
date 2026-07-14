// api/blue-transcode-admin.js — orquestracao do transcode do feed (admin).
// Fix permanente da fluidez: moov no fim + arquivos 20-41MB eram a causa
// da tela preta/travadas (diagnostico 2026-07-11).
//
// Actions (admin_secret):
//   GET  ?action=list            — videos + tamanho + transcoded_at
//   GET  ?action=audit-files     — HEAD em cada arquivo; lista mortos
//   POST ?action=clean-dead      — {video_ids:[...]} oculta rows sem arquivo
//   POST ?action=process&video_id=X&backup=1 — dispara transcode no Railway
//   GET  ?action=job&job_id=X    — status do job no Railway
module.exports = async function handler(req, res) {
  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const RW = process.env.RAILWAY_FFMPEG_URL;
  const ADMIN = process.env.ADMIN_SECRET;
  const secret = req.query.admin_secret || req.body?.admin_secret;
  if (!ADMIN || secret !== ADMIN) return res.status(401).json({ error: 'unauthorized' });
  if (!SU || !SK) return res.status(500).json({ error: 'config' });
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const action = req.query.action || req.body?.action;

  const cdn = (u) => u; // storage direto (o transcode baixa da origem, nao do CDN)

  try {
    if (action === 'list') {
      // transcoded_at pode nao existir ainda (SQL pendente) — tenta com, cai sem
      let r = await fetch(
        `${SU}/rest/v1/blue_videos?status=eq.active&select=id,video_url,created_at,transcoded_at&order=created_at.desc&limit=500`,
        { headers: h }
      );
      if (!r.ok) r = await fetch(
        `${SU}/rest/v1/blue_videos?status=eq.active&select=id,video_url,created_at&order=created_at.desc&limit=500`,
        { headers: h }
      );
      const rows = r.ok ? await r.json() : [];
      return res.status(200).json({ total: rows.length, videos: rows });
    }

    if (action === 'audit-files') {
      const r = await fetch(
        `${SU}/rest/v1/blue_videos?status=eq.active&select=id,video_url&order=created_at.desc&limit=500`,
        { headers: h }
      );
      const rows = r.ok ? await r.json() : [];
      const dead = [];
      for (const v of rows) {
        if (!v.video_url) { dead.push({ id: v.id, motivo: 'sem_url' }); continue; }
        try {
          const head = await fetch(cdn(v.video_url), { method: 'HEAD' });
          if (!head.ok) dead.push({ id: v.id, motivo: 'http_' + head.status, url: v.video_url.slice(-60) });
        } catch (e) {
          dead.push({ id: v.id, motivo: 'fetch_fail' });
        }
      }
      return res.status(200).json({ checados: rows.length, mortos: dead.length, dead });
    }

    if (action === 'clean-dead') {
      const ids = req.body?.video_ids || [];
      if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'video_ids[] obrigatorio' });
      let ok = 0;
      for (const id of ids) {
        const r = await fetch(`${SU}/rest/v1/blue_videos?id=eq.${id}`, {
          method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'deleted', updated_at: new Date().toISOString() }),
        });
        if (r.ok) ok++;
      }
      return res.status(200).json({ ocultados: ok, de: ids.length });
    }

    if (action === 'process') {
      if (!RW) return res.status(503).json({ error: 'RAILWAY_FFMPEG_URL ausente' });
      const videoId = req.query.video_id || req.body?.video_id;
      if (!videoId) return res.status(400).json({ error: 'video_id obrigatorio' });
      const r = await fetch(`${SU}/rest/v1/blue_videos?id=eq.${videoId}&select=id,video_url&limit=1`, { headers: h });
      const [v] = r.ok ? await r.json() : [];
      if (!v?.video_url) return res.status(404).json({ error: 'video_nao_encontrado' });
      // storage_path a partir da URL publica
      const m = v.video_url.match(/object\/(?:public\/)?blue-videos\/([^?]+)/);
      if (!m) return res.status(400).json({ error: 'url_fora_do_bucket', url: v.video_url });
      const jr = await fetch(`${RW.replace(/\/$/, '')}/blue-transcode`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_url: v.video_url.replace('cdn.bluetubeviral.com', SU.replace('https://', '')),
          storage_path: m[1],
          video_id: v.id,
          backup: req.query.backup === '1' || req.body?.backup === true,
          supabase_url: SU, supabase_key: SK,
        }),
      });
      const jd = await jr.json().catch(() => ({}));
      return res.status(jr.status).json(jd);
    }

    if (action === 'job') {
      if (!RW) return res.status(503).json({ error: 'RAILWAY_FFMPEG_URL ausente' });
      const jobId = req.query.job_id;
      const r = await fetch(`${RW.replace(/\/$/, '')}/status/${jobId}`);
      return res.status(r.status).json(await r.json().catch(() => ({})));
    }

    return res.status(400).json({ error: 'action invalida (list|audit-files|clean-dead|process|job)' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
