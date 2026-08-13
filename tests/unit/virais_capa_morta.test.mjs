// tests/unit/virais_capa_morta.test.mjs — node --test
//
// A CAPA CINZA DOS VÍDEOS REMOVIDOS DO YOUTUBE.
//
// ── O CASO REAL (12/08/2026) ────────────────────────────────────────────────
// O dono viu quadrados cinzas no lugar da capa em respostas do chat do Blublu
// na Virais, e perguntou se dava pra consertar SEM tirar os vídeos do acervo.
//
// Causa, MEDIDA contra o i.ytimg.com: quando o vídeo é removido do YouTube, a
// capa responde **HTTP 404 com um JPEG cinza de 120x90 dentro** (1.097 bytes).
// Vale pra todas as resoluções — maxres, sd, hq e mq devolvem o mesmo cinza.
// Comparação no mesmo teste: vídeo vivo devolve 200 / 111 KB / 1280x720.
//
// E é isso que explica por que o conserto anterior nunca funcionou: o corpo é
// um JPEG VÁLIDO, então o navegador decodifica e considera a imagem carregada.
// `onerror="this.style.display='none'"` NÃO dispara. O que aparece é o cinza do
// YouTube, não um erro.
//
// A única marca confiável é o TAMANHO. Por isso a verificação é no `onload`, e
// por dimensão — não por status HTTP (que o <img> não expõe) nem por onerror.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HTML = readFileSync(new URL('../../public/virais.html', import.meta.url), 'utf8');

// Recorta a função do arquivo real e roda ela de verdade num DOM mínimo.
function carregarFuncao() {
  const i = HTML.indexOf('window.btCapaMorta = function');
  const fim = HTML.indexOf('\n};', i) + 3;
  assert.ok(i > 0 && fim > i, 'btCapaMorta sumiu do virais.html');
  const criados = [];
  const ctx = {
    window: {},
    escHtml: (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    getComputedStyle: (el) => ({ position: el._pos || 'static' }),
    document: {
      createElement: (t) => {
        const el = { tag: t, className: '', innerHTML: '', style: {}, children: [] };
        criados.push(el);
        return el;
      },
    },
    console,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInNewContext(HTML.slice(i, fim), ctx, { filename: 'virais.html' });
  return { fn: ctx.window.btCapaMorta, criados };
}

function imgFalsa(w, h, cap, posPai) {
  const pai = {
    _pos: posPai || 'relative',
    filhos: [],
    querySelector: function (sel) { return this.filhos.find((f) => (f.className || '').includes(sel.replace('.', ''))) || null; },
    appendChild: function (c) { this.filhos.push(c); return c; },
  };
  return {
    naturalWidth: w, naturalHeight: h, style: {}, parentElement: pai,
    getAttribute: (k) => (k === 'data-cap' ? cap : null),
    _pai: pai,
  };
}

test('a capa 120x90 do YouTube (vídeo removido) vira cartão de reserva', () => {
  const { fn } = carregarFuncao();
  const img = imgFalsa(120, 90, 'Hokage Damage Test');
  fn(img);
  assert.equal(img.style.display, 'none', 'a imagem cinza sai da tela');
  assert.equal(img._pai.filhos.length, 1, 'e entra um cartão no lugar');
  assert.match(img._pai.filhos[0].className, /tk-fallback/);
  assert.match(img._pai.filhos[0].innerHTML, /Hokage Damage Test/, 'com o título do vídeo, que continua no acervo');
});

test('capa BOA não é tocada (o conserto não pode apagar o que funciona)', () => {
  const { fn } = carregarFuncao();
  for (const [w, h] of [[1280, 720], [480, 360], [320, 180]]) {
    const img = imgFalsa(w, h, 'vídeo normal');
    fn(img);
    assert.notEqual(img.style.display, 'none', `${w}x${h} é capa de verdade e foi escondida`);
    assert.equal(img._pai.filhos.length, 0);
  }
});

test('erro de rede (largura 0) também cai no cartão de reserva', () => {
  const { fn } = carregarFuncao();
  const img = imgFalsa(0, 0, 'sem rede');
  fn(img);
  assert.equal(img.style.display, 'none');
  assert.equal(img._pai.filhos.length, 1);
});

test('o cartão não é criado duas vezes se a função rodar de novo', () => {
  const { fn } = carregarFuncao();
  const img = imgFalsa(120, 90, 'x');
  fn(img); fn(img);
  assert.equal(img._pai.filhos.length, 1, 'onload + onerror no mesmo <img> não pode empilhar cartão');
});

test('o título é ESCAPADO (ele vem do banco e vai pra innerHTML)', () => {
  const { fn } = carregarFuncao();
  const img = imgFalsa(120, 90, '<img src=x onerror=alert(1)>');
  fn(img);
  const html = img._pai.filhos[0].innerHTML;
  assert.equal(html.includes('<img src=x'), false, 'título do banco virando HTML é XSS');
  assert.match(html, /&lt;img/);
});

test('pai sem posicionamento ganha a variante "solta" (o card do Blublu)', () => {
  const { fn } = carregarFuncao();
  const relativo = imgFalsa(120, 90, 'a', 'relative');
  fn(relativo);
  assert.equal(/solta/.test(relativo._pai.filhos[0].className), false, 'wrapper posicionado usa o inset:0 normal');
  const estatico = imgFalsa(120, 90, 'a', 'static');
  fn(estatico);
  assert.match(estatico._pai.filhos[0].className, /solta/,
    'sem isso o cartão colapsaria pra altura zero no card do Blublu');
  assert.match(HTML, /\.tk-fallback\.solta\{/, 'e a classe precisa existir no CSS');
});

test('os dois cards que só escondiam a imagem agora chamam a verificação', () => {
  // O `onerror` sozinho era inútil: ele nunca dispara pro cinza do YouTube.
  assert.equal(/onerror="this\.style\.display='none'"/.test(HTML), false,
    'o conserto que não funcionava não pode voltar');
  const chamadas = (HTML.match(/onload="btCapaMorta\(this\)"/g) || []).length;
  assert.ok(chamadas >= 2, `só ${chamadas} cards verificam a capa — o do Blublu e o da grade precisam`);
  assert.equal((HTML.match(/data-cap="/g) || []).length, chamadas,
    'todo card que verifica precisa passar o título pelo data-cap');
  // ⚠️ O título NÃO pode ir por JSON.stringify dentro do atributo: aspas duplas
  // no título fechariam o atributo e quebrariam a tag. Foi o 1º erro aqui.
  assert.equal(/btCapaMorta\(this,\$\{JSON\.stringify/.test(HTML), false);
});

test('nenhum vídeo é removido do acervo por causa da capa', () => {
  const i = HTML.indexOf('window.btCapaMorta');
  const fn = HTML.slice(i, HTML.indexOf('\n};', i));
  for (const proibido of ['delete', 'remove()', 'splice', 'fetch(']) {
    assert.equal(fn.includes(proibido), false,
      `a correção de capa mexe só na TELA — "${proibido}" indica que ela passou a mexer em dado`);
  }
  assert.match(HTML, /Isto NÃO tira o vídeo do acervo/, 'e o porquê fica escrito no código');
});
