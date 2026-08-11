// api/sala-voz.js — Sala de voz ao vivo da Comunidade (SÓ ÁUDIO, transporte LiveKit)
//
// ── POR QUE O TRANSPORTE MUDOU ──────────────────────────────────────────────
// A versão anterior era P2P mesh com sinalização por Supabase Realtime: cada
// navegador abria (N-1) RTCPeerConnection e a lista de quem estava na sala era
// montada de batimentos por broadcast. Cinco rodadas de conserto e ela nunca
// funcionou no navegador do dono. A causa raiz foi MEDIDA em bancada (11/08):
//   · o send() do SDK do Supabase MENTE — com o WebSocket morto ele escapa por
//     HTTP e devolve 'ok' (9 de 9 sondas), então ninguém conseguia inferir
//     saúde de socket dali;
//   · a lista piscava, e o código DESTRUÍA a conexão de voz de quem sumia da
//     lista: 4 RTCPeerConnection numa sala de 2 pessoas (ANA=5/BRU=3 na
//     bancada; consertado 1/1);
//   · e mesmo com o conserto, no navegador do dono continuou sem áudio.
// Reconexão, renegociação, TURN e compatibilidade de navegador é EXATAMENTE a
// parte que nos derrubou — e é exatamente o que um SFU gerenciado resolve. O
// LiveKit passa a ser o transporte; o portão de plano e o teto de 10 continuam
// sendo NOSSOS, aqui neste arquivo.
//
// ── O QUE ESTE ENDPOINT FAZ ─────────────────────────────────────────────────
//   1) config  → portão de plano. Só Full/Master (ou moderador, igual
//                api/community.js:75) recebe o desenho da sala. Sem chamada
//                nenhuma ao LiveKit: é o que a página pede no load.
//   2) contar  → quantas pessoas estão na sala AGORA (e quem), pelo RoomService.
//                É o que faz o contador aparecer ANTES de entrar sem que o
//                navegador precise abrir microfone nem entrar na sala.
//   3) entrar  → assina o CRACHÁ (JWT do LiveKit) depois de checar plano, teto
//                de 10 e sessão duplicada. É a única porta de entrada da sala.
//
// ── O QUE SUMIU, E POR QUE ──────────────────────────────────────────────────
// A ação `verificar` (que resolvia tickets HMAC alheios) MORREU. Ela existia
// porque o canal broadcast era aberto: qualquer um podia anunciar o nome que
// quisesse, então nome/foto/plano tinham que voltar do servidor. No LiveKit a
// identidade JÁ VEM ASSINADA no crachá — `sub` (identity), `name` e `metadata`
// são carimbados aqui e o participante NÃO recebe `canUpdateOwnMetadata`, então
// ele não consegue reescrever quem é. O SFU entrega essa identidade pros outros
// participantes. Um ticket paralelo em cima disso seria cerimônia sem defesa.
//
// ── SEGREDO ────────────────────────────────────────────────────────────────
// LIVEKIT_API_SECRET nunca sai daqui. O navegador recebe só o crachá assinado
// (curto) e a URL wss pública do SFU.
//
// ── MEDIDO CONTRA O LIVEKIT REAL (probe de 11/08) ──────────────────────────
// O JSON do twirp desta conta volta em snake_case (`num_participants`,
// `max_participants`) e NÃO em camelCase — por isso a leitura aceita os dois,
// com o snake primeiro. ListRooms com `names` devolve {"rooms":[]} quando a
// sala não existe (não dá erro), e ListParticipants numa sala fora do grant
// `room` do crachá volta 401 "permissions denied" — crachá de participante
// comum NÃO serve pra operação de admin.

const crypto = require('node:crypto');

// ── constantes ──────────────────────────────────────────────────────────────
// ATENÇÃO: MAX_PESSOAS é ESPELHO de MAX em public/sala-voz.js. Mudou aqui, muda
// lá. O front usa o valor que vem daqui (config.max); a constante de lá é só
// fallback se a config falhar. E ele é aplicado em DOIS lugares: na contagem
// antes de assinar o crachá (abaixo) e no `max_participants` da própria sala no
// LiveKit — assim, se dois pedidos correrem juntos, quem fura o limite é
// recusado pelo SFU em vez de entrar e estourar a sala.
const MAX_PESSOAS = 10;
const SALA = 'sala-voz-comunidade';

// Crachá curto de propósito. Ele não precisa durar a conversa inteira: o
// servidor do LiveKit renova o token do cliente pela própria conexão de
// sinalização, então uma reconexão horas depois usa o token renovado, não este.
const TTL_CRACHA_S = 2 * 60 * 60;
// Crachá de admin: vive o tempo da chamada e morre.
const TTL_ADMIN_S = 60;
// Sala vazia é apagada pelo LiveKit depois disso (e recriada no próximo
// `entrar`, com o teto junto). Curto o bastante pra não deixar sala fantasma,
// longo o bastante pra alguém que caiu voltar sem a sala sumir por baixo.
const SALA_VAZIA_S = 300;
// Quem sai é removido depois disso — cobre um refresh de página sem o card da
// pessoa piscar pra todo mundo.
const PARTIDA_S = 20;
// Cache do `contar`: com a página inteira perguntando de tempos em tempos, uma
// rajada de pedidos no mesmo instante vira UMA chamada ao LiveKit.
const CACHE_CONTAR_MS = 3000;

// ── JWT do LiveKit, assinado à mão ──────────────────────────────────────────
// Sem dependência npm nova de propósito. O @livekit/server-sdk traria o
// protobuf inteiro e uma árvore de dependências pra fazer três coisas que cabem
// em 20 linhas: um HS256, um POST e um JSON. A superfície que ele resolveria
// (retry, tipos, paginação) não é usada aqui. Se um dia a gente precisar de
// webhook, egress ou ingress, aí o SDK se paga — hoje não.
const b64u = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function assinarJwt(payload, ttlSeg, key, secret) {
  const agora = Math.floor(Date.now() / 1000);
  const cab = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  // nbf com 10s de folga pra trás: relógio de lambda atrasado alguns segundos
  // faria o LiveKit recusar um crachá recém-assinado ("token not valid yet").
  const corpo = b64u(JSON.stringify(Object.assign({
    iss: key, nbf: agora - 10, exp: agora + ttlSeg,
  }, payload)));
  const sig = crypto.createHmac('sha256', secret).update(cab + '.' + corpo).digest();
  return cab + '.' + corpo + '.' + b64u(sig);
}

// Crachá de ADMIN: fala com o RoomService (contar, criar a sala com o teto).
// Nunca chega no navegador.
function crachaAdmin(key, secret) {
  return assinarJwt({
    sub: 'srv-sala-voz',
    video: { room: SALA, roomList: true, roomCreate: true, roomAdmin: true },
  }, TTL_ADMIN_S, key, secret);
}

// Crachá de PARTICIPANTE: entra na sala, publica e escuta — só isso.
//   · canPublishSources: ['microphone'] — vídeo e tela ficam para depois, e o
//     limite é do SERVIDOR: mesmo um navegador adulterado não publica câmera.
//   · canPublishData: false — não existe chat de dados aqui; o que não é usado
//     não precisa ser permitido.
//   · canUpdateOwnMetadata: false — é o que faz nome/foto/plano serem fato e
//     não boato. Era esse o trabalho do ticket HMAC da versão anterior.
function crachaParticipante(pessoa, key, secret) {
  return assinarJwt({
    sub: pessoa.id,
    name: pessoa.nome,
    metadata: JSON.stringify({ a: pessoa.avatar || '', p: pessoa.plano }),
    video: {
      room: SALA,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      canPublishSources: ['microphone'],
    },
  }, TTL_CRACHA_S, key, secret);
}

// wss://x.livekit.cloud -> https://x.livekit.cloud (o RoomService é HTTP)
function baseHttp(url) {
  return String(url || '').replace(/^ws/i, 'http').replace(/\/+$/, '');
}

// Uma chamada ao RoomService. Devolve estado em vez de estourar: LiveKit fora
// do ar tem que virar "sala indisponível agora" na tela, não 500 mudo.
async function rpc(metodo, corpo, ctx) {
  const controle = new AbortController();
  const t = setTimeout(() => controle.abort(), 6000);
  try {
    const r = await fetch(`${baseHttp(ctx.url)}/twirp/livekit.RoomService/${metodo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + crachaAdmin(ctx.key, ctx.secret) },
      body: JSON.stringify(corpo || {}),
      signal: controle.signal,
    });
    const txt = await r.text();
    let d = null;
    try { d = JSON.parse(txt); } catch (e) { d = null; }
    return { ok: r.ok, status: r.status, d: d };
  } catch (e) {
    return { ok: false, status: 0, d: null, erro: String((e && e.message) || e).slice(0, 120) };
  }
}

// O JSON desta conta volta em snake_case (medido). Aceita os dois pra não
// quebrar se a serialização do LiveKit mudar de lado um dia.
const campo = (o, snake, camel) => (o && (o[snake] != null ? o[snake] : o[camel]));

// Metadata é escrita por NÓS na assinatura do crachá; mesmo assim volta pela
// rede, então volta a passar pela limpeza antes de virar resposta.
function lerMeta(txt) {
  try {
    const m = JSON.parse(txt || '{}');
    return { avatar: fotoOk(m && m.a), plano: plano(m && m.p) };
  } catch (e) { return { avatar: null, plano: 'full' }; }
}
const plano = (p) => (p === 'mod' ? 'mod' : p === 'master' ? 'master' : 'full');

// Quem está na sala agora. `n` vem do ListRooms (barato e sempre existe) e a
// lista de nomes só é buscada quando há alguém — sala vazia não paga chamada.
async function estadoDaSala(ctx, comNomes) {
  const r = await rpc('ListRooms', { names: [SALA] }, ctx);
  if (!r.ok) return { ok: false };
  const sala = (r.d && Array.isArray(r.d.rooms) && r.d.rooms[0]) || null;
  const nLista = sala ? Number(campo(sala, 'num_participants', 'numParticipants') || 0) : 0;

  // ⚠️ NÃO confie no ListRooms pra dizer que a sala está vazia. MEDIDO na prova
  // de integração (11/08): com Ana e Bruno conversando e trocando áudio, o
  // ListRooms devolveu [] — lista vazia, até sem filtro de nome — enquanto o
  // ListParticipants na MESMA sala devolvia os dois como ACTIVE. Acontece
  // quando a sala foi apagada e recriada.
  //
  // O código voltava cedo aqui e anunciava "ninguém na sala" com gente dentro.
  // Como o contador é o que convence alguém a entrar, ele mentindo pra menos
  // esvazia a sala sozinho: quem chega vê zero e desiste.
  //
  // Agora o ListParticipants é sempre consultado. Ele é a fonte da verdade —
  // custa uma chamada a mais numa sala vazia, e vale.
  const p = await rpc('ListParticipants', { room: SALA }, ctx);
  const n = nLista;
  // Contagem boa e lista ruim não é motivo pra dizer que a sala caiu: devolve o
  // número (que é o que o contador usa) e uma lista vazia.
  if (!p.ok || !p.d || !Array.isArray(p.d.participants)) return { ok: true, n, pessoas: [], identidades: [] };

  const vivos = p.d.participants.filter((x) => {
    const e = x && x.state;
    // ACTIVE/JOINED/JOINING contam; DISCONNECTED é resto de quem já saiu.
    return e !== 'DISCONNECTED' && e !== 3;
  });
  return {
    ok: true,
    n: Math.max(n, vivos.length),
    identidades: vivos.map((x) => String(x.identity || '')),
    pessoas: vivos.map((x) => {
      const meta = lerMeta(x.metadata);
      return { nome: limpar(x.name, 32) || 'criador', avatar: meta.avatar, plano: meta.plano };
    }),
  };
}

// Nome/foto que saem daqui já vão limpos: quem consome escapa de novo no HTML,
// mas tag nenhuma deveria chegar até lá pra começo de conversa.
const limpar = (s, max) => String(s == null ? '' : s)
  .replace(/<[^>]*>/g, '')
  .replace(/[\u0000-\u001f\u007f]/g, '')   // tira caractere de controle: nome e uma linha so
  .trim().slice(0, max);
const fotoOk = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u) && u.length < 500) ? u : null;

// Cache do `contar` por instância de lambda. Não é fonte de verdade nenhuma —
// o portão que vale (teto de 10) refaz a chamada sempre, sem cache.
let cacheContar = { em: 0, dados: null };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || '';
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });

  const LK = {
    url: process.env.LIVEKIT_URL || '',
    key: process.env.LIVEKIT_API_KEY || '',
    secret: process.env.LIVEKIT_API_SECRET || '',
  };

  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const q = req.query || {};
  const b = req.body || {};
  const action = q.action || b.action;
  const token = q.token || b.token;

  // ── PORTÃO: mesmo de api/community.js (login + Full/Master, mod entra sem) ──
  // Ele vem ANTES de qualquer coisa do LiveKit de propósito: quem não é
  // assinante não recebe crachá, não descobre a URL do SFU e não gasta uma
  // chamada da nossa conta — mesmo sabendo o endereço deste endpoint.
  let userId = null, userEmail = null, paying = false, planName = null;
  if (token) {
    try {
      const ur = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK || SK, Authorization: 'Bearer ' + token } });
      if (ur.ok) {
        const u = await ur.json();
        userId = u.id; userEmail = u.email;
        const pr = await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(userEmail)}&select=plan,plan_expires_at,is_manual`, { headers: H });
        if (pr.ok) {
          const sub = (await pr.json())[0];
          if (sub && ['full', 'master'].includes(sub.plan)) {
            const valido = sub.is_manual || !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date();
            if (valido) { paying = true; planName = sub.plan; }
          }
        }
      }
    } catch (e) {}
  }
  if (!userId) return res.status(401).json({ error: 'Login necessário.', login: true });

  // Perfil da comunidade: aqui só LÊ. Quem cria é o api/community.js quando a
  // pessoa abre a Comunidade — e ela precisa abrir a Comunidade pra ver a sala.
  let profile = null;
  try {
    const pf = await fetch(`${SU}/rest/v1/community_profiles?user_id=eq.${userId}&select=display_name,avatar_url,is_moderator,banned,plan`, { headers: H });
    if (pf.ok) profile = (await pf.json())[0] || null;
  } catch (e) {}

  const isMod = !!(profile && profile.is_moderator);
  // Moderador entra sem plano — se esquecer isto, a moderação fica trancada
  // pra fora da própria sala (mesma regra de api/community.js:75).
  if (!paying && !isMod) return res.status(403).json({ error: 'A sala de voz é exclusiva de assinantes Full e Master.', upgrade: true });
  if (profile && profile.banned && !isMod) return res.status(403).json({ error: 'Você foi banido da Comunidade.', banned: true });

  const nome = limpar((profile && profile.display_name) || (userEmail || 'criador').split('@')[0], 32) || 'criador';
  const foto = fotoOk(profile && profile.avatar_url);
  const meuPlano = isMod ? 'mod' : (planName || 'full');
  const me = { id: userId, nome, avatar: foto, plano: planName, mod: isMod };

  // LiveKit sem credencial não é "erro interno": é sala fora do ar. A diferença
  // importa porque é ela que faz a entrada dizer "sala indisponível agora" em
  // vez de fingir que está tudo bem e falhar no clique.
  const semLiveKit = !LK.url || !LK.key || !LK.secret;

  try {
    // ── CONFIG: o desenho da sala. Sem tocar no LiveKit. ────────────────────
    if (action === 'config') {
      return res.status(200).json({
        ok: true,
        sala: SALA,
        max: MAX_PESSOAS,
        me,
        // O front já nasce sabendo que a sala está fora do ar, sem precisar
        // errar um clique pra descobrir.
        indisponivel: semLiveKit,
      });
    }

    // ── CONTAR: quem está na sala agora, sem entrar e sem microfone. ────────
    if (action === 'contar') {
      if (semLiveKit) return res.status(200).json({ ok: true, n: 0, pessoas: [], max: MAX_PESSOAS, indisponivel: true });
      const agora = Date.now();
      if (cacheContar.dados && agora - cacheContar.em < CACHE_CONTAR_MS) {
        return res.status(200).json(Object.assign({ ok: true, max: MAX_PESSOAS, cache: true }, cacheContar.dados));
      }
      const st = await estadoDaSala(LK, true);
      if (!st.ok) return res.status(200).json({ ok: true, n: 0, pessoas: [], max: MAX_PESSOAS, indisponivel: true });
      const dados = { n: st.n, pessoas: st.pessoas };
      cacheContar = { em: agora, dados };
      return res.status(200).json(Object.assign({ ok: true, max: MAX_PESSOAS, indisponivel: false }, dados));
    }

    // ── ENTRAR: o crachá. É aqui que o teto de 10 é cobrado. ────────────────
    if (action === 'entrar') {
      if (semLiveKit) return res.status(503).json({ error: 'A sala de voz está indisponível agora.', indisponivel: true });

      // Contagem SEM cache: o teto é decisão, não enfeite de tela.
      const st = await estadoDaSala(LK, true);
      if (!st.ok) return res.status(503).json({ error: 'A sala de voz está indisponível agora.', indisponivel: true });

      const jaEstou = st.identidades.indexOf(String(userId)) >= 0;

      // Cheio é cheio — MENOS pra quem já está lá dentro e só está reentrando
      // (aba recarregada, celular que caiu): essa pessoa já ocupa a vaga dela,
      // e recusar seria trancar alguém pra fora da própria conversa.
      if (!jaEstou && st.n >= MAX_PESSOAS) {
        return res.status(403).json({ error: 'A sala está cheia (' + MAX_PESSOAS + ' pessoas).', cheia: true, n: st.n, max: MAX_PESSOAS });
      }

      // Mesma pessoa em duas abas se ouve duas vezes e aparece duplicada. Ela
      // é BARRADA por padrão — mas não de forma definitiva: `assumir` deixa a
      // pessoa tomar a vaga de volta. Isso existe porque a sessão presa nem
      // sempre é uma aba de verdade: navegador que fechou no tranco fica ~20s
      // pendurado no SFU, e sem essa saída a pessoa levaria "você já está em
      // outra aba" olhando pra uma aba só.
      if (jaEstou && !b.assumir) {
        return res.status(409).json({ error: 'Você já está nesta sala em outra aba.', jaEstou: true });
      }

      // Garante a sala com os prazos certos. CreateRoom numa sala que já existe
      // devolve a sala existente (medido), então é seguro repetir; e falha aqui
      // não impede a entrada, porque o LiveKit cria a sala no join de qualquer
      // jeito — sala sem prazo é melhor que sala fechada.
      //
      // ⚠️ `max_participants` NÃO é um portão. MEDIDO em 11/08 contra esta conta:
      // sala criada com max_participants=2 aceitou o TERCEIRO participante — o
      // handshake passou e os três ficaram na sala. Ele vai junto porque é a
      // intenção declarada (e vale em self-hosted), mas o teto de verdade são
      // duas camadas NOSSAS: a contagem logo acima (sem cache) e, pra corrida
      // de dois pedidos no mesmo instante, o desempate no navegador — quem
      // ficou além do teto se retira sozinho (checarLotacao em
      // public/sala-voz.js), calculando a MESMA ordem em todo mundo.
      await rpc('CreateRoom', {
        name: SALA,
        max_participants: MAX_PESSOAS,
        empty_timeout: SALA_VAZIA_S,
        departure_timeout: PARTIDA_S,
      }, LK);

      const cracha = crachaParticipante({ id: userId, nome, avatar: foto, plano: meuPlano }, LK.key, LK.secret);
      return res.status(200).json({
        ok: true,
        url: LK.url,
        sala: SALA,
        token: cracha,
        max: MAX_PESSOAS,
        me,
        expira_em: Date.now() + TTL_CRACHA_S * 1000,
        n: st.n,
      });
    }

    return res.status(400).json({ error: 'Ação inválida.' });
  } catch (e) {
    return res.status(500).json({ error: 'Falha na sala de voz.', detail: String((e && e.message) || e).slice(0, 200) });
  }
};

// Superfície de diagnóstico: deixa o teste exercitar a assinatura do crachá e a
// leitura do JSON do LiveKit sem subir servidor nem falar com o Supabase. Nada
// aqui é usado pelo handler acima — é a irmã do `_interno` do front.
module.exports.__interno = {
  MAX_PESSOAS, SALA, TTL_CRACHA_S,
  assinarJwt, crachaAdmin, crachaParticipante, baseHttp, campo, lerMeta, limpar, fotoOk,
  // `rpc` e `estadoDaSala` pedem rede: eles NÃO são exercitados pelo
  // tests/unit (teste unitário que fala com a internet é teste que falha por
  // motivo errado). Ficam expostos pro smoke manual contra o LiveKit real.
  rpc, estadoDaSala,
};
