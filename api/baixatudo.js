// api/baixatudo.js — BaixaTudo: lista e entrega o perfil inteiro
// ===========================================================================
// YouTube (Shorts) e TikTok. Feature ISOLADA: não usa NADA do BaixaBlue e o
// BaixaBlue não usa nada daqui — nem código, nem cookie, nem motor.
//
// Divisão de trabalho:
//   LISTAR  → Railway /baixatudo-list (yt-dlp, só metadata; fila+cache lá)
//   LINK    → aqui, falando com a cadeia de motores Cobalt/TikWM
//   BAIXAR  → o NAVEGADOR, direto do túnel. Nenhum byte de mídia passa pelo
//             nosso servidor, então lote pesado não rouba banda de ninguém.
//
// Ações: ?action=listar { channel_url } · ?action=link { url } · ?action=health

const RAILWAY =  (process.env.RAILWAY_FFMPEG_URL || 'https://bluetube-production.up.railway.app').replace(/\/$/, '');
const SU = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_KEY;

// O dono pediu explicitamente TODOS os Shorts do canal ("colei um canal com 76
// e só pegou 60"). O teto vira só uma rede contra canal gigante virar job
// infinito — não um corte que o usuário sente no dia a dia.
const TETO_SHORTS = 1000;

// ── CADEIA DE MOTORES (Fase 2) ─────────────────────────────────────────────
// Ordem de preferência. O primeiro que responder, ganha.
//  1. Cobalt DEDICADO ao BaixaTudo (COBALT_BAIXATUDO_URL) — isolamento real
//  2. Cobalt reserva do BaixaTudo (COBALT_BAIXATUDO_URL_2), se existir
//  3. Cobalt compartilhado — SÓ enquanto o dedicado não existir. É uma ponte
//     de transição: assim que o dedicado for configurado, este nunca é tocado
//     (senão o BaixaTudo estaria usando infra do BaixaBlue, o que é proibido).
//  4. TikWM — só TikTok, grátis e independente de tudo.
function motoresDisponiveis(rede) {
  const lista = [];
  const dedicado = (process.env.COBALT_BAIXATUDO_URL || '').replace(/\/$/, '');
  const reserva = (process.env.COBALT_BAIXATUDO_URL_2 || '').replace(/\/$/, '');
  const compartilhado = (process.env.COBALT_API_URL || '').replace(/\/$/, '');

  if (dedicado) lista.push({ tipo: 'cobalt', nome: 'cobalt_dedicado', url: dedicado, chave: process.env.COBALT_BAIXATUDO_KEY || '' });
  if (reserva) lista.push({ tipo: 'cobalt', nome: 'cobalt_reserva', url: reserva, chave: process.env.COBALT_BAIXATUDO_KEY_2 || '' });
  // ponte: só entra se NÃO houver motor próprio
  if (!dedicado && !reserva && compartilhado) {
    lista.push({ tipo: 'cobalt', nome: 'cobalt_compartilhado', url: compartilhado, chave: process.env.COBALT_API_KEY || '' });
  }
  if (rede === 'tiktok') lista.push({ tipo: 'tikwm', nome: 'tikwm' });
  return lista;
}

// Chama um Cobalt. Codec por rede — medido em 03/08:
//   YouTube  h264 já dá 1080x1920
//   TikTok   h264 dá 576x1024; com H265 sobe pra 1080x1920
async function viaCobalt(motor, url, rede) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (motor.chave) headers.Authorization = 'Api-Key ' + motor.chave;
  const tentativas = rede === 'tiktok'
    ? [{ videoQuality: 'max', allowH265: true }, { videoQuality: 'max' }, { videoQuality: '720' }]
    : [{ videoQuality: '1080', youtubeVideoCodec: 'h264' }, { videoQuality: '720', youtubeVideoCodec: 'h264' }];
  let ultimo = null;
  for (const extra of tentativas) {
    const r = await fetch(motor.url + '/', {
      method: 'POST', headers,
      body: JSON.stringify({ url, filenameStyle: 'basic', ...extra }),
      signal: AbortSignal.timeout(45000),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.url) return { url: d.url, filename: d.filename || '', qualidade: extra.videoQuality };
    ultimo = d?.error?.code || d?.status || `http_${r.status}`;
    // vídeo indisponível não melhora trocando qualidade — desiste deste motor
    if (/content\.video\.(unavailable|private|age)/i.test(String(ultimo))) break;
  }
  throw new Error(motor.nome + ': ' + String(ultimo).slice(0, 90));
}

// TikWM: rede de segurança do TikTok. Grátis, sem chave, independente do
// Cobalt. Qualidade menor (576x1024 medido) — só entra se o Cobalt falhou,
// porque vídeo em qualidade menor ainda é melhor que download nenhum.
async function viaTikwm(url) {
  const r = await fetch('https://www.tikwm.com/api/?url=' + encodeURIComponent(url), {
    signal: AbortSignal.timeout(30000),
  });
  const d = await r.json().catch(() => ({}));
  const caminho = d?.data?.hdplay || d?.data?.play;
  if (!caminho) throw new Error('tikwm: sem url');
  const abs = caminho.startsWith('http') ? caminho : 'https://www.tikwm.com' + caminho;
  const titulo = (d?.data?.title || 'tiktok').toString().slice(0, 80);
  return { url: abs, filename: titulo + '.mp4', qualidade: d?.data?.hdplay ? 'hd' : 'padrao', degradado: true };
}

// ── COTA POR USUÁRIO (Fase 4) ──────────────────────────────────────────────
// Uma pessoa listando perfil atrás de perfil consome a fila do Railway e o
// castigo do YouTube cai pra todo mundo. Isto limita LISTAGENS por pessoa numa
// janela curta — o download em si não é limitado (é o navegador dela quem baixa).
// Em memória: cada instância serverless tem a sua. Não é contabilidade exata,
// é freio contra abuso — e sem depender de banco nem de nada compartilhado.
const COTA_LISTAGENS = parseInt(process.env.BAIXATUDO_COTA_LISTAGENS || '12', 10);
const COTA_JANELA_MS = parseInt(process.env.BAIXATUDO_COTA_JANELA_MS || '600000', 10); // 10 min
const usoPorEmail = new Map();

function cotaEstourada(email) {
  const agora = Date.now();
  const marcas = (usoPorEmail.get(email) || []).filter((t) => agora - t < COTA_JANELA_MS);
  if (marcas.length >= COTA_LISTAGENS) {
    usoPorEmail.set(email, marcas);
    return Math.ceil((COTA_JANELA_MS - (agora - marcas[0])) / 1000);
  }
  marcas.push(agora);
  usoPorEmail.set(email, marcas);
  if (usoPorEmail.size > 500) usoPorEmail.delete(usoPorEmail.keys().next().value); // teto de memória
  return 0;
}

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
      const ok = urlBruta.match(/^https:\/\/(?:www\.)?(youtube\.com|youtu\.be|tiktok\.com)\//i);
      if (!ok) return res.status(400).json({ error: 'url_invalida' });
      alvoUrl = urlBruta;
      rede = /tiktok/i.test(ok[1]) ? 'tiktok' : 'youtube';
    } else if (/^[\w-]{11}$/.test(id)) {
      alvoUrl = `https://www.youtube.com/shorts/${id}`;
      rede = 'youtube';
    } else {
      return res.status(400).json({ error: 'id_invalido' });
    }

    const motores = motoresDisponiveis(rede);
    if (!motores.length) return res.status(503).json({ error: 'motor_indisponivel' });

    const falhas = [];
    for (const motor of motores) {
      try {
        const r = motor.tipo === 'tikwm' ? await viaTikwm(alvoUrl) : await viaCobalt(motor, alvoUrl, rede);
        return res.status(200).json({ ...r, rede, motor: motor.nome });
      } catch (e) {
        falhas.push(String(e.message || '').slice(0, 90));
      }
    }
    console.error('[baixatudo/link]', rede, alvoUrl.slice(0, 60), '| cadeia inteira falhou:', falhas.join(' · '));
    return res.status(502).json({
      error: 'motor_falhou',
      detail: 'Não consegui esse vídeo agora. Os outros seguem normal.',
      tentados: motores.length,
    });
  }

  // ── action=health: estado da cadeia de motores (pro admin) ───────────────
  if (String(src.action || '') === 'health') {
    const motores = motoresDisponiveis('youtube');
    const dedicado = !!process.env.COBALT_BAIXATUDO_URL;
    const testes = [];
    for (const motor of motores) {
      const t0 = Date.now();
      try {
        await viaCobalt(motor, 'https://www.youtube.com/shorts/poUrVmuTt6E', 'youtube');
        testes.push({ motor: motor.nome, ok: true, ms: Date.now() - t0 });
      } catch (e) {
        testes.push({ motor: motor.nome, ok: false, ms: Date.now() - t0, erro: String(e.message).slice(0, 80) });
      }
    }
    let listagem = null;
    try {
      const r = await fetch(`${RAILWAY}/baixatudo-health?rapido=1`, { signal: AbortSignal.timeout(15000) });
      listagem = await r.json().catch(() => null);
    } catch (e) { listagem = { ok: false, erro: 'railway_inacessivel' }; }
    return res.status(200).json({
      ok: testes.some((t) => t.ok),
      isolado_do_baixablue: dedicado,
      aviso: dedicado ? null : 'Sem Cobalt dedicado: o BaixaTudo está usando o motor compartilhado com o BaixaBlue. Configure COBALT_BAIXATUDO_URL pra isolar.',
      motores: testes,
      listagem,
    });
  }

  // ── action=listar (padrão): a partir daqui o link do canal é obrigatório
  if (!channelUrl) return res.status(400).json({ error: 'channel_url_obrigatorio' });

  // cota: só a LISTAGEM é limitada (o download é o navegador da pessoa)
  const esperaCota = cotaEstourada(email);
  if (esperaCota) {
    res.setHeader('Retry-After', String(esperaCota));
    return res.status(429).json({
      error: 'cota_listagem',
      detail: `Você listou muitos perfis seguidos. Espera ${Math.ceil(esperaCota / 60)} min — isso protege a fila de todo mundo.`,
    });
  }

  const limite = Math.min(parseInt(src.limite, 10) || TETO_SHORTS, TETO_SHORTS);

  try {
    const r = await fetch(`${RAILWAY}/baixatudo-list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_url: channelUrl, limite }),
      // 260s > 240s do yt-dlp no Railway. Estava 60s: perfil grande mostrava
      // erro na tela enquanto o container seguia trabalhando à toa por 3 min.
      signal: AbortSignal.timeout(260000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Erros do Railway já vêm com mensagem amigável — repassa sem vazar stack.
      // O Retry-After (fila cheia / rede em descanso) precisa chegar no front,
      // senão ele repete na hora e piora a fila.
      const espera = r.headers.get('retry-after');
      if (espera) res.setHeader('Retry-After', espera);
      return res.status(r.status).json({ error: d.error || 'list_failed', detail: d.detail || null });
    }
    return res.status(200).json(d);
  } catch (e) {
    console.error('[baixatudo]', e.message);
    const timeout = /timeout|aborted/i.test(e.message || '');
    return res.status(timeout ? 504 : 502).json({
      error: timeout ? 'timeout' : 'railway_indisponivel',
      detail: timeout ? 'O canal demorou demais pra responder. Tenta de novo.' : null,
    });
  }
};
