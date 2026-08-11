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
  S.sub = 'on';
  S.ids.set('T-OUTRO', { id: 'u2', nome: 'Ana', avatar: null, plano: 'full' });
  S.canal = {
    presenceState: () => ({ 'u2~zz': [{ t: 'T-OUTRO', m: 0, j: Date.now() }] }),
    track: () => 'ok', send: () => 'ok',
  };
  I.sincronizar();
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
  let untrack = 0; let micParado = 0;
  entrarNaSala(S, I);
  S.canal = { untrack: () => { untrack++; }, presenceState: () => ({}), send: () => 'ok' };
  S.stream = { getTracks: () => [{ stop: () => { micParado++; } }], getAudioTracks: () => [] };
  I.abrirConfirmacaoNavegacao('https://bluetubeviral.com/blue');
  SV.sair('');                       // é o que o botão de confirmar chama
  assert.equal(untrack, 1, 'sem untrack a pessoa vira fantasma na sala que deixou');
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
  let untrack = 0;
  entrarNaSala(S, I);
  S.canal = { untrack: () => { untrack++; }, presenceState: () => ({}), send: () => 'ok' };
  I.abrirConfirmacaoNavegacao('https://bluetubeviral.com/blue');
  assert.equal(untrack, 1, 'saiu da sala direito mesmo sem ter onde perguntar');
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
