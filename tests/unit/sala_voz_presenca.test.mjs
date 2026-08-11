// tests/unit/sala_voz_presenca.test.mjs — node --test
//
// A sala de voz da Comunidade TROCOU DE TRANSPORTE (11/08/2026): saiu o P2P
// mesh com sinalização por Supabase Realtime, entrou o LiveKit (SFU gerenciado).
//
// Por que a troca, em uma frase: o transporte antigo tinha uma classe inteira de
// defeito — "a lista de participantes discorda da conexão de voz" — e ela nos
// derrubou cinco vezes. Foi medido em bancada que o send() do SDK do Supabase
// devolve 'ok' com o WebSocket morto (escape HTTP), que a lista piscava, e que o
// código destruía a conexão de voz de quem sumia da lista: 4 RTCPeerConnection
// numa sala de 2 pessoas. Consertado o mesh, no navegador do dono continuou sem
// áudio. Reconexão/renegociação/TURN é justamente o que um SFU resolve.
//
// OS TESTES DO TRANSPORTE ANTIGO FORAM APAGADOS DE PROPÓSITO. Batimento, censo,
// ticket HMAC, geração de negociação, orçamento de reconstrução, 'opa',
// carência de sumiço, medidor com AudioContext — nada disso existe mais. Manter
// teste de código que não existe é ruído que ensina a ignorar o vermelho.
//
// O que este arquivo trava agora:
//
//  0. TRANSPORTE: a lista de pessoas VEM do LiveKit; quem fala vem do indicador
//     do LiveKit; o microfone só é pedido DEPOIS do clique e é solto ao sair;
//     e as duas opções do Room que carregam defeito conhecido
//     (disconnectOnPageLeave / stopMicTrackOnMute) estão do lado certo.
//  1. A CASCA, item por item, continua de pé: contador antes de entrar sem
//     microfone, modal de duas portas, painel com cards, sons, confirmação de
//     saída, aviso ao navegar, medidas do botão iguais às do .cbt-snav.
//  2. PORTÃO E TETO continuam NOSSOS, no backend: crachá só depois de checar
//     plano, teto de 10 cobrado na contagem E no max_participants da sala.
//  3. Estado degradado é MARCADO: LiveKit fora do ar vira "sala indisponível
//     agora", não uma sala que parece normal e falha no clique.
//  4. Coerência do rodapé: falando NUNCA pode passar de pessoas.
//  5. Timbres de entrada/saída (som-notificacao.js) com teto anti-rajada.
//  6. O 403 da presença do SUPORTE (support-chat.js) — vizinho de arquivo, nada
//     a ver com a sala; continua aqui porque continua valendo.
//
// Os testes de sala-voz.js rodam o ARQUIVO DE VERDADE dentro de um DOM falso,
// com um LiveKit falso no lugar do SDK. Não são asserções de texto sobre o
// código, exceto onde a garantia é justamente "esta linha não pode voltar".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const SALA = readFileSync(new URL('../../public/sala-voz.js', import.meta.url), 'utf8');
const SOM = readFileSync(new URL('../../public/som-notificacao.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../../public/comunidade.html', import.meta.url), 'utf8');
const API = readFileSync(new URL('../../api/sala-voz.js', import.meta.url), 'utf8');
const SQL_FIX = readFileSync(new URL('../../sql/support_presenca_fix_403.sql', import.meta.url), 'utf8');
const SUPORTE = readFileSync(new URL('../../public/support-chat.js', import.meta.url), 'utf8');
const CBT = readFileSync(new URL('../../public/comunidade.js', import.meta.url), 'utf8');
const backend = require('../../api/sala-voz.js');

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
  function PeerFalso() {}
  // Os ouvintes de window são GRAVADOS: o aviso ao navegar mora no
  // beforeunload, e sem poder disparar o evento não dá pra provar nem que ele
  // pergunta dentro da sala nem que ele CALA fora dela.
  const ouvintesW = {};
  const window = {
    addEventListener: (ev, fn) => { (ouvintesW[ev] = ouvintesW[ev] || []).push(fn); },
    removeEventListener: () => {},
    PointerEvent: function () {},
    RTCPeerConnection: PeerFalso,     // o entrar() confere que o navegador fala WebRTC
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
    setTimeout, clearTimeout,
    // ⚠️ setInterval do Node NÃO entra aqui. O relógio da inatividade abre um
    // intervalo de verdade ao entrar na sala, e no navegador ele se encerra
    // sozinho (sair() chama inatDesligar); mas dentro do vm ninguém sai, então
    // o intervalo ficava vivo segurando o processo e o ARQUIVO de teste nunca
    // terminava — 75 testes verdes e o node pendurado. Aqui ele é registrado e
    // descartado: o que se testa é a lógica, não a passagem do tempo.
    setInterval: () => 0,
    clearInterval: () => {},
    Map, Set, Promise, Date, Math, JSON, String, Number, Array, Object, Boolean,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    // Microfone existe no aparelho — quem PEDE é o LiveKit, e só depois do clique.
    navigator: { mediaDevices: { getUserMedia: async () => ({}) } },
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

// O modal e o painel são montados com innerHTML — string, no DOM falso. Registra
// os nós à mão pra exercitar a interface de verdade (montarModal/montarDock saem
// na primeira linha quando o nó já existe).
// `semConfirmacao` reproduz o painel de um cache ANTIGO, de antes da caixa de
// confirmação existir: o dock está lá, a pergunta não. É um caso real (a Vercel
// cacheia .js por 4h) e a regra dele é dura — navegar não pode ficar refém.
function registrarUI(document, opcoes = {}) {
  const criar = (id) => document._registrar(Object.assign(document.createElement('div'), { id }));
  const nos = {
    dlg: criar('svzDlg'), dlgSub: criar('svzDlgSub'), dlgQuem: criar('svzDlgQuem'),
    dlgErro: criar('svzDlgErro'), bEntrar: criar('svzBEntrar'), bMudo: criar('svzBMudo'),
    dock: criar('svzDock'), dockSub: criar('svzDockSub'), grid: criar('svzGrid'),
    bMudar: criar('svzBMudar'), nota: criar('svzNota'),
  };
  if (!opcoes.semConfirmacao) {
    Object.assign(nos, {
      conf: criar('svzConf'), tit: criar('svzConfTit'),
      sub: criar('svzConfSub'), ok: criar('svzBSairSim'),
    });
  }
  return nos;
}

function carregarSala() {
  const { ctx, document } = domFalso();
  vm.runInNewContext(SALA, ctx, { filename: 'sala-voz.js' });
  const SV = ctx.window.SalaVoz;
  assert.ok(SV && SV._interno, 'sala-voz.js precisa expor _interno pro diagnóstico');
  return { SV, S: SV._estado(), I: SV._interno, document, ctx };
}

// ─── LiveKit falso ─────────────────────────────────────────────────────────
// Só a superfície que a sala usa. `linha` é a ordem real dos acontecimentos —
// é ela que prova que o microfone vem DEPOIS de conectar, nunca antes.
function livekitFalso() {
  const linha = [];
  const RoomEvent = {
    ParticipantConnected: 'participantConnected',
    ParticipantDisconnected: 'participantDisconnected',
    TrackMuted: 'trackMuted', TrackUnmuted: 'trackUnmuted',
    TrackSubscribed: 'trackSubscribed', TrackUnsubscribed: 'trackUnsubscribed',
    LocalTrackPublished: 'localTrackPublished',
    ParticipantMetadataChanged: 'participantMetadataChanged',
    ParticipantNameChanged: 'participantNameChanged',
    ActiveSpeakersChanged: 'activeSpeakersChanged',
    ConnectionQualityChanged: 'connectionQualityChanged',
    ConnectionStateChanged: 'connectionStateChanged',
    Reconnecting: 'reconnecting', Reconnected: 'reconnected',
    AudioPlaybackStatusChanged: 'audioPlaybackChanged',
    MediaDevicesError: 'mediaDevicesError',
    Disconnected: 'disconnected',
  };
  const ConnectionState = { Connected: 'connected', Reconnecting: 'reconnecting', Disconnected: 'disconnected' };
  const DisconnectReason = { CLIENT_INITIATED: 1, DUPLICATE_IDENTITY: 2, SERVER_SHUTDOWN: 3, PARTICIPANT_REMOVED: 4, ROOM_DELETED: 5 };
  const Track = { Source: { Microphone: 'microphone' } };
  const AudioPresets = { speech: { maxBitrate: 24000 } };

  function participante(identity, nome, extra = {}) {
    return Object.assign({
      identity, name: nome,
      metadata: JSON.stringify({ a: '', p: 'full' }),
      isMicrophoneEnabled: true,
      joinedAt: new Date(1000),
    }, extra);
  }

  class RoomFalso {
    constructor(opts) {
      this.opts = opts || {};
      this._h = {};
      this.state = 'disconnected';
      this.canPlaybackAudio = true;
      this.remoteParticipants = new Map();
      this.micErro = null;
      this.desconectado = false;
      const room = this;
      this.localParticipant = participante('u-dono', 'Dono', {
        metadata: JSON.stringify({ a: '', p: 'master' }),
        isMicrophoneEnabled: false,
        async setMicrophoneEnabled(v) {
          linha.push('mic:' + v);
          if (room.micErro) throw room.micErro;
          this.isMicrophoneEnabled = v;
        },
        getTrackPublication: () => room.pubMic || null,
      });
    }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
    removeAllListeners() { linha.push('laços removidos'); this._h = {}; return this; }
    emitir(ev, ...a) { (this._h[ev] || []).forEach((f) => f(...a)); }
    async connect(url, token) { linha.push('connect'); this.url = url; this.token = token; this.state = 'connected'; }
    disconnect() { linha.push('disconnect'); this.desconectado = true; this.state = 'disconnected'; }
    startAudio() { linha.push('startAudio'); return Promise.resolve(); }
  }
  return { LK: { Room: RoomFalso, RoomEvent, ConnectionState, DisconnectReason, Track, AudioPresets }, linha, participante };
}

// Respostas do nosso backend, por ação. Sem isto o entrar() nem chega no SFU.
function ligarApi(ctx, mapa) {
  const chamadas = [];
  ctx.fetch = async (url, opts) => {
    const acao = String(url).split('action=')[1] || '';
    chamadas.push({ acao, corpo: JSON.parse((opts && opts.body) || '{}') });
    const r = mapa[acao] || { status: 200, d: { ok: true, n: 0, pessoas: [], max: 10 } };
    return { ok: r.status < 400, status: r.status, json: async () => r.d };
  };
  return chamadas;
}

const CONFIG_OK = { status: 200, d: { ok: true, sala: 'sala-voz-comunidade', max: 10, me: { id: 'u-dono', nome: 'Dono', avatar: null, plano: 'master', mod: false }, indisponivel: false } };
const ENTRAR_OK = { status: 200, d: { ok: true, url: 'wss://sfu.exemplo/x', sala: 'sala-voz-comunidade', token: 'CRACHA', max: 10, me: CONFIG_OK.d.me, n: 0 } };

// Põe a pessoa dentro da sala pelo caminho de verdade: backend, SDK, Room.
async function entrarNaSala(ctx, SV, S, extras = {}) {
  const { LK, linha } = livekitFalso();
  S.LK = LK;
  S.cfg = CONFIG_OK.d;
  const chamadas = ligarApi(ctx, Object.assign({
    config: CONFIG_OK, entrar: ENTRAR_OK, contar: { status: 200, d: { ok: true, n: 1, pessoas: [], max: 10 } },
  }, extras));
  await SV.entrar(false);
  return { LK, linha, chamadas, sala: S.sala };
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══ 0 — TRANSPORTE: a lista É a conexão ═════════════════════════════════
// O defeito que nos derrubou cinco vezes era "a lista discorda da conexão".
// Ele não pode mais existir: não há lista nossa a sincronizar — a lista é lida
// do Room a cada evento.

test('a lista de pessoas vem do LiveKit (local + remotos), com nome e plano do crachá', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  registrarUI(document);
  const { sala, LK } = await entrarNaSala(ctx, SV, S);
  sala.remoteParticipants.set('u2', LK.Room && null);   // placeholder trocado abaixo
  sala.remoteParticipants.clear();
  const ana = { identity: 'u2', name: 'Ana', metadata: JSON.stringify({ a: 'https://cdn/x.png', p: 'master' }), isMicrophoneEnabled: true, joinedAt: new Date(2000) };
  sala.remoteParticipants.set('u2', ana);
  sala.emitir('participantConnected', ana);

  assert.equal(I.contarPresentes(), 2, 'era exatamente o que a presence/batimento não entregava');
  const pe = S.pessoas.get('u2');
  assert.equal(pe.nome, 'Ana');
  assert.equal(pe.plano, 'master', 'plano vem do metadata que o SERVIDOR assinou');
  assert.equal(pe.avatar, 'https://cdn/x.png');
  assert.equal(pe.mudo, false);
  assert.ok(S.pessoas.has('u-dono'), 'e eu sempre me vejo — era o bug "0 pessoas · 1 falando"');
  I.pararPolling();
});

test('quem sai some na hora, sem prazo nenhum de expiração', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  registrarUI(document);
  const { sala } = await entrarNaSala(ctx, SV, S);
  const ana = { identity: 'u2', name: 'Ana', metadata: '{}', isMicrophoneEnabled: true, joinedAt: new Date(2000) };
  sala.remoteParticipants.set('u2', ana);
  sala.emitir('participantConnected', ana);
  assert.equal(I.contarPresentes(), 2);

  sala.remoteParticipants.delete('u2');
  sala.emitir('participantDisconnected', ana);
  assert.equal(I.contarPresentes(), 1, 'saída é evento do SFU, não ausência de batimento');
  assert.equal(S.falando.has('u2'), false, 'e quem saiu não pode continuar "falando"');
  I.pararPolling();
});

test('metadata forjável não existe mais: nome/foto/plano vêm do crachá', () => {
  // O ticket HMAC morreu porque a defesa mudou de lugar, não porque sumiu: o
  // participante NÃO recebe canUpdateOwnMetadata, então ele não reescreve quem é.
  assert.match(API, /canUpdateOwnMetadata:\s*false/, 'sem isto o participante reescreve o próprio nome/plano');
  assert.match(API, /canPublishSources:\s*\['microphone'\]/, 'só áudio — e quem impõe é o servidor, não o navegador');
  assert.match(API, /canPublishData:\s*false/);
  assert.doesNotMatch(SALA, /action=verificar|'verificar'/, 'o resolvedor de tickets alheios não faz mais sentido');
});

test('quem fala vem do indicador do LiveKit — e nunca passa de quem está na sala', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  registrarUI(document);
  const { sala } = await entrarNaSala(ctx, SV, S);
  const ana = { identity: 'u2', name: 'Ana', metadata: '{}', isMicrophoneEnabled: true, joinedAt: new Date(2000) };
  sala.remoteParticipants.set('u2', ana);
  sala.emitir('participantConnected', ana);

  sala.emitir('activeSpeakersChanged', [ana, sala.localParticipant]);
  assert.equal(I.contarFalando(), 2);
  assert.ok(I.contarFalando() <= I.contarPresentes());

  // Alguém que já saiu não pode ficar piscando no rodapé.
  sala.remoteParticipants.delete('u2');
  sala.emitir('participantDisconnected', ana);
  assert.equal(I.contarFalando(), 1, '"0 pessoas · 1 falando" era literalmente isto');
  assert.ok(I.contarFalando() <= I.contarPresentes());
  I.pararPolling();
});

test('"0 pessoas · 1 falando" é impossível — inclusive num estado rasgado', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  registrarUI(document);
  const { sala } = await entrarNaSala(ctx, SV, S);
  const ana = { identity: 'u2', name: 'Ana', metadata: '{}', isMicrophoneEnabled: true, joinedAt: new Date(2000) };
  sala.remoteParticipants.set('u2', ana);
  sala.emitir('participantConnected', ana);
  sala.emitir('activeSpeakersChanged', [ana]);
  assert.equal(I.contarFalando(), 1);

  // Saí, mas o último ActiveSpeakers ainda está na memória e a lista de pessoas
  // passa a vir do backend: é aqui que o número mentiroso nascia.
  SV.sair('');
  S.falando.add('u2');
  S.pessoas.set('u2', { eu: false, nome: 'Ana', avatar: null, plano: 'full', mudo: false, entrou: 2 });
  assert.equal(I.contarFalando(), 0, 'fora da sala não existe "falando"');
  assert.ok(I.contarFalando() <= I.contarPresentes(), 'falando é subconjunto de presentes, sempre');
  I.pararPolling();
});

test('não sobrou medidor de fala nosso (AudioContext deu dois bugs)', () => {
  const codigo = SALA.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(codigo, /AudioContext|createAnalyser|getByteTimeDomainData/,
    'limiar fixo 3,5x acima da voz do dono e contexto fechado lendo 0.00000: dois bugs, um medidor');
  assert.match(SALA, /ActiveSpeakersChanged/, 'quem sabe quem fala é o SFU, que já tem o áudio');
});

test('não sobrou transporte P2P nenhum no arquivo', () => {
  const codigo = SALA.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const morto of ['new RTCPeerConnection', 'createOffer', 'setRemoteDescription',
    'addIceCandidate', 'iceServers', 'supabase-js', "'bat'", "'tchau'", "'opa'"]) {
    assert.ok(!codigo.includes(morto), 'sobrou ' + morto + ' — o transporte antigo não pode voltar pela porta dos fundos');
  }
});

// ═══ AS DUAS OPÇÕES DO ROOM QUE CARREGAM DEFEITO CONHECIDO ═══════════════

test('disconnectOnPageLeave:false — tela apagada não é sair (defeito 11)', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  registrarUI(document);
  const { sala } = await entrarNaSala(ctx, SV, S);
  assert.equal(sala.opts.disconnectOnPageLeave, false,
    'o padrão do SDK desconecta no pagehide — e no iPhone pagehide dispara quando a TELA APAGA');
  // E a nossa própria regra do pagehide continua: sem beforeunload, é suspensão.
  ctx.window._disparar('pagehide', { persisted: false });
  assert.equal(sala.desconectado, false, 'guardar o celular no bolso não pode derrubar a conversa');
  assert.equal(S.entrei, true);
  assert.equal(S.suspenso, true, 'só marca o estado — e o painel diz isso');
  I.pararPolling();
});

test('stopMicTrackOnMute:false — mutar não derruba a faixa (desmutar é instantâneo)', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  registrarUI(document);
  const { sala, linha } = await entrarNaSala(ctx, SV, S);
  assert.equal(sala.opts.stopMicTrackOnMute, false);
  assert.equal(sala.opts.audioCaptureDefaults.echoCancellation, true, 'sem isto a sala vira microfonia');
  assert.equal(sala.opts.audioCaptureDefaults.channelCount, 1, 'voz é mono: estéreo só dobra o upload');
  assert.equal(sala.opts.publishDefaults.dtx, true);

  await SV.mudo();
  assert.equal(S.mudo, true);
  assert.equal(linha[linha.length - 1], 'mic:false', 'mudo é a faixa silenciada, não uma renegociação');
  I.pararPolling();
});

// ═══ MICROFONE: só depois do clique, e solto ao sair ══════════════════════

test('o microfone é pedido DEPOIS de conectar — nunca antes do clique', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  registrarUI(document);
  const { linha, chamadas } = await entrarNaSala(ctx, SV, S);
  assert.deepEqual(linha.slice(0, 2), ['connect', 'mic:true'],
    'pedir microfone antes de saber se a pessoa entra é o defeito que o modal existe pra evitar');
  assert.ok(chamadas.some((c) => c.acao === 'entrar'), 'e o crachá vem do NOSSO backend, com portão de plano');
  I.pararPolling();
});

test('"entrar mudo" captura e silencia (não entra sem microfone)', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  registrarUI(document);
  const { LK } = livekitFalso();
  S.LK = LK; S.cfg = CONFIG_OK.d;
  ligarApi(ctx, { config: CONFIG_OK, entrar: ENTRAR_OK, contar: { status: 200, d: { ok: true, n: 0, pessoas: [] } } });
  await SV.entrar(true);
  assert.equal(S.entrei, true);
  assert.equal(S.mudo, true);
  assert.equal(S.sala.localParticipant.isMicrophoneEnabled, false);
  I.pararPolling();
});

test('microfone bloqueado NÃO custa a entrada inteira — entra ouvindo, marcado', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  const nos = registrarUI(document);
  const { LK } = livekitFalso();
  S.LK = LK; S.cfg = CONFIG_OK.d;
  ligarApi(ctx, { config: CONFIG_OK, entrar: ENTRAR_OK, contar: { status: 200, d: { ok: true, n: 0, pessoas: [] } } });
  // O Room falso recusa o microfone, como um navegador com permissão negada.
  const RoomOriginal = LK.Room;
  LK.Room = function (o) { const r = new RoomOriginal(o); r.micErro = Object.assign(new Error('x'), { name: 'NotAllowedError' }); return r; };
  await SV.entrar(true);
  assert.equal(S.entrei, true, 'quem clicou em "entrar mudo (só ouvir)" queria justamente OUVIR');
  assert.equal(S.semMic, true);
  assert.match(nos.nota.textContent, /só ouvindo/, 'e o painel diz a verdade em vez de mostrar um mudo que mente');
  I.pararPolling();
});

test('sair desliga a sala (o que solta o microfone) e limpa tudo', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  registrarUI(document);
  const { sala, linha } = await entrarNaSala(ctx, SV, S);
  SV.sair('');
  assert.equal(sala.desconectado, true, 'disconnect() é o que solta a faixa local — a luzinha do mic apaga aí');
  assert.ok(linha.indexOf('laços removidos') < linha.lastIndexOf('disconnect'),
    'os laços saem ANTES: um Room morto emitindo Disconnected chamaria sair() em laço');
  assert.equal(S.entrei, false);
  assert.equal(S.sala, null);
  assert.equal(S.pessoas.size, 0);
  I.pararPolling();
});

test('queda inesperada avisa o motivo em vez de sumir em silêncio', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  registrarUI(document);
  const { sala, LK } = await entrarNaSala(ctx, SV, S);
  sala.emitir('disconnected', LK.DisconnectReason.DUPLICATE_IDENTITY);
  assert.equal(S.entrei, false);
  const toast = document.getElementById('svzToast');
  assert.match(toast.textContent, /outra aba ou aparelho/);
  I.pararPolling();
});

test('autoplay barrado vira aviso + um toque na tela libera (e o laço se remove)', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  registrarUI(document);
  const { sala, linha } = await entrarNaSala(ctx, SV, S);
  sala.canPlaybackAudio = false;
  sala.emitir('audioPlaybackChanged');
  const toast = document.getElementById('svzToast');
  assert.match(toast.textContent, /Toque na tela/);
  document._disparar('pointerdown', {});
  await esperar(10);
  assert.ok(linha.includes('startAudio'), 'o primeiro toque tem que soltar o áudio de todo mundo de uma vez');
  I.pararPolling();
});

// ═══ 1 — A CASCA, item por item ══════════════════════════════════════════

test('o contador aparece ANTES de entrar, sem microfone e sem ocupar vaga', async () => {
  const { S, I, ctx, document } = carregarSala();
  registrarUI(document);
  S.cfg = CONFIG_OK.d;
  const chamadas = ligarApi(ctx, {
    contar: { status: 200, d: { ok: true, n: 3, max: 10, pessoas: [{ nome: 'Ana', avatar: null, plano: 'full' }] } },
  });
  await I.atualizarContagem(true);
  assert.equal(I.contarPresentes(), 3, 'o número tem que existir sem ninguém entrar na sala');
  assert.deepEqual(chamadas.map((c) => c.acao), ['contar'], 'e sem tocar no SFU pelo navegador');
  assert.equal(S.LK, null, 'nem o SDK de mídia é baixado só pra contar');
  assert.equal(S.sala, null);
  I.pararPolling();
});

test('contagem velha volta a ser "toque pra ver quem está" (não anuncia sala de horas atrás)', async () => {
  const { S, I, ctx, document } = carregarSala();
  registrarUI(document);
  S.cfg = CONFIG_OK.d;
  ligarApi(ctx, { contar: { status: 200, d: { ok: true, n: 4, max: 10, pessoas: [] } } });
  await I.atualizarContagem(true);
  assert.equal(I.contagemFresca(), true);
  assert.equal(I.contarPresentes(), 4);
  S.contadoEm = Date.now() - 10 * 60 * 1000;
  assert.equal(I.contagemFresca(), false);
  assert.equal(I.contarPresentes(), 0, 'badge congelado com pontinho verde convida pra uma sala que pode estar vazia');
  I.pararPolling();
});

test('falha de rede na contagem não apaga uma contagem boa que ainda está fresca', async () => {
  const { S, I, ctx, document } = carregarSala();
  registrarUI(document);
  S.cfg = CONFIG_OK.d;
  ligarApi(ctx, { contar: { status: 200, d: { ok: true, n: 5, max: 10, pessoas: [] } } });
  await I.atualizarContagem(true);
  ctx.fetch = async () => { throw new Error('rede'); };
  await I.atualizarContagem(true);
  assert.equal(I.contarPresentes(), 5, 'um engasgo de rede não é prova de que a sala esvaziou');
  I.pararPolling();
});

test('o modal mostra quem está lá, com nome escapado', async () => {
  const { S, I, ctx, document } = carregarSala();
  const nos = registrarUI(document);
  nos.dlg.classList.add('on');
  S.cfg = CONFIG_OK.d;
  ligarApi(ctx, { contar: { status: 200, d: { ok: true, n: 1, max: 10, pessoas: [{ nome: '<img src=x>', avatar: null, plano: 'full' }] } } });
  await I.atualizarContagem(true);
  assert.match(nos.dlgQuem.innerHTML, /&lt;img src=x&gt;/, 'nome de outra pessoa nunca vira HTML');
  assert.doesNotMatch(nos.dlgQuem.innerHTML, /<img src=x>/);
  I.pararPolling();
});

test('o card do painel escapa nome e foto, e marca o meu como "Você"', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  registrarUI(document);
  const { sala } = await entrarNaSala(ctx, SV, S);
  const mau = { identity: 'u9', name: '"><script>x</script>', metadata: JSON.stringify({ a: 'javascript:alert(1)', p: 'full' }), isMicrophoneEnabled: false, joinedAt: new Date(3000) };
  sala.remoteParticipants.set('u9', mau);
  sala.emitir('participantConnected', mau);

  const card = I.cardHTML('u9', S.pessoas.get('u9'));
  assert.doesNotMatch(card, /<script>/, 'nome vindo da rede nunca vira tag');
  assert.doesNotMatch(card, /javascript:/, 'foto que não é https não vira src');
  assert.match(card, /svz-mic/, 'quem está mudo ganha o 🔇');
  assert.match(I.cardHTML('u-dono', S.pessoas.get('u-dono')), /Você/, 'o card do próprio usuário sumia da grade');
  I.pararPolling();
});

test('o rodapé conta pessoas e falando, e eu apareço primeiro na grade', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  const nos = registrarUI(document);
  const { sala } = await entrarNaSala(ctx, SV, S);
  const ana = { identity: 'u2', name: 'Ana', metadata: '{}', isMicrophoneEnabled: true, joinedAt: new Date(500) };
  sala.remoteParticipants.set('u2', ana);
  sala.emitir('participantConnected', ana);
  sala.emitir('activeSpeakersChanged', [ana]);
  assert.match(nos.dockSub.textContent, /2 pessoas • 1 falando/);
  assert.equal(I.listaOrdenada()[0][0], 'u-dono', 'mesmo tendo entrado depois, eu venho primeiro: card não pula de lugar');
  I.pararPolling();
});

test('rede ruim MARCA o card, mas não some com ninguém', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  const nos = registrarUI(document);
  const { sala } = await entrarNaSala(ctx, SV, S);
  const ana = { identity: 'u2', name: 'Ana', metadata: '{}', isMicrophoneEnabled: true, joinedAt: new Date(2000) };
  sala.remoteParticipants.set('u2', ana);
  sala.emitir('participantConnected', ana);

  sala.emitir('connectionQualityChanged', 'poor', ana);
  assert.match(I.cardHTML('u2', S.pessoas.get('u2')), /oscila/);
  assert.match(nos.nota.textContent, /oscilando/);
  assert.equal(I.contarPresentes(), 2, 'sinal ruim não é ter saído: quem sai, sai por evento');

  sala.emitir('connectionQualityChanged', 'lost', ana);
  assert.match(I.cardHTML('u2', S.pessoas.get('u2')), /caiu/);
  assert.equal(I.contarPresentes(), 2);
  I.pararPolling();
});

test('reconexão é do LiveKit — a sala só marca o estado', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  const nos = registrarUI(document);
  const { sala } = await entrarNaSala(ctx, SV, S);
  sala.emitir('reconnecting');
  assert.equal(S.conn, 'instavel');
  assert.match(nos.nota.textContent, /instável/);
  assert.equal(S.entrei, true, 'oscilar não é sair: era isto que a versão anterior errava');
  sala.emitir('reconnected');
  assert.equal(S.conn, 'on');
  I.pararPolling();
});

// ═══ 2 — PORTÃO E TETO continuam NOSSOS, no backend ══════════════════════

test('o crachá só é assinado DEPOIS do portão de plano', () => {
  const iPortao = API.indexOf("if (!paying && !isMod) return res.status(403)");
  const iCracha = API.indexOf('crachaParticipante({ id: userId');
  assert.ok(iPortao > 0 && iCracha > iPortao,
    'assinar antes de checar plano entregaria a sala pra quem sabe o endereço do endpoint');
  assert.match(API, /if \(!userId\) return res\.status\(401\)/);
});

test('o teto de 10 é cobrado no backend, e sem cache', () => {
  const I = backend.__interno;
  assert.equal(I.MAX_PESSOAS, 10);
  assert.match(API, /st\.n >= MAX_PESSOAS[\s\S]{0,200}cheia: true/, 'a contagem antes de assinar o crachá');
  assert.match(API, /const st = await estadoDaSala\(LK, true\);\s*\n\s*if \(!st\.ok\)/,
    'a contagem do teto não pode vir do cache do contador — cache é enfeite de tela, não decisão');
  // O max_participants é mandado e É cobrado, com folga de 2 (medido na faixa
  // toda em 11/08: 2→4, 4→6, 10→12, sem limite→18 de 18). Entre 10 e 12 quem
  // segura são as camadas nossas.
  assert.match(API, /max_participants: MAX_PESSOAS/);
  assert.match(API, /portão FROUXO/,
    'quem ler este arquivo depois precisa saber que o SFU segura em max+2 — nem firme nem ausente');
});

test('corrida de entrada: quem furou o teto se retira sozinho, e só ele', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  registrarUI(document);
  const { sala } = await entrarNaSala(ctx, SV, S);
  // Eu entrei por ÚLTIMO numa sala que já tinha 10 (a contagem do servidor e a
  // do outro pedido cruzaram). O max_participants do LiveKit não segura isso.
  S.pessoas.get('u-dono').entrou = 99999;
  for (let i = 0; i < 10; i++) S.pessoas.set('v' + i, { eu: false, nome: 'V' + i, avatar: null, plano: 'full', mudo: false, entrou: 1000 + i });
  I.checarLotacao();
  assert.equal(S.entrei, false, 'furar o teto e travar é pior que recusar');
  assert.equal(sala.desconectado, true);

  // E o inverso: quem chegou ANTES não sai por causa de quem chegou depois.
  const outra = carregarSala();
  registrarUI(outra.document);
  await entrarNaSala(outra.ctx, outra.SV, outra.S);
  outra.S.pessoas.get('u-dono').entrou = 1;
  for (let i = 0; i < 10; i++) outra.S.pessoas.set('v' + i, { eu: false, nome: 'V' + i, avatar: null, plano: 'full', mudo: false, entrou: 5000 + i });
  outra.I.checarLotacao();
  assert.equal(outra.S.entrei, true, 'o desempate é por ordem de chegada, igual em todo navegador');
  assert.deepEqual(outra.I.ordemDeChegada()[0], 'u-dono');
  I.pararPolling(); outra.I.pararPolling();
});

test('o crachá é HS256 de verdade, curto, e não carrega o segredo', () => {
  const I = backend.__interno;
  const chave = 'APIfake', segredo = 'segredo-de-teste-32-bytes-aqui!!';
  const t = I.crachaParticipante({ id: 'u1', nome: 'Ana', avatar: 'https://cdn/a.png', plano: 'master' }, chave, segredo);
  const [c, p, s] = t.split('.');
  const esperado = crypto.createHmac('sha256', segredo).update(c + '.' + p).digest('base64url');
  assert.equal(s, esperado, 'assinatura tem que fechar com o segredo — é o que o LiveKit valida');
  const corpo = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(corpo.iss, chave);
  assert.equal(corpo.sub, 'u1', 'identity é o user_id: é ele que impede a pessoa de se passar por outra');
  assert.equal(corpo.video.roomJoin, true);
  assert.equal(corpo.video.canUpdateOwnMetadata, false);
  assert.deepEqual(corpo.video.canPublishSources, ['microphone'], 'só áudio: sem vídeo e sem tela');
  assert.equal(corpo.exp - corpo.nbf, I.TTL_CRACHA_S + 10, 'validade curta');
  assert.ok(corpo.nbf < Math.floor(Date.now() / 1000), 'nbf com folga: relógio de lambda atrasado recusaria o crachá novo');
  assert.ok(!t.includes(segredo) && !JSON.stringify(corpo).includes(segredo), 'o segredo NUNCA vai pro navegador');
});

test('o crachá de admin não é o de participante (e vice-versa)', () => {
  const I = backend.__interno;
  const admin = JSON.parse(Buffer.from(I.crachaAdmin('k', 's').split('.')[1], 'base64url').toString());
  assert.equal(admin.video.roomAdmin, true);
  assert.equal(admin.video.roomJoin, undefined, 'crachá de admin não entra na sala');
  const part = JSON.parse(Buffer.from(I.crachaParticipante({ id: 'u', nome: 'n', plano: 'full' }, 'k', 's').split('.')[1], 'base64url').toString());
  assert.equal(part.video.roomAdmin, undefined,
    'e crachá de participante NÃO faz operação de admin — medido: dá 401 "permissions denied"');
});

test('a leitura do LiveKit aceita o snake_case que esta conta devolve (medido)', () => {
  const I = backend.__interno;
  assert.equal(I.campo({ num_participants: 3 }, 'num_participants', 'numParticipants'), 3);
  assert.equal(I.campo({ numParticipants: 4 }, 'num_participants', 'numParticipants'), 4,
    'aceita os dois: se a serialização do LiveKit mudar de lado, o contador não zera');
  assert.deepEqual(I.lerMeta(JSON.stringify({ a: 'https://cdn/a.png', p: 'master' })), { avatar: 'https://cdn/a.png', plano: 'master' });
  assert.deepEqual(I.lerMeta('lixo{'), { avatar: null, plano: 'full' }, 'metadata quebrada não pode derrubar a listagem');
  assert.equal(I.lerMeta(JSON.stringify({ a: 'javascript:alert(1)', p: 'x' })).avatar, null);
  assert.equal(I.baseHttp('wss://x.livekit.cloud/'), 'https://x.livekit.cloud');
});

test('o front NÃO decide plano nem teto sozinho — ele obedece o servidor', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  const nos = registrarUI(document);
  nos.dlg.classList.add('on');
  const { LK } = livekitFalso();
  S.LK = LK; S.cfg = CONFIG_OK.d;
  ligarApi(ctx, {
    entrar: { status: 403, d: { error: 'cheia', cheia: true, n: 10, max: 10 } },
    contar: { status: 200, d: { ok: true, n: 10, pessoas: [] } },
  });
  await SV.entrar(false);
  assert.equal(S.entrei, false, 'sala cheia é recusa do servidor, não sugestão');
  assert.equal(S.sala, null, 'e nem Room é aberto: a vaga nunca chega a ser ocupada');
  assert.match(nos.dlgErro.innerHTML, /cheia/);
  I.pararPolling();
});

test('sessão duplicada barra, mas oferece tomar a vaga de volta', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  const nos = registrarUI(document);
  nos.dlg.classList.add('on');
  const { LK } = livekitFalso();
  S.LK = LK; S.cfg = CONFIG_OK.d;
  ligarApi(ctx, { entrar: { status: 409, d: { error: 'x', jaEstou: true } }, contar: { status: 200, d: { ok: true, n: 1, pessoas: [] } } });
  await SV.entrar(false);
  assert.equal(S.entrei, false);
  assert.match(nos.dlgErro.innerHTML, /svzBAssumir/,
    'aba que fechou no tranco fica segundos pendurada no SFU: sem saída, a pessoa vê "outra aba" olhando pra uma aba só');
  assert.match(API, /jaEstou && !b\.assumir/, 'e quem decide é o servidor, não o navegador');
  I.pararPolling();
});

// ═══ 3 — ESTADO DEGRADADO É MARCADO ══════════════════════════════════════

test('LiveKit fora do ar: a entrada DIZ "sala indisponível agora"', async () => {
  const { S, I, ctx, document } = carregarSala();
  const nos = registrarUI(document);
  nos.dlg.classList.add('on');
  let rotulo = '';
  const entrada = document.createElement('div');
  entrada.querySelector = () => ({ textContent: '' });
  entrada.setAttribute = (k, v) => { if (k === 'aria-label') rotulo = v; };
  document.querySelectorAll = (sel) => (sel === '.svz-entrada' ? [entrada] : []);
  S.cfg = CONFIG_OK.d;
  ligarApi(ctx, { contar: { status: 200, d: { ok: true, n: 0, pessoas: [], indisponivel: true } } });
  await I.atualizarContagem(true);
  assert.match(rotulo, /sala indisponível agora/, 'fingir que está tudo bem e falhar no clique é o pior dos dois');
  assert.equal(nos.bEntrar.disabled, true, 'e os botões do modal não podem convidar pra um lugar que não existe');
  I.pararPolling();
});

test('SDK que não carrega de CDN nenhuma também é "indisponível", não erro mudo', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  const nos = registrarUI(document);
  nos.dlg.classList.add('on');
  S.cfg = CONFIG_OK.d;
  ligarApi(ctx, { entrar: ENTRAR_OK, contar: { status: 200, d: { ok: true, n: 0, pessoas: [] } } });
  // S.LK fica null e o import dinâmico não existe neste contexto: é exatamente
  // o caso de "as duas CDNs fora do ar".
  await SV.entrar(false);
  assert.equal(S.entrei, false);
  assert.equal(S.conn, 'erro');
  assert.match(nos.dlgErro.innerHTML, /indispon/i);
  I.pararPolling();
});

test('são DUAS CDNs, em ordem, e com versão fixada', () => {
  assert.match(SALA, /cdn\.jsdelivr\.net\/npm\/livekit-client@\d+\.\d+\.\d+/, 'a primeira é um arquivo só, autocontido');
  assert.match(SALA, /esm\.sh\/livekit-client@\d+\.\d+\.\d+/, 'a segunda é a reserva');
  assert.doesNotMatch(SALA, /livekit-client@latest|livekit-client@\^/, 'SDK de mídia que muda sozinho é sala que quebra sozinha');
});

test('o SDK só é baixado no clique (quem passa pela Comunidade não paga 1,2MB)', () => {
  assert.match(SALA, /function carregarSDK/);
  const ligar = SALA.slice(SALA.indexOf('async function ligar()'), SALA.indexOf("document.addEventListener('visibilitychange'"));
  assert.doesNotMatch(ligar, /carregarSDK/, 'carregar o SDK no load da página custa 1,2MB pra quem nem vai entrar');
  assert.match(SALA.slice(SALA.indexOf('async function entrar(')), /var LK = await carregarSDK\(\)/);
});

// ═══ 5 — timbres de entrar/sair ══════════════════════════════════════════

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
  ctx.BTSom.alternar();                    // liga -> 'off'
  assert.equal(ctx.BTSom.entrou(), false, 'som desligado tem que valer pra entrar/sair');
});

test('a sala continua funcionando se o som não carregar', () => {
  assert.match(SALA, /if \(window\.BTSom && typeof window\.BTSom\[nome\] === 'function'\)/,
    'BTSom é opcional: um bipe não pode derrubar a sala');
});

// ═══ confirmação antes de sair ═══════════════════════════════════════════

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

test('saída programática (queda, sala cheia) NÃO pede confirmação', () => {
  assert.match(SALA, /function sair\(motivo\)[\s\S]{0,2600}fecharConfirmacaoSaida\(\)/,
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

// ═══ BUG 2 — 403 da presença do suporte (vizinho, não é da sala) ═════════

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

// ═══ a entrada não pode competir com o "Como usar?" ══════════════════════
// Ela era um cartão de vidro grande, com brilho e ícone de 40px, e roubava o
// olho do "Como usar?" (o destaque da página). Virou irmã do item de navegação
// "🏛️ Comunidade" que fica logo abaixo dela. O teste compara as MEDIDAS REAIS
// dos dois arquivos: se alguém mexer no .cbt-snav do comunidade.js e esquecer
// da sala, isto quebra — que é exatamente o serviço que ele presta.

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

test('a entrada continua sendo pintada com a legenda invisível', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  registrarUI(document);
  const entrada = document.createElement('div');
  let rotulo = null;
  entrada.setAttribute = (k, v) => { if (k === 'aria-label') rotulo = v; };
  entrada.querySelector = () => ({ textContent: '' });
  document.querySelectorAll = (sel) => (sel === '.svz-entrada' ? [entrada] : []);
  await entrarNaSala(ctx, SV, S);
  assert.match(entrada.title || '', /^Sala de voz ao vivo — /);
  assert.match(rotulo || '', /você está na sala/, 'o aria-label carrega o estado, não um rótulo fixo');
  I.pararPolling();
});

// ═══ aviso ao navegar ════════════════════════════════════════════════════
// Estando na sala, clicar em qualquer link encerrava a conversa em silêncio.
// Duas camadas: link do site vira a mesma pergunta do painel; fechar aba /
// digitar outra URL cai no beforeunload nativo. E — a parte que mais importa —
// FORA da sala nenhuma das duas pode existir.

test('link interno pergunta ANTES de navegar, no painel (não no confirm())', () => {
  const { S, I, document } = carregarSala();
  const nos = registrarUI(document);
  S.entrei = true;
  I.abrirConfirmacaoNavegacao('https://bluetubeviral.com/blue');
  assert.ok(nos.conf.classList.contains('on'), 'a pergunta tem que aparecer');
  assert.equal(nos.tit.textContent, 'Sair desta página?');
  assert.match(nos.sub.textContent, /encerrar a conversa/, 'é o texto que o dono pediu');
  assert.equal(I.destino(), 'https://bluetubeviral.com/blue', 'o link fica guardado esperando o sim');
});

test('confirmar sai da sala DIREITO e só então navega', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  registrarUI(document);
  const { sala } = await entrarNaSala(ctx, SV, S);
  I.abrirConfirmacaoNavegacao('https://bluetubeviral.com/blue');
  SV.sair('');                       // é o que o botão de confirmar chama
  assert.equal(sala.desconectado, true, 'a sala tem que ser desligada antes de a página trocar');
  assert.equal(S.entrei, false);
  assert.equal(ctx.window.location.href, 'https://bluetubeviral.com/blue', 'e aí sim navega');
  assert.equal(I.destino(), null, 'o destino não pode ficar armado pra próxima saída');
  I.pararPolling();
});

test('desistir da pergunta esquece o link (não navega depois, do nada)', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  registrarUI(document);
  await entrarNaSala(ctx, SV, S);
  I.abrirConfirmacaoNavegacao('https://bluetubeviral.com/blue');
  I.fecharConfirmacao();
  assert.equal(I.destino(), null, 'desistir mata o link junto com a pergunta');
  SV.sair('');
  assert.equal(ctx.window.location.href, 'https://bluetubeviral.com/comunidade',
    'a página não pode trocar sozinha depois que a pessoa disse que ficava');
  I.pararPolling();
});

test('sem a caixa de pergunta, navegar não trava — só sai da sala e vai', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  registrarUI(document, { semConfirmacao: true });   // painel de um cache antigo
  const { sala } = await entrarNaSala(ctx, SV, S);
  I.abrirConfirmacaoNavegacao('https://bluetubeviral.com/blue');
  assert.equal(sala.desconectado, true, 'saiu da sala direito mesmo sem ter onde perguntar');
  assert.equal(S.entrei, false);
  assert.equal(ctx.window.location.href, 'https://bluetubeviral.com/blue',
    'uma página que não deixa a pessoa sair seria pior que o defeito original');
  I.pararPolling();
});

test('a pergunta desminimiza o painel (senão ela não cabe nele)', () => {
  const { S, I, document } = carregarSala();
  const nos = registrarUI(document);
  nos.dock.classList.add('mini');
  S.entrei = true;
  I.abrirConfirmacaoNavegacao('https://bluetubeviral.com/blue');
  assert.equal(nos.dock.classList.contains('mini'), false,
    'no dock minimizado a pergunta teria a altura do cabeçalho');
});

test('saída pelo botão Sair não navega pra lugar nenhum', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  registrarUI(document);
  await entrarNaSala(ctx, SV, S);
  SV.sair('');
  assert.equal(ctx.window.location.href, 'https://bluetubeviral.com/comunidade');
  I.pararPolling();
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
  assert.match(beforeunload, /\} else \{\s*despedir\(\);\s*\}/,
    'sem sala aberta não há o que perguntar: despede direto');
  const ramoDentroDaSala = beforeunload.slice(
    beforeunload.indexOf('if (S.entrei) {'), beforeunload.indexOf('} else {'));
  assert.ok(ramoDentroDaSala.length > 0, 'o beforeunload perdeu o ramo de dentro da sala');
  assert.doesNotMatch(ramoDentroDaSala, /despedir\(\)/,
    'cancelar a saída não pode deixar a pessoa na sala com o microfone morto');
  assert.match(beforeunload, /S\.saindoDeVerdade = true;/);
  assert.match(beforeunload, /setTimeout\(function \(\) \{ S\.saindoDeVerdade = false; \}, 4000\);/);
  assert.match(SALA, /if \(S\.saindoDeVerdade && !e\.persisted\) \{ despedir\(\); return; \}/,
    'quem despede na saída de verdade é o pagehide — essa regra É o defeito 11');
  assert.match(SALA, /window\.addEventListener\('pagehide'[\s\S]{0,320}suspender\(\);/,
    "'pagehide' sem o sinal continua sendo suspensão, não saída");
  ctx.window._disparar('beforeunload', { preventDefault() {}, returnValue: undefined });
  assert.equal(S.saindoDeVerdade, true, 'o sinal que o pagehide espera não pode ter sumido');
});

test('fechar a aba de verdade desliga a sala sem reentrar no sair()', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  registrarUI(document);
  const { sala, linha } = await entrarNaSala(ctx, SV, S);
  ctx.window._disparar('beforeunload', { preventDefault() {}, returnValue: undefined });
  ctx.window._disparar('pagehide', { persisted: false });
  assert.equal(sala.desconectado, true, 'saída confirmada solta o microfone na hora');
  assert.equal(S.sala, null);
  assert.ok(linha.indexOf('laços removidos') < linha.lastIndexOf('disconnect'),
    'os laços saem antes do disconnect: senão o Disconnected do SDK chama sair() numa página que já morreu');
  I.pararPolling();
});

test('trocar de aba não derruba ninguém da conversa', async () => {
  const { SV, S, I, ctx, document } = carregarSala();
  registrarUI(document);
  const { sala } = await entrarNaSala(ctx, SV, S);
  document.hidden = true;
  document._disparar('visibilitychange', {});
  assert.equal(S.entrei, true, 'sair da chamada porque trocou de aba seria péssimo');
  assert.equal(sala.desconectado, false);
  assert.equal(S.suspenso, true);
  document.hidden = false;
  document._disparar('visibilitychange', {});
  await esperar(10);
  assert.equal(S.suspenso, false, 'e voltar limpa a marca');
  I.pararPolling();
});

// ═══════════════════════════════════════════════════════════════════════════
// DEFEITO 12 — "acende mas não sai som"
// Medido pelo dono em 11/08: o indicador de fala funcionava (o LiveKit avisa
// que há som chegando) e nenhum som saía. Causa: o handler de TrackSubscribed
// só repintava a tela. Faixa que ninguém anexa num elemento de áudio NÃO TOCA.
//
// Estes testes guardam a CLASSE, não a linha: qualquer refatoração que volte a
// tratar TrackSubscribed sem anexar a faixa quebra aqui.
// ═══════════════════════════════════════════════════════════════════════════
test('DEFEITO 12: TrackSubscribed ANEXA a faixa de áudio, não só repinta', () => {
  const i = SALA.indexOf('E.TrackSubscribed');
  assert.notEqual(i, -1, 'o handler de TrackSubscribed sumiu');
  // Recorta até o handler seguinte pra não passar por acaso com um attach()
  // que mora em outro lugar do arquivo.
  const bloco = SALA.slice(i, SALA.indexOf('E.TrackUnsubscribed'));
  assert.match(bloco, /\.attach\(\)/, 'TrackSubscribed nao anexa a faixa - o som nao tem por onde sair');
  assert.match(bloco, /appendChild/, 'o <audio> nao entra no documento; alguns navegadores nao tocam fora do DOM');
  assert.match(bloco, /startAudio/, 'autoplay recusado precisa cair no startAudio() do LiveKit');
});

test('DEFEITO 12: TrackUnsubscribed REMOVE o <audio>, sem deixar órfão', () => {
  const i = SALA.indexOf('E.TrackUnsubscribed');
  assert.notEqual(i, -1);
  assert.match(SALA.slice(i, i + 500), /detach\(\)/, 'faixa que saiu nao e desanexada - sobra <audio> morto a cada entra-e-sai');
});

test('a versão do sala-voz.js no HTML sobe junto (cache de 4h da Vercel)', () => {
  const html = readFileSync(new URL('../../public/comunidade.html', import.meta.url), 'utf8');
  const m = html.match(/sala-voz\.js\?v=(\w+)/);
  assert.ok(m, 'sala-voz.js sem ?v= - a Vercel serve .js com cache de 4h e o conserto nao chega em ninguem');
  assert.notEqual(m[1], '20260811lk1', 'a versao nao subiu junto com a mudanca no arquivo');
});

// ═══════════════════════════════════════════════════════════════════════════
// QUEDA POR INATIVIDADE
// Nasceu de medição: ninguém desconecta quem esquece a sala aberta, e duas
// pessoas esquecidas queimam a cota grátis do LiveKit em 1,7 dia.
// ═══════════════════════════════════════════════════════════════════════════
test('INATIVIDADE: são DOIS relógios — sem falar (5min) e sem tocar (40min)', () => {
  assert.match(SALA, /SEM_FALAR_MS:\s*5\s*\*\s*60\s*\*\s*1000/, 'o relógio de 5 min sem falar sumiu');
  assert.match(SALA, /SEM_TOCAR_MS:\s*40\s*\*\s*60\s*\*\s*1000/,
    'o teto por falta de TOQUE sumiu — sem ele, celular no bolso roçando o tecido reinicia o relógio da fala pra sempre e nunca cai');
});

test('INATIVIDADE: só o toque de gente reinicia o teto longo; falar não', () => {
  const i = SALA.indexOf('function inatReiniciar');
  assert.notEqual(i, -1);
  const corpo = SALA.slice(i, i + 320);
  assert.match(corpo, /if \(porToque\) INAT\.toque = t;/,
    'o relógio do teto longo passou a ser reiniciado sem toque — o buraco do bolso volta');
  // E a fala chama com porToque FALSO, senão barulho vira "gente presente".
  assert.match(SALA, /inatReiniciar\(false\)/, 'a fala deixou de ser marcada como "não é toque"');
});

test('INATIVIDADE: o seletor do toque casa com a interface que EXISTE', () => {
  const i = SALA.indexOf('function inatToque');
  const corpo = SALA.slice(i, i + 1200);
  const sel = /closest\(\s*'([^']+)'/.exec(corpo);
  assert.ok(sel, 'sumiu o closest do toque');
  // Um seletor que não casa com nada é pior que não ter: derruba quem está ali.
  assert.equal(/#svzPainel|#svzModal/.test(sel[1]), false,
    'voltou a apontar pra id que não existe neste arquivo — nenhum toque contaria');
  assert.match(sel[1], /svz/, 'o seletor precisa mirar a interface da sala');
});

test('INATIVIDADE: o relógio liga ao entrar e desliga ao sair', () => {
  const e = SALA.indexOf('S.entrei = true;');
  assert.match(SALA.slice(e, e + 120), /inatLigar\(\)/, 'entrou na sala e o relógio não ligou');
  const s = SALA.indexOf('function sair(motivo)');
  assert.match(SALA.slice(s, s + 120), /inatDesligar\(\)/,
    'saiu e o relógio continuou correndo — dispararia sair() de novo, fora da sala');
});

test('INATIVIDADE: a pessoa é AVISADA antes de cair, não expulsa de surpresa', () => {
  assert.match(SALA, /AVISO_ANTES_MS/, 'sumiu o aviso prévio');
  const i = SALA.indexOf('function inatChecar');
  const corpo = SALA.slice(i, i + 900);
  assert.match(corpo, /INAT\.SEM_FALAR_MS - INAT\.AVISO_ANTES_MS/,
    'o aviso deixou de vir ANTES do prazo — quem só ouvia cairia sem chance de reagir');
});

test('INATIVIDADE: sair() recebe TEXTO legível, não um código cru', () => {
  const i = SALA.indexOf('function inatChecar');
  const corpo = SALA.slice(i, i + 900);
  // sair(motivo) faz aviso(motivo): passar 'inatividade' mostraria a palavra crua.
  assert.equal(/sair\('inatividade'\)|sair\('inatividade_longa'\)/.test(corpo), false,
    'voltou a passar código cru pro sair() — a pessoa leria "inatividade" na tela');
  assert.match(corpo, /Você saiu da sala de voz/, 'sumiu a explicação que a pessoa lê');
});

// ═══════════════════════════════════════════════════════════════════════════
// SALA DE VOZ É SÓ VOZ — e quem garante isso é o navegador de quem OUVE.
// Medido: o SFU compara a FONTE declarada, não o tipo da faixa. Vídeo 1080p
// declarado como "microphone" foi ACEITO pelo servidor.
// ═══════════════════════════════════════════════════════════════════════════
test('VÍDEO: a faixa que não é áudio é recusada ANTES de baixar byte', () => {
  const i = SALA.indexOf('E.TrackPublished');
  assert.notEqual(i, -1, 'sumiu o porteiro do TrackPublished — vídeo voltaria a descer pra todo mundo');
  const bloco = SALA.slice(i, i + 500);
  assert.match(bloco, /kind !== 'audio'/);
  assert.match(bloco, /setSubscribed\(false\)/, 'o porteiro não recusa a assinatura');
});

test('VÍDEO: há SEGUNDA camada pra faixa que vencer a corrida', () => {
  const i = SALA.indexOf('E.TrackSubscribed');
  const bloco = SALA.slice(i, i + 900);
  assert.match(bloco, /kind !== 'audio'/,
    'o TrackSubscribed voltou a aceitar qualquer faixa — uma corrida perdida custa a banda de nove pessoas');
  assert.match(bloco, /function \(faixa, publicacao\)/,
    'sem a publicação no handler não dá pra desassinar');
});

test('VÍDEO: o comentário do crachá não ensina mais o modelo errado', () => {
  const API = readFileSync(new URL('../../api/sala-voz.js', import.meta.url), 'utf8');
  assert.equal(/mesmo um navegador adulterado não publica câmera/.test(API), false,
    'voltou a afirmar que o servidor barra vídeo — medido que NÃO barra quando a fonte é declarada como microfone');
  assert.match(API, /FONTE DECLARADA, não o tipo da faixa/);
});

// ═══════════════════════════════════════════════════════════════════════════
// O BOTÃO NÃO PODE MORRER
// ═══════════════════════════════════════════════════════════════════════════
test('ENTRAR: o envelope solta a trava em QUALQUER saída, não só na que falhou', () => {
  assert.match(SALA, /async function entrarInterno\(/,
    'o corpo do entrar deixou de ser envolvido — cada await lá dentro volta a poder congelar o modal');
  const i = SALA.indexOf('async function entrar(mudo, assumir)');
  const bloco = SALA.slice(i, i + 900);
  assert.match(bloco, /finally/, 'sem finally, uma rejeição nova volta a deixar S.entrando preso');
  assert.match(bloco, /if \(!S\.entrei && S\.entrando\)/,
    'a trava tem que sair só quando NÃO entrou — senão atropela a entrada boa');
});

// ═══════════════════════════════════════════════════════════════════════════
// NÃO AFIRMAR O QUE NÃO SE MEDIU
// ═══════════════════════════════════════════════════════════════════════════
test('MODAL: não diz "a sala está vazia" quando a contagem não chegou', () => {
  const i = SALA.indexOf("A sala está cheia (' + MAX + ' de ' + MAX");
  const bloco = SALA.slice(i, i + 1400);
  assert.match(bloco, /!S\.entrei && !contagemFresca\(\)/,
    'o modal voltou a afirmar sala vazia sem ter medido — e contradiz o botão que a pessoa acabou de tocar');
  const pos = bloco.indexOf('!contagemFresca()');
  // Ancora no TEXTO do código, não na frase solta: o comentário logo acima
  // também contém 'A sala está vazia' e fazia o teste medir a distância errada.
  const posVazia = bloco.indexOf('A sala está vazia. Entra e chama');
  assert.ok(pos > -1 && pos < posVazia, 'a guarda tem que vir ANTES do texto de sala vazia');
});

test('MODAL: sem contagem fresca, não desenha rosto nenhum', () => {
  const i = SALA.indexOf('var lista = S.entrei ? Array.from(S.pessoas.values())');
  assert.notEqual(i, -1);
  assert.match(SALA.slice(i, i + 220), /contagemFresca\(\) \? \(S\.foraNomes \|\| \[\]\) : \[\]/,
    'voltaria a desenhar 4 rostos embaixo da frase que diz que a sala está vazia');
});
