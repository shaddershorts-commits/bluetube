// tests/unit/toast_existe.test.mjs — node --test
// ============================================================================
// A CLASSE: chamar toast() sem que ele exista.
//
// Medido em 11/08: quatro páginas chamavam toast( e só duas definiam. Na
// index.html as 6 chamadas estavam desprotegidas, e uma delas ficava no meio
// do fluxo de exclusão de conta (LGPD):
//
//   a API apaga a conta → localStorage.clear() → toast(...) ESTOURA
//   → o setTimeout que redirecionava NUNCA RODA
//
// A conta era apagada e a pessoa não via nada. O teste abaixo não guarda essa
// linha: guarda a REGRA. Página nova que chamar toast sem carregar o arquivo
// quebra aqui, antes de chegar em produção.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUB = path.join(RAIZ, 'public');
const TOAST = fs.readFileSync(path.join(PUB, 'toast.js'), 'utf8');

// Cobre as formas todas: function toast, const/let/var toast =, window.toast =
const DEFINE = /(?:function\s+toast\b|(?:const|let|var)\s+toast\s*=|window\.toast\s*=)/;
const CHAMA = /\btoast\s*\(/;

// ═══════════════════════════════════════════════════════════════════════════
// A REGRA
// ═══════════════════════════════════════════════════════════════════════════

test('CLASSE: toda página que chama toast() define ou carrega o /toast.js', () => {
  const paginas = fs.readdirSync(PUB).filter((f) => f.endsWith('.html'));
  const quebradas = [];
  for (const nome of paginas) {
    const src = fs.readFileSync(path.join(PUB, nome), 'utf8');
    if (!CHAMA.test(src)) continue;
    const proprio = DEFINE.test(src);
    const carrega = /src=["']\/toast\.js/.test(src);
    // Script externo que a página carregue também pode definir o dela.
    let porScript = false;
    for (const m of src.matchAll(/src=["']\/([A-Za-z0-9_.-]+\.js)/g)) {
      const alvo = path.join(PUB, m[1]);
      if (fs.existsSync(alvo) && DEFINE.test(fs.readFileSync(alvo, 'utf8'))) { porScript = true; break; }
    }
    if (!proprio && !carrega && !porScript) quebradas.push(nome);
  }
  assert.deepEqual(quebradas, [],
    'estas páginas chamam toast() e não têm de onde: ' + quebradas.join(', '));
});

test('a home carrega o toast.js — era ela que apagava conta em silêncio', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  assert.match(html, /src=["']\/toast\.js\?v=/,
    'sem o toast.js (com ?v=) a exclusão de conta volta a engolir o redirecionamento');
});

test('a Virais carrega o toast.js — a confirmação do alerta dependia dele', () => {
  const html = fs.readFileSync(path.join(PUB, 'virais.html'), 'utf8');
  assert.match(html, /src=["']\/toast\.js\?v=/);
});

test('o toast.js entra versionado (a Vercel cacheia .js por 4h)', () => {
  for (const nome of ['index.html', 'virais.html']) {
    const html = fs.readFileSync(path.join(PUB, nome), 'utf8');
    const m = html.match(/\/toast\.js(\?v=[\w.-]+)?/);
    assert.ok(m && m[1], `${nome}: /toast.js sem ?v= — não chega em quem já visitou`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPORTAMENTO — roda o arquivo de verdade num DOM de mentira.
// Teste que só faz grep passa com o recurso quebrado; este não.
// ═══════════════════════════════════════════════════════════════════════════

function domFalso() {
  const criar = (tag) => {
    const el = {
      tagName: tag, className: '', id: '', textContent: '', filhos: [],
      parentNode: null, isConnected: false, attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(c) { c.parentNode = this; c.isConnected = true; this.filhos.push(c); return c; },
      removeChild(c) { this.filhos = this.filhos.filter((x) => x !== c); c.parentNode = null; c.isConnected = false; return c; },
      get childElementCount() { return this.filhos.length; },
      classList: {
        add(...cs) { const s = new Set(String(el.className).split(/\s+/).filter(Boolean)); cs.forEach((c) => s.add(c)); el.className = [...s].join(' '); },
        remove(...cs) { const s = new Set(String(el.className).split(/\s+/).filter(Boolean)); cs.forEach((c) => s.delete(c)); el.className = [...s].join(' '); },
        contains(c) { return String(el.className).split(/\s+/).includes(c); },
      },
    };
    return el;
  };
  const head = criar('head'); const body = criar('body');
  head.isConnected = true; body.isConnected = true;
  const doc = {
    head, body, documentElement: criar('html'),
    createElement: criar,
    getElementById(id) {
      const busca = (n) => { if (n.id === id) return n; for (const f of n.filhos) { const r = busca(f); if (r) return r; } return null; };
      return busca(head) || busca(body);
    },
  };
  // Os dois relógios ficam SEPARADOS de propósito. Misturados, drenar a fila
  // rodava também o timer que apaga o aviso, e a inspeção acontecia depois do
  // toast já ter sumido — o teste acusava "nada na tela" com o código certo.
  const quadros = []; const timers = [];
  const win = {
    document: doc,
    requestAnimationFrame: (fn) => { quadros.push(fn); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    console: { warn() {} },
  };
  win.window = win;
  return {
    win, doc,
    // só o caminho de EXIBIR
    correr: () => { let n = 0; while (quadros.length && n++ < 200) quadros.shift()(); },
    // o caminho de SUMIR, quando o teste quiser
    avancar: () => { let n = 0; while (timers.length && n++ < 200) { timers.shift().fn(); while (quadros.length) quadros.shift()(); } },
  };
}

function rodarToast(mensagem, previo) {
  const { win, doc, correr, avancar } = domFalso();
  if (previo) win.toast = previo;
  const ctx = vm.createContext(win);
  vm.runInContext(TOAST, ctx);
  if (typeof win.toast === 'function') win.toast(mensagem);
  correr();
  const achados = [];
  const busca = (n) => { if (String(n.className).includes('bt-toast') && n.tagName === 'div' && n.textContent) achados.push(n); n.filhos.forEach(busca); };
  busca(doc.body);
  return { win, doc, achados, avancar, olhar: () => { const a = []; const b = (n) => { if (String(n.className).includes('bt-toast') && n.tagName === 'div' && n.textContent) a.push(n); n.filhos.forEach(b); }; b(doc.body); return a; } };
}

test('COMPORTAMENTO: toast() põe a mensagem na tela de verdade', () => {
  const { achados } = rodarToast('✅ Conta deletada. Redirecionando...');
  assert.equal(achados.length, 1, 'nada apareceu na tela — é o defeito original de volta');
  assert.equal(achados[0].textContent, '✅ Conta deletada. Redirecionando...');
});

test('COMPORTAMENTO: mensagem de erro sai marcada como erro', () => {
  const { achados } = rodarToast('Erro: falha ao deletar');
  assert.ok(achados[0].className.includes('ruim'), 'erro saiu com a cara de sucesso');
});

test('COMPORTAMENTO: o texto NÃO é interpretado como HTML', () => {
  // A mensagem carrega e.message e resposta de API — texto de fora.
  const { achados } = rodarToast('<img src=x onerror=alert(1)>');
  assert.equal(achados[0].textContent, '<img src=x onerror=alert(1)>',
    'o texto foi parar em innerHTML — isso é porta de injeção');
});

test('COMPORTAMENTO: não sobrescreve o toast que a página já tem', () => {
  let chamou = null;
  const meu = (m) => { chamou = m; };
  const { win } = rodarToast('oi', meu);
  assert.equal(win.toast, meu, 'atropelou o toast próprio da página');
  assert.equal(chamou, 'oi');
});

test('COMPORTAMENTO: toast() NUNCA joga erro pra quem chamou', () => {
  // Esta é a regra que mais importa: foi um aviso que estourou que impediu o
  // redirecionamento da exclusão de conta. Aviso quebrado é aceitável;
  // aviso que derruba a linha seguinte, não.
  const { win } = domFalso();
  const ctx = vm.createContext(win);
  vm.runInContext(TOAST, ctx);
  win.document.body.appendChild = () => { throw new Error('DOM caiu'); };
  win.document.head.appendChild = () => { throw new Error('DOM caiu'); };
  win.document.documentElement.appendChild = () => { throw new Error('DOM caiu'); };
  assert.doesNotThrow(() => win.toast('qualquer coisa'),
    'o toast deixou a exceção escapar — a linha seguinte de quem chamou não roda');
});

test('COMPORTAMENTO: mensagem vazia ou nula não cria caixa fantasma', () => {
  for (const m of ['', null, undefined]) {
    const { achados } = rodarToast(m);
    assert.equal(achados.length, 0, `criou caixa vazia para ${JSON.stringify(m)}`);
  }
});

test('COMPORTAMENTO: o aviso some sozinho e não deixa lixo no documento', () => {
  const { avancar, olhar, doc } = rodarToast('Salvo!');
  assert.equal(olhar().length, 1, 'não apareceu');
  avancar();
  assert.equal(olhar().length, 0, 'o aviso ficou preso na tela pra sempre');
  // A pilha também tem que ir embora; senão sobra um <div> vazio por visita.
  const sobrou = doc.body.filhos.filter((f) => String(f.className).includes('bt-toast'));
  assert.deepEqual(sobrou, [], 'sobrou a pilha vazia no documento');
});

// ═══════════════════════════════════════════════════════════════════════════
// ALTITUDE — o enfeite não pode decidir se a ação acontece.
// Carregar o toast.js conserta HOJE. Esta ordem conserta a classe: mesmo que
// o toast.js falhe ao carregar amanhã, a pessoa sai da tela morta.
// ═══════════════════════════════════════════════════════════════════════════
test('exclusão de conta: o redirecionamento é agendado ANTES da mensagem', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const i = html.indexOf('async function deleteMyAccount(');
  assert.notEqual(i, -1, 'deleteMyAccount sumiu ou foi renomeada');
  const corpo = html.slice(i, i + 1400);
  const posRedir = corpo.indexOf("window.location.href='/'");
  const posAviso = corpo.indexOf("toast('✅ Conta deletada");
  assert.ok(posRedir > -1, 'o redirecionamento sumiu do fluxo de exclusão');
  assert.ok(posAviso > -1, 'a confirmação sumiu do fluxo de exclusão');
  assert.ok(posRedir < posAviso,
    'a mensagem voltou pra frente do redirecionamento — se ela quebrar, a conta é apagada e a pessoa fica presa numa tela morta');
});
