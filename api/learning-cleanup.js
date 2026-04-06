// api/learning-cleanup.js — Weekly cron: clean low-quality roteiro examples
// Schedule: 0 3 * * 0 (Sunday 3am)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return res.status(200).json({ ok: false, error: 'Missing env' });

  const headers = { 'apikey': SK, 'Authorization': `Bearer ${SK}`, 'Content-Type': 'application/json' };
  const results = { deleted_low_score: 0, deleted_stale: 0, kept: 0 };

  try {
    // 1. Remove consistently bad examples (score < 0.3 with 10+ votes)
    const badRes = await fetch(
      `${SU}/rest/v1/roteiro_exemplos?select=id,aprovacoes,reprovacoes&order=created_at.asc&limit=500`,
      { headers }
    );
    if (badRes.ok) {
      const all = await badRes.json();
      for (const r of all) {
        const total = (r.aprovacoes || 0) + (r.reprovacoes || 0);
        const score = total > 0 ? r.aprovacoes / total : 0;
        if (total >= 10 && score < 0.3) {
          await fetch(`${SU}/rest/v1/roteiro_exemplos?id=eq.${r.id}`, { method: 'DELETE', headers });
          results.deleted_low_score++;
        }
      }
    }

    // 2. Remove stale examples (90+ days without votes, score still 0)
    const staleDate = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    const staleRes = await fetch(
      `${SU}/rest/v1/roteiro_exemplos?updated_at=lt.${staleDate}&aprovacoes=eq.0&reprovacoes=eq.0&select=id`,
      { headers }
    );
    if (staleRes.ok) {
      const stale = await staleRes.json();
      for (const r of stale) {
        await fetch(`${SU}/rest/v1/roteiro_exemplos?id=eq.${r.id}`, { method: 'DELETE', headers });
        results.deleted_stale++;
      }
    }

    // 3. Count remaining
    const countRes = await fetch(`${SU}/rest/v1/roteiro_exemplos?select=id`, { headers });
    if (countRes.ok) { const d = await countRes.json(); results.kept = d?.length || 0; }

    // 4. Clean expired rate_limits (older than 1 hour)
    const rlDate = new Date(Date.now() - 3600 * 1000).toISOString();
    await fetch(`${SU}/rest/v1/rate_limits?window_start=lt.${rlDate}`, { method: 'DELETE', headers }).catch(() => {});

    // 5. Clean expired cache
    await fetch(`${SU}/rest/v1/api_cache?expires_at=lt.${new Date().toISOString()}`, { method: 'DELETE', headers }).catch(() => {});

    console.log('[learning-cleanup]', results);
    return res.status(200).json({ ok: true, ...results, timestamp: new Date().toISOString() });
  } catch (e) {
    console.error('[learning-cleanup] Error:', e);
    return res.status(200).json({ ok: false, error: e.message });
  }
};
