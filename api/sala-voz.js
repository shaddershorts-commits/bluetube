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
//   4) salas / criar / sala-editar / encerrar     → as SALAS PRIVADAS.
//   5) papel / expulsar / perdoar / silenciar / guardar → o comando delas.
//
// ── SALAS PRIVADAS: O BURACO QUE ELAS TIVERAM QUE TAPAR ─────────────────────
// A sala pública acima tem UM portão, e ele roda UMA vez: ao assinar o crachá.
// Depois disso NADA tirava ninguém de dentro — MEDIDO em 11/08: não existe
// caminho de revogação, e o LiveKit renova a credencial do cliente sozinho pela
// conexão de sinalização, com validade além da nossa.
//
// Isso torna "sala com senha" uma promessa falsa se ela for feita só de senha
// na porta: quem entrou fica, e quem guardou o crachá volta com ele sem passar
// pela porta. Então a sala privada nasceu com as duas peças que faltavam:
//
//   · REMOÇÃO ATIVA — `RemoveParticipant` (uma pessoa) e `DeleteRoom` (a sala
//     inteira) do RoomService. É o único caminho que existe, e quem chama é o
//     servidor, com crachá de admin. `expulsar` e `encerrar` usam esses dois.
//   · LISTA DE EXPULSOS — em community_voice_members.expulso_ate. Remover sem
//     lembrar é enxugar gelo: a pessoa pede outro crachá e volta em 3 segundos.
//
// E a terceira peça, que é a que fecha a fresta do CRACHÁ GUARDADO: a
// VARREDURA (`varrer`). O portão olha quem PEDE pra entrar; a varredura olha
// quem ESTÁ dentro e tira quem não pode estar. Ela roda em toda entrada (a
// lista de participantes já está na mão, custo zero) e é chamada de novo pelo
// navegador de quem manda na sala a cada chegada de gente — evento que o
// LiveKit já entrega, então não custa pergunta repetida a ninguém.
//
// O que a troca de senha NÃO faz: tirar quem já está dentro. Quem está dentro
// entrou com a senha que valia; pra tirar alguém existe o expulsar, que é
// remoção de verdade. Está escrito na tela com essas palavras.
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

// ── SALAS PRIVADAS: números ────────────────────────────────────────────────
// Expulsão VENCE. Uma expulsão eterna vira lista de inimigos que o dono nunca
// lembra de limpar — e o `perdoar` existe justamente pra encurtar quando ele
// quiser. 12h cobre "sai daqui hoje" sem virar sentença.
const EXPULSAO_H = 12;
// Freio de força bruta na senha: 5 erros e a pessoa espera 10 minutos NAQUELA
// sala. Sem isto, senha de 4 dígitos cai em segundos e vira enfeite.
const SENHA_TENTATIVAS = 5;
const SENHA_CASTIGO_MIN = 10;
const TITULO_MAX = 40;
const SENHA_MIN = 4;
const SENHA_MAX = 40;
// Quantas salas privadas a lista mostra. Como cada dono só pode ter UMA sala
// aberta (índice único no banco), este teto só é alcançado com muita gente
// conversando ao mesmo tempo — e aí as com gente vêm primeiro.
const LISTA_MAX = 40;
// Espelho do BLOCKED_WORDS de api/community.js. É uma cópia curta de propósito:
// o título de sala é público pra todo assinante e o arquivo de lá não exporta
// nada. Mexeu lá em palavra que também importa aqui, mexe aqui.
const PALAVRAS_BLOQUEADAS = ['porn', 'xxx', 'nude', 'nudes', 'onlyfans', 'xvideos', 'pornhub', 'hentai', 'gore', 'suicidio'];

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

// Crachá de ADMIN: fala com o RoomService (contar, criar a sala com o teto,
// REMOVER gente, apagar a sala). Nunca chega no navegador.
//
// O `sala` é o escopo, e ele importa: MEDIDO em 11/08, ListParticipants numa
// sala fora do grant `room` do crachá volta 401 "permissions denied". Ou seja,
// um crachá de admin escapado só alcança a sala pra qual foi assinado — cada
// operação assina o dela, com 60 segundos de vida. `sala` nulo assina um crachá
// só de LISTAGEM (é o que percorre todas as salas vivas de uma vez).
function crachaAdmin(key, secret, sala) {
  const alvo = sala === undefined ? SALA : sala;
  const video = { roomList: true, roomCreate: true, roomAdmin: true };
  if (alvo) video.room = alvo;
  return assinarJwt({ sub: 'srv-sala-voz', video: video }, TTL_ADMIN_S, key, secret);
}

// ── SENHA DE SALA ───────────────────────────────────────────────────────────
// scrypt com sal por sala. A senha em texto NUNCA toca o banco — não é
// paranoia de manual: a senha que a pessoa escolhe aqui costuma ser a que ela
// usa em outro lugar, e um dump desta tabela não pode virar isso.
//
// N=16384 (16MB, dentro do maxmem padrão do Node) custa uns ~50ms por conta —
// caro o bastante pra atrapalhar quem tenta adivinhar, barato o bastante pra
// caber numa entrada. Quem tenta adivinhar ainda esbarra ANTES no freio de 5
// tentativas; o scrypt é a segunda linha, pra quem levar o banco embora.
const SCRYPT_N = 16384;

function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(senha), sal, 32, { N: SCRYPT_N, r: 8, p: 1 });
  return 'scrypt$' + SCRYPT_N + '$' + sal.toString('hex') + '$' + h.toString('hex');
}

// Comparação em tempo constante. Senha errada e senha certa têm que demorar o
// mesmo tanto: `===` de string vaza, byte a byte, o quanto o palpite chegou
// perto — e aqui do outro lado tem gente com um cronômetro.
function conferirSenha(senha, guardado) {
  try {
    const p = String(guardado || '').split('$');
    if (p.length !== 4 || p[0] !== 'scrypt') return false;
    const N = Number(p[1]);
    if (!Number.isFinite(N) || N < 1024 || N > 1048576) return false;
    const sal = Buffer.from(p[2], 'hex');
    const esperado = Buffer.from(p[3], 'hex');
    if (!sal.length || !esperado.length) return false;
    const h = crypto.scryptSync(String(senha), sal, esperado.length, { N: N, r: 8, p: 1 });
    return crypto.timingSafeEqual(h, esperado);
  } catch (e) { return false; }
}

// Nome da sala DENTRO do LiveKit. Curto, sem PII e sem nada adivinhável do
// dono: ele viaja no crachá e aparece em log de terceiro. Saber o slug não dá
// entrada nenhuma (o portão é a senha + a lista de expulsos), mas nome de sala
// não é lugar pra email de ninguém.
function slugNovo() {
  return 'sv-' + crypto.randomBytes(6).toString('hex');
}

// Crachá de PARTICIPANTE: entra na sala, publica e escuta — só isso.
//   · canPublishSources: ['microphone'] — vídeo e tela ficam para depois.
//     ⚠️ ATENÇÃO ao que este limite REALMENTE faz. Ele estava descrito aqui como
//     "o limite é do SERVIDOR: mesmo um navegador adulterado não publica
//     câmera", e isso é FALSO — medido em 11/08 contra esta conta. O SFU compara
//     a FONTE DECLARADA, não o tipo da faixa: vídeo 1920x1080 declarado com
//     source=MICROPHONE foi ACEITO (TrackPublished, type=1 VIDEO). Só é barrado
//     quem se declara honestamente como câmera ou tela.
//     Ou seja: isto barra o desatento, não o adulterado. Quem segura de verdade
//     é o navegador dos OUTROS, que recusa assinar faixa que não seja áudio
//     (public/sala-voz.js) — é lá que a banda de todo mundo é protegida.
//   · canPublishData: false — não existe chat de dados aqui; o que não é usado
//     não precisa ser permitido.
//   · canUpdateOwnMetadata: false — é o que faz nome/foto/plano serem fato e
//     não boato. Era esse o trabalho do ticket HMAC da versão anterior.
//   · `h` no metadata é QUEM MANDA na sala ('dono' | 'co'). Ele fica no crachá,
//     e não numa lista que cada navegador busca por fora, por dois motivos: é
//     assinado por nós (ninguém se promove sozinho — canUpdateOwnMetadata é
//     false) e chega a todo mundo pelo próprio SFU. Promoção no meio da
//     conversa não fica velha: o servidor reescreve o metadata pelo
//     UpdateParticipant e o LiveKit avisa os presentes na hora
//     (ParticipantMetadataChanged, que o front já escuta).
function crachaParticipante(pessoa, key, secret) {
  return assinarJwt({
    sub: pessoa.id,
    name: pessoa.nome,
    metadata: metaDe(pessoa),
    video: {
      room: pessoa.sala || SALA,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      canPublishSources: ['microphone'],
    },
  }, TTL_CRACHA_S, key, secret);
}

// O metadata do crachá é escrito num lugar só, porque ele é reescrito depois
// (UpdateParticipant, na promoção) e dois lugares montando o mesmo objeto é
// como nasce um card sem foto ou sem coroa.
function metaDe(pessoa) {
  const m = { a: pessoa.avatar || '', p: pessoa.plano };
  if (pessoa.manda === 'dono' || pessoa.manda === 'co') m.h = pessoa.manda;
  return JSON.stringify(m);
}

// wss://x.livekit.cloud -> https://x.livekit.cloud (o RoomService é HTTP)
function baseHttp(url) {
  return String(url || '').replace(/^ws/i, 'http').replace(/\/+$/, '');
}

// Uma chamada ao RoomService. Devolve estado em vez de estourar: LiveKit fora
// do ar tem que virar "sala indisponível agora" na tela, não 500 mudo.
//
// `sala` é o escopo do crachá de admin desta chamada (veja crachaAdmin). Quando
// não vem, é a sala pública — todas as chamadas antigas continuam valendo.
async function rpc(metodo, corpo, ctx, sala) {
  const controle = new AbortController();
  const t = setTimeout(() => controle.abort(), 6000);
  try {
    const r = await fetch(`${baseHttp(ctx.url)}/twirp/livekit.RoomService/${metodo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + crachaAdmin(ctx.key, ctx.secret, sala) },
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
    return { avatar: fotoOk(m && m.a), plano: plano(m && m.p), manda: manda(m && m.h) };
  } catch (e) { return { avatar: null, plano: 'full', manda: null }; }
}
const plano = (p) => (p === 'mod' ? 'mod' : p === 'master' ? 'master' : 'full');
const manda = (h) => (h === 'dono' ? 'dono' : h === 'co' ? 'co' : null);

// Quem está na sala agora. `n` vem do ListRooms (barato e sempre existe) e a
// lista de nomes só é buscada quando há alguém — sala vazia não paga chamada.
//
// `sala` é o nome dela no LiveKit: a pública quando não vem (é o que mantém
// todas as chamadas antigas valendo) ou o slug de uma sala privada.
async function estadoDaSala(ctx, qualSala) {
  const alvo = String(qualSala || '') || SALA;
  const r = await rpc('ListRooms', { names: [alvo] }, ctx, alvo);
  // ⚠️ ListRooms falhando NÃO é motivo pra dizer que a sala caiu. Aqui havia um
  // `if (!r.ok) return { ok: false }` que contradizia, uma linha acima, o
  // comentário logo abaixo: um 503 dele — rate-limit ou soluço do LiveKit
  // Cloud — apagava o recurso inteiro da página com o ListParticipants sadio
  // do lado, reportando gente ACTIVE. Medido com twirp falso.
  // Ele é só um palpite barato agora; quem decide é o ListParticipants.
  const sala = (r.ok && r.d && Array.isArray(r.d.rooms) && r.d.rooms[0]) || null;
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
  const p = await rpc('ListParticipants', { room: alvo }, ctx, alvo);
  // Só agora dá pra dizer que caiu: as DUAS fontes falharam.
  if (!p.ok && !r.ok) return { ok: false };
  const n = nLista;
  // Contagem boa e lista ruim não é motivo pra dizer que a sala caiu: devolve o
  // número (que é o que o contador usa) e uma lista vazia.
  // Contagem boa e lista ruim é ESTADO DEGRADADO, e vai marcado: sem a lista
  // não dá pra saber quem já está dentro, e o teto lá embaixo usa exatamente
  // isso pra não barrar quem só deu F5. Devolver identidades:[] calado fazia o
  // sistema tratar "não sei quem está lá" como "não tem ninguém lá".
  if (!p.ok || !p.d || !Array.isArray(p.d.participants)) return { ok: true, n, pessoas: [], identidades: [], listaOk: false };

  const vivos = p.d.participants.filter((x) => {
    const e = x && x.state;
    // ACTIVE/JOINED/JOINING contam; DISCONNECTED é resto de quem já saiu.
    return e !== 'DISCONNECTED' && e !== 3;
  });
  return {
    ok: true,
    // ⚠️ NÃO use Math.max(n, vivos.length) aqui. Era o que estava escrito, e
    // desfazia na linha seguinte o filtro de fantasmas feito logo acima: com o
    // ListRooms dizendo 10 e só 7 vivos, o máximo devolve 10 e um novato leva
    // "a sala está cheia" com sete pessoas dentro. O ListRooms é justamente a
    // fonte que este arquivo já aprendeu a não acreditar (veja o comentário na
    // consulta). Quem foi filtrado manda no número.
    n: vivos.length,
    listaOk: true,
    identidades: vivos.map((x) => String(x.identity || '')),
    // Cru, do jeito que o SFU mandou: `silenciar` precisa do sid das faixas, e
    // buscar de novo seria uma segunda chamada pela mesma informação.
    crus: vivos,
    pessoas: vivos.map((x) => {
      const meta = lerMeta(x.metadata);
      return { nome: limpar(x.name, 32) || 'criador', avatar: meta.avatar, plano: meta.plano, manda: meta.manda };
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
//
// É um mapa POR SALA desde as salas privadas: com um objeto só, a contagem da
// sala A apareceria como se fosse a da sala B durante os 3 segundos do cache.
// O teto de 40 é higiene de lambda quente — mapa que só cresce em processo
// reaproveitado é vazamento com outro nome.
const cacheContar = new Map();
function lerCache(sala) {
  const c = cacheContar.get(sala);
  return (c && Date.now() - c.em < CACHE_CONTAR_MS) ? c.dados : null;
}
function gravarCache(sala, dados) {
  if (cacheContar.size > 40) cacheContar.clear();
  cacheContar.set(sala, { em: Date.now(), dados: dados });
}

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

  // ══ SALAS PRIVADAS ════════════════════════════════════════════════════════
  // Daqui pra baixo é tudo sobre elas. A sala pública continua exatamente como
  // estava: ela não tem linha no banco, e `salaDb` nulo significa "a pública".

  const TAB_SALAS = `${SU}/rest/v1/community_voice_rooms`;
  const TAB_MEMB = `${SU}/rest/v1/community_voice_members`;
  const COLS_SALA = 'id,slug,titulo,owner_id,senha_hash,senha_versao,aberta,criada_em,ultima_entrada';
  const agoraIso = () => new Date().toISOString();
  const meuId = String(userId).toLowerCase();
  const ehUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
  const ehSlug = (s) => /^[a-z0-9-]{4,40}$/.test(String(s || ''));
  const temPalavrao = (s) => { const t = ' ' + String(s).toLowerCase() + ' '; return PALAVRAS_BLOQUEADAS.some((w) => t.includes(w)); };

  const salaPorSlug = async (slug) => {
    if (!ehSlug(slug)) return null;
    const r = await fetch(`${TAB_SALAS}?slug=eq.${slug}&select=${COLS_SALA}`, { headers: H });
    return r.ok ? ((await r.json())[0] || null) : null;
  };
  const minhaSalaAberta = async () => {
    const r = await fetch(`${TAB_SALAS}?owner_id=eq.${meuId}&aberta=is.true&select=${COLS_SALA}&limit=1`, { headers: H });
    return r.ok ? ((await r.json())[0] || null) : null;
  };
  const membroDe = async (roomId, uid) => {
    const r = await fetch(`${TAB_MEMB}?room_id=eq.${roomId}&user_id=eq.${String(uid).toLowerCase()}&select=*`, { headers: H });
    return r.ok ? ((await r.json())[0] || null) : null;
  };
  // Upsert parcial: o PostgREST só sobrescreve as colunas que vão no corpo
  // (ON CONFLICT DO UPDATE SET col = excluded.col, uma por uma). É o que deixa
  // "expulsar" escrever expulso_ate sem apagar o histórico de tentativas.
  const salvarMembro = async (roomId, uid, patch) => {
    const corpo = Object.assign({ room_id: roomId, user_id: String(uid).toLowerCase(), updated_at: agoraIso() }, patch);
    const r = await fetch(TAB_MEMB, {
      method: 'POST',
      headers: Object.assign({}, H, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(corpo),
    });
    return r.ok;
  };

  // ── QUEM MANDA ────────────────────────────────────────────────────────────
  // 'dono' | 'mod' | 'co' | null. O dono sai do owner_id da sala, NUNCA de uma
  // linha em members: papel de dono derivado de dois lugares é como se cria o
  // caso "o dono perdeu o controle da própria sala".
  const papelNa = (salaDb, memb) => {
    if (salaDb && String(salaDb.owner_id).toLowerCase() === meuId) return 'dono';
    if (isMod) return 'mod';                       // moderador do site manda em qualquer sala
    if (salaDb && memb && memb.papel === 'co') return 'co';
    return null;
  };
  // Força na hierarquia. Só se mexe em quem tem MENOS força — é isso que
  // impede co-anfitrião de expulsar co-anfitrião (empate = nada acontece) e
  // dono de expulsar moderador do site.
  const forca = (p) => (p === 'mod' ? 3 : p === 'dono' ? 2 : p === 'co' ? 1 : 0);
  // Trocar senha, promover, perdoar e encerrar são do DONO (e do moderador).
  const ehComando = (p) => p === 'dono' || p === 'mod';

  // ── A VARREDURA ───────────────────────────────────────────────────────────
  // O portão olha quem PEDE pra entrar. Esta olha quem ESTÁ dentro — e é ela
  // que fecha a única fresta que sobrava: o crachá guardado. Um crachá vale 2h
  // e o LiveKit renova sozinho, então quem foi expulso e tinha o token na mão
  // podia voltar direto pelo SFU, sem passar por este endpoint. Aqui ele é
  // removido de novo, sem depender de ele pedir licença.
  //
  // Ela é barata de propósito: recebe a lista de quem está dentro (que quem
  // chama JÁ tem na mão) e faz UMA pergunta ao banco, só pelos expulsos.
  // Sala sem expulso não gera chamada nenhuma ao LiveKit.
  const varrer = async (salaDb, identidades) => {
    const dentro = (identidades || []).map((s) => String(s || '').toLowerCase()).filter(ehUuid);
    if (!salaDb || !dentro.length) return { ok: true, removidos: [] };
    let alvos = [];
    try {
      const r = await fetch(`${TAB_MEMB}?room_id=eq.${salaDb.id}&user_id=in.(${dentro.join(',')})&expulso_ate=gt.${encodeURIComponent(agoraIso())}&select=user_id`, { headers: H });
      // Banco fora do ar não pode virar "não tem expulso nenhum": nesse estado a
      // varredura simplesmente não roda, e diz isso a quem chamou. O portão
      // continua de pé — quem tentar ENTRAR de novo esbarra nele.
      if (!r.ok) return { ok: false, removidos: [] };
      alvos = (await r.json()).map((x) => String(x.user_id).toLowerCase());
    } catch (e) { return { ok: false, removidos: [] }; }
    const removidos = [];
    for (const uid of alvos) {
      const rr = await rpc('RemoveParticipant', { room: salaDb.slug, identity: uid }, LK, salaDb.slug);
      if (rr.ok) removidos.push(uid);
    }
    return { ok: true, removidos };
  };

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
    // Sem `sala` é a pública — que é como a página sempre chamou e continua
    // chamando no relógio dela.
    if (action === 'contar') {
      const alvo = (q.sala || b.sala) ? await salaPorSlug(q.sala || b.sala) : null;
      if ((q.sala || b.sala) && !alvo) return res.status(404).json({ error: 'Essa sala não existe mais.', sumiu: true });
      const nomeSala = alvo ? alvo.slug : SALA;
      if (semLiveKit) return res.status(200).json({ ok: true, n: 0, pessoas: [], max: MAX_PESSOAS, indisponivel: true });
      const cache = lerCache(nomeSala);
      if (cache) return res.status(200).json(Object.assign({ ok: true, max: MAX_PESSOAS, cache: true }, cache));
      const st = await estadoDaSala(LK, nomeSala);
      if (!st.ok) return res.status(200).json({ ok: true, n: 0, pessoas: [], max: MAX_PESSOAS, indisponivel: true });
      const dados = { n: st.n, pessoas: st.pessoas };
      gravarCache(nomeSala, dados);
      return res.status(200).json(Object.assign({ ok: true, max: MAX_PESSOAS, indisponivel: false }, dados));
    }

    // ── ENTRAR: o crachá. É aqui que o teto de 10 é cobrado. ────────────────
    if (action === 'entrar') {
      if (semLiveKit) return res.status(503).json({ error: 'A sala de voz está indisponível agora.', indisponivel: true });

      // ── qual sala, e tenho direito de entrar NELA? ───────────────────────
      // A sala pública TAMBÉM passa por aqui: ela tem linha no banco (sem dono
      // e sem senha), e é isso que dá a ela a lista de expulsos e a varredura.
      // Era o lugar onde o buraco medido — "nada tira ninguém de dentro" —
      // ficava mais caro, porque é onde a Comunidade inteira conversa.
      //
      // `salaDb` nulo continua sendo caso VÁLIDO: é a sala pública antes de
      // alguém rodar o SQL. Nesse estado ela funciona exatamente como
      // funcionava ontem — o que está no ar não pode depender de um arquivo
      // colado à mão no painel do Supabase pra continuar de pé.
      const slugPedido = String(b.sala || q.sala || '') || SALA;
      const salaDb = await salaPorSlug(slugPedido);
      let meuPapel = null;
      if (!salaDb && slugPedido !== SALA) return res.status(404).json({ error: 'Essa sala não existe mais.', sumiu: true });
      if (salaDb) {
        if (!salaDb.aberta) {
          return res.status(410).json(salaDb.owner_id
            ? { error: 'Essa sala foi encerrada pelo dono.', encerrada: true }
            : { error: 'A sala de voz está fechada no momento.', encerrada: true });
        }

        const memb = await membroDe(salaDb.id, userId);
        meuPapel = papelNa(salaDb, memb);

        // 1) LISTA DE EXPULSOS. Vem ANTES da senha de propósito: quem foi
        //    expulso não tem que descobrir isso errando senha, e acertar a
        //    senha não desfaz uma expulsão.
        const expAte = memb && memb.expulso_ate ? new Date(memb.expulso_ate).getTime() : 0;
        if (expAte > Date.now() && !ehComando(meuPapel)) {
          const faltam = Math.max(1, Math.round((expAte - Date.now()) / 60000));
          return res.status(403).json({
            error: faltam >= 60
              ? 'Você foi removido desta sala. Dá pra voltar em ' + Math.round(faltam / 60) + 'h.'
              : 'Você foi removido desta sala. Dá pra voltar em ' + faltam + 'min.',
            expulso: true, minutos: faltam,
          });
        }

        // 2) SENHA. Quem manda na sala (dono, co-anfitrião, moderador) não
        //    digita senha: o co-anfitrião foi escolhido a dedo pelo dono, e
        //    fazer o dono digitar a própria senha é cerimônia sem defesa.
        if (salaDb.senha_hash && !meuPapel) {
          const liberado = memb && memb.liberado_versao === salaDb.senha_versao;
          if (!liberado) {
            const castigo = memb && memb.falhas_ate ? new Date(memb.falhas_ate).getTime() : 0;
            if (castigo > Date.now()) {
              return res.status(429).json({
                error: 'Senha errada demais. Tenta de novo em ' + Math.max(1, Math.round((castigo - Date.now()) / 60000)) + 'min.',
                travado: true,
              });
            }
            const tentativa = String(b.senha == null ? '' : b.senha);
            if (!tentativa) return res.status(401).json({ error: 'Essa sala pede senha.', pedeSenha: true });
            if (!conferirSenha(tentativa, salaDb.senha_hash)) {
              // O contador de erros sobe ANTES da resposta: se ele fosse
              // depois (ou fire-and-forget), o serverless cortaria a promessa
              // no return e o freio nunca apertaria — que é o mesmo defeito
              // que já custou 28 notificações de amizade neste projeto.
              const falhas = ((memb && memb.falhas) || 0) + 1;
              const patch = { falhas };
              if (falhas >= SENHA_TENTATIVAS) {
                patch.falhas = 0;
                patch.falhas_ate = new Date(Date.now() + SENHA_CASTIGO_MIN * 60000).toISOString();
              }
              await salvarMembro(salaDb.id, userId, patch);
              return res.status(401).json({
                error: falhas >= SENHA_TENTATIVAS
                  ? 'Senha errada. Espera ' + SENHA_CASTIGO_MIN + ' minutos pra tentar de novo.'
                  : 'Senha errada.',
                pedeSenha: true, restam: Math.max(0, SENHA_TENTATIVAS - falhas),
              });
            }
            // Acertou: fica liberado NESTA versão da senha. Trocar a senha
            // sobe a versão e derruba todas as liberações de uma vez.
            await salvarMembro(salaDb.id, userId, { liberado_versao: salaDb.senha_versao, falhas: 0, falhas_ate: null });
          }
        }
      }
      const nomeSala = salaDb ? salaDb.slug : SALA;

      // Contagem SEM cache: o teto é decisão, não enfeite de tela.
      const st = await estadoDaSala(LK, nomeSala);
      if (!st.ok) return res.status(503).json({ error: 'A sala de voz está indisponível agora.', indisponivel: true });

      // A VARREDURA, na entrada. A lista de quem está dentro já está na mão
      // (custo zero) e é a hora mais barata de tirar quem foi expulso e voltou
      // com o crachá guardado. Ela não decide nada sobre QUEM ESTÁ ENTRANDO —
      // esse já passou pela lista de expulsos lá em cima.
      const limpeza = salaDb ? await varrer(salaDb, st.identidades) : { removidos: [] };

      const jaEstou = st.identidades.indexOf(String(userId)) >= 0;
      // A contagem foi feita ANTES da varredura. Quem ela acabou de tirar não
      // ocupa mais vaga — sem descontar, a pessoa levaria "a sala está cheia"
      // no exato instante em que uma vaga foi aberta pra ela.
      const nAgora = Math.max(0, st.n - limpeza.removidos.length);

      // Cheio é cheio — MENOS pra quem já está lá dentro e só está reentrando
      // (aba recarregada, celular que caiu): essa pessoa já ocupa a vaga dela,
      // e recusar seria trancar alguém pra fora da própria conversa.
      // Sem a lista, `jaEstou` é sempre falso — não porque a pessoa não esteja
      // dentro, mas porque não dá pra saber. Aplicar o teto nesse estado tranca
      // pra fora justamente quem já estava na sala e só deu F5. Na dúvida entre
      // deixar entrar um a mais e expulsar alguém que já estava conversando, o
      // erro barato é o primeiro: o SFU ainda segura o teto de verdade.
      if (st.listaOk !== false && !jaEstou && nAgora >= MAX_PESSOAS) {
        return res.status(403).json({ error: 'A sala está cheia (' + MAX_PESSOAS + ' pessoas).', cheia: true, n: nAgora, max: MAX_PESSOAS });
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
      // ⚠️ `max_participants` é um portão FROUXO, não um portão firme. A regra
      // medida contra esta conta (11/08) é max + 2: max=2 aceitou 4, max=4
      // aceitou 6, max=10 aceitou 12, e sem declarar entraram 18 de 18.
      //
      // (A leitura anterior aqui dizia "NÃO é um portão". Ela veio de um caso
      // único — max=2 aceitou o terceiro — que era compatível com as duas
      // hipóteses. A varredura da faixa inteira desempatou. Fica registrado
      // porque a diferença importa: o pior caso é 12 numa sala de 10, não
      // ilimitado.)
      //
      // Entre 10 e 12 quem segura são
      // duas camadas NOSSAS: a contagem logo acima (sem cache) e, pra corrida
      // de dois pedidos no mesmo instante, o desempate no navegador — quem
      // ficou além do teto se retira sozinho (checarLotacao em
      // public/sala-voz.js), calculando a MESMA ordem em todo mundo.
      // Carimbo de atividade: é o que ordena a lista de salas e o que mantém
      // uma sala viva visível mesmo quando o ListRooms do LiveKit a esquece
      // (ele já foi pego mentindo por omissão — medido em 11/08).
      //
      // ⚠️ AWAIT, e não fire-and-forget. Em serverless, promise não aguardada
      // antes do res é DESCARTADA quando a função retorna — foi assim que 28
      // notificações de amizade viraram zero neste projeto. Vai junto do
      // CreateRoom no Promise.all: são independentes, então o await custa o
      // tempo da mais lenta das duas, não a soma.
      await Promise.all([
        rpc('CreateRoom', {
          name: nomeSala,
          max_participants: MAX_PESSOAS,
          empty_timeout: SALA_VAZIA_S,
          departure_timeout: PARTIDA_S,
        }, LK, nomeSala),
        salaDb ? fetch(`${TAB_SALAS}?id=eq.${salaDb.id}`, {
          method: 'PATCH', headers: Object.assign({}, H, { Prefer: 'return=minimal' }),
          body: JSON.stringify({ ultima_entrada: agoraIso() }),
        }).catch(() => null) : null,
      ]);

      const cracha = crachaParticipante({ id: userId, nome, avatar: foto, plano: meuPlano, sala: nomeSala, manda: meuPapel === 'mod' ? 'co' : meuPapel }, LK.key, LK.secret);
      return res.status(200).json({
        ok: true,
        url: LK.url,
        sala: nomeSala,
        token: cracha,
        max: MAX_PESSOAS,
        me,
        expira_em: Date.now() + TTL_CRACHA_S * 1000,
        n: nAgora,
        // O que o painel precisa saber pra desenhar (ou não) os comandos.
        // `papel` vem mesmo na sala pública: lá o moderador do site manda, e é
        // o que dá a ele o botão de expulsar onde antes não existia nenhum.
        privada: !!(salaDb && salaDb.owner_id),
        titulo: (salaDb && salaDb.owner_id) ? salaDb.titulo : null,
        papel: meuPapel,
        comSenha: !!(salaDb && salaDb.senha_hash),
      });
    }

    // ══ SALAS PRIVADAS: LISTAR, CRIAR, EDITAR, ENCERRAR ══════════════════════

    // ── SALAS: a lista que aparece no modal de entrada. ─────────────────────
    // UMA chamada ao LiveKit (ListRooms sem nomes = todas as salas vivas) e UMA
    // ao banco. A lista sai do BANCO, não do LiveKit: o ListRooms já foi pego
    // mentindo por omissão, e uma sala viva sumir da lista é pior do que ela
    // aparecer com o contador zerado.
    if (action === 'salas') {
      // `owner_id=not.is.null` tira a sala PÚBLICA da lista: ela tem linha no
      // banco (pela lista de expulsos), mas não é uma sala de ninguém — quem a
      // mostra é o card fixo lá em cima da lista.
      const [rAbertas, rMinha] = await Promise.all([
        fetch(`${TAB_SALAS}?aberta=is.true&owner_id=not.is.null&select=${COLS_SALA}&order=ultima_entrada.desc.nullslast&limit=${LISTA_MAX}`, { headers: H }),
        minhaSalaAberta(),
      ]);
      // Tabela ainda não criada (o SQL é colado à mão no painel do Supabase) é
      // um estado REAL e previsto: a resposta diz `semTabela` e o front esconde
      // a seção inteira. Sem isso, a pessoa veria "criar sala" e levaria um
      // erro no clique — pior que não ver o botão.
      if (!rAbertas.ok) {
        return res.status(200).json({
          ok: true, max: MAX_PESSOAS, indisponivel: semLiveKit, semTabela: true,
          aberta: { slug: SALA, n: 0, contagemOk: false }, salas: [], podeCriar: false,
        });
      }
      const abertas = await rAbertas.json();
      // A minha entra na lista mesmo se ficou fora do limite: sala que a pessoa
      // criou e não encontra é sala perdida.
      if (rMinha && !abertas.some((s) => s.id === rMinha.id)) abertas.push(rMinha);

      const vivas = {};
      let contagemOk = false;
      if (!semLiveKit) {
        const r = await rpc('ListRooms', {}, LK, null);
        if (r.ok && r.d && Array.isArray(r.d.rooms)) {
          contagemOk = true;
          for (const s of r.d.rooms) vivas[String(s.name || '')] = Number(campo(s, 'num_participants', 'numParticipants') || 0);
        }
      }

      // Meu papel em cada sala: UMA consulta pras minhas linhas de membro, não
      // uma por sala (a lista pode ter 40).
      let minhasLinhas = {};
      if (abertas.length) {
        try {
          const rm = await fetch(`${TAB_MEMB}?user_id=eq.${meuId}&room_id=in.(${abertas.map((s) => s.id).join(',')})&select=room_id,papel,liberado_versao,expulso_ate`, { headers: H });
          if (rm.ok) for (const l of await rm.json()) minhasLinhas[l.room_id] = l;
        } catch (e) {}
      }

      const donos = {};
      // `in.()` com lista vazia é erro de sintaxe no PostgREST, não lista
      // vazia: sem esta guarda, a primeira visita (nenhuma sala criada ainda)
      // levaria um 400 do banco no meio de uma tela que deveria dizer
      // simplesmente "ninguém criou sala ainda".
      if (abertas.length) {
        try {
          const ids = [...new Set(abertas.map((s) => String(s.owner_id).toLowerCase()).filter(ehUuid))];
          if (ids.length) {
            const rp = await fetch(`${SU}/rest/v1/community_profiles?user_id=in.(${ids.join(',')})&select=user_id,display_name,avatar_url`, { headers: H });
            if (rp.ok) for (const p of await rp.json()) donos[String(p.user_id).toLowerCase()] = p;
          }
        } catch (e) {}
      }

      const lista = abertas.map((s) => {
        const memb = minhasLinhas[s.id] || null;
        const papel = papelNa(s, memb);
        const dono = donos[String(s.owner_id).toLowerCase()] || null;
        const expAte = memb && memb.expulso_ate ? new Date(memb.expulso_ate).getTime() : 0;
        return {
          slug: s.slug,
          titulo: s.titulo,
          dono: dono ? limpar(dono.display_name, 32) : 'criador',
          donoAvatar: dono ? fotoOk(dono.avatar_url) : null,
          minha: String(s.owner_id).toLowerCase() === meuId,
          papel,
          comSenha: !!s.senha_hash,
          // Já passei por esta senha? É o que faz a sala abrir sem perguntar de
          // novo — e o que volta a perguntar quando o dono troca a senha.
          liberado: !s.senha_hash || !!papel || (memb && memb.liberado_versao === s.senha_versao),
          expulso: expAte > Date.now() && !ehComando(papel),
          n: vivas[s.slug] || 0,
          // Contagem que não pôde ser feita não pode virar "sala vazia" na tela.
          contagemOk,
        };
      }).sort((a, b) => (b.n - a.n) || (a.minha ? -1 : b.minha ? 1 : 0));

      return res.status(200).json({
        ok: true, max: MAX_PESSOAS, indisponivel: semLiveKit,
        aberta: { slug: SALA, n: vivas[SALA] || 0, contagemOk },
        salas: lista,
        // Uma sala aberta por dono (é índice único no banco, não só regra aqui).
        podeCriar: !rMinha,
      });
    }

    // ── CRIAR: a minha sala. Uma por pessoa, enquanto estiver aberta. ───────
    if (action === 'criar') {
      const titulo = limpar(b.titulo, TITULO_MAX);
      if (titulo.length < 2) return res.status(400).json({ error: 'Dê um nome à sala (2 a ' + TITULO_MAX + ' letras).' });
      if (temPalavrao(titulo)) return res.status(400).json({ error: 'Esse nome não passa na moderação da Comunidade.' });
      const senha = b.senha == null ? '' : String(b.senha);
      if (senha && (senha.length < SENHA_MIN || senha.length > SENHA_MAX)) {
        return res.status(400).json({ error: 'A senha precisa ter de ' + SENHA_MIN + ' a ' + SENHA_MAX + ' caracteres.' });
      }
      const ja = await minhaSalaAberta();
      // Duplo-clique no botão não pode virar duas salas: se já existe, devolve
      // a que existe em vez de estourar um erro que a pessoa não entende.
      if (ja) return res.status(200).json({ ok: true, jaTinha: true, slug: ja.slug, titulo: ja.titulo, comSenha: !!ja.senha_hash });

      const linha = {
        slug: slugNovo(), titulo, owner_id: meuId,
        senha_hash: senha ? hashSenha(senha) : null,
        senha_versao: 1, aberta: true,
      };
      const r = await fetch(TAB_SALAS, {
        method: 'POST', headers: Object.assign({}, H, { Prefer: 'return=representation' }),
        body: JSON.stringify(linha),
      });
      if (!r.ok) {
        // 409 = o índice único pegou uma corrida (dois cliques no mesmo
        // instante). Relê e devolve a sala que ganhou, em vez de erro.
        if (r.status === 409) {
          const dela = await minhaSalaAberta();
          if (dela) return res.status(200).json({ ok: true, jaTinha: true, slug: dela.slug, titulo: dela.titulo, comSenha: !!dela.senha_hash });
        }
        return res.status(500).json({ error: 'Não deu pra criar a sala agora. Tenta de novo.' });
      }
      const nova = (await r.json())[0];
      return res.status(200).json({ ok: true, slug: nova.slug, titulo: nova.titulo, comSenha: !!nova.senha_hash });
    }

    // ── SALA-EDITAR: título e senha. Só o dono (e o moderador). ────────────
    if (action === 'sala-editar') {
      const salaDb = await salaPorSlug(b.sala || q.sala);
      if (!salaDb) return res.status(404).json({ error: 'Essa sala não existe mais.', sumiu: true });
      // A sala pública não é de ninguém: nem o moderador põe senha nela. Ela é
      // a porta de entrada da Comunidade — trancá-la seria trancar a casa.
      if (!salaDb.owner_id) return res.status(403).json({ error: 'A sala aberta da Comunidade não tem dono nem senha.' });
      if (!ehComando(papelNa(salaDb, await membroDe(salaDb.id, userId)))) {
        return res.status(403).json({ error: 'Só o dono muda a sala.' });
      }
      const patch = { updated_at: agoraIso() };
      if (b.titulo != null) {
        const titulo = limpar(b.titulo, TITULO_MAX);
        if (titulo.length < 2) return res.status(400).json({ error: 'Dê um nome à sala (2 a ' + TITULO_MAX + ' letras).' });
        if (temPalavrao(titulo)) return res.status(400).json({ error: 'Esse nome não passa na moderação da Comunidade.' });
        patch.titulo = titulo;
      }
      // `senha` ausente = não mexe. String vazia = TIRAR a senha. Os dois casos
      // precisam ser distinguíveis, senão não existe como abrir a sala de novo.
      if (b.senha !== undefined) {
        const senha = b.senha == null ? '' : String(b.senha);
        if (senha && (senha.length < SENHA_MIN || senha.length > SENHA_MAX)) {
          return res.status(400).json({ error: 'A senha precisa ter de ' + SENHA_MIN + ' a ' + SENHA_MAX + ' caracteres.' });
        }
        patch.senha_hash = senha ? hashSenha(senha) : null;
        // A versão SOBE em toda troca — inclusive ao tirar a senha e pôr outra
        // depois. É o que derruba, de uma vez, todas as liberações antigas.
        patch.senha_versao = Number(salaDb.senha_versao || 1) + 1;
      }
      const r = await fetch(`${TAB_SALAS}?id=eq.${salaDb.id}`, {
        method: 'PATCH', headers: Object.assign({}, H, { Prefer: 'return=representation' }),
        body: JSON.stringify(patch),
      });
      if (!r.ok) return res.status(500).json({ error: 'Não deu pra salvar agora. Tenta de novo.' });
      const dep = (await r.json())[0] || salaDb;
      return res.status(200).json({
        ok: true, titulo: dep.titulo, comSenha: !!dep.senha_hash,
        // Dito com todas as letras porque é a diferença entre uma promessa
        // cumprida e uma promessa falsa: trocar a senha fecha a PORTA, não
        // esvazia a sala. Pra tirar alguém que já está dentro existe o expulsar.
        aviso: b.senha !== undefined ? 'A senha nova vale pra quem entrar daqui pra frente. Quem já está na sala continua nela — pra tirar alguém, use o expulsar.' : null,
      });
    }

    // ── ENCERRAR: apaga a sala no LiveKit (tira TODO MUNDO) e fecha a linha. ─
    // `DeleteRoom` é a segunda das duas únicas formas de tirar alguém de uma
    // sala do LiveKit. O front já sabe traduzir o motivo ROOM_DELETED que chega
    // pra quem estava dentro ("A sala de voz foi encerrada").
    if (action === 'encerrar') {
      const salaDb = await salaPorSlug(b.sala || q.sala);
      if (!salaDb) return res.status(404).json({ error: 'Essa sala não existe mais.', sumiu: true });
      // Encerrar a sala pública a fecharia pra sempre (só um SQL a reabriria).
      // O moderador que precisa esvaziá-la tem o expulsar, que é reversível.
      if (!salaDb.owner_id) return res.status(403).json({ error: 'A sala aberta da Comunidade não se encerra.' });
      if (!ehComando(papelNa(salaDb, await membroDe(salaDb.id, userId)))) {
        return res.status(403).json({ error: 'Só o dono encerra a sala.' });
      }
      // O banco primeiro: se o DeleteRoom falhar, a sala já está fechada pra
      // novas entradas e ninguém entra por engano numa sala que "acabou".
      const r = await fetch(`${TAB_SALAS}?id=eq.${salaDb.id}`, {
        method: 'PATCH', headers: Object.assign({}, H, { Prefer: 'return=minimal' }),
        body: JSON.stringify({ aberta: false, encerrada_em: agoraIso(), updated_at: agoraIso() }),
      });
      if (!r.ok) return res.status(500).json({ error: 'Não deu pra encerrar agora. Tenta de novo.' });
      const del = await rpc('DeleteRoom', { room: salaDb.slug }, LK, salaDb.slug);
      return res.status(200).json({ ok: true, esvaziou: !!del.ok });
    }

    // ══ O COMANDO DA SALA: papel, expulsar, perdoar, silenciar, guardar ══════

    // Toda ação daqui pra baixo precisa da sala e do meu papel nela — e várias
    // precisam também do papel do ALVO. Uma função só, pra que a autorização
    // não seja reinventada (levemente diferente) em cada uma delas.
    const abrirComando = async (precisaAlvo) => {
      const salaDb = await salaPorSlug(b.sala || q.sala);
      if (!salaDb) return { erro: { http: 404, corpo: { error: 'Essa sala não existe mais.', sumiu: true } } };
      const meuMemb = await membroDe(salaDb.id, userId);
      const meuPapel = papelNa(salaDb, meuMemb);
      if (!meuPapel) return { erro: { http: 403, corpo: { error: 'Só quem manda na sala faz isso.' } } };
      if (!precisaAlvo) return { salaDb, meuPapel };

      const alvoId = String(b.alvo || q.alvo || '').toLowerCase();
      if (!ehUuid(alvoId)) return { erro: { http: 400, corpo: { error: 'Pessoa inválida.' } } };
      if (alvoId === meuId) return { erro: { http: 400, corpo: { error: 'Essa ação é sobre outra pessoa, não sobre você.' } } };
      const alvoMemb = await membroDe(salaDb.id, alvoId);
      let alvoPerfil = null;
      try {
        const rp = await fetch(`${SU}/rest/v1/community_profiles?user_id=eq.${alvoId}&select=display_name,avatar_url,is_moderator`, { headers: H });
        if (rp.ok) alvoPerfil = (await rp.json())[0] || null;
      } catch (e) {}
      // Papel do ALVO calculado com a mesma régua — inclusive o "é moderador do
      // site", que é o que impede um dono de expulsar a moderação da Comunidade.
      const alvoPapel = String(salaDb.owner_id).toLowerCase() === alvoId ? 'dono'
        : (alvoPerfil && alvoPerfil.is_moderator) ? 'mod'
          : (alvoMemb && alvoMemb.papel === 'co') ? 'co' : null;
      if (forca(meuPapel) <= forca(alvoPapel)) {
        return { erro: { http: 403, corpo: { error: 'Você não manda nessa pessoa aqui.' } } };
      }
      return { salaDb, meuPapel, alvoId, alvoMemb, alvoPapel, alvoNome: alvoPerfil ? limpar(alvoPerfil.display_name, 32) : 'essa pessoa' };
    };

    // ── EXPULSAR: a remoção de verdade. ────────────────────────────────────
    // A ORDEM AQUI NÃO É ESTILO. A lista de expulsos é gravada ANTES de chamar
    // o LiveKit porque as duas falhas possíveis não custam a mesma coisa:
    //   · banco gravado e remoção falhou → a pessoa continua na sala por ora,
    //     mas não volta depois, e a varredura da próxima entrada a tira;
    //   · remoção feita e banco falhou   → ela volta em 3 segundos, pra sempre.
    // O erro barato primeiro.
    if (action === 'expulsar') {
      const c = await abrirComando(true);
      if (c.erro) return res.status(c.erro.http).json(c.erro.corpo);

      const ate = new Date(Date.now() + EXPULSAO_H * 3600000).toISOString();
      const gravou = await salvarMembro(c.salaDb.id, c.alvoId, {
        expulso_ate: ate, expulso_por: meuId,
        // Perde o co-anfitrião e a liberação da senha junto: expulso que volta
        // como co-anfitrião seria uma expulsão que promoveu.
        papel: null, liberado_versao: null,
      });
      if (!gravou) return res.status(500).json({ error: 'Não deu pra registrar a expulsão — e sem registro ela não vale nada. Tenta de novo.' });

      // Duas tentativas: um soluço de rede no meio disso deixaria a pessoa
      // dentro da sala com a expulsão só no papel.
      let tirou = false;
      for (let i = 0; i < 2 && !tirou; i++) {
        const rr = await rpc('RemoveParticipant', { room: c.salaDb.slug, identity: c.alvoId }, LK, c.salaDb.slug);
        tirou = !!rr.ok;
      }
      return res.status(200).json({
        ok: true, tirou, horas: EXPULSAO_H, nome: c.alvoNome,
        // Honesto quando não deu: quem clicou precisa saber que a pessoa ainda
        // está ouvindo, em vez de achar que resolveu.
        aviso: tirou ? null : 'Registrei a expulsão, mas o servidor de voz não confirmou a saída. Ela não entra mais — se ainda estiver ouvindo, clique de novo.',
      });
    }

    // ── PERDOAR: tira da lista de expulsos antes da hora. ──────────────────
    if (action === 'perdoar') {
      const c = await abrirComando(true);
      if (c.erro) return res.status(c.erro.http).json(c.erro.corpo);
      if (!ehComando(c.meuPapel)) return res.status(403).json({ error: 'Só o dono perdoa.' });
      const ok = await salvarMembro(c.salaDb.id, c.alvoId, { expulso_ate: null, expulso_por: null, falhas: 0, falhas_ate: null });
      if (!ok) return res.status(500).json({ error: 'Não deu pra salvar agora. Tenta de novo.' });
      return res.status(200).json({ ok: true, nome: c.alvoNome });
    }

    // ── PAPEL: promover/rebaixar co-anfitrião. Só o dono. ──────────────────
    // A promoção reescreve o metadata da pessoa NO SFU (UpdateParticipant), e
    // não só no banco. É isso que faz a coroa aparecer na hora pra todo mundo
    // que está na sala: o LiveKit dispara ParticipantMetadataChanged, que o
    // front já escuta. Sem isso, o promovido só descobriria na próxima entrada.
    if (action === 'papel') {
      const c = await abrirComando(true);
      if (c.erro) return res.status(c.erro.http).json(c.erro.corpo);
      if (!ehComando(c.meuPapel)) return res.status(403).json({ error: 'Só o dono escolhe os co-anfitriões.' });
      const virar = b.papel === 'co' ? 'co' : null;
      const ok = await salvarMembro(c.salaDb.id, c.alvoId, { papel: virar });
      if (!ok) return res.status(500).json({ error: 'Não deu pra salvar agora. Tenta de novo.' });

      // Reescreve o crachá vivo dela. Falha aqui NÃO desfaz a promoção: ela
      // vale no banco, e a próxima entrada carimba o metadata certo.
      let avisou = false;
      try {
        const st = await estadoDaSala(LK, c.salaDb.slug);
        const dentro = (st.crus || []).find((p) => String(p.identity || '').toLowerCase() === c.alvoId);
        if (dentro) {
          const meta = lerMeta(dentro.metadata);
          const rr = await rpc('UpdateParticipant', {
            room: c.salaDb.slug, identity: c.alvoId,
            name: String(dentro.name || ''),
            metadata: metaDe({ avatar: meta.avatar, plano: meta.plano, manda: virar }),
          }, LK, c.salaDb.slug);
          avisou = !!rr.ok;
        }
      } catch (e) {}
      return res.status(200).json({ ok: true, papel: virar, nome: c.alvoNome, avisou });
    }

    // ── SILENCIAR: fecha o microfone de alguém no SERVIDOR. ────────────────
    // Diferente de pedir "por favor se mute": o SFU para de encaminhar a faixa,
    // então não depende do navegador da pessoa cooperar. Ela pode se desmutar
    // de novo — silenciar é freio de conversa, não mordaça; pra tirar de vez
    // existe o expulsar.
    if (action === 'silenciar') {
      const c = await abrirComando(true);
      if (c.erro) return res.status(c.erro.http).json(c.erro.corpo);
      const st = await estadoDaSala(LK, c.salaDb.slug);
      if (!st.ok) return res.status(503).json({ error: 'A sala de voz está indisponível agora.', indisponivel: true });
      const dentro = (st.crus || []).find((p) => String(p.identity || '').toLowerCase() === c.alvoId);
      if (!dentro) return res.status(404).json({ error: 'Essa pessoa não está mais na sala.' });
      const faixas = (dentro.tracks || []).filter((t) => t && (t.type === 'AUDIO' || t.type === 0 || t.source === 'MICROPHONE'));
      let mudou = 0;
      for (const f of faixas) {
        const sid = f.sid || f.track_sid;
        if (!sid) continue;
        const rr = await rpc('MutePublishedTrack', { room: c.salaDb.slug, identity: c.alvoId, track_sid: sid, muted: true }, LK, c.salaDb.slug);
        if (rr.ok) mudou++;
      }
      return res.status(200).json({ ok: true, mudou, nome: c.alvoNome });
    }

    // ── GUARDAR: a varredura pedida pelo navegador de quem manda. ──────────
    // Quem chama é o front de um dono/co-anfitrião, e SÓ quando o LiveKit avisa
    // que alguém entrou (ParticipantConnected) — um evento que já chega de
    // graça pelo socket dele. Não existe relógio nenhum perguntando de tempos
    // em tempos: polling foi o que encareceu a Vercel neste projeto antes.
    //
    // É esta chamada que fecha a fresta do crachá guardado no caso em que
    // ninguém está entrando pela porta: a pessoa expulsa reconecta direto no
    // SFU com o token velho, todo mundo na sala recebe o aviso de chegada, e o
    // navegador de quem manda pede a varredura.
    if (action === 'guardar') {
      const c = await abrirComando(false);
      if (c.erro) return res.status(c.erro.http).json(c.erro.corpo);
      const st = await estadoDaSala(LK, c.salaDb.slug);
      if (!st.ok) return res.status(200).json({ ok: true, removidos: 0, indisponivel: true });
      const v = await varrer(c.salaDb, st.identidades);
      return res.status(200).json({ ok: true, removidos: v.removidos.length, varreu: v.ok });
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
  MAX_PESSOAS, SALA, TTL_CRACHA_S, EXPULSAO_H, SENHA_TENTATIVAS, SENHA_CASTIGO_MIN,
  assinarJwt, crachaAdmin, crachaParticipante, baseHttp, campo, lerMeta, limpar, fotoOk,
  // Salas privadas: a senha e o nome da sala são pura conta, dá pra exercitar
  // sem banco nenhum — e senha é exatamente o tipo de código que não pode ter
  // "funciona na maioria das vezes".
  hashSenha, conferirSenha, slugNovo, metaDe, manda,
  // `rpc` e `estadoDaSala` pedem rede: eles NÃO são exercitados pelo
  // tests/unit (teste unitário que fala com a internet é teste que falha por
  // motivo errado). Ficam expostos pro smoke manual contra o LiveKit real.
  rpc, estadoDaSala,
};
