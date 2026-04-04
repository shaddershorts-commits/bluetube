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
  const CALLBACK_URL = (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://www.bluetubeviral.com') + '/api/blue-render-webhook';

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
    const renderIds = [];

    for (const v of toRender) {
      const idx = v.variation_index || 1;
      const color = styleColors[v.caption_style] || '#FFFFFF';
      const hookText = v.hook_text || 'Hook';
      const ctaText = v.cta_text || 'CTA';

      // Vary position/size per variation for visual differentiation
      let hookPosition = 'bottom';
      let hookOffsetY = 0.15;
      let hookSize = 'medium';
      let ctaPosition = 'bottom';
      let ctaOffsetY = 0.08;
      let hookBackground = 'transparent';

      if (idx === 1) { hookPosition = 'bottom'; hookOffsetY = 0.15; hookSize = 'medium'; }
      else if (idx === 2) { hookPosition = 'top'; hookOffsetY = -0.15; hookSize = 'medium'; ctaPosition = 'top'; ctaOffsetY = -0.1; }
      else if (idx === 3) { hookPosition = 'bottom'; hookOffsetY = 0.12; hookSize = 'medium'; hookBackground = '#000000B3'; }
      else if (idx === 4) { hookPosition = 'center'; hookOffsetY = 0; hookSize = 'medium'; ctaPosition = 'bottom'; ctaOffsetY = 0.08; }
      else { hookPosition = 'bottom'; hookOffsetY = 0.15; hookSize = 'large'; }

      // Build Shotstack timeline using native "title" asset type
      const timeline = {
        timeline: {
          tracks: [
            {
              clips: [
                {
                  asset: {
                    type: 'title',
                    text: hookText,
                    style: 'minimal',
                    color: color,
                    size: hookSize,
                    background: hookBackground
                  },
                  start: 0,
                  length: 3,
                  position: hookPosition,
                  offset: { y: hookOffsetY }
                },
                {
                  asset: {
                    type: 'title',
                    text: ctaText,
                    style: 'minimal',
                    color: color,
                    size: 'small',
                    background: 'transparent'
                  },
                  start: 27,
                  length: 3,
                  position: ctaPosition,
                  offset: { y: ctaOffsetY }
                }
              ]
            },
            {
              clips: [
                {
                  asset: { type: 'video', src: base_video_url },
                  start: 0,
                  length: 30
                }
              ]
            }
          ]
        },
        output: {
          format: 'mp4',
          resolution: 'sd',
          size: { width: 480, height: 854 }
        },
        callback: CALLBACK_URL
      };

      console.log(`[blue-render] var#${idx} hook="${hookText.slice(0,40)}" color=${color} pos=${hookPosition}`);

      try {
        const rR = await fetch(`${SHOTSTACK_URL}/render`, {
          method: 'POST',
          headers: { 'x-api-key': SHOTSTACK_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify(timeline)
        });
        const rD = await rR.json();

        const renderId = rD.response?.id;
        console.log(`[blue-render] var#${idx} → render_id=${renderId || 'FAILED'} status=${rR.status}`);

        if (rR.ok && renderId) {
          await fetch(`${SU}/rest/v1/blue_variations?id=eq.${v.id}`, {
            method: 'PATCH',
            headers: { ...h, Prefer: 'return=minimal' },
            body: JSON.stringify({ shotstack_render_id: renderId, render_status: 'rendering' })
          });
          renderIds.push({ variation_index: idx, render_id: renderId, hook: hookText.slice(0, 50) });
          submitted++;
        } else {
          const errMsg = rD.message || rD.error || JSON.stringify(rD).slice(0, 200);
          console.error(`[blue-render] var#${idx} FAILED:`, errMsg);
          errors.push({ variation_index: idx, error: errMsg });
        }
      } catch(e) {
        console.error(`[blue-render] var#${idx} EXCEPTION:`, e.message);
        errors.push({ variation_index: idx, error: e.message });
      }
    }

    return res.status(200).json({
      success: submitted > 0,
      renders_submitted: submitted,
      render_ids: renderIds,
      callback_url: CALLBACK_URL,
      message: `${submitted} vídeo${submitted !== 1 ? 's' : ''} em renderização`,
      errors: errors.length > 0 ? errors : undefined
    });
  }

  return res.status(400).json({ error: 'Ação inválida' });
};
