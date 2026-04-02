// api/blue-interact.js — Registra interações e atualiza score do vídeo
// POST { type, video_id, user_id?, session_id, watch_duration?, completion_pct? }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  try {
    const { type, video_id, user_id, session_id, watch_duration = 0, video_duration = 0, completion_pct = 0 } = req.body || {};
    if (!type || !video_id) return res.status(400).json({ error: 'type e video_id obrigatórios' });

    const completed = completion_pct >= 80;
    const skipped   = completion_pct < 20 && watch_duration > 0;

    // Registra interação
    await fetch(`${SU}/rest/v1/blue_interactions`, {
      method: 'POST',
      headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({ type, video_id, user_id: user_id || null, session_id: session_id || null, watch_duration, video_duration, completion_pct, completed, skipped })
    });

    // Marca como visto no feed
    if ((user_id || session_id) && type === 'view') {
      await fetch(`${SU}/rest/v1/blue_feed_seen`, {
        method: 'POST',
        headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ video_id, user_id: user_id || null, session_id: session_id || null, seen_at: new Date().toISOString() })
      }).catch(() => {});
    }

    // Busca métricas atuais do vídeo
    const vR = await fetch(`${SU}/rest/v1/blue_videos?id=eq.${video_id}&select=*`, { headers: h });
    if (!vR.ok) return res.status(200).json({ ok: true });
    const vArr = await vR.json();
    const v = vArr[0];
    if (!v) return res.status(200).json({ ok: true });

    // Atualiza contadores e recalcula score
    const patch = {};

    if (type === 'view') {
      patch.views = (v.views || 0) + 1;
      patch.test_views = (v.test_views || 0) + 1;
      patch.total_watch_time = (v.total_watch_time || 0) + watch_duration;
      const totalViews = patch.views;
      patch.completion_rate = totalViews > 0
        ? ((v.completion_rate || 0) * (totalViews - 1) + (completed ? 100 : completion_pct)) / totalViews
        : completion_pct;
      patch.skip_rate = totalViews > 0
        ? ((v.skip_rate || 0) * (totalViews - 1) + (skipped ? 100 : 0)) / totalViews
        : 0;
    } else if (type === 'like')   { patch.likes = Math.max(0, (v.likes || 0) + 1); }
    else if (type === 'unlike')   { patch.likes = Math.max(0, (v.likes || 0) - 1); }
    else if (type === 'save')     { patch.saves = Math.max(0, (v.saves || 0) + 1); }
    else if (type === 'unsave')   { patch.saves = Math.max(0, (v.saves || 0) - 1); }

    // Recalcula score (0-100)
    const newLikes    = patch.likes !== undefined ? patch.likes : (v.likes || 0);
    const newSaves    = patch.saves !== undefined ? patch.saves : (v.saves || 0);
    const newViews    = patch.views !== undefined ? patch.views : (v.views || 0);
    const compRate    = patch.completion_rate !== undefined ? patch.completion_rate : (v.completion_rate || 0);
    const skipRate    = patch.skip_rate !== undefined ? patch.skip_rate : (v.skip_rate || 0);
    const engRate     = newViews > 0 ? ((newLikes * 3 + newSaves * 5) / newViews) * 100 : 0;
    const retScore    = compRate * 0.4 + (100 - skipRate) * 0.2;
    const engScore    = Math.min(100, engRate * 2);
    patch.score       = Math.min(100, Math.max(0, retScore * 0.6 + engScore * 0.4));

    // Sai da fase de teste após 30 views
    if ((v.test_views || 0) >= 30) patch.test_phase = false;

    patch.updated_at = new Date().toISOString();

    await fetch(`${SU}/rest/v1/blue_videos?id=eq.${video_id}`, {
      method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(patch)
    });

    return res.status(200).json({ ok: true, score: patch.score });
  } catch(err) {
    console.error('blue-interact error:', err.message);
    return res.status(200).json({ ok: false });
  }
};
