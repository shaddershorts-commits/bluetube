// api/baixatudo.js — BaixaTudo: lista os Shorts de um canal do YouTube
// ===========================================================================
// Feature ISOLADA (2026-08-03). Não toca em nenhum caminho de download que já
// existe: o BaixaBlue normal continua indo pro /youtube-process (com as 4
// camadas BlueMetadata). Aqui é o oposto — zero descaracterização, o objetivo
// é VELOCIDADE + QUALIDADE.
//
// Divisão de trabalho (mesma da BaixaBlue de hoje):
//   - LISTAR passa por aqui: valida plano no SERVIDOR (console não burla) e
//     esconde a URL do Railway.
//   - BAIXAR o vídeo o front pede direto ao Railway (/baixatudo-video), igual
//     o /youtube-process já faz. Passar GBs por função serverless seria lento
//     e caro — o Railway já serve arquivo, é o lugar certo.
//
// GET/POST /api/baixatudo?action=listar
//   body/query: { token, channel_url, limite? }
//   → { canal, total, shorts: [{ id, titulo, duracao, views, thumb }] }

const RAILWAY = (process.env.RAILWAY_FFMPEG_URL || 'https://bluetube-production.up.railway.app').replace(/\/$/, '');
const SU = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_KEY;

const TETO_SHORTS = 60; // teto duro: canal com 800 shorts não vira job infinito

// Mesma regra dos outros portões da casa: is_manual (eterno) OU dentro da
// validade. Plano vencido conta como free.
function planoEfetivo(sub) {
  if (!sub || !sub.plan || sub.plan === 'free') return 'free';
  const manual = sub.is_manual === true;
  const naoVenceu = !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date();
  return (manual || naoVenceu) ? sub.plan : 'free';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const token = src.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const channelUrl = String(src.channel_url || '').trim();

  if (!token) return res.status(401).json({ error: 'login_obrigatorio' });
  if (!channelUrl) return res.status(400).json({ error: 'channel_url_obrigatorio' });

  // ── portão: BaixaBlue é Master (o front redireciona, mas o servidor decide)
  let email = null;
  try {
    const u = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
    if (u.ok) email = (await u.json())?.email || null;
  } catch (e) {}
  if (!email) return res.status(401).json({ error: 'token_invalido' });

  let plano = 'free';
  try {
    const s = await fetch(
      `${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=plan,plan_expires_at,is_manual&limit=1`,
      { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } }
    );
    if (s.ok) plano = planoEfetivo((await s.json())[0]);
  } catch (e) {
    return res.status(500).json({ error: 'auth_check_failed' });
  }
  if (plano !== 'master') {
    return res.status(403).json({ error: 'plano_master_necessario', current_plan: plano });
  }

  const limite = Math.min(parseInt(src.limite, 10) || TETO_SHORTS, TETO_SHORTS);

  try {
    const r = await fetch(`${RAILWAY}/baixatudo-list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_url: channelUrl, limite }),
      signal: AbortSignal.timeout(60000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Erros do Railway já vêm com mensagem amigável — repassa sem vazar stack
      return res.status(r.status).json({ error: d.error || 'list_failed', detail: d.detail || null });
    }
    return res.status(200).json({
      ...d,
      // o front baixa direto do Railway (arquivo grande não passa por serverless)
      base_download: `${RAILWAY}/baixatudo-video`,
    });
  } catch (e) {
    console.error('[baixatudo]', e.message);
    const timeout = /timeout|aborted/i.test(e.message || '');
    return res.status(timeout ? 504 : 502).json({
      error: timeout ? 'timeout' : 'railway_indisponivel',
      detail: timeout ? 'O canal demorou demais pra responder. Tenta de novo.' : null,
    });
  }
};
