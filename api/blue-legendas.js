// api/blue-legendas.js — Legendas automáticas via Whisper
// CommonJS

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const OAI = process.env.OPENAI_API_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const action = req.method === 'GET' ? req.query.action : (req.body && req.body.action);

  // ── GERAR LEGENDAS PARA UM VÍDEO ───────────────────────────────────────
  if (req.method === 'POST' && action === 'gerar') {
    const { video_id } = req.body;
    if (!video_id) return res.status(400).json({ error: 'video_id obrigatório' });
    if (!OAI) return res.status(200).json({ ok: false, skip: 'OpenAI não configurado' });

    try {
      // Get video URL
      const vR = await fetch(`${SU}/rest/v1/blue_videos?id=eq.${video_id}&select=video_url,legendas_geradas`, { headers: h });
      const video = vR.ok ? (await vR.json())[0] : null;
      if (!video) return res.status(404).json({ error: 'Vídeo não encontrado' });
      if (video.legendas_geradas) return res.status(200).json({ ok: true, skip: 'Legendas já geradas' });

      // Download video audio
      const videoResp = await fetch(video.video_url);
      if (!videoResp.ok) return res.status(200).json({ ok: false, skip: 'Erro ao baixar vídeo' });
      const videoBuffer = Buffer.from(await videoResp.arrayBuffer());

      // Call Whisper API
      const FormData = require('form-data') || null;
      // Use multipart manually since we may not have form-data
      const boundary = '----BlueWhisper' + Date.now();
      const parts = [];
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.mp4"\r\nContent-Type: video/mp4\r\n\r\n`);
      parts.push(videoBuffer);
      parts.push(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1`);
      parts.push(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json`);
      parts.push(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nsegment`);
      parts.push(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\npt`);
      parts.push(`\r\n--${boundary}--\r\n`);

      const body = Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p) : p));

      const wR = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + OAI,
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
        },
        body
      });

      if (!wR.ok) {
        const err = await wR.text();
        console.error('Whisper error:', err);
        return res.status(200).json({ ok: false, skip: 'Whisper error' });
      }

      const whisper = await wR.json();
      const segments = whisper.segments || [];
      const fullText = whisper.text || '';

      // Convert to WebVTT
      let vtt = 'WEBVTT\n\n';
      segments.forEach((seg, i) => {
        const start = formatTime(seg.start);
        const end = formatTime(seg.end);
        vtt += `${i + 1}\n${start} --> ${end}\n${seg.text.trim()}\n\n`;
      });

      // Upload VTT to Supabase Storage
      const vttPath = `legendas/${video_id}/legendas_pt.vtt`;
      const upR = await fetch(`${SU}/storage/v1/object/blue-videos/${vttPath}`, {
        method: 'POST',
        headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'text/vtt', 'x-upsert': 'true' },
        body: vtt
      });

      const legendasUrl = upR.ok ? `${SU}/storage/v1/object/public/blue-videos/${vttPath}` : null;

      // Update video
      await fetch(`${SU}/rest/v1/blue_videos?id=eq.${video_id}`, {
        method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          legendas_url: legendasUrl,
          legendas_geradas: true,
          transcricao: fullText.slice(0, 5000)
        })
      });

      console.log('📝 Legendas geradas:', video_id, segments.length, 'segmentos');
      return res.status(200).json({ ok: true, legendas_url: legendasUrl, segmentos: segments.length });
    } catch(e) {
      console.error('Legendas error:', e.message);
      return res.status(200).json({ ok: false, error: e.message });
    }
  }

  // ── PROCESSAR FILA (cron) ───────────────────────────────────────────────
  if (action === 'processar-fila') {
    if (!OAI) return res.status(200).json({ ok: true, skip: 'OpenAI não configurado' });
    try {
      const SITE = process.env.SITE_URL || 'https://bluetubeviral.com';
      const vR = await fetch(`${SU}/rest/v1/blue_videos?legendas_geradas=eq.false&status=eq.active&video_url=neq.null&order=created_at.desc&limit=5&select=id`, { headers: h });
      const videos = vR.ok ? await vR.json() : [];
      let processed = 0;
      for (const v of videos) {
        try {
          await fetch(`${SITE}/api/blue-legendas`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'gerar', video_id: v.id })
          });
          processed++;
        } catch(e) { console.error('Fila legendas error:', v.id, e.message); }
      }
      return res.status(200).json({ ok: true, processados: processed, total: videos.length });
    } catch(e) { return res.status(200).json({ ok: false, error: e.message }); }
  }

  return res.status(404).json({ error: 'Action não encontrada' });
};

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
}