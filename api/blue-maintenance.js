// api/blue-maintenance.js — Auto-maintenance for Blue social network
// Cron: 0 */6 * * * (every 6 hours)
// Also handles POST {action:"report-broken"} from frontend

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
  if (!SU || !SK) return res.status(200).json({ ok: false, error: 'Missing env' });

  const H = { 'apikey': SK, 'Authorization': `Bearer ${SK}`, 'Content-Type': 'application/json' };
  const now = new Date().toISOString();

  // ── REPORT VIDEO (user report: inappropriate, spam, etc) ────────────────────
  if (req.method === 'POST' && req.body?.action === 'report-video') {
    const { video_id, reason, token } = req.body;
    if (!video_id || !reason) return res.status(400).json({ error: 'Missing fields' });
    let reporterId = null;
    if (token) {
      try {
        const AK = process.env.SUPABASE_ANON_KEY || SK;
        const ur = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
        if (ur.ok) reporterId = (await ur.json()).id;
      } catch(e) {}
    }
    try {
      await fetch(`${SU}/rest/v1/blue_reports`, {
        method: 'POST', headers: { ...H, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ video_id, reporter_id: reporterId, reason, status: 'pending', created_at: now })
      });
      // Check total reports for this video → auto under_review at 5
      const cr = await fetch(`${SU}/rest/v1/blue_reports?video_id=eq.${video_id}&select=id`, { headers: H });
      if (cr.ok) {
        const reports = await cr.json();
        if (reports.length >= 5) {
          await fetch(`${SU}/rest/v1/blue_videos?id=eq.${video_id}&status=eq.active`, {
            method: 'PATCH', headers: { ...H, 'Prefer': 'return=minimal' },
            body: JSON.stringify({ status: 'under_review' })
          });
          // Notify admin
          if (RESEND_KEY && ADMIN_EMAIL) {
            fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
              body: JSON.stringify({
                from: 'BlueTube <noreply@bluetubeviral.com>', to: [ADMIN_EMAIL],
                subject: `⚑ Vídeo com 5+ denúncias — ${video_id}`,
                html: `<div style="font-family:sans-serif;background:#0a1628;color:#e8f4ff;padding:24px;border-radius:12px"><h3 style="color:#ff7a5a">⚑ Vídeo denunciado 5+ vezes</h3><p>ID: ${video_id}</p><p>Última razão: ${reason}</p><p>Total: ${reports.length} denúncias</p><p>Status: under_review (removido do feed automaticamente)</p><a href="https://bluetubeviral.com/admin.html" style="color:#00aaff">Abrir painel admin →</a></div>`
              })
            }).catch(() => {});
          }
        }
      }
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(200).json({ ok: false, error: e.message });
    }
  }

  // ── REPORT BROKEN (from frontend) ──────────────────────────────────────────
  if (req.method === 'POST' && req.body?.action === 'report-broken') {
    const { video_id } = req.body;
    if (!video_id) return res.status(400).json({ error: 'Missing video_id' });
    try {
      // Get current broken_reports count
      const gr = await fetch(`${SU}/rest/v1/blue_videos?id=eq.${video_id}&select=broken_reports,status`, { headers: H });
      if (!gr.ok) return res.status(200).json({ ok: false });
      const gd = await gr.json();
      const vid = gd?.[0];
      if (!vid) return res.status(200).json({ ok: false, error: 'Video not found' });

      const newCount = (vid.broken_reports || 0) + 1;
      const updates = { broken_reports: newCount, last_checked_at: now };

      // Auto-mark unavailable after 3 reports
      if (newCount >= 3 && vid.status === 'active') {
        updates.status = 'unavailable';
        console.log(`[maintenance] Auto-unavailable: ${video_id} (${newCount} reports)`);
      }

      await fetch(`${SU}/rest/v1/blue_videos?id=eq.${video_id}`, {
        method: 'PATCH', headers: { ...H, 'Prefer': 'return=minimal' },
        body: JSON.stringify(updates)
      });

      return res.status(200).json({ ok: true, reports: newCount, status: updates.status || vid.status });
    } catch (e) {
      return res.status(200).json({ ok: false, error: e.message });
    }
  }

  // ── GET = Health check / Manual trigger ────────────────────────────────────
  const results = {
    checked_videos: 0, marked_unavailable: 0,
    orphan_comments: 0, orphan_interactions: 0, orphan_messages: 0,
    score_fixes: 0, duplicates: 0, comment_fixes: 0, conversation_archives: 0,
    timestamp: now
  };

  try {
    // ═══ V1: CHECK VIDEO AVAILABILITY ═══════════════════════════════════════
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

    // Fetch active videos: new (>1h, <5 views) OR old (no interaction in 7 days)
    const vidRes = await fetch(
      `${SU}/rest/v1/blue_videos?status=eq.active&select=id,video_url,thumbnail_url,views,created_at,last_checked_at&order=created_at.asc&limit=50`,
      { headers: H }
    );
    const removedVideos = [];

    if (vidRes.ok) {
      const videos = await vidRes.json();
      for (const v of videos) {
        // Skip recently checked (within 6h)
        if (v.last_checked_at && new Date(v.last_checked_at) > new Date(Date.now() - 6 * 3600 * 1000)) continue;

        // Only check: new videos (>1h, <5 views) or old ones (no recent check)
        const isNew = new Date(v.created_at) < new Date(oneHourAgo) && (v.views || 0) < 5;
        const isOld = !v.last_checked_at || new Date(v.last_checked_at) < new Date(sevenDaysAgo);
        if (!isNew && !isOld) continue;

        results.checked_videos++;
        let broken = false;

        if (v.video_url) {
          try {
            const hr = await fetch(v.video_url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
            if (hr.status === 404 || hr.status === 403) broken = true;
          } catch (e) {
            broken = true; // network error = likely removed
          }
        } else {
          broken = true; // no URL
        }

        const updates = { last_checked_at: now };
        if (broken) {
          updates.status = 'unavailable';
          results.marked_unavailable++;
          removedVideos.push({ id: v.id, url: v.video_url });
          // Check thumbnail too
          if (v.thumbnail_url) {
            try {
              const tr = await fetch(v.thumbnail_url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
              if (!tr.ok) updates.thumbnail_url = null;
            } catch (e) { updates.thumbnail_url = null; }
          }
        }

        await fetch(`${SU}/rest/v1/blue_videos?id=eq.${v.id}`, {
          method: 'PATCH', headers: { ...H, 'Prefer': 'return=minimal' },
          body: JSON.stringify(updates)
        });
      }
    }

    // ═══ V2: PROFILES WITHOUT ACTIVE VIDEOS ═════════════════════════════════
    // (lightweight — just check if any profile has 0 active videos)
    // Skipped for now — profiles remain visible regardless

    // ═══ V3: ORPHAN DATA ════════════════════════════════════════════════════
    // Get IDs of non-active videos
    const deadRes = await fetch(
      `${SU}/rest/v1/blue_videos?status=neq.active&select=id`,
      { headers: H }
    );
    if (deadRes.ok) {
      const deadIds = (await deadRes.json()).map(v => v.id);
      if (deadIds.length > 0) {
        for (const did of deadIds.slice(0, 30)) {
          // Orphan comments
          const cr = await fetch(`${SU}/rest/v1/blue_comments?video_id=eq.${did}`, { method: 'DELETE', headers: H });
          if (cr.ok) results.orphan_comments++;

          // Orphan interactions
          const ir = await fetch(`${SU}/rest/v1/blue_interactions?video_id=eq.${did}`, { method: 'DELETE', headers: H });
          if (ir.ok) results.orphan_interactions++;
        }
      }
    }

    // ═══ V4: SCORE INCONSISTENCIES ══════════════════════════════════════════
    // Negative scores → reset to 0
    const negRes = await fetch(`${SU}/rest/v1/blue_videos?score=lt.0&status=eq.active&select=id`, { headers: H });
    if (negRes.ok) {
      const negVids = await negRes.json();
      for (const v of negVids) {
        await fetch(`${SU}/rest/v1/blue_videos?id=eq.${v.id}`, {
          method: 'PATCH', headers: { ...H, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ score: 0 })
        });
        results.score_fixes++;
      }
    }

    // Test phase > 7 days with < 5 views → end test phase
    const testCutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const testRes = await fetch(
      `${SU}/rest/v1/blue_videos?test_phase=eq.true&created_at=lt.${testCutoff}&select=id,views`,
      { headers: H }
    );
    if (testRes.ok) {
      const testVids = await testRes.json();
      for (const v of testVids) {
        if ((v.views || 0) < 5) {
          await fetch(`${SU}/rest/v1/blue_videos?id=eq.${v.id}`, {
            method: 'PATCH', headers: { ...H, 'Prefer': 'return=minimal' },
            body: JSON.stringify({ test_phase: false })
          });
          results.score_fixes++;
        }
      }
    }

    // ═══ V5: DUPLICATE VIDEOS ═══════════════════════════════════════════════
    const allActiveRes = await fetch(
      `${SU}/rest/v1/blue_videos?status=eq.active&select=id,user_id,video_url,created_at&order=created_at.desc`,
      { headers: H }
    );
    if (allActiveRes.ok) {
      const allActive = await allActiveRes.json();
      const seen = new Map();
      for (const v of allActive) {
        const key = `${v.user_id}|${v.video_url}`;
        if (seen.has(key)) {
          // This is older duplicate — mark it
          await fetch(`${SU}/rest/v1/blue_videos?id=eq.${v.id}`, {
            method: 'PATCH', headers: { ...H, 'Prefer': 'return=minimal' },
            body: JSON.stringify({ status: 'duplicate' })
          });
          results.duplicates++;
        } else {
          seen.set(key, v.id);
        }
      }
    }

    // ═══ V7: PROBLEMATIC COMMENTS ═══════════════════════════════════════════
    // Empty/whitespace comments
    const emptyRes = await fetch(
      `${SU}/rest/v1/blue_comments?select=id,content&limit=200`,
      { headers: H }
    );
    if (emptyRes.ok) {
      const comments = await emptyRes.json();
      for (const c of comments) {
        if (!c.content || !c.content.trim()) {
          await fetch(`${SU}/rest/v1/blue_comments?id=eq.${c.id}`, { method: 'DELETE', headers: H });
          results.comment_fixes++;
        } else if (c.content.length > 500) {
          await fetch(`${SU}/rest/v1/blue_comments?id=eq.${c.id}`, {
            method: 'PATCH', headers: { ...H, 'Prefer': 'return=minimal' },
            body: JSON.stringify({ content: c.content.slice(0, 500) })
          });
          results.comment_fixes++;
        }
      }
    }

    // ═══ V8: CONVERSATIONS ══════════════════════════════════════════════════
    // Old unread messages → mark as read (30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    try {
      await fetch(
        `${SU}/rest/v1/blue_messages?is_read=eq.false&created_at=lt.${thirtyDaysAgo}`,
        { method: 'PATCH', headers: { ...H, 'Prefer': 'return=minimal' }, body: JSON.stringify({ is_read: true }) }
      );
    } catch (e) {}

    // ═══ NOTIFY ADMIN ═══════════════════════════════════════════════════════
    if (results.marked_unavailable > 0 && RESEND_KEY && ADMIN_EMAIL) {
      const videoList = removedVideos.map(v => `• ${v.id} — ${v.url || 'sem URL'}`).join('\n');
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
          body: JSON.stringify({
            from: 'BlueTube Monitor <noreply@bluetubeviral.com>',
            to: [ADMIN_EMAIL],
            subject: `🎬 Blue Maintenance — ${results.marked_unavailable} vídeo(s) removido(s)`,
            html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a1628;color:#e8f4ff;border-radius:16px;padding:28px;border:1px solid rgba(0,170,255,0.2)">
              <h2 style="color:#00aaff;margin:0 0 16px">🎬 Blue Maintenance</h2>
              <p><strong>${results.marked_unavailable}</strong> vídeo(s) marcado(s) como indisponível.</p>
              <p><strong>${results.checked_videos}</strong> vídeos verificados no total.</p>
              <pre style="background:rgba(0,0,0,0.3);padding:12px;border-radius:8px;font-size:12px;overflow-x:auto">${videoList}</pre>
              <p style="margin-top:16px">Outros: ${results.orphan_comments} comentários órfãos, ${results.duplicates} duplicados, ${results.score_fixes} scores corrigidos.</p>
              <p style="font-size:12px;color:rgba(150,190,230,0.4);margin-top:20px">Blue Maintenance · ${now}</p>
            </div>`
          })
        });
      } catch (e) {}
    }

    // Save last run results for admin dashboard
    try {
      await fetch(`${SU}/rest/v1/api_cache?cache_key=eq.blue_maintenance_last`, { method: 'DELETE', headers: H }).catch(() => {});
      await fetch(`${SU}/rest/v1/api_cache`, {
        method: 'POST', headers: { ...H, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          cache_key: 'blue_maintenance_last',
          value: results,
          created_at: now,
          expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
        })
      });
    } catch (e) {}

    console.log('[blue-maintenance]', results);
    return res.status(200).json({ ok: true, ...results });

  } catch (e) {
    console.error('[blue-maintenance] Error:', e);
    return res.status(200).json({ ok: false, error: e.message, ...results });
  }
};
