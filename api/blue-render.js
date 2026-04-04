// api/blue-render.js — Shotstack video rendering for BlueHorizon mutations
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const ANON = process.env.SUPABASE_ANON_KEY || SK;
  const SHOTSTACK_KEY = process.env.SHOTSTACK_API_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });
  if (!SHOTSTACK_KEY) return res.status(500).json({ error: 'Shotstack API key missing' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const SHOTSTACK_URL = 'https://api.shotstack.io/edit/stage';
  const CALLBACK_URL = (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://bluetubeviral.com') + '/api/blue-render-webhook';

  // Auth
  const token = req.method === 'GET' ? req.query.token : req.body?.token;
  if (!token) return res.status(401).json({ error: 'Token necessário' });
  let userId;
  try {
    const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: ANON, Authorization: 'Bearer ' + token } });
    if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
    userId = (await uR.json()).id;
  } catch(e) { return res.status(401).json({ error: 'Token inválido' }); }

  // ── GET: check render status ─────────────────────────────────────────────
  if (req.method === 'GET' && req.query.render_id) {
    try {
      const r = await fetch(`${SHOTSTACK_URL}/render/${req.query.render_id}`, {
        headers: { 'x-api-key': SHOTSTACK_KEY }
      });
      const data = await r.json();
      return res.status(200).json({
        status: data.response?.status || 'unknown',
        url: data.response?.url || null,
        id: req.query.render_id
      });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const action = req.body?.action;

  // ── POST: render_variations ──────────────────────────────────────────────
  if (action === 'render_variations') {
    const { job_id, base_video_url } = req.body;
    if (!job_id) return res.status(400).json({ error: 'job_id obrigatório' });
    if (!base_video_url) return res.status(400).json({ error: 'base_video_url obrigatório' });

    // Verify job belongs to user
    const jobR = await fetch(`${SU}/rest/v1/blue_mutation_jobs?id=eq.${job_id}&creator_id=eq.${userId}&select=id`, { headers: h });
    const jobs = jobR.ok ? await jobR.json() : [];
    if (!jobs.length) return res.status(403).json({ error: 'Job não encontrado' });

    // Fetch approved variations
    const varR = await fetch(
      `${SU}/rest/v1/blue_variations?job_id=eq.${job_id}&safety_approved=eq.true&order=variation_index.asc&select=*`,
      { headers: h }
    );
    const variations = varR.ok ? await varR.json() : [];
    if (!variations.length) return res.status(400).json({ error: 'Nenhuma variação aprovada encontrada' });

    // Process max 5 per call (Vercel timeout)
    const toRender = variations.filter(v => !v.shotstack_render_id || v.render_status === 'failed').slice(0, 5);
    if (!toRender.length) return res.status(200).json({ success: true, renders_submitted: 0, message: 'Todas as variações já estão em renderização ou prontas' });

    const styleColors = {
      white_bold: '#FFFFFF',
      yellow_bold: '#FFD700',
      cyan_clean: '#00D4FF',
      outline: '#FFFFFF',
      white_clean: '#F0F0F0'
    };

    let submitted = 0;
    const errors = [];

    for (const v of toRender) {
      const color = styleColors[v.caption_style] || '#FFFFFF';
      const textShadow = v.caption_style === 'outline'
        ? '-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 0 8px rgba(0,0,0,0.9)'
        : '2px 2px 4px rgba(0,0,0,0.8)';

      const hookHtml = `<p style="font-family:Arial,sans-serif;font-weight:bold;font-size:48px;color:${color};text-align:center;text-shadow:${textShadow};padding:0 20px;margin:0;line-height:1.2">${escHtml(v.hook_text || '')}</p>`;
      const ctaHtml = `<p style="font-family:Arial,sans-serif;font-weight:bold;font-size:40px;color:${color};text-align:center;text-shadow:${textShadow};padding:0 20px;margin:0;line-height:1.2">${escHtml(v.cta_text || '')}</p>`;

      const timeline = {
        timeline: {
          tracks: [
            {
              clips: [
                {
                  asset: { type: 'video', src: base_video_url },
                  start: 0,
                  length: 30
                }
              ]
            },
            {
              clips: [
                {
                  asset: { type: 'html', html: hookHtml, width: 1080, height: 300 },
                  start: 0,
                  length: 3,
                  position: 'bottom',
                  offset: { y: 0.15 }
                },
                {
                  asset: { type: 'html', html: ctaHtml, width: 1080, height: 200 },
                  start: 27,
                  length: 3,
                  position: 'bottom',
                  offset: { y: 0.1 }
                }
              ]
            }
          ]
        },
        output: {
          format: 'mp4',
          resolution: 'sd',
          aspectRatio: '9:16'
        },
        callback: CALLBACK_URL
      };

      try {
        const rR = await fetch(`${SHOTSTACK_URL}/render`, {
          method: 'POST',
          headers: { 'x-api-key': SHOTSTACK_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify(timeline)
        });
        const rD = await rR.json();

        if (rR.ok && rD.response?.id) {
          // Save render_id to variation
          await fetch(`${SU}/rest/v1/blue_variations?id=eq.${v.id}`, {
            method: 'PATCH',
            headers: { ...h, Prefer: 'return=minimal' },
            body: JSON.stringify({
              shotstack_render_id: rD.response.id,
              render_status: 'rendering'
            })
          });
          submitted++;
        } else {
          console.error('Shotstack render error:', JSON.stringify(rD).slice(0, 300));
          errors.push({ variation_id: v.id, error: rD.message || rD.error || 'Render failed' });
        }
      } catch(e) {
        console.error('Shotstack fetch error:', e.message);
        errors.push({ variation_id: v.id, error: e.message });
      }
    }

    return res.status(200).json({
      success: submitted > 0,
      renders_submitted: submitted,
      message: `${submitted} vídeo${submitted !== 1 ? 's' : ''} em renderização`,
      errors: errors.length > 0 ? errors : undefined
    });
  }

  return res.status(400).json({ error: 'Ação inválida' });
};

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
