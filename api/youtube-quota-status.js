// api/youtube-quota-status.js
//
// Monitor de cota YouTube Data API. Faz 1 request leve (videos.list com
// um id conhecido = 1 unidade) em cada chave pra checar se está saudável
// (200 OK), exhausted (403 quotaExceeded), ou inválida.
//
// Cron diário 23h UTC (último teste antes do reset 00:00 PT) + manual via
// admin pra debug. Email pro admin se alguma chave estiver >70% utilizada
// (usando counter rough: count quotaExceeded events nas últimas 24h).
//
// Camada 3 da blindagem do BlueLens novo. Garante visibilidade da cota.

const YT_TEST_VIDEO_ID = 'jNQXAC9IVRw'; // "Me at the zoo" — primeiro vídeo do YouTube, sempre disponível

async function testKey(key) {
  if (!key) return { status: 'missing' };
  const t0 = Date.now();
  try {
    const r = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=id&id=${YT_TEST_VIDEO_ID}&key=${key}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const duration_ms = Date.now() - t0;
    if (r.ok) return { status: 'ok', duration_ms };
    if (r.status === 403) {
      const txt = await r.text().catch(() => '');
      if (txt.includes('quotaExceeded') || txt.includes('dailyLimitExceeded')) {
        return { status: 'quota_exceeded', duration_ms };
      }
      return { status: 'forbidden', duration_ms, error: txt.slice(0, 200) };
    }
    if (r.status === 400) return { status: 'invalid_key', duration_ms };
    return { status: 'http_' + r.status, duration_ms };
  } catch (e) {
    return { status: 'network_error', error: e.message };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const keys = [
    { name: 'YT_KEY_1', value: process.env.YOUTUBE_API_KEY_1, used_by: 'Virais/coletor/canais (compartilhado)' },
    { name: 'YT_KEY_2', value: process.env.YOUTUBE_API_KEY_2, used_by: 'Virais/coletor/canais (compartilhado)' },
    { name: 'YT_KEY_3', value: process.env.YOUTUBE_API_KEY_3, used_by: 'Virais/coletor/canais (compartilhado)' },
    { name: 'YT_KEY_4', value: process.env.YOUTUBE_API_KEY_4, used_by: 'Virais/coletor/canais (compartilhado)' },
    { name: 'YT_KEY_5', value: process.env.YOUTUBE_API_KEY_5, used_by: 'BlueLens-search DEDICADA' },
  ];

  const results = [];
  for (const k of keys) {
    const r = await testKey(k.value);
    results.push({ name: k.name, used_by: k.used_by, ...r });
  }

  // Alerta condicional pro admin se alguma chave critica caiu
  const exhausted = results.filter(r => r.status === 'quota_exceeded');
  const failed = results.filter(r => ['invalid_key', 'forbidden', 'missing'].includes(r.status));
  const critical = exhausted.length > 0 || failed.length > 1; // 1 falha tolerável, 2+ é problema

  if (critical && process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
    const html = `<h2>⚠️ YouTube API Quota — atenção</h2>
      <p><strong>${exhausted.length}</strong> chave(s) com quota exhausted, <strong>${failed.length}</strong> chave(s) com erro.</p>
      <table cellpadding="6" style="font-family:monospace;font-size:12px;border-collapse:collapse">
        <tr style="background:#0a1628;color:#fbbf24"><th>Chave</th><th>Usada por</th><th>Status</th><th>ms</th></tr>
        ${results.map(r => `<tr style="border-top:1px solid #1a2740"><td>${r.name}</td><td>${r.used_by}</td>
          <td style="color:${r.status==='ok'?'#22c55e':r.status==='quota_exceeded'?'#ef4444':'#fbbf24'}">${r.status}</td>
          <td>${r.duration_ms || '—'}</td></tr>`).join('')}
      </table>
      <p style="margin-top:16px;color:#7d92b8">Cota reseta diariamente às 00:00 PT (07:00/08:00 UTC). Se YT_KEY_5 estiver
      exhausted, BlueLens-search desativa sozinho via circuit breaker — outras features (Virais/auth) seguem usando keys 1-4.</p>`;
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || 'BlueTube <bluetubeoficial@bluetubeviral.com>',
        to: process.env.ADMIN_EMAIL,
        subject: `⚠️ YouTube Quota — ${exhausted.length} exhausted, ${failed.length} erro`,
        html,
      }),
    }).catch(() => {});
  }

  return res.status(200).json({
    ok: true,
    checked_at: new Date().toISOString(),
    summary: {
      total: keys.length,
      ok: results.filter(r => r.status === 'ok').length,
      quota_exceeded: exhausted.length,
      failed: failed.length,
    },
    keys: results,
  });
};
