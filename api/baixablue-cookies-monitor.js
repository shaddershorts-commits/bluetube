// api/baixablue-cookies-monitor.js — Monitor de saúde dos cookies do BaixaBlue.
//
// Cron a cada 4h chama Railway /cookies-health (fast yt-dlp metadata check).
// Quando detecta cookies expirados ('bot_check'), envia email pro admin com
// instruções de como renovar. Debounce via api_cache pra não spammar (1 email
// por episódio, re-alerta só quando voltar a falhar depois de recuperar).
//
// 100% pipeline:
//   Cron Vercel → este endpoint → Railway /cookies-health → email se quebrar
//
// NÃO bloqueia BaixaBlue se cookies expirarem — só notifica. O sistema
// continua funcionando via Cobalt pra ~60% dos vídeos.

module.exports = async function handler(req, res) {
  const RAILWAY_URL = process.env.RAILWAY_FFMPEG_URL || 'https://bluetube-production.up.railway.app';
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;

  if (!ADMIN_EMAIL || !RESEND_KEY) {
    return res.status(500).json({ error: 'config_missing', need: ['ADMIN_EMAIL', 'RESEND_API_KEY'] });
  }

  let healthData = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    const r = await fetch(RAILWAY_URL + '/cookies-health', { signal: ctrl.signal });
    clearTimeout(timer);
    healthData = await r.json();
  } catch (e) {
    // Railway down — não é problema de cookies; só loga e sai
    console.error('[cookies-monitor] Railway unreachable:', e.message);
    return res.status(200).json({ ok: false, skipped: 'railway_unreachable', detail: e.message });
  }

  const cookiesOk = healthData && healthData.ok === true;
  const reason = healthData && healthData.reason;

  // Debounce via api_cache: alerta só na transição OK → broken, e re-alerta
  // quando recupera + quebra de novo. Não spamma em quebra prolongada.
  const cacheKey = 'baixablue_cookies_last_state';
  const cacheH = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  let prevState = null;
  try {
    const pr = await fetch(`${SU}/rest/v1/api_cache?cache_key=eq.${cacheKey}&expires_at=gt.${new Date().toISOString()}&select=value`, { headers: cacheH });
    if (pr.ok) { const pd = await pr.json(); prevState = pd?.[0]?.value || null; }
  } catch (e) {}

  // Salva estado atual (TTL 7 dias — episódios longos)
  const newState = { ok: cookiesOk, reason: reason || null, alerted: false, at: new Date().toISOString() };
  const alreadyAlerted = prevState && prevState.alerted === true && prevState.ok === false;

  if (cookiesOk) {
    // Voltou ao normal — limpa estado pra próxima quebra alertar de novo
    if (prevState && prevState.ok === false) {
      console.log('[cookies-monitor] cookies recuperaram');
    }
    if (SU && SK) {
      fetch(`${SU}/rest/v1/api_cache?cache_key=eq.${cacheKey}`, { method: 'DELETE', headers: cacheH }).catch(() => {});
    }
    return res.status(200).json({ ok: true, status: 'cookies_ok', recovered: prevState?.ok === false });
  }

  // Cookies quebrados — alerta se ainda não alertou neste episódio
  if (alreadyAlerted) {
    return res.status(200).json({ ok: false, status: 'still_broken', alerted: 'previously', reason });
  }

  // Envia email
  const subject = '🚨 BaixaBlue: cookies do YouTube expiraram';
  const html = `
<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:30px;background:#020817;color:#e8f4ff">
  <h1 style="color:#ff6464;font-size:22px;margin-bottom:14px">🚨 Cookies do BaixaBlue expiraram</h1>
  <p style="line-height:1.6;color:rgba(232,244,255,.8)">
    O monitor detectou que os cookies do YouTube no Railway não estão mais válidos.
    YouTube está rejeitando com "Sign in to confirm you're not a bot".
  </p>
  <div style="background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.3);border-radius:10px;padding:14px 18px;margin:20px 0">
    <strong style="color:#22c55e">⚡ Impacto:</strong>
    <span style="color:rgba(232,244,255,.7)">BaixaBlue continua funcionando pra ~60% dos vídeos via Cobalt. Os outros 40% (Shorts com anti-bot agressivo) vão falhar até você renovar.</span>
  </div>
  <h2 style="font-size:16px;margin-top:24px;color:#fbbf24">Como renovar (5 min)</h2>
  <ol style="line-height:1.8;color:rgba(232,244,255,.85)">
    <li>Abra <a href="https://youtube.com" style="color:#00aaff">youtube.com</a> logado (de preferência conta descartável)</li>
    <li>Use a extensão <strong>"Get cookies.txt LOCALLY"</strong> → Export As Netscape</li>
    <li>Abre o cookies.txt no Notepad → Ctrl+A → Ctrl+C</li>
    <li>Railway → projeto bluetube → Variables → <code style="background:rgba(0,170,255,.1);padding:2px 6px;border-radius:4px">YOUTUBE_COOKIES</code> → cola novo conteúdo</li>
    <li>Railway redeploy automático em 2-3 min</li>
  </ol>
  <div style="margin-top:24px;padding-top:20px;border-top:1px solid rgba(0,170,255,.1);font-size:12px;color:rgba(150,190,230,.5)">
    Detalhe técnico: <code>${(reason || 'unknown').slice(0, 100)}</code><br>
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
    console.error('[cookies-monitor] resend err:', e.message);
  }

  // Marca estado como alertado pra não enviar de novo até recuperar
  if (SU && SK) {
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
    reason,
    email_sent: emailSent,
  });
};
