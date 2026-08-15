// tests/unit/texto.test.mjs — o texto nao pode sair do video (node --test)
//
// Bug relatado 2026-07-29: a legenda passa da borda do quadro. Sao DUAS pontas:
// no preview a caixa era cortada, e no arquivo final o drawtext do ffmpeg nao
// quebra linha nenhuma. A quebra e decidida uma vez (core/text-layout.js) e
// viaja pronta no payload — estes testes travam essa regra.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/editor-v1/core/store.js';
import * as act from '../../public/editor-v1/core/actions.js';
import { exportPayload } from '../../public/editor-v1/core/selectors.js';
import {
  quebrarLinhas, layoutTexto, prenderNoQuadro, layoutDoTexto,
  LARGURA_SEGURA, MAX_LINHAS,
} from '../../public/editor-v1/core/text-layout.js';
import {
  estadoAnim, exprFfmpeg, duracaoAnim, animValida,
} from '../../public/editor-v1/core/text-anim.js';

// medicao de teste: cada caractere ocupa metade da fonte (deterministica)
const medir = (s, f) => String(s).length * f * 0.5;

test('quebra em palavras quando a linha estoura', () => {
  const linhas = quebrarLinhas('um dois tres quatro cinco', (s) => medir(s, 10), 100);
  assert.ok(linhas.length > 1);
  for (const l of linhas) assert.ok(medir(l, 10) <= 100, `linha larga demais: "${l}"`);
});

test('respeita a quebra que o usuario digitou', () => {
  const linhas = quebrarLinhas('a\nb', (s) => medir(s, 10), 1000);
  assert.deepEqual(linhas, ['a', 'b']);
});

test('palavra gigante e PARTIDA (senao vazaria sozinha do quadro)', () => {
  const gigante = 'A'.repeat(80);
  const linhas = quebrarLinhas(gigante, (s) => medir(s, 10), 100);
  assert.ok(linhas.length > 1, 'tem que partir');
  for (const l of linhas) assert.ok(medir(l, 10) <= 100, `pedaco largo demais: ${l.length} chars`);
  assert.equal(linhas.join(''), gigante, 'sem perder nem duplicar caractere');
});

test('texto curto continua numa linha so', () => {
  assert.deepEqual(quebrarLinhas('oi', (s) => medir(s, 10), 500), ['oi']);
});

test('texto vazio nao quebra o layout', () => {
  assert.deepEqual(quebrarLinhas('', (s) => medir(s, 10), 100), ['']);
  assert.deepEqual(quebrarLinhas(null, (s) => medir(s, 10), 100), ['']);
});

test('paredao de linhas encolhe a fonte em vez de crescer sem parar', () => {
  const texto = Array.from({ length: 40 }, (_, i) => 'palavra' + i).join(' ');
  const r = layoutTexto({ texto, fontePx: 100, larguraQuadro: 1080, medirCom: medir });
  assert.ok(r.fontePx < 100, 'a fonte encolheu');
  assert.ok(r.fontePx >= 100 * 0.55, 'mas nao vira formiga');
});

test('nenhuma linha passa da largura segura do quadro', () => {
  const r = layoutTexto({
    texto: 'uma legenda bem comprida que precisa quebrar em varias linhas mesmo',
    fontePx: 60, larguraQuadro: 1080, medirCom: medir,
  });
  for (const l of r.linhas) {
    assert.ok(medir(l, r.fontePx) <= 1080 * LARGURA_SEGURA + 1e-6, `linha estourou: "${l}"`);
  }
});

test('prender no quadro puxa o bloco pra dentro das bordas', () => {
  const p = prenderNoQuadro({ xPct: 0.98, yPct: 0.99, larguraPx: 400, alturaPx: 100,
    larguraQuadro: 1080, alturaQuadro: 1920 });
  assert.ok(p.xPct < 0.98, 'trouxe pra dentro na horizontal');
  assert.ok(p.yPct < 0.99, 'trouxe pra dentro na vertical');
  // a metade do bloco cabe dentro do quadro
  assert.ok(p.xPct + (400 / 2) / 1080 <= 1);
  assert.ok(p.yPct + (100 / 2) / 1920 <= 1);
});

test('texto centrado e pequeno NAO e movido a toa', () => {
  const p = prenderNoQuadro({ xPct: 0.5, yPct: 0.5, larguraPx: 100, alturaPx: 40,
    larguraQuadro: 1080, alturaQuadro: 1920 });
  assert.equal(p.xPct, 0.5);
  assert.equal(p.yPct, 0.5);
});

test('a quebra NAO depende da largura de referencia (preview = render)', () => {
  const txt = { content: 'uma legenda comprida o suficiente pra quebrar em linhas', size: 'large', font: 'Anton', x_pct: 0.5, y_pct: 0.5 };
  const a = layoutDoTexto(txt, 0.09, 1080, 1920);
  const b = layoutDoTexto(txt, 0.09, 540, 960);
  assert.deepEqual(a.linhas, b.linhas, 'as mesmas linhas em qualquer largura');
  assert.ok(Math.abs(a.fontePct - b.fontePct) < 1e-9, 'a mesma fonte relativa');
});

// ── o que chega no RENDER ──

function storeComTexto(content, patch = {}) {
  const store = createStore();
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 30, width: 1080, height: 1920, size_bytes: 1 }));
  store.dispatch(act.addText({ content, start_sec: 0, end_sec: 3, ...patch }));
  return store;
}

test('o payload leva as LINHAS prontas (o ffmpeg nao quebra sozinho)', () => {
  const store = storeComTexto('uma legenda bem comprida que nao cabe de jeito nenhum numa linha so do quadro');
  const t = exportPayload(store.getState()).texts[0];
  assert.ok(Array.isArray(t.lines), 'campo lines existe');
  assert.ok(t.lines.length > 1, 'e veio quebrada: ' + t.lines.length + ' linhas');
  assert.equal(t.lines.join(' ').replace(/\s+/g, ' ').trim(), t.content.replace(/\s+/g, ' ').trim(),
    'as linhas somam exatamente o texto original');
});

test('o payload leva a fonte final (a que encolheu, se encolheu)', () => {
  const store = storeComTexto(Array.from({ length: 60 }, (_, i) => 'p' + i).join(' '), { size: 'xlarge' });
  const t = exportPayload(store.getState()).texts[0];
  assert.ok(t.font_pct > 0);
  assert.ok(t.font_pct < 0.13, 'menor que o xlarge nominal (encolheu pra caber)');
  // texto MUITO longo ainda gera muitas linhas de proposito: o piso de 55%
  // vale mais que caber em 4 linhas (legenda ilegivel nao serve pra nada)
  assert.ok(t.font_pct >= 0.13 * 0.55 - 1e-9, 'mas nao passa do piso');
});

test('o payload leva a posicao JA presa no quadro', () => {
  const store = storeComTexto('legenda comprida perto da borda direita do quadro');
  const st = store.getState();
  const id = st.texts[0].id;
  store.dispatch(act.moveText(id, 0.99, 0.99));   // joga pro canto
  const t = exportPayload(store.getState()).texts[0];
  assert.ok(t.x_pct < 0.99, `x_pct ${t.x_pct} tem que ter sido puxado pra dentro`);
  assert.ok(t.y_pct < 0.99, `y_pct ${t.y_pct} tem que ter sido puxado pra dentro`);
});

// ── ANIMACAO (antes so existia como CSS das miniaturas do painel) ──

test('sem animacao, o texto fica cheio o tempo todo', () => {
  for (const u of [0, 0.1, 1, 2.9]) {
    const e = estadoAnim('nenhuma', u, 3);
    assert.equal(e.opacidade, 1);
    assert.equal(e.escala, 1);
  }
});

test('fade: entra do zero, fica cheio no meio e sai no fim', () => {
  const ini = estadoAnim('fade', 0, 3);
  const meio = estadoAnim('fade', 1.5, 3);
  const fim = estadoAnim('fade', 3, 3);
  assert.equal(ini.opacidade, 0);
  assert.equal(meio.opacidade, 1);
  assert.equal(fim.opacidade, 0);
});

test('pop: comeca menor, passa de 1 (o salto) e assenta em 1', () => {
  const ini = estadoAnim('pop', 0, 3);
  const d = duracaoAnim(3);
  const salto = estadoAnim('pop', d * 0.6, 3);
  const parado = estadoAnim('pop', 1.5, 3);
  assert.ok(ini.escala < 1, 'entra menor');
  assert.ok(salto.escala > 1, 'passa de 1 no meio da entrada');
  assert.equal(parado.escala, 1, 'e assenta');
});

test('subir: entra deslocado e assenta no lugar', () => {
  assert.ok(estadoAnim('subir', 0, 3).deslocY > 0);
  assert.equal(estadoAnim('subir', 2, 3).deslocY, 0);
});

test('a animacao nunca come mais que um quarto de um bloco curto', () => {
  assert.ok(duracaoAnim(0.4) <= 0.4 / 4 + 1e-9, 'legenda de palavra nao fica so animando');
  assert.equal(duracaoAnim(10), 0.35, 'e tem teto em blocos longos');
});

test('animacao invalida cai no padrao (nao quebra projeto antigo)', () => {
  assert.equal(animValida('inexistente'), 'nenhuma');
  assert.equal(animValida(undefined), 'nenhuma');
  assert.equal(animValida('pop'), 'pop');
});

test('as expressoes de ffmpeg saem so pra quem anima', () => {
  assert.equal(exprFfmpeg('nenhuma', 0, 3).alpha, null, 'sem animacao = filtro limpo');
  assert.ok(exprFfmpeg('fade', 0, 3).alpha.includes('min('));
  assert.equal(exprFfmpeg('fade', 0, 3).escala, null, 'fade nao mexe no tamanho');
  assert.ok(exprFfmpeg('pop', 0, 3).escala.includes('if('), 'pop anima o tamanho');
  assert.ok(exprFfmpeg('subir', 0, 3).deslocY.includes('1-'), 'subir anima a posicao');
});

test('as virgulas das expressoes vao ESCAPADAS (senao viram outro filtro)', () => {
  const e = exprFfmpeg('pop', 0, 3);
  // toda virgula dentro da expressao precisa de \ — sem isso o ffmpeg entende
  // como separador de filtro e o comando inteiro quebra
  for (const s of [e.alpha, e.escala]) {
    const cruas = (s.match(/(^|[^\\]),/g) || []).length;
    assert.equal(cruas, 0, 'virgula sem escape em: ' + s);
  }
});

test('o payload leva a animacao escolhida (e omite quando nao ha)', () => {
  const a = storeComTexto('oi', { anim: 'pop' });
  assert.equal(exportPayload(a.getState()).texts[0].anim, 'pop');
  const b = storeComTexto('oi');
  assert.equal(exportPayload(b.getState()).texts[0].anim, undefined);
});

test('texto curto e centralizado atravessa o payload sem mexer', () => {
  const store = storeComTexto('oi');
  const t = exportPayload(store.getState()).texts[0];
  assert.deepEqual(t.lines, ['oi']);
  assert.equal(t.x_pct, 0.5);
});
