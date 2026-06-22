// api/bluelens-cookies-monitor.js — Monitor de saúde do BlueLens.
//
// Diferente do baixablue-cookies-monitor (que só testa cookies via
// /cookies-health), este testa a CHAIN COMPLETA do /extract-fingerprint
// com um vídeo conhecido pra detectar quando alguma camada quebra:
//   - Camada A (Cobalt tunnel)
//   - Camada B (chain /api/auth?action=download)
//   - Camada C (yt-dlp + cookies + POT + player_clients)
//
// Cron a cada 6h. Se TODAS as 3 camadas falharem, alerta admin via email.
// Debounce via api_cache (1 email por episódio, re-alerta após recuperação).
//
// Como o BlueLens cobra SerpAPI por análise, este monitor usa um vídeo
// público pequeno + força cache miss (?force=true não usado aqui pra economizar
// quota — só testamos o extract Railway, não o pipeline completo).

const RAILWAY_URL = process.env.RAILWAY_FFMPEG_URL || 'https://bluetube-production.up.railway.app';

// Vídeo pequeno e estável pra teste (Shorts antigo, sem age-gate, sem geo-block).
// Se mudar, atualizar TEST_VIDEO_ID.
const TEST_VIDEO_URL = 'https://www.youtube.com/shorts/BUqlzukB1Mc';

module.exports = async function handler(req, res) {
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;

  if (!ADMIN_EMAIL || !RESEND_KEY) {
    return res.status(500).json({ error: 'config_missing', need: ['ADMIN_EMAIL', 'RESEND_API_KEY'] });
  }

  let extractData = null;
  let extractStatus = 0;
  const startTs = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    const r = await fetch(RAILWAY_URL + '/extract-fingerprint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // fps=1 + max_seconds=10 = teste leve (~5-15s no melhor caso)
      body: JSON.stringify({ url: TEST_VIDEO_URL, fps: 1, max_seconds: 10 }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    extractStatus = r.status;
    extractData = await r.json().catch(() => ({}));
  } catch (e) {
    console.error('[bluelens-monitor] Railway unreachable:', e.message);
    return res.status(200).json({ ok: false, skipped: 'railway_unreachable', detail: e.message });
  }

  const allOk = extractData && extractData.ok === true && (extractData.p_hashes || []).length > 0;
  const elapsed = Date.now() - startTs;
  const source = extractData?.download_source || null;
  const attempts = extractData?.download_attempts || [];

  // Debounce via api_cache: alerta só na transição OK → broken, re-alerta na recuperação+queda
  const cacheKey = 'bluelens_chain_last_state';
  const cacheH = SU && SK ? { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' } : null;

  let prevState = null;
  if (cacheH) {
    try {
      const pr = await fetch(
        `${SU}/rest/v1/api_cache?cache_key=eq.${cacheKey}&expires_at=gt.${new Date().toISOString()}&select=value`,
        { headers: cacheH }
      );
      if (pr.ok) { const pd = await pr.json(); prevState = pd?.[0]?.value || null; }
    } catch (_) {}
  }

  const newState = { ok: allOk, source, status: extractStatus, alerted: false, at: new Date().toISOString() };
  const alreadyAlerted = prevState && prevState.alerted === true && prevState.ok === false;

  if (allOk) {
    if (prevState && prevState.ok === false) console.log('[bluelens-monitor] chain recovered');
    if (cacheH) {
      fetch(`${SU}/rest/v1/api_cache?cache_key=eq.${cacheKey}`, { method: 'DELETE', headers: cacheH }).catch(() => {});
    }
    return res.status(200).json({
      ok: true,
      status: 'chain_ok',
      source,
      elapsed_ms: elapsed,
      recovered: prevState?.ok === false,
    });
  }

  if (alreadyAlerted) {
    return res.status(200).json({ ok: false, status: 'still_broken', alerted: 'previously', attempts });
  }

  // Email alerta
  const detail = extractData?.detail || extractData?.error || `HTTP ${extractStatus}`;
  const attemptsHtml = attempts.map(a => {
    const status = a.ok ? '✅' : '❌';
    return `<li><strong>Camada ${a.layer}</strong>: ${status} ${a.reason || a.source || 'ok'}${a.size ? ` (${(a.size / 1024 / 1024).toFixed(1)}MB)` : ''}</li>`;
  }).join('');

  const subject = '🚨 BlueLens: chain de download quebrou';
  const html = `
<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:30px;background:#020817;color:#e8f4ff">
  <h1 style="color:#ff6464;font-size:22px;margin-bottom:14px">🚨 BlueLens não está extraindo fingerprints</h1>
  <p style="line-height:1.6;color:rgba(232,244,255,.8)">
    O monitor testou o /extract-fingerprint do Railway e <strong>TODAS as 3 camadas falharam</strong>.
    Significa que a análise de cópia visual do BlueLens (botão "Verificar reposts") não está funcionando.
  </p>
  <div style="background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.3);border-radius:10px;padding:14px 18px;margin:20px 0">
    <strong style="color:#22c55e">⚡ Impacto:</strong>
    <span style="color:rgba(232,244,255,.7)">BlueLens fica indisponível até alguma das camadas voltar. BaixaBlue não é afetado (sistemas separados).</span>
  </div>
  <h2 style="font-size:16px;margin-top:24px;color:#fbbf24">Detalhes das 3 camadas testadas</h2>
  <ul style="line-height:1.8;color:rgba(232,244,255,.85)">${attemptsHtml || '<li>(sem detalhes — Railway retornou sem attempts)</li>'}</ul>
  <h2 style="font-size:16px;margin-top:24px;color:#fbbf24">Como debugar (5min)</h2>
  <ol style="line-height:1.8;color:rgba(232,244,255,.85)">
    <li>Painel <code style="background:rgba(0,170,255,.1);padding:2px 6px;border-radius:4px">/admin → 📥 BaixaBlue Health</code> → verifica se Cobalt/RapidAPI estão verdes</li>
    <li>Se Cobalt vermelho: ver logs Railway service <code>cobalto</code></li>
    <li>Se Camada C (yt-dlp) bot_check: cookies expiraram → renovar <code>YOUTUBE_COOKIES</code> via Railway CLI</li>
    <li>Se erro genérico: testar manual <code>POST ${RAILWAY_URL}/extract-fingerprint</code></li>
  </ol>
  <div style="margin-top:24px;padding-top:20px;border-top:1px solid rgba(0,170,255,.1);font-size:12px;color:rgba(150,190,230,.5)">
    Detail: <code>${(detail || 'unknown').slice(0, 200)}</code><br>
    Tempo: ${elapsed}ms<br>
    Detectado em: ${new Date().toLocaleString('pt-BR')}
  </div>
</body></html>`;

  let emailSent = false;
  try {
    const er = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'monitor@bluetubeviral.com',
        to: ADMIN_EMAIL,
        subject,
        html,
      }),
    });
    emailSent = er.ok;
  } catch (e) {
    console.error('[bluelens-monitor] resend err:', e.message);
  }

  if (cacheH) {
    newState.alerted = emailSent;
    fetch(`${SU}/rest/v1/api_cache`, {
      method: 'POST',
      headers: { ...cacheH, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        cache_key: cacheKey,
        value: newState,
        expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      }),
    }).catch(() => {});
  }

  return res.status(200).json({
    ok: false,
    status: 'broken_alerted',
    source,
    attempts,
    email_sent: emailSent,
  });
};
