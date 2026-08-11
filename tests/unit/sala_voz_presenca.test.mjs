// tests/unit/sala_voz_presenca.test.mjs — node --test
//
// A sala de voz da Comunidade NÃO usa a presence do Realtime. Foi medido em
// 11/08/2026 com dois clientes reais do @supabase/supabase-js (anon+JWT do
// usuário e service key) contra este projeto: os dois ficam SUBSCRIBED, o
// track() devolve 'ok' e nenhum evento 'sync'/'join'/'leave' chega — nem entre
// dois clientes no mesmo canal. Broadcast entrega normalmente nos dois casos.
// Em produção isso apareceu como o dono entrando pelo celular e pelo
// computador e cada aparelho vendo uma sala só com ele mesmo.
//
// Quem está na sala passou a ser o BATIMENTO por broadcast. Este arquivo trava:
//
//  0. A presença por batimento: chegada, batimento perdido que NÃO derruba,
//     ausência sustentada que derruba, 'tchau' na hora, resposta imediata ao
//     "cheguei", prazo longo pra quem bloqueia a tela, e as guardas contra
//     tempestade / lista envenenada.
//  1. BUG "0 pessoas · 1 falando" sem nenhum card: a pessoa SEMPRE se vê e
//     SEMPRE é contada, venha da rede o que vier.
//  2. Coerência do rodapé: falando NUNCA pode passar de pessoas.
//  3. Timbres de entrada/saída (som-notificacao.js) com teto anti-rajada.
//  4. Confirmação antes de sair, dispensável por Esc e clique fora.
//  5. A entrada tem o MESMO peso visual do "🏛️ Comunidade" (.cbt-snav).
//  6. Aviso ao navegar: link do site pergunta no painel, fechar aba pergunta no
//     beforeunload — e nada disso existe fora da sala.
//
// Os testes de sala-voz.js rodam o ARQUIVO DE VERDADE dentro de um DOM falso e
// mexem no estado interno — não são asserções de texto sobre o código. A UI
// (WebRTC, socket, microfone) fica de fora: nenhum deles participa da contagem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SALA = readFileSync(new URL('../../public/sala-voz.js', import.meta.url), 'utf8');
const SOM = readFileSync(new URL('../../public/som-notificacao.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../../public/comunidade.html', import.meta.url), 'utf8');
const SQL_FIX = readFileSync(new URL('../../sql/support_presenca_fix_403.sql', import.meta.url), 'utf8');
const SUPORTE = readFileSync(new URL('../../public/support-chat.js', import.meta.url), 'utf8');
const CBT = readFileSync(new URL('../../public/comunidade.js', import.meta.url), 'utf8');

// ─── DOM mínimo ────────────────────────────────────────────────────────────
// Só o suficiente pro arquivo carregar e pintar. Nada aqui simula rede.
function domFalso() {
  const nos = new Map();
  const ouvintes = {};
  function criarNo(tag) {
    const no = {
      tagName: tag, id: '', className: '', textContent: '', innerHTML: '',
      _filhos: [], _classes: new Set(), style: {}, disabled: false,
      classList: {
        add: (c) => no._classes.add(c),
        remove: (c) => no._classes.delete(c),
        toggle: (c, v) => (v === undefined ? (no._classes.has(c) ? no._classes.delete(c) : no._classes.add(c)) : (v ? no._classes.add(c) : no._classes.delete(c))),
        contains: (c) => no._classes.has(c),
      },
      appendChild: (f) => { no._filhos.push(f); if (f.id) nos.set(f.id, f); return f; },
      insertBefore: (f) => { no._filhos.push(f); if (f.id) nos.set(f.id, f); return f; },
      remove: () => { if (no.id) nos.delete(no.id); },
      addEventListener: () => {}, removeEventListener: () => {},
      setAttribute: () => {}, getAttribute: () => null,
      querySelector: () => null, querySelectorAll: () => [],
      contains: () => false, focus: () => {},
      get firstElementChild() { return no._filhos[0] || null; },
      get parentNode() { return no._pai || null; },
    };
    return no;
  }
  const document = {
    readyState: 'loading',            // segura o ligar(): nada de rede no teste
    hidden: false,
    head: criarNo('head'),
    body: criarNo('body'),
    createElement: criarNo,
    getElementById: (id) => nos.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (ev, fn) => { (ouvintes[ev] = ouvintes[ev] || []).push(fn); },
    removeEventListener: () => {},
    _disparar: (ev, e) => (ouvintes[ev] || []).forEach((f) => f(e || {})),
    _registrar: (no) => { if (no.id) nos.set(no.id, no); return no; },
  };
  function PeerFalso() {
    this.connectionState = 'new'; this.iceConnectionState = 'new';
    this.addTrack = () => {}; this.close = () => {}; this.getSenders = () => [];
    this.createOffer = async () => ({}); this.setLocalDescription = async () => {};
    this.addTransceiver = () => {};
  }
  // Os ouvintes de window passaram a ser GRAVADOS: o aviso ao navegar mora no
  // beforeunload, e sem poder disparar o evento não dá pra provar nem que ele
  // pergunta dentro da sala nem que ele CALA fora dela.
  const ouvintesW = {};
  const window = {
    addEventListener: (ev, fn) => { (ouvintesW[ev] = ouvintesW[ev] || []).push(fn); },
    removeEventListener: () => {},
    PointerEvent: function () {},
    RTCPeerConnection: PeerFalso,
    AudioContext: function () {},
    location: {
      href: 'https://bluetubeviral.com/comunidade',
      origin: 'https://bluetubeviral.com',
      pathname: '/comunidade',
      search: '',
    },
    _disparar: (ev, e) => { (ouvintesW[ev] || []).forEach((f) => f(e || {})); return e; },
  };
  window.window = window;
  window.document = document;
  const ctx = {
    window, document, console, URL,
    RTCPeerConnection: PeerFalso,   // o mesh usa o global cru
    setTimeout, clearTimeout, setInterval, clearInterval,
    Map, Set, Promise, Date, Math, JSON, String, Number, Array, Object, Boolean,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { mediaDevices: {} },
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  };
  ctx.globalThis = ctx;
  return { ctx, document, window };
}

// Âncora de mentira: só o que saiDaPagina() lê.
function link(href, attrs = {}) {
  const a = { href: href && /^[a-z]+:/i.test(href) ? href : 'https://bluetubeviral.com' + (href || '') };
  a.getAttribute = (n) => (n === 'href' ? (href === null ? null : href) : (n in attrs ? attrs[n] : null));
  return a;
}

// A caixa de confirmação vive dentro do dock, que o DOM falso não constrói
// (innerHTML aqui é só uma string). Registra os nós à mão pra exercitar a
// pergunta de verdade, sem simular HTML.
function registrarConfirmacao(document) {
  const criar = (id) => document._registrar(Object.assign(document.createElement('div'), { id }));
  return {
    conf: criar('svzConf'), tit: criar('svzConfTit'),
    sub: criar('svzConfSub'), ok: criar('svzBSairSim'),
  };
}

function carregarSala() {
  const { ctx, document } = domFalso();
  vm.runInNewContext(SALA, ctx, { filename: 'sala-voz.js' });
  const SV = ctx.window.SalaVoz;
  assert.ok(SV && SV._interno, 'sala-voz.js precisa expor _interno pro diagnóstico');
  return { SV, S: SV._estado(), I: SV._interno, document, ctx };
}

// Coloca a pessoa "dentro da sala", exatamente como entrar() faz depois do
// "cheguei" sair com 'ok' — sem microfone, sem socket, sem WebRTC.
function entrarNaSala(S, I) {
  S.cfg = {
    ticket: 'TICKET-DONO', expira_em: Date.now() + 3600000, canal: 'x', max: 10,
    me: { id: 'u-dono', nome: 'Dono', avatar: null, plano: 'master', mod: false },
  };
  S.sessao = 'u-dono~ab12';
  S.entrouEm = Date.now();
  S.entrei = true;
  I.registrarMinhaIdentidade();
  I.garantirEuNaLista();
}

// Canal de mentira que ANOTA o que foi mandado. É o que sobrou de "simular
// rede": a sala só fala broadcast agora, então gravar send() cobre presença,
// saída e sinalização de uma vez.
function canalFalso() {
  const enviados = [];
  return {
    enviados,
    send: ({ event, payload }) => { enviados.push({ event, payload }); return 'ok'; },
    eventos: (nome) => enviados.filter((m) => m.event === nome),
  };
}

// Canal de pé, sem censo em curso: é o estado em que a varredura pode agir.
function canalDePe(S) {
  const c = canalFalso();
  S.canal = c;
  S.sub = 'on';
  S.censoAte = 0;
  return c;
}

// Um batimento chegando de outra pessoa.
function batimento(chave, extra = {}) {
  return Object.assign({ k: chave, t: 'T-' + chave, m: 0, j: Date.now(), z: 0, novo: 0 }, extra);
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══ 0 — PRESENÇA POR BATIMENTO ══════════════════════════════════════════

test('batimento de alguém novo põe a pessoa na sala', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  S.ids.set('T-u2~zz', { id: 'u2', nome: 'Ana', avatar: null, plano: 'full' });
  I.aoBatimento(batimento('u2~zz'));
  assert.equal(I.contarPresentes(), 2, 'era exatamente o que a presence não entregava');
  assert.equal(S.presentes.get('u2~zz').ticket, 'T-u2~zz');
});

test('batimento PERDIDO não derruba ninguém — só a ausência sustentada', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  S.ids.set('T-u2~zz', { id: 'u2', nome: 'Ana', avatar: null, plano: 'full' });
  I.aoBatimento(batimento('u2~zz'));

  // Broadcast é fire-and-forget: três batimentos seguidos podem sumir.
  S.presentes.get('u2~zz').visto = Date.now() - 12000;
  I.varrer();
  assert.equal(I.contarPresentes(), 2, 'perder pacote não pode expulsar quem está falando');

  // Ausência sustentada (além do prazo) sim.
  S.presentes.get('u2~zz').visto = Date.now() - 15000;
  I.varrer();
  assert.equal(I.contarPresentes(), 1, 'quem parou de bater tem que sair da lista');
});

// ═══ AS DUAS VIDAS: a lista e a conexão ═════════════════════════════════
// Reprodução do teste real do dono (11/08): celular + computador no MESMO
// Wi-Fi, "conexões: 4" numa sala de DUAS pessoas, todas closed. A bancada
// isolou a cadeia: o socket de um lado cai (o escape HTTP do SDK também), o
// batimento dele some, e o outro lado — que nunca caiu — o expira em 14,03s e
// chama destruirPeer() + esquecerPar(). O canal do caído só volta ~8s depois da
// rede (backoff do SDK), ele reanuncia, o mesh reconstrói: ~22s por ciclo,
// 4 ciclos = 4 conexões. E como esquecerPar() zerava S.tentativas, o teto de
// MAX_TENTATIVAS nunca chegava: reconstrução infinita.

// Um peer de mentira com o estado que importa (é o pc que decide se há voz).
function peerFalso(estado) {
  return {
    pc: { close: () => {}, connectionState: estado, onicecandidate: null, ontrack: null, onconnectionstatechange: null },
    audio: null, remoto: null, g: 1, desde: Date.now(), tDesc: null, ouvi: 0, conectouEm: Date.now(),
  };
}

test('socket do outro cai: ele sai da LISTA mas a VOZ sobrevive', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  S.ids.set('T-u2~zz', { id: 'u2', nome: 'Ana', avatar: null, plano: 'full' });
  I.aoBatimento(batimento('u2~zz'));
  S.peers.set('u2~zz', peerFalso('connected'));   // áudio fluindo nos dois sentidos

  // 15s sem batimento: é exatamente o instante em que o dono perdia a voz.
  S.presentes.get('u2~zz').visto = Date.now() - 15000;
  I.varrer();

  assert.equal(S.peers.has('u2~zz'), true,
    'destruir a conexão de quem só perdeu o socket é O defeito: 4 conexões pra 2 pessoas');
  assert.equal(S.presentes.get('u2~zz').ausente > 0, true, 'mas a lista dele marca que oscilou');
  assert.equal(I.contarPresentes(), 2, 'e ele continua contado: eu ainda o ESTOU ouvindo');

  // Mesmo muito depois da carência: conexão viva não tem prazo.
  S.presentes.get('u2~zz').visto = Date.now() - 600000;
  I.varrer();
  assert.equal(S.peers.has('u2~zz'), true, 'conexão viva não expira por relógio de lista');
});

test('sem voz pra proteger, a ausência sustentada tira da lista como sempre', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  S.ids.set('T-u2~zz', { id: 'u2', nome: 'Ana', avatar: null, plano: 'full' });
  I.aoBatimento(batimento('u2~zz'));
  S.peers.delete('u2~zz');            // nunca abriu peer (é o caso do observador)
  S.presentes.get('u2~zz').visto = Date.now() - 15000;
  I.varrer();
  assert.equal(S.presentes.has('u2~zz'), false,
    'sem conexão nenhuma a proteger, a lista volta a ser a única prova');
});

test('peer em formação ganha a carência do apagão de canal, e ela vence', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  S.ids.set('T-u2~zz', { id: 'u2', nome: 'Ana', avatar: null, plano: 'full' });
  I.aoBatimento(batimento('u2~zz'));
  S.peers.set('u2~zz', peerFalso('connecting'));   // negociando quando o socket caiu
  S.presentes.get('u2~zz').visto = Date.now() - 15000;
  I.varrer();
  // ICE é P2P: uma negociação em curso pode fechar sozinha mesmo com o canal
  // fora. Medido: apagão de 45s deixou o canal fora 48,26s. Por isso a carência.
  assert.equal(S.peers.has('u2~zz'), true, 'matar negociação em curso reinicia tudo do zero à toa');
  assert.equal(I.contarPresentes(), 1, 'mas ele NÃO é anunciado como presente: não há voz nem batimento');

  // Vencida a carência sem nunca ter virado voz, aí sim desiste.
  S.presentes.get('u2~zz').ausente = Date.now() - 46000;
  I.varrer();
  assert.equal(S.presentes.has('u2~zz'), false);
  assert.equal(S.peers.has('u2~zz'), false, 'peer que nunca carregou áudio não fica pendurado pra sempre');
});

test('voltar a bater limpa a marca de ausência sem reconstruir a conexão', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  S.ids.set('T-u2~zz', { id: 'u2', nome: 'Ana', avatar: null, plano: 'full' });
  I.aoBatimento(batimento('u2~zz'));
  const peer = peerFalso('connected');
  S.peers.set('u2~zz', peer);
  S.presentes.get('u2~zz').visto = Date.now() - 15000;
  I.varrer();
  assert.equal(S.presentes.get('u2~zz').ausente > 0, true);

  // O canal dele voltou (~8s depois da rede, por causa do backoff do SDK).
  I.aoBatimento(batimento('u2~zz'));
  assert.equal(S.presentes.get('u2~zz').ausente, 0, 'quem voltou a bater voltou pra lista');
  assert.equal(S.peers.get('u2~zz'), peer,
    'e continua sendo O MESMO peer: reconstruir na volta era o que multiplicava conexão');
});

test('o orçamento de reconstruções NÃO é zerado por sumiço da lista', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  S.ids.set('T-u2~zz', { id: 'u2', nome: 'Ana', avatar: null, plano: 'full' });
  I.aoBatimento(batimento('u2~zz'));
  S.tentativas.set('u2~zz', 2);        // já gastou 2 das 3
  // Ciclo de sumiço-e-volta, que era o que comprava reconstruções infinitas.
  S.presentes.get('u2~zz').visto = Date.now() - 15000;
  I.varrer();
  I.aoBatimento(batimento('u2~zz'));
  assert.equal(S.tentativas.get('u2~zz'), 2,
    'esquecerPar() zerando o teto fazia MAX_TENTATIVAS nunca chegar — rebuild eterno');
});

test('ausente não me expulsa da sala cheia (nem ocupa vaga no desempate)', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  // 10 verificados que entraram antes de mim, mas TODOS oscilando: eu seria o
  // 11º e me retiraria sozinho por causa de gente que talvez nem esteja lá.
  for (let i = 0; i < 10; i++) {
    S.ids.set('T-v' + i + '~x', { id: 'v' + i, nome: 'V' + i, avatar: null, plano: 'full' });
    S.presentes.set('v' + i + '~x', { ticket: 'T-v' + i + '~x', mudo: 0, entrou: 1000 + i, visto: 0, ausente: Date.now() });
  }
  I.checarLotacao();
  assert.equal(S.entrei, true, 'perder a vaga por oscilação de socket dos outros seria expulsão por ruído');
});

// ═══ RECONEXÃO: reaproveitar o que continua bom ══════════════════════════
// Mídia é P2P e NÃO passa pelo Realtime: uma conexão de voz atravessa o apagão
// do canal sem nem saber que ele caiu. Refazer o mesh inteiro na volta do
// socket era o que multiplicava conexão.

test('socket volta: conexão boa é REAPROVEITADA, só a quebrada é mexida', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  const c = canalDePe(S);
  S.ids.set('T-boa~zz', { id: 'ub', nome: 'Boa', avatar: null, plano: 'full' });
  S.ids.set('T-a-ruim~zz', { id: 'ur', nome: 'Ruim', avatar: null, plano: 'full' });
  S.presentes.set('boa~zz', { ticket: 'T-boa~zz', mudo: 0, entrou: 1, visto: Date.now(), ausente: 0 });
  S.presentes.set('a-ruim~zz', { ticket: 'T-a-ruim~zz', mudo: 0, entrou: 2, visto: Date.now(), ausente: 0 });
  const boa = peerFalso('connected');
  const ruim = peerFalso('failed');
  S.peers.set('boa~zz', boa);
  S.peers.set('a-ruim~zz', ruim);

  I.revisarPeers();

  assert.equal(S.peers.get('boa~zz'), boa,
    'renegociar quem já está entregando áudio é justamente o que fazia 4 conexões pra 2 pessoas');
  assert.equal(S.peers.has('a-ruim~zz'), false, 'a que falhou de verdade tem que ser refeita');
  assert.equal(c.eventos('opa').length, 1, 'e o lado que não oferta pede a oferta do outro');
});

test('oferta perdida no apagão é REPETIDA antes de gastar orçamento', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  const c = canalDePe(S);
  const p = peerFalso('connecting');
  p.pc.signalingState = 'have-local-offer';       // minha oferta está de pé
  p.pc.localDescription = { type: 'offer', sdp: 'v=0' };
  S.peers.set('u2~zz', p);

  assert.equal(I.reenviarOferta('u2~zz'), true);
  const sdps = c.eventos('sdp');
  assert.equal(sdps.length, 1, 'broadcast não tem replay: a mensagem do apagão simplesmente sumiu');
  assert.equal(sdps[0].payload.tipo, 'offer');
  assert.equal(sdps[0].payload.g, p.g, 'repetir a MESMA oferta não muda a geração nem cria peer');
  assert.equal(S.peers.get('u2~zz'), p, 'e não destrói nada');
  assert.equal((S.tentativas.get('u2~zz') || 0), 0, 'o caminho barato não pode custar orçamento');

  // Sem oferta pendente não há o que repetir — aí sim os caminhos caros valem.
  p.pc.signalingState = 'stable';
  assert.equal(I.reenviarOferta('u2~zz'), false);
});

// ═══ REPARO POR SINAL DA PRÓPRIA CONEXÃO ════════════════════════════════
// "faixa recebida: audio · ended · muted=true" com "analisadores: 5, todos rms
// 0.00000": conexão que se diz 'connected' e não entrega um pacote. Quem manda
// reparar é a faixa, nunca a lista.

test('conexão que nunca entregou áudio é reparada (e a que entregou, não)', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  const c = canalDePe(S);
  S.presentes.set('a-mudo~zz', { ticket: 'T1', mudo: 0, entrou: 1, visto: Date.now(), ausente: 0 });
  const p = peerFalso('connected');
  p.ouvi = 0;                        // a faixa nunca desmutou: rms 0.00000
  S.peers.set('a-mudo~zz', p);
  assert.equal(I.ouvindo(p), false);

  I.repararPorAudio('a-mudo~zz', 'teste');
  assert.equal(c.eventos('opa').length, 1, 'conectado e mudo é defeito, não silêncio');

  // Throttle: um par teimoso não pode virar reparo em loop.
  I.repararPorAudio('a-mudo~zz', 'teste');
  assert.equal(c.eventos('opa').length, 1, 'sem throttle o reparo vira o próprio loop que ele conserta');

  // E quem JÁ entregou áudio não é reparado por silêncio: com DTX (usedtx=1) o
  // silêncio corta o fluxo, e mutar depois de ter falado é normal.
  const bom = peerFalso('connected');
  bom.ouvi = Date.now();
  assert.equal(I.ouvindo(bom), true);
});

// O sinal de áudio é INDIRETO: navegador que não dispara 'unmute', pessoa que
// entrou muda, DTX cortando o fluxo. Por isso ele pode insistir no caminho
// barato, mas NUNCA destruir — derrubar uma conexão possivelmente boa por causa
// dele seria repetir exatamente o defeito que este conserto existe pra matar.
test('reparo por áudio tem teto e NUNCA destrói a conexão', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  const c = canalDePe(S);
  S.presentes.set('a-mudo~zz', { ticket: 'T1', mudo: 0, entrou: 1, visto: Date.now(), ausente: 0 });
  const peer = peerFalso('connected');
  S.peers.set('a-mudo~zz', peer);
  for (let i = 0; i < 8; i++) {
    const reg = S.reparoAudio.get('a-mudo~zz') || { n: 0 };
    S.reparoAudio.set('a-mudo~zz', { quando: 0, n: reg.n });   // vence o throttle
    I.repararPorAudio('a-mudo~zz', 'teste');
  }
  assert.equal(c.eventos('opa').length, 3, 'insiste no barato até o teto e para');
  assert.equal(S.peers.get('a-mudo~zz'), peer, 'e não derruba: o sinal pode estar errado');
  assert.equal(S.semRota.has('a-mudo~zz'), false, 'nem desiste do par por um sinal indireto');
  assert.equal((S.tentativas.get('a-mudo~zz') || 0), 0, 'orçamento de reconstrução é de outro dono');
});

test('quem entrou MUDO não é confundido com conexão quebrada', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  // "Entrar mudo (só ouvir)" é um dos dois botões do modal: sem esta guarda,
  // metade das entradas viraria alvo de reparo pra sempre.
  S.presentes.set('a-x~zz', { ticket: 'T1', mudo: true, entrou: 1, visto: Date.now(), ausente: 0 });
  const p = peerFalso('connected');
  p.conectouEm = Date.now() - 60000;   // conectado faz um minuto, sem um pacote
  p.ouvi = 0;
  S.peers.set('a-x~zz', p);
  assert.equal(I.ouvindo(p), false, 'de fato não chegou áudio — e está certo assim');
});

test('faixa viva e não muda vale como prova de áudio (sem depender do evento)', () => {
  const { I } = carregarSala();
  const p = peerFalso('connected');
  p.ouvi = 0;
  p.remoto = { getAudioTracks: () => [{ readyState: 'live', muted: true }] };
  assert.equal(I.ouvindo(p), false, 'faixa muda não prova nada');
  p.remoto = { getAudioTracks: () => [{ readyState: 'live', muted: false }] };
  assert.equal(I.ouvindo(p), true, 'nem todo navegador dispara unmute de faixa remota');
  assert.ok(p.ouvi > 0, 'e a prova LATCHA: com DTX o silêncio corta o fluxo e isso é normal');
});

test('conexão que falhou de par AUSENTE não é reconstruída (não há com quem)', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  S.presentes.set('a-x~zz', { ticket: 'T1', mudo: 0, entrou: 1, visto: 0, ausente: Date.now() });
  S.peers.set('a-x~zz', peerFalso('failed'));
  const c = canalDePe(S);
  I.revisarPeers();                        // é quem chama recuperar() no 'failed'
  assert.equal(S.peers.has('a-x~zz'), false, 'a conexão morta é desfeita');
  assert.equal((S.tentativas.get('a-x~zz') || 0), 0,
    'mas sem gastar orçamento: o socket do outro está fora, a oferta não chegaria');
  assert.equal(c.eventos('opa').length, 0, 'e sem cutucar um socket que não existe');
});

test('reparo por áudio não cutuca par ausente (a mensagem não chegaria)', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  const c = canalDePe(S);
  S.presentes.set('a-x~zz', { ticket: 'T1', mudo: 0, entrou: 1, visto: 0, ausente: Date.now() });
  S.peers.set('a-x~zz', peerFalso('connected'));
  I.repararPorAudio('a-x~zz', 'teste');
  assert.equal(c.eventos('opa').length, 0);
});

test('reparo não age em par que já desistimos (semRota) nem fora da sala', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  const c = canalDePe(S);
  S.presentes.set('a-x~zz', { ticket: 'T1', mudo: 0, entrou: 1, visto: Date.now(), ausente: 0 });
  S.peers.set('a-x~zz', peerFalso('connected'));
  S.semRota.add('a-x~zz');
  I.repararPorAudio('a-x~zz', 'teste');
  assert.equal(c.eventos('opa').length, 0, 'a nota "sem conexão direta" tem que ficar estável');
  S.semRota.delete('a-x~zz');
  S.entrei = false;
  I.repararPorAudio('a-x~zz', 'teste');
  assert.equal(c.eventos('opa').length, 0, 'observador não negocia áudio com ninguém');
});

// ═══ O send() QUE MENTE ═════════════════════════════════════════════════
// Medido: com o WebSocket morto o SDK escapa por HTTP e devolve 'ok' (9 de 9
// sondas). Quando o HTTP também morre — o console do dono — ele pendura 10s
// (DEFAULT_TIMEOUT) antes de falhar, e o enviarFirme repetia 3x: 30s por
// candidato ICE. A espera passou a ser nossa.

test('envio que pendura desiste no nosso prazo, não nos 10s do SDK', async () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  S.canal = { send: () => new Promise(() => {}) };   // nunca resolve: HTTP também fora
  S.sub = 'on';
  const t0 = Date.now();
  const ok = await I.enviar('bat', { k: S.sessao });
  const levou = Date.now() - t0;
  assert.equal(ok, false, 'o reenvio precisa saber que não foi');
  assert.ok(levou < 5000, `esperou ${levou}ms — o ponto era não pendurar 10s por mensagem`);
});

// A REPRODUÇÃO DO CONSOLE DO DONO, ponta a ponta.
// Sala de 2 (celular + computador, mesmo Wi-Fi). O socket de A cai — e o escape
// HTTP do SDK também, que foi o ERR_CONNECTION_TIMED_OUT no /api/broadcast.
// B nunca caiu, então a lista de B nunca congela e a varredura dele roda o
// tempo todo. Antes: B expirava A em 14,0s e destruía a conexão; A voltava ~8s
// depois da rede (backoff) e o mesh reconstruía. ~22s por ciclo, 4 ciclos =
// "conexões: 4" numa sala de duas pessoas.
test('sala de 2 com apagão de socket de um lado: UMA conexão, não quatro', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);          // eu sou B, o lado que nunca cai
  canalDePe(S);
  S.ids.set('T-a~zz', { id: 'ua', nome: 'A', avatar: null, plano: 'full' });
  I.aoBatimento(batimento('a~zz'));
  const conexao = peerFalso('connected');
  S.peers.set('a~zz', conexao);           // voz fluindo nos dois sentidos

  const t0 = Date.now();
  // Apagão de 28s (o medido pra uma queda de rede de 20s: 20s fora + backoff do
  // SDK). A varredura de B roda a cada batimento — 7 voltas.
  for (let i = 1; i <= 7; i++) {
    S.presentes.get('a~zz').visto = t0 - i * 4000;
    I.varrer();
  }
  assert.equal(S.peers.get('a~zz'), conexao, 'a conexão tem que ATRAVESSAR o apagão inteira');
  assert.equal(S.presentes.get('a~zz').ausente > 0, true, 'a lista dele marca oscilação');
  assert.equal(I.contarPresentes(), 2, 'e ele continua contado: eu ainda o ouço');

  // O canal de A volta e ele reanuncia.
  I.aoBatimento(batimento('a~zz', { novo: 1 }));
  assert.equal(S.presentes.get('a~zz').ausente, 0);
  assert.equal(S.peers.get('a~zz'), conexao, 'MESMA conexão: nada foi reconstruído');
  assert.equal(S.peers.size, 1, 'era exatamente aqui que nasciam as 4 conexões');
  assert.equal((S.tentativas.get('a~zz') || 0), 0, 'e nenhum orçamento foi gasto');

  // Três ciclos iguais (foi o que o relatório contou): continua UMA conexão.
  for (let ciclo = 0; ciclo < 3; ciclo++) {
    for (let i = 1; i <= 7; i++) {
      S.presentes.get('a~zz').visto = Date.now() - i * 4000;
      I.varrer();
    }
    I.aoBatimento(batimento('a~zz', { novo: 1 }));
  }
  assert.equal(S.peers.size, 1, 'conexões: 4 pra 2 pessoas era o sintoma — agora é 1');
  assert.equal(S.peers.get('a~zz'), conexao);
});

test('quem bloqueia a tela avisa e ganha prazo longo (não é expulso)', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  I.aoBatimento(batimento('u2~zz', { z: 1 }));
  // Aba de fundo no Chrome bate 1x por MINUTO: com o prazo normal (14s) a
  // pessoa cairia da sala só por guardar o celular no bolso.
  S.presentes.get('u2~zz').visto = Date.now() - 65000;
  I.varrer();
  assert.equal(S.presentes.has('u2~zz'), true, 'tela apagada não é sair da sala');
  S.presentes.get('u2~zz').visto = Date.now() - 101000;
  I.varrer();
  assert.equal(S.presentes.has('u2~zz'), false, 'mas o prazo longo é prazo, não licença eterna');
});

test('eu mesmo NUNCA expiro da minha lista', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  S.presentes.get(S.sessao).visto = Date.now() - 600000;
  I.varrer();
  assert.equal(I.contarPresentes(), 1, 'quem está com o microfone aberto não some do próprio painel');
});

test('lista CONGELA com o canal fora do ar (socket caído ≠ sala vazia)', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  I.aoBatimento(batimento('u2~zz'));
  S.presentes.get('u2~zz').visto = Date.now() - 60000;
  S.sub = 'erro';
  I.varrer();
  assert.equal(S.presentes.has('u2~zz'), true, 'sem canal não chega batimento de ninguém: apagar a sala seria mentir');
  assert.equal(I.listaConfiavel(), false, 'e o mesh não pode podar peer nenhum nesse estado');
  S.sub = 'on';
  I.varrer();
  assert.equal(S.presentes.has('u2~zz'), false);
});

test('durante o censo ninguém expira (é a volta da tela bloqueada)', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  I.aoBatimento(batimento('u2~zz'));
  S.presentes.get('u2~zz').visto = Date.now() - 60000;   // ninguém bateu enquanto congelado
  S.censoAte = Date.now() + 1500;                        // acabei de perguntar
  I.varrer();
  assert.equal(S.presentes.has('u2~zz'), true, 'a sala inteira sumiria antes da primeira resposta chegar');
  assert.equal(I.listaConfiavel(), false);
});

test("'tchau' tira a pessoa na hora, sem esperar prazo", () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  I.aoBatimento(batimento('u2~zz'));
  assert.equal(I.contarPresentes(), 2);
  I.aoTchau({ k: 'u2~zz' });
  assert.equal(I.contarPresentes(), 1, 'saída limpa não pode deixar fantasma por 14s');
});

test('"cheguei" faz os outros responderem NA HORA (e uma vez só)', async () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  const c = canalDePe(S);
  // Dez chegadas no mesmo instante: se cada uma virasse uma resposta, uma sala
  // cheia entrando junto viraria tempestade.
  for (let i = 0; i < 10; i++) I.aoBatimento(batimento('u' + i + '~zz', { novo: 1 }));
  await esperar(600);
  const bats = c.eventos('bat');
  assert.equal(bats.length, 1, 'resposta ao censo tem jitter e throttle');
  assert.equal(bats[0].payload.k, S.sessao);
  assert.equal(bats[0].payload.t, 'TICKET-DONO', 'a resposta é um batimento de verdade, com ticket');
});

test('observador não bate — só escuta e pergunta', async () => {
  const { S, I } = carregarSala();
  const c = canalDePe(S);
  S.cfg = { ticket: 'T', canal: 'x', max: 10, me: { id: 'u9', nome: 'X' }, expira_em: Date.now() + 3600000 };
  S.sessao = 'u9~ob';
  S.entrei = false;
  I.aoBatimento(batimento('u2~zz', { novo: 1 }));
  await esperar(600);
  assert.equal(c.eventos('bat').length, 0, 'quem não entrou não pode aparecer pra ninguém');
  I.pedirCenso();
  const ois = c.eventos('oi');
  assert.equal(ois.length, 1, 'mas ele PERGUNTA: é assim que o contador da entrada nasce cheio');
  assert.equal(ois[0].payload.k, '', 'sem chave e sem ticket: pergunta, não presença');
});

test('mutar manda batimento, não "cheguei", e não reescreve a hora de entrada', () => {
  const { SV, S, I } = carregarSala();
  entrarNaSala(S, I);
  const c = canalDePe(S);
  const entrouEm = S.entrouEm;
  S.stream = { getAudioTracks: () => [{ enabled: true }], getTracks: () => [] };
  SV.mudo();
  const bats = c.eventos('bat');
  assert.equal(c.eventos('oi').length, 0, 'clicar em Mudo não pode fazer a sala inteira responder');
  assert.equal(bats.length, 1);
  assert.equal(bats[0].payload.m, 1);
  assert.equal(bats[0].payload.j, entrouEm,
    'mutar reescrevendo a hora de entrada faria quem muta ser o expulso da sala cheia');
  assert.equal(S.presentes.get(S.sessao).entrou, entrouEm);
});

test('a hora de entrada de um par não é reescrita por batimento posterior', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  I.aoBatimento(batimento('u2~zz', { j: 1000 }));
  I.aoBatimento(batimento('u2~zz', { j: 9999999999999 }));
  assert.equal(S.presentes.get('u2~zz').entrou, 1000, 'a ordem de chegada é o desempate da sala cheia');
});

test('batimento com a MINHA chave é ignorado (ninguém me reescreve)', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  I.aoBatimento({ k: S.sessao, t: 'TICKET-FORJADO', m: 1, j: 1 });
  assert.equal(S.presentes.get(S.sessao).ticket, 'TICKET-DONO');
  assert.equal(S.presentes.get(S.sessao).mudo, false);
  I.aoTchau({ k: S.sessao });
  assert.equal(I.contarPresentes(), 1, 'nem um "tchau" forjado me tira da minha própria sala');
});

test('a lista tem teto: canal aberto não vira despejo de chaves inventadas', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  for (let i = 0; i < 200; i++) I.aoBatimento(batimento('lixo' + i + '~x'));
  assert.ok(S.presentes.size <= 16, `lista sem teto (${S.presentes.size} registros)`);
  assert.ok(S.presentes.has(S.sessao), 'e o meu registro não pode ser empurrado pra fora por lixo');
});

test('batimento sem ticket não entra na lista', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  I.aoBatimento({ k: 'u2~zz', m: 0, j: Date.now() });
  I.aoBatimento({ k: 'u3~zz', t: '', m: 0, j: Date.now() });
  assert.equal(I.contarPresentes(), 1, 'sem ticket não há como o servidor dizer quem é: não é participante');
});

test("sair manda 'tchau' com o canal ainda vivo", () => {
  const { SV, S, I, document } = carregarSala();
  registrarConfirmacao(document);
  entrarNaSala(S, I);
  const c = canalDePe(S);
  SV.sair('');
  const tchaus = c.eventos('tchau');
  assert.equal(tchaus.length, 1, 'sem tchau a pessoa fica fantasma até expirar na sala que deixou');
  assert.equal(tchaus[0].payload.k, 'u-dono~ab12', 'e tem que sair ANTES de a sessão ser zerada');
  assert.equal(S.entrei, false);
});

// O teto de 10 continua valendo, mas quem me EXPULSA da conversa tem que ser
// gente verificada. Com presença por broadcast qualquer um despeja batimento
// com ticket desconhecido — sem esse cuidado, encher o canal de lixo tiraria
// pessoas de verdade da sala.
test('enxurrada de batimentos desconhecidos NÃO me expulsa da sala', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  for (let i = 0; i < 14; i++) I.aoBatimento(batimento('lixo' + i + '~x', { j: 1 }));
  assert.equal(S.entrei, true, 'sair por causa de tickets que ninguém confirmou seria expulsão por spam');
  assert.ok(S.presentes.has(S.sessao));
});

test('mas o teto de 10 continua valendo entre gente verificada', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  // 10 verificados que entraram ANTES de mim: eu sou o 11º e me retiro sozinho.
  for (let i = 0; i < 10; i++) {
    S.ids.set('T-v' + i + '~x', { id: 'v' + i, nome: 'V' + i, avatar: null, plano: 'full' });
    I.aoBatimento(batimento('v' + i + '~x', { j: 1000 + i }));
  }
  assert.equal(S.entrei, false, 'sala cheia: quem chegou por último se retira, em vez de furar o limite');
});

test('bloquear a tela manda o último batimento marcado', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  const c = canalDePe(S);
  I.suspender();
  const bats = c.eventos('bat');
  assert.equal(bats.length, 1, "'freeze'/'visibilitychange' disparam antes do congelamento: dá tempo de avisar");
  assert.equal(bats[0].payload.z, 1, 'sem esse aviso os outros me expulsam em 14s por sumiço');
});

// ═══ BUG 1 — a pessoa TEM que se ver e ser contada ═══════════════════════

test('sala vazia: o dono entra, se conta e ganha o próprio card', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);

  assert.equal(I.contarPresentes(), 1, 'era o "0 pessoas" do painel');
  assert.ok(S.presentes.has(S.sessao), 'o próprio registro tem que existir localmente');

  const card = I.cardHTML(S.sessao, S.presentes.get(S.sessao));
  assert.match(card, /Você/, 'o card do próprio usuário sumia da grade');
  assert.doesNotMatch(card, /não verificado/, 'eu nunca sou fantasma pra mim mesmo');
});

test('o card mostra a conexão oscilando em vez de sumir com quem se ouve', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  S.ids.set('T-u2~zz', { id: 'u2', nome: 'Ana', avatar: null, plano: 'full' });
  I.aoBatimento(batimento('u2~zz'));
  S.peers.set('u2~zz', peerFalso('connected'));
  S.presentes.get('u2~zz').visto = Date.now() - 15000;
  I.varrer();

  const card = I.cardHTML('u2~zz', S.presentes.get('u2~zz'));
  assert.match(card, /svz-p oscila|oscila/, 'o card tem que dizer que o sinal dela oscila');
  assert.match(card, /continua ouvindo/, 'e que o áudio segue — é a informação que importa');
  assert.doesNotMatch(card, /caiu/, 'oscilar não é ter caído: a voz está chegando');
  assert.match(card, /Ana/);

  // Eu nunca oscilo pra mim mesmo.
  assert.doesNotMatch(I.cardHTML(S.sessao, S.presentes.get(S.sessao)), /oscila/);
});

test('sala silenciosa não apaga quem está nela', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  // Sala de uma pessoa só: NADA chega pelo canal, nunca. Era exatamente aqui
  // que a presence deixava a pessoa com "0 pessoas · 1 falando".
  canalDePe(S);
  I.varrer();
  assert.equal(I.contarPresentes(), 1, 'zerou a contagem de quem está com o mic aberto');
  assert.ok(S.presentes.has(S.sessao));
});

test('sala com os outros: eu continuo na lista junto com eles', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  S.ids.set('T-u2~zz', { id: 'u2', nome: 'Ana', avatar: null, plano: 'full' });
  I.aoBatimento(batimento('u2~zz'));
  I.varrer();
  assert.equal(I.contarPresentes(), 2);
  assert.ok(S.presentes.has(S.sessao), 'a lista dos outros não pode me apagar da minha');
});

// ═══ BUG 1c — a lista congelada não pode cegar a poda do mesh ════════════
// O mesh derruba peer de quem saiu da lista. Se ele podasse com a lista
// CONGELADA (socket caído, censo em curso), uma oscilação de rede derrubaria o
// áudio de quem não saiu — exatamente o que a carência sempre existiu pra
// evitar. O sinal é o listaConfiavel(), e ele é conservador de propósito.

test('mesh NÃO poda peer enquanto a lista está congelada', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  // Peer que nunca conectou: não há voz pra proteger, então é a lista que manda.
  const peer = { pc: { close: () => {}, connectionState: 'connecting' }, audio: null, g: 1, desde: Date.now(), tDesc: null };
  S.peers.set('u2~zz', peer);          // par que já não está mais na lista
  S.sumido.set('u2~zz', Date.now() - 60000);   // carência já vencida
  S.sub = 'erro';                              // socket piscou
  I.mesh();
  assert.equal(S.peers.has('u2~zz'), true, 'derrubar áudio por oscilação de rede é o defeito, não o conserto');
  assert.equal(I.listaConfiavel(), false);
  // Com a lista confiável de novo, o par que realmente saiu tem que cair.
  S.sub = 'on';
  I.mesh();
  assert.equal(S.peers.has('u2~zz'), false, 'peer de quem saiu não pode ficar pendurado pra sempre');
});

// A REGRA NOVA, e a que este conserto inteiro existe pra impor: mesmo com a
// lista confiável, mesmo com a carência vencida, mesmo o par tendo sumido do
// registro — conexão que está ENTREGANDO ÁUDIO não é derrubada por decisão de
// lista. No teste real do dono foram 4 RTCPeerConnection numa sala de 2 pessoas
// porque o sumiço do batimento destruía a voz de quem só tinha perdido o socket.
test('mesh NUNCA poda peer com voz viva, mesmo com a lista confiável', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  S.peers.set('u2~zz', {
    pc: { close: () => {}, connectionState: 'connected' },
    audio: null, g: 1, desde: Date.now(), tDesc: null,
  });
  S.sumido.set('u2~zz', Date.now() - 600000);   // carência vencida faz 10 minutos
  assert.equal(I.listaConfiavel(), true, 'lista confiável: é o pior caso pro peer');
  I.mesh();
  assert.equal(S.peers.has('u2~zz'), true, 'a conexão é fato; a lista é boato');
  assert.equal(I.vozViva('u2~zz'), true);
});

test("'disconnected' conta como voz viva (oscila e volta sozinho)", () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  const estados = {
    connected: true, completed: true, disconnected: true,
    new: false, connecting: false, failed: false, closed: false,
  };
  Object.keys(estados).forEach((est) => {
    S.peers.set('u2~zz', { pc: { close: () => {}, connectionState: est }, audio: null, g: 1, desde: Date.now(), tDesc: null });
    assert.equal(I.vozViva('u2~zz'), estados[est], `vozViva('${est}') divergiu`);
  });
  S.peers.delete('u2~zz');
  assert.equal(I.vozViva('u2~zz'), false, 'sem peer não há voz');
});

test("'disconnected' NÃO ganha proteção sem prazo (só quem entrega ganha)", () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  S.ids.set('T-u2~zz', { id: 'u2', nome: 'Ana', avatar: null, plano: 'full' });
  I.aoBatimento(batimento('u2~zz'));
  S.peers.set('u2~zz', peerFalso('disconnected'));
  S.presentes.get('u2~zz').visto = Date.now() - 15000;
  I.varrer();
  assert.equal(S.peers.has('u2~zz'), true, 'oscilação de verdade cabe na carência');
  // Se um navegador segurasse 'disconnected' pra sempre, quem foi embora nunca
  // sairia da lista. A carência é o teto disso.
  S.presentes.get('u2~zz').ausente = Date.now() - 46000;
  I.varrer();
  assert.equal(S.presentes.has('u2~zz'), false, "'disconnected' eterno não pode virar presença eterna");
  assert.equal(I.vozEntregando('u2~zz'), false);
});

test('lista confiável é canal de pé E fora de censo', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  canalDePe(S);
  assert.equal(I.listaConfiavel(), true);
  S.censoAte = Date.now() + 1000;
  assert.equal(I.listaConfiavel(), false, 'durante o censo a lista ainda está se formando');
  S.censoAte = 0; S.sub = 'off';
  assert.equal(I.listaConfiavel(), false);
});

test('entrar recoloca a lista em quarentena (nada expira antes de responder)', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  const c = canalDePe(S);
  I.anunciar();
  assert.ok(S.censoAte > Date.now(), 'sem quarentena, a volta da tela bloqueada apagaria a sala');
  assert.equal(I.listaConfiavel(), false);
  assert.equal(c.eventos('oi').length, 1, 'anunciar é o "cheguei": pergunta e se apresenta na mesma mensagem');
  assert.equal(c.eventos('oi')[0].payload.novo, 1, 'sem o pedido, os outros só apareceriam no próximo ciclo');
  I.pararBatimento();   // o relógio do batimento seguraria o processo de teste
});

test('falha no `verificar` não me transforma em fantasma', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  // Simula o pior caso: o servidor recusou até o MEU ticket.
  S.ids.delete('TICKET-DONO');
  S.ruins.set('TICKET-DONO', Date.now());
  assert.equal(I.fantasma(S.presentes.get(S.sessao), S.sessao), false);
  assert.equal(I.contarPresentes(), 1, 'a pessoa sumia do próprio painel');
  // e a regra continua valendo pros outros
  assert.equal(I.fantasma({ ticket: 'TICKET-DONO' }, 'outra~chave'), true);
});

// ═══ BUG 1b — coerência: falando <= pessoas ══════════════════════════════

test('"0 pessoas · 1 falando" é impossível: falando é subconjunto de presentes', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  S.falando.add(S.sessao);
  assert.ok(I.contarFalando() <= I.contarPresentes());

  // medidor sobrevivendo a quem já saiu da presence (o caso que gerava o
  // número mentiroso): não pode contar como "falando".
  S.falando.add('u9~fantasma');
  assert.equal(I.contarFalando(), 1);
  assert.ok(I.contarFalando() <= I.contarPresentes());

  // e nem quando NINGUÉM está presente
  S.presentes.clear(); S.entrei = false;
  assert.equal(I.contarPresentes(), 0);
  assert.equal(I.contarFalando(), 0, 'era literalmente o "0 pessoas · 1 falando"');
});

test('fantasma não conta como falando', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  S.presentes.set('u3~qq', { ticket: 'T-RUIM', mudo: 0, entrou: Date.now() });
  S.ruins.set('T-RUIM', Date.now());
  S.falando.add('u3~qq');
  assert.equal(I.contarPresentes(), 1);
  assert.equal(I.contarFalando(), 0);
});

// ═══ MELHORIA 3 — timbres de entrar/sair ════════════════════════════════

function carregarSom() {
  const ouvintes = {};
  const criados = [];
  function Osc() {
    this.frequency = { value: 0, setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} };
    this.connect = () => {}; this.start = () => {}; this.stop = () => {};
    criados.push(this);
  }
  function Ganho() {
    this.gain = { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} };
    this.connect = () => {};
  }
  const ctx = {
    window: {}, console,
    document: {
      addEventListener: (ev, fn) => { (ouvintes[ev] = ouvintes[ev] || []).push(fn); },
      _disparar: (ev) => (ouvintes[ev] || []).forEach((f) => f({})),
    },
    localStorage: (() => {
      const m = new Map();
      return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
    })(),
    Date, Math, JSON, String, Number, Array, Object,
  };
  ctx.window.AudioContext = function () {
    this.state = 'running'; this.currentTime = 0;
    this.createOscillator = () => new Osc();
    this.createGain = () => new Ganho();
    this.destination = {};
    this.resume = () => {};
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(SOM, ctx, { filename: 'som-notificacao.js' });
  return { BTSom: ctx.window.BTSom, document: ctx.document, criados };
}

test('BTSom ganhou entrou() e saiu() sem perder o tocar() do sininho', () => {
  const { BTSom } = carregarSom();
  assert.equal(typeof BTSom.tocar, 'function', 'o sininho e o suporte dependem dele');
  assert.equal(typeof BTSom.entrou, 'function');
  assert.equal(typeof BTSom.saiu, 'function');
  assert.equal(typeof BTSom.alternar, 'function');
});

test('regra de autoplay: sem gesto do usuário, nada toca (e nada estoura)', () => {
  const { BTSom, criados } = carregarSom();
  assert.equal(BTSom.entrou(), false, 'contexto de áudio só nasce depois do primeiro clique');
  assert.equal(BTSom.saiu(), false);
  assert.equal(criados.length, 0);
});

test('depois do gesto, entrar e sair são timbres distintos e ambos tocam', () => {
  const { BTSom, document, criados } = carregarSom();
  document._disparar('click');
  assert.equal(BTSom.entrou(), true);
  const apósEntrar = criados.length;
  assert.ok(apósEntrar >= 2, 'entrar é subindo, com mais de um tom');
  assert.equal(BTSom.saiu(), true, 'sair tem contador próprio, não herda o de entrar');
  assert.ok(criados.length > apósEntrar);
});

test('rajada de entradas não vira metralhadora', () => {
  const { BTSom, document } = carregarSom();
  document._disparar('click');
  // 10 chegadas no mesmo instante: só as primeiras podem soar.
  let tocou = 0;
  for (let i = 0; i < 10; i++) if (BTSom.entrou()) tocou++;
  assert.equal(tocou, 1, 'o mesmo timbre tem intervalo mínimo');
  let total = tocou;
  for (let i = 0; i < 10; i++) if (BTSom.saiu()) total++;
  assert.ok(total <= 3, `teto da janela não respeitado (tocou ${total}x)`);
});

test('desligar o som no localStorage cala os timbres novos também', () => {
  const ctx = carregarSom();
  ctx.document._disparar('click');
  // simula a preferência 'off' trocando o leitor por baixo é frágil;
  // o alternar() é a porta pública e faz exatamente isso.
  ctx.BTSom.alternar();                    // liga -> 'off'
  assert.equal(ctx.BTSom.entrou(), false, 'som desligado tem que valer pra entrar/sair');
});

// ═══ MELHORIA 4 — confirmação antes de sair ═════════════════════════════

test('o botão Sair pede confirmação em vez de sair na hora', () => {
  assert.match(SALA, /\$\('svzBSair'\)\.addEventListener\('click', abrirConfirmacaoSaida\)/,
    'clique no Sair não pode mais chamar sair() direto');
  assert.match(SALA, /id="svzBSairSim"/, 'precisa do botão que confirma');
  assert.match(SALA, /id="svzBFicar"/, 'precisa da saída rápida da pergunta');
  assert.match(SALA, /\$\('svzBSairSim'\)\.addEventListener\('click', function \(\) \{ sair\(''\); \}\)/);
});

test('a confirmação usa o painel, nunca o confirm() do navegador', () => {
  const codigo = SALA.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(codigo, /(^|[^.\w])confirm\s*\(/m, 'confirm() trava a thread e engasga o áudio');
  assert.match(SALA, /\.svz-conf\{position:absolute/, 'a pergunta vive dentro do dock');
});

test('Esc e clique fora dispensam a confirmação', () => {
  assert.match(SALA, /e\.key === 'Escape' && confirmacaoAberta\(\)/);
  assert.match(SALA, /window\.PointerEvent \? 'pointerdown' : 'mousedown'/);
  assert.match(SALA, /if \(caixa && caixa\.contains\(e\.target\)\) return;/,
    'clicar nos próprios botões não pode fechar a pergunta');
});

test('saída programática (sala cheia, ticket vencido) NÃO pede confirmação', () => {
  // sair() continua sendo a porta direta; só o BOTÃO passa pela pergunta.
  assert.match(SALA, /sair\('A sala encheu bem na hora/);
  assert.match(SALA, /sair\('Sua sessão da Comunidade expirou/);
  assert.match(SALA, /function sair\(motivo\)[\s\S]{0,2000}fecharConfirmacaoSaida\(\)/,
    'sair() tem que limpar a pergunta que ficou aberta');
});

// ═══ Cache-busting e carregamento ═══════════════════════════════════════

test('comunidade.html carrega o som ANTES da sala e com ?v= novo', () => {
  const iSom = HTML.indexOf('/som-notificacao.js?v=');
  const iSala = HTML.indexOf('/sala-voz.js?v=');
  assert.ok(iSom > 0, 'sem som-notificacao.js na página, BTSom não existe na Comunidade');
  assert.ok(iSom < iSala, 'o som tem que vir antes da sala');
  // Fixar a versão exata fazia o teste quebrar a CADA bump — e um teste que
  // quebra por motivo certo vira ruído que a gente aprende a ignorar. O que
  // precisa ser garantido é TER versão, não qual.
  assert.match(HTML, /sala-voz\.js\?v=[a-z0-9]+/, 'o .js precisa de ?v= (Vercel cacheia 4h)');
});

test('sala continua funcionando se o som não carregar', () => {
  assert.match(SALA, /if \(window\.BTSom && typeof window\.BTSom\[nome\] === 'function'\)/,
    'BTSom é opcional: um bipe não pode derrubar a sala');
});

// ═══ BUG 2 — 403 da presença do suporte ═════════════════════════════════

test('o SQL adiciona a policy de SELECT que o ON CONFLICT exige', () => {
  assert.match(SQL_FIX, /create policy presenca_select_own on support_presenca\s+for select to authenticated using \(auth\.uid\(\) = user_id\)/,
    'sem SELECT, o INSERT ... ON CONFLICT DO UPDATE falha com 42501 -> 403');
  assert.match(SQL_FIX, /with check \(auth\.uid\(\) = user_id\)/, 'o UPDATE precisa dos dois lados');
  assert.match(SQL_FIX, /drop policy if exists/, 'tem que ser idempotente');
  assert.match(SQL_FIX, /create or replace function public\.support_ping\(\)/);
  assert.match(SQL_FIX, /set search_path = public, pg_temp/,
    'SECURITY DEFINER sem search_path fixo é sequestrável');
  assert.doesNotMatch(SQL_FIX, /support_ping\(\s*p_user/, 'o dono da linha sai de auth.uid(), não de argumento');
});

test('a privacidade original continua de pé: ninguém vê a presença alheia', () => {
  assert.match(SQL_FIX, /for select to authenticated using \(auth\.uid\(\) = user_id\)/);
  assert.doesNotMatch(SQL_FIX, /for select[\s\S]{0,80}using \(true\)/);
});

test('o front tolera o SQL ainda não ter rodado e para de poluir o console', () => {
  assert.match(SUPORTE, /rpc\/support_ping/, 'caminho preferido');
  assert.match(SUPORTE, /on_conflict=user_id/, 'reserva não depende da inferência do PostgREST');
  assert.match(SUPORTE, /function idDoToken/, 'user_id explícito, sem depender do DEFAULT auth.uid()');
  assert.match(SUPORTE, /if \(presencaMuda\(\)\) return;/,
    'só para de mandar o request é que o console para de mostrar o 403');
  assert.match(SUPORTE, /console\.debug/, 'log discreto, não console.error');
  assert.doesNotMatch(SUPORTE, /console\.(error|warn)\('\[presença/);
  assert.match(SUPORTE, /if \(st === 401\) return;/,
    'sessão vencida não pode queimar 24h de presença');
});

// ═══ MELHORIA 5 — a entrada não pode competir com o "Como usar?" ═════════
// Ela era um cartão de vidro grande, com brilho e ícone de 40px, e roubava o
// olho do "Como usar?" (o destaque da página). Virou irmã do item de navegação
// "🏛️ Comunidade" que fica logo abaixo dela. O teste compara as MEDIDAS REAIS
// dos dois arquivos: se alguém mexer no .cbt-snav do comunidade.js e esquecer
// da sala, isto quebra — que é exatamente o serviço que ele presta.

// A folha da sala é montada com concatenação de strings; aqui ela volta a ser
// CSS pra poder ser lida por regra, não por texto solto.
function cssDaSala() {
  return SALA.slice(SALA.indexOf("var CSS = ''"), SALA.indexOf('function estilo'))
    .split('\n').map((l) => l.trim()).filter((l) => !l.startsWith('//')).join('')
    .replace(/'\s*\+\s*'/g, '').replace(/^var CSS = ''/, '').replace(/'/g, '');
}

function props(regra, css) {
  const m = css.match(new RegExp(regra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}'));
  assert.ok(m, 'não achei a regra ' + regra);
  const p = {};
  m[1].split(';').forEach((d) => {
    const i = d.indexOf(':');
    if (i > 0) p[d.slice(0, i).trim()] = d.slice(i + 1).trim();
  });
  return p;
}

test('a entrada tem as MESMAS medidas do botão "🏛️ Comunidade" (.cbt-snav)', () => {
  const alvo = props('.cbt-snav', CBT);
  const nossa = props('.svz-entrada', cssDaSala());
  // As medidas que definem tamanho e peso. Se qualquer uma divergir, um dos
  // dois botões ficou maior que o outro na tela.
  ['padding', 'border-radius', 'gap', 'font-size', 'font-weight', 'font-family',
    'color', 'background', 'border', 'display', 'align-items', 'text-align', 'transition',
  ].forEach((k) => {
    assert.equal(nossa[k], alvo[k], k + ' divergiu do .cbt-snav — a entrada voltou a destoar');
  });
});

test('o hover também é o mesmo (senão o desalinhamento volta no mouse)', () => {
  assert.deepEqual(props('.svz-entrada:hover', cssDaSala()), props('.cbt-snav:hover', CBT));
});

test('nada de vidro, brilho e ícone gigante na entrada', () => {
  const css = cssDaSala();
  const e = props('.svz-entrada', css);
  assert.ok(!e['box-shadow'], 'o brilho era metade do problema');
  assert.ok(!e['backdrop-filter'], 'vidro é receita de cartão, não de item de menu');
  assert.equal(props('.svz-ico', css).flex, '0 0 auto', 'o ícone não pode voltar a ter 40px');
  // Ter gente na sala muda a COR, como o .cbt-snav.on — não o tamanho da caixa.
  assert.deepEqual(Object.keys(props('.svz-entrada.tem-gente', css)), ['color']);
});

test('a legenda some do desenho mas NÃO some da informação', () => {
  const sub = props('.svz-sub', cssDaSala());
  assert.equal(sub.position, 'absolute');
  assert.equal(sub.clip, 'rect(0 0 0 0)', 'escondida pro olho, viva pro leitor de tela');
  assert.match(SALA, /el\.title = 'Sala de voz ao vivo — ' \+ texto/,
    'quem conta "3 pessoas conversando" tem que sobreviver no tooltip');
  assert.match(SALA, /setAttribute\('aria-label', 'Sala de voz ao vivo — ' \+ texto\)/);
});

test('a entrada continua sendo pintada com a legenda invisível', () => {
  const { S, I, ctx } = carregarSala();
  const entrada = ctx.document.createElement('div');
  let rotulo = null;
  entrada.setAttribute = (k, v) => { if (k === 'aria-label') rotulo = v; };
  entrada.querySelector = () => ({ textContent: '' });
  ctx.document.querySelectorAll = (sel) => (sel === '.svz-entrada' ? [entrada] : []);
  entrarNaSala(S, I);
  canalDePe(S);
  S.ids.set('T-u2~zz', { id: 'u2', nome: 'Ana', avatar: null, plano: 'full' });
  I.aoBatimento(batimento('u2~zz'));
  assert.match(entrada.title || '', /^Sala de voz ao vivo — /);
  assert.match(rotulo || '', /você está na sala/, 'o aria-label carrega o estado, não um rótulo fixo');
});

// ═══ MELHORIA 6 — aviso ao navegar ══════════════════════════════════════
// Estando na sala, clicar em qualquer link encerrava a conversa em silêncio.
// Duas camadas: link do site vira a mesma pergunta do painel; fechar aba /
// digitar outra URL cai no beforeunload nativo. E — a parte que mais importa —
// FORA da sala nenhuma das duas pode existir.

test('link interno pergunta ANTES de navegar, no painel (não no confirm())', () => {
  const { S, I, document } = carregarSala();
  const nos = registrarConfirmacao(document);
  S.entrei = true;
  I.abrirConfirmacaoNavegacao('https://bluetubeviral.com/blue');
  assert.ok(nos.conf.classList.contains('on'), 'a pergunta tem que aparecer');
  assert.equal(nos.tit.textContent, 'Sair desta página?');
  assert.match(nos.sub.textContent, /encerrar a conversa/, 'é o texto que o dono pediu');
  assert.equal(I.destino(), 'https://bluetubeviral.com/blue', 'o link fica guardado esperando o sim');
});

test('confirmar sai da sala DIREITO e só então navega', () => {
  const { SV, S, I, document, ctx } = carregarSala();
  registrarConfirmacao(document);
  let micParado = 0;
  entrarNaSala(S, I);
  const c = canalDePe(S);
  S.stream = { getTracks: () => [{ stop: () => { micParado++; } }], getAudioTracks: () => [] };
  I.abrirConfirmacaoNavegacao('https://bluetubeviral.com/blue');
  SV.sair('');                       // é o que o botão de confirmar chama
  assert.equal(c.eventos('tchau').length, 1, "sem 'tchau' a pessoa vira fantasma na sala que deixou");
  assert.equal(micParado, 1, 'o microfone tem que ser solto antes da página trocar');
  assert.equal(S.entrei, false);
  assert.equal(ctx.window.location.href, 'https://bluetubeviral.com/blue', 'e aí sim navega');
  assert.equal(I.destino(), null, 'o destino não pode ficar armado pra próxima saída');
});

test('desistir da pergunta esquece o link (não navega depois, do nada)', () => {
  const { SV, S, I, document, ctx } = carregarSala();
  registrarConfirmacao(document);
  entrarNaSala(S, I);
  I.abrirConfirmacaoNavegacao('https://bluetubeviral.com/blue');
  // É onde Esc e o clique fora desembocam (ver 'Esc e clique fora dispensam').
  I.fecharConfirmacao();
  assert.equal(I.destino(), null, 'desistir mata o link junto com a pergunta');
  SV.sair('');
  assert.equal(ctx.window.location.href, 'https://bluetubeviral.com/comunidade',
    'a página não pode trocar sozinha depois que a pessoa disse que ficava');
});

test('sem a caixa de pergunta, navegar não trava — só sai da sala e vai', () => {
  const { S, I, ctx } = carregarSala();   // de propósito: NADA registrado
  entrarNaSala(S, I);
  const c = canalDePe(S);
  I.abrirConfirmacaoNavegacao('https://bluetubeviral.com/blue');
  assert.equal(c.eventos('tchau').length, 1, 'saiu da sala direito mesmo sem ter onde perguntar');
  assert.equal(S.entrei, false);
  assert.equal(ctx.window.location.href, 'https://bluetubeviral.com/blue',
    'uma página que não deixa a pessoa sair seria pior que o defeito original');
});

test('a pergunta desminimiza o painel (senão ela não cabe nele)', () => {
  const { S, I, document } = carregarSala();
  registrarConfirmacao(document);
  const dock = document._registrar(Object.assign(document.createElement('div'), { id: 'svzDock' }));
  dock.classList.add('mini');
  S.entrei = true;
  I.abrirConfirmacaoNavegacao('https://bluetubeviral.com/blue');
  assert.equal(dock.classList.contains('mini'), false,
    'no dock minimizado a pergunta teria a altura do cabeçalho');
});

test('saída pelo botão Sair não navega pra lugar nenhum', () => {
  const { SV, S, I, document, ctx } = carregarSala();
  registrarConfirmacao(document);
  entrarNaSala(S, I);
  SV.sair('');
  assert.equal(ctx.window.location.href, 'https://bluetubeviral.com/comunidade');
});

test('a regra do que é "sair da página" cobre os casos em que perguntar é errado', () => {
  const { I } = carregarSala();
  const sai = (a, e) => I.saiDaPagina(a, e);
  assert.equal(sai(link('/blue')), true, 'link interno de verdade');
  assert.equal(sai(link('https://youtube.com/x')), true, 'link externo também tira a pessoa daqui');
  assert.equal(sai(link('#topo')), false, 'âncora só rola a página');
  assert.equal(sai(link('/comunidade')), false, 'a MESMA página não é sair dela');
  assert.equal(sai(link('/comunidade#dicas')), false, 'trocar só o hash não recarrega nada');
  assert.equal(sai(link('javascript:void(0)')), false, 'o menu da Comunidade inteiro usa isto');
  assert.equal(sai(link('mailto:oi@bluetubeviral.com')), false);
  assert.equal(sai(link('tel:+5511999999999')), false);
  assert.equal(sai(link('/blue', { target: '_blank' })), false, 'nova aba: esta página fica viva');
  assert.equal(sai(link('/arquivo.zip', { download: '' })), false, 'download não sai da página');
  assert.equal(sai(link('/blue'), { ctrlKey: true }), false, 'Ctrl+clique abre noutra aba');
  assert.equal(sai(link('/blue'), { metaKey: true }), false, 'Cmd+clique idem (Mac)');
  assert.equal(sai(link('/blue'), { button: 1 }), false, 'botão do meio idem');
  assert.equal(sai(null), false, 'clique fora de qualquer link');
});

test('a guarda só age DENTRO da sala — e é ligada em captura', () => {
  assert.match(SALA, /if \(!S\.entrei\) return;\s*\/\/ fora da sala não se pergunta nada/,
    'navegar fora da sala não pode custar um clique a mais');
  assert.match(SALA, /document\.addEventListener\('click', function \(e\) \{[\s\S]{0,700}\}, true\);/,
    'sem captura o onclick da página navega antes da gente perguntar');
  assert.match(SALA, /abrirConfirmacaoNavegacao\(a\.href\)/);
});

test('beforeunload pergunta na sala e fica CALADO fora dela', () => {
  const { S, ctx } = carregarSala();
  const evento = () => ({ barrado: false, returnValue: undefined, preventDefault() { this.barrado = true; } });

  const fora = ctx.window._disparar('beforeunload', evento());
  assert.equal(fora.barrado, false, 'fechar a aba fora da sala não pode abrir caixa nenhuma');
  assert.equal(fora.returnValue, undefined);

  S.entrei = true;
  const dentro = ctx.window._disparar('beforeunload', evento());
  assert.equal(dentro.barrado, true, 'é a única rede possível pra fechar aba / digitar outra URL');
  assert.match(String(dentro.returnValue), /sala de voz/i);
});

test('o conserto do defeito 11 continua de pé (tela apagada ≠ sair)', () => {
  const { S, ctx } = carregarSala();
  const beforeunload = SALA.slice(SALA.indexOf("window.addEventListener('beforeunload'"),
    SALA.indexOf("window.addEventListener('pagehide'"));
  // Fora da sala o beforeunload segue despedindo NA HORA, como sempre fez.
  assert.match(beforeunload, /\} else \{\s*despedir\(\);\s*\}/,
    'sem sala aberta não há o que perguntar: despede direto');
  // Dentro da sala ele NÃO pode mais despedir: a pessoa pode responder "ficar",
  // e desligar o microfone de quem ficou seria trocar de defeito.
  const ramoDentroDaSala = beforeunload.slice(
    beforeunload.indexOf('if (S.entrei) {'), beforeunload.indexOf('} else {'));
  assert.ok(ramoDentroDaSala.length > 0, 'o beforeunload perdeu o ramo de dentro da sala');
  assert.doesNotMatch(ramoDentroDaSala, /despedir\(\)/,
    'cancelar a saída não pode deixar a pessoa na sala com o microfone morto');
  // O sinal que o pagehide espera continua sendo armado e desarmado igual.
  assert.match(beforeunload, /S\.saindoDeVerdade = true;/);
  assert.match(beforeunload, /setTimeout\(function \(\) \{ S\.saindoDeVerdade = false; \}, 4000\);/);
  assert.match(SALA, /if \(S\.saindoDeVerdade && !e\.persisted\) \{ despedir\(\); return; \}/,
    'quem despede na saída de verdade é o pagehide — essa regra É o defeito 11');
  assert.match(SALA, /window\.addEventListener\('pagehide'[\s\S]{0,240}suspender\(\);/,
    "'pagehide' sem o sinal continua sendo suspensão, não saída");
  ctx.window._disparar('beforeunload', { preventDefault() {}, returnValue: undefined });
  assert.equal(S.saindoDeVerdade, true, 'o sinal que o pagehide espera não pode ter sumido');
});
