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

// O dono pediu explicitamente TODOS os Shorts do canal ("colei um canal com 76
// e só pegou 60"). O teto vira só uma rede contra canal gigante virar job
// infinito — não um corte que o usuário sente no dia a dia.
const TETO_SHORTS = 1000;

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
  // ⚠️ channel_url NÃO pode ser exigido aqui: o action=link manda só o id.
  // Exigir antes do desvio fazia TODO download morrer em 400 (bug de 03/08,
  // pego no primeiro teste real do dono — 60 de 60 falharam).

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

  // ── action=link: pede ao Cobalt o link HD de UM Short ───────────────────
  // O motor é o nosso Cobalt self-hosted (grátis, sem cookie). Ele fica AQUI
  // na Vercel porque é aqui que vivem COBALT_API_URL/KEY — e assim o container
  // compartilhado do Railway nunca vê um byte de mídia: o navegador baixa
  // direto do Cobalt (o túnel manda access-control-allow-origin: *).
  if (String(src.action || '') === 'link') {
    // Aceita a URL completa (multi-plataforma) ou, por compatibilidade, o id de
    // 11 chars do YouTube. No TikTok o id sozinho NÃO basta: o link carrega o
    // @perfil, por isso a listagem devolve a url pronta de cada item.
    const urlBruta = String(src.url || '').trim();
    const id = String(src.id || '').trim();
    let alvoUrl = null, rede = null;

    if (urlBruta) {
      const ok = urlBruta.match(/^https:\/\/(?:www\.)?(youtube\.com|youtu\.be|tiktok\.com|instagram\.com)\//i);
      if (!ok) return res.status(400).json({ error: 'url_invalida' });
      alvoUrl = urlBruta;
      rede = /tiktok/i.test(ok[1]) ? 'tiktok' : /instagram/i.test(ok[1]) ? 'instagram' : 'youtube';
    } else if (/^[\w-]{11}$/.test(id)) {
      alvoUrl = `https://www.youtube.com/shorts/${id}`;
      rede = 'youtube';
    } else {
      return res.status(400).json({ error: 'id_invalido' });
    }

    const COBALT = (process.env.COBALT_API_URL || '').replace(/\/$/, '');
    if (!COBALT) return res.status(503).json({ error: 'motor_indisponivel' });
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (process.env.COBALT_API_KEY) headers.Authorization = 'Api-Key ' + process.env.COBALT_API_KEY;

    // CODEC POR REDE (medido em 03/08, não chutado):
    //  YouTube  → h264 já entrega 1080x1920
    //  TikTok   → h264 entrega só 576x1024; com H265 sobe pra 1080x1920
    //  Instagram→ 720x1280 é o teto da plataforma (h265 não muda nada)
    const tentativas = rede === 'tiktok'
      ? [{ videoQuality: 'max', allowH265: true }, { videoQuality: 'max' }, { videoQuality: '720' }]
      : [{ videoQuality: '1080', youtubeVideoCodec: 'h264' }, { videoQuality: '720', youtubeVideoCodec: 'h264' }];

    let ultimo = null;
    for (const extra of tentativas) {
      try {
        const r = await fetch(COBALT + '/', {
          method: 'POST', headers,
          body: JSON.stringify({ url: alvoUrl, filenameStyle: 'basic', ...extra }),
          signal: AbortSignal.timeout(60000),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.url) {
          return res.status(200).json({
            url: d.url, filename: d.filename || '',
            qualidade: extra.videoQuality, rede,
          });
        }
        ultimo = d?.error?.code || d?.status || `http_${r.status}`;
      } catch (e) { ultimo = e.message; }
    }
    console.error('[baixatudo/link]', rede, alvoUrl.slice(0, 60), String(ultimo).slice(0, 140));
    return res.status(502).json({ error: 'motor_falhou', detail: 'Não consegui esse vídeo agora. Os outros seguem normal.' });
  }

  // ── action=listar (padrão): a partir daqui o link do canal é obrigatório
  if (!channelUrl) return res.status(400).json({ error: 'channel_url_obrigatorio' });

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
