// tests/unit/sala_voz_presenca.test.mjs — node --test
//
// Trava os quatro consertos de 11/08/2026 na sala de voz da Comunidade:
//
//  1. BUG "0 pessoas · 1 falando" sem nenhum card. Quem preenchia S.presentes
//     era só o evento 'presence sync' do Realtime — que não chega quando a sala
//     está vazia. A pessoa entrava de verdade, mas nunca se via.
//  2. Coerência do rodapé: falando NUNCA pode passar de pessoas.
//  3. Timbres de entrada/saída (som-notificacao.js) com teto anti-rajada.
//  4. Confirmação antes de sair, dispensável por Esc e clique fora.
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
  const window = {
    addEventListener: () => {}, removeEventListener: () => {},
    PointerEvent: function () {},
    RTCPeerConnection: PeerFalso,
    AudioContext: function () {},
  };
  window.window = window;
  window.document = document;
  const ctx = {
    window, document, console,
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

function carregarSala() {
  const { ctx, document } = domFalso();
  vm.runInNewContext(SALA, ctx, { filename: 'sala-voz.js' });
  const SV = ctx.window.SalaVoz;
  assert.ok(SV && SV._interno, 'sala-voz.js precisa expor _interno pro diagnóstico');
  return { SV, S: SV._estado(), I: SV._interno, document, ctx };
}

// Coloca a pessoa "dentro da sala", exatamente como entrar() faz depois do
// track() dar 'ok' — sem microfone, sem socket, sem WebRTC.
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

test('o "sync" que nunca chega não pode apagar quem está na sala', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  // presenceState vazio é EXATAMENTE o cenário do bug: sala com uma pessoa só,
  // o Realtime não tem diferença de estado pra mandar.
  S.canal = { presenceState: () => ({}), track: () => 'ok', send: () => 'ok' };
  I.sincronizar();
  assert.equal(I.contarPresentes(), 1, 'zerou a contagem de quem está com o mic aberto');
  assert.ok(S.presentes.has(S.sessao));
});

test('sync com os outros mas sem mim: eu continuo na lista', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  S.ids.set('T-OUTRO', { id: 'u2', nome: 'Ana', avatar: null, plano: 'full' });
  S.canal = {
    presenceState: () => ({ 'u2~zz': [{ t: 'T-OUTRO', m: 0, j: Date.now() }] }),
    track: () => 'ok', send: () => 'ok',
  };
  I.sincronizar();
  assert.equal(I.contarPresentes(), 2, 'meu track sumiu do servidor, mas eu não sumi da sala');
  assert.ok(S.presentes.has(S.sessao));
});

// ═══ BUG 1c — o conserto não pode cegar a poda do mesh ═══════════════════
// Armadilha achada na revisão: o mesh decide se PODE derrubar peers olhando
// "o estado me incluía?" — e isso era lido de S.presentes.has(S.sessao). Como
// agora eu me insiro em S.presentes SEMPRE, essa pergunta passaria a responder
// "sim" até no meio de um socket flap, e a poda derrubaria o áudio de quem não
// saiu (exatamente o que a carência existe pra evitar). O sinal foi movido pra
// S.euNoServidor, lido ANTES do remendo local.

test('estado do servidor sem mim NÃO pode virar "confiável" pro mesh', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  S.canal = {
    presenceState: () => ({ 'u2~zz': [{ t: 'T-OUTRO', m: 0, j: Date.now() }] }),
    track: () => 'ok', send: () => 'ok',
  };
  I.sincronizar();
  assert.ok(S.presentes.has(S.sessao), 'eu continuo visível pra mim mesmo');
  assert.equal(S.euNoServidor, false, 'o servidor não me viu: o mesh não pode podar ninguém');
});

test('estado do servidor COM mim volta a liberar a poda', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  S.canal = {
    presenceState: () => ({ [S.sessao]: [{ t: 'TICKET-DONO', m: 0, j: S.entrouEm }] }),
    track: () => 'ok', send: () => 'ok',
  };
  I.sincronizar();
  assert.equal(S.euNoServidor, true, 'estado íntegro: a limpeza de peers tem que voltar a rodar');
});

test('presence vazia deixa o mesh em modo "não poda nada"', () => {
  const { S, I } = carregarSala();
  entrarNaSala(S, I);
  S.euNoServidor = true;                       // herdado de um sync anterior bom
  S.canal = { presenceState: () => ({}), track: () => 'ok', send: () => 'ok' };
  I.sincronizar();
  assert.equal(S.euNoServidor, false, 'socket piscou: segura a poda até o estado voltar');
  assert.equal(I.contarPresentes(), 1, 'e mesmo assim eu não sumo do painel');
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
