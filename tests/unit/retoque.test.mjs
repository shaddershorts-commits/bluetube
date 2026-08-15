// tests/unit/retoque.test.mjs — Retoque: Basico + HSL + Curvas + Roda
//
// O bug de fundo que estes testes travam: o grade NAO saia do navegador. Nao
// era enviado no payload E nao sobrevivia a reabrir o projeto (o
// normalizeLoadedState nao copiava o campo). Os 15 controles aprovados em
// 29/07 eram, na pratica, enfeite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/editor-v1/core/store.js';
import * as act from '../../public/editor-v1/core/actions.js';
import { exportPayload } from '../../public/editor-v1/core/selectors.js';
import { normalizeLoadedState } from '../../public/editor-v1/core/schema.js';
import {
  CAMPOS_COR, TODAS_CHAVES, CHAVES_HSL, CHAVES_CURVA, CHAVES_RODA,
  FAIXAS_HSL, ANCORAS_CURVA, temAjuste, svgDoGrade, paramsRender,
  nivelDoCanal, pontosCurva, pesosTonais, NEUTRO,
} from '../../public/editor-v1/preview/color-grade.js';

function comClipe() {
  const store = createStore();
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 30, width: 1080, height: 1920, size_bytes: 1 }));
  return store;
}
const idDoClipe = (store) => store.getState().clips[0].id;

// ── catalogo ──

test('as 3 abas novas trouxeram controles de verdade', () => {
  assert.equal(CHAVES_HSL.length, 18, '6 faixas x 3 eixos');
  assert.equal(CHAVES_CURVA.length, 12, '4 canais x 3 ancoras');
  assert.equal(CHAVES_RODA.length, 9, '3 faixas tonais x 3 canais');
  assert.equal(TODAS_CHAVES.length, CAMPOS_COR.length + 39);
});

test('nenhuma chave repetida entre as abas', () => {
  assert.equal(new Set(TODAS_CHAVES).size, TODAS_CHAVES.length);
});

test('toda chave e NUMERO plano (o reducer so aceita isso)', () => {
  for (const k of TODAS_CHAVES) assert.equal(typeof NEUTRO[k], 'number');
});

test('pesos tonais somam ~1 e separam as zonas', () => {
  const s = pesosTonais(0), m = pesosTonais(0.5), a = pesosTonais(1);
  assert.ok(s.sombras > 0.9 && s.altas === 0, 'preto e sombra');
  assert.ok(m.medios > 0.9, 'meio e medio');
  assert.ok(a.altas > 0.9 && a.sombras === 0, 'branco e alta');
});

// ── o porteiro (temAjuste) ──

test('temAjuste ENXERGA as abas novas (senao o filtro nem liga)', () => {
  assert.equal(temAjuste({}), false);
  assert.equal(temAjuste({ hsl_azul_s: 40 }), true);
  assert.equal(temAjuste({ cur_r_medios: -30 }), true);
  assert.equal(temAjuste({ roda_altas_b: 20 }), true);
});

// ── preview (SVG) ──

test('cada aba nova produz filtro SVG de verdade', () => {
  assert.ok(svgDoGrade({ hsl_vermelho_s: 60 }, 'f').includes('feColorMatrix'), 'HSL');
  assert.ok(svgDoGrade({ cur_rgb_altas: 60 }, 'f').includes('feComponentTransfer'), 'curvas');
  assert.ok(svgDoGrade({ roda_sombras_r: 60 }, 'f').includes('feComponentTransfer'), 'roda');
  assert.equal(svgDoGrade({}, 'f'), null, 'neutro nao paga filtro nenhum');
});

test('HSL usa a MASCARA da faixa escolhida (e seletivo, nao global)', () => {
  const svg = svgDoGrade({ hsl_azul_s: 80 }, 'f');
  const azul = FAIXAS_HSL.find(f => f.id === 'azul').mascara;
  assert.ok(svg.includes(`${azul[0]} ${azul[1]} ${azul[2]}`), 'a mascara do azul aparece no filtro');
});

test('mexer no canal R muda SO a tabela do R', () => {
  const svg = svgDoGrade({ cur_r_medios: 80 }, 'f');
  const tabelas = [...svg.matchAll(/feFunc([RGB]) type="table" tableValues="([^"]+)"/g)];
  const porCanal = Object.fromEntries(tabelas.map(m => [m[1], m[2]]));
  assert.notEqual(porCanal.R, porCanal.G, 'R saiu diferente');
  assert.equal(porCanal.G, porCanal.B, 'G e B seguem iguais');
});

// ── a curva ──

test('curva neutra e a identidade', () => {
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    assert.ok(Math.abs(nivelDoCanal({}, 'r', v) - v) < 1e-9);
  }
});

test('levantar as altas mexe no topo e quase nao mexe no preto', () => {
  const g = { cur_rgb_altas: 100 };
  assert.ok(nivelDoCanal(g, 'r', 0.9) > 0.9, 'topo subiu');
  assert.ok(Math.abs(nivelDoCanal(g, 'r', 0.05) - 0.05) < 0.02, 'preto ficou');
});

test('levantar as sombras mexe no preto e quase nao mexe no topo', () => {
  const g = { cur_rgb_sombras: 100 };
  assert.ok(nivelDoCanal(g, 'r', 0.05) > 0.15, 'preto levantou');
  assert.ok(Math.abs(nivelDoCanal(g, 'r', 0.95) - 0.95) < 0.02, 'topo ficou');
});

test('a curva nunca sai de 0..1 (nem no exagero)', () => {
  const g = {};
  for (const k of TODAS_CHAVES) g[k] = 100;
  for (let i = 0; i <= 20; i++) {
    const y = nivelDoCanal(g, 'r', i / 20);
    assert.ok(y >= 0 && y <= 1, `estourou em ${i / 20}: ${y}`);
  }
});

test('os pontos que vao pro ffmpeg saem ordenados e dentro de 0..1', () => {
  const pts = pontosCurva({ cur_rgb_medios: 70 }, 'r');
  assert.ok(pts.length >= 2);
  for (let i = 0; i < pts.length; i++) {
    assert.ok(pts[i][0] >= 0 && pts[i][0] <= 1 && pts[i][1] >= 0 && pts[i][1] <= 1);
    if (i) assert.ok(pts[i][0] > pts[i - 1][0], 'x sempre crescente');
  }
});

test('a curva do payload SEGUE a conta do preview (mesma regua)', () => {
  const g = { cur_rgb_altas: 40, roda_sombras_b: 30, exposicao: 20 };
  for (const [x, y] of pontosCurva(g, 'b')) {
    assert.ok(Math.abs(nivelDoCanal(g, 'b', x) - y) < 1e-3, `divergiu em x=${x}`);
  }
});

// ── o que chega no render ──

test('neutro nao manda nada pro render', () => {
  assert.equal(paramsRender({}), null);
  assert.equal(paramsRender(NEUTRO), null);
});

test('HSL vira faixa que o ffmpeg entende (r/y/g/c/b/m)', () => {
  const p = paramsRender({ hsl_amarelo_h: 50, hsl_azul_s: -40 });
  const faixas = p.hsl.map(h => h.faixa).sort();
  assert.deepEqual(faixas, ['b', 'y']);
  const amarelo = p.hsl.find(h => h.faixa === 'y');
  assert.ok(Math.abs(amarelo.h) > 0 && Math.abs(amarelo.h) <= 180, 'matiz em graus');
});

test('saturacao ZERO (preto e branco) vai pro render — nao pode virar falsy', () => {
  const p = paramsRender({ saturacao: -100 });
  assert.equal(p.saturacao, 0);
  assert.ok('saturacao' in p, 'a chave TEM que existir mesmo valendo 0');
});

test('o payload leva o grade E os numeros do render', () => {
  const store = comClipe();
  store.dispatch(act.setClipGrade(idDoClipe(store), { exposicao: 40, hsl_verde_s: 50 }));
  const c = exportPayload(store.getState()).clips[0];
  assert.ok(c.grade, 'estado cru pra reabrir o projeto');
  assert.ok(c.grade_render, 'numeros prontos pro ffmpeg');
  assert.ok(c.grade_render.curvas, 'a exposicao virou curva');
  assert.ok(c.grade_render.hsl.some(h => h.faixa === 'g'), 'o verde foi junto');
});

test('cena sem retoque nao engorda o payload', () => {
  const store = comClipe();
  const c = exportPayload(store.getState()).clips[0];
  assert.equal(c.grade, undefined);
  assert.equal(c.grade_render, undefined);
});

// ── persistencia (o bug silencioso) ──

test('o Retoque SOBREVIVE a reabrir o projeto', () => {
  const store = comClipe();
  store.dispatch(act.setClipGrade(idDoClipe(store), { contraste: 35, cur_g_altas: -20, hsl_ciano_l: 15 }));
  const salvo = JSON.parse(JSON.stringify(store.getState()));
  const recarregado = normalizeLoadedState(salvo);
  assert.equal(recarregado.clips[0].grade.contraste, 35);
  assert.equal(recarregado.clips[0].grade.cur_g_altas, -20);
  assert.equal(recarregado.clips[0].grade.hsl_ciano_l, 15);
});

test('ao recarregar, valor fora da faixa e cortado e lixo e descartado', () => {
  const bruto = {
    video: { url: 'u', duration: 10 },
    clips: [{ id: 1, source_in: 0, source_out: 5, active: true,
      grade: { contraste: 9999, exposicao: -9999, 'x)malicioso': 5, vazio: 'abc' } }],
  };
  const s = normalizeLoadedState(bruto);
  assert.equal(s.clips[0].grade.contraste, 100);
  assert.equal(s.clips[0].grade.exposicao, -100);
  assert.equal('x)malicioso' in s.clips[0].grade, false, 'chave estranha nao entra');
  assert.equal('vazio' in s.clips[0].grade, false, 'valor nao-numerico nao entra');
});

test('redefinir limpa TUDO, inclusive as abas novas', () => {
  const store = comClipe();
  const id = idDoClipe(store);
  store.dispatch(act.setClipGrade(id, { hsl_azul_h: 40, cur_b_sombras: 20, roda_medios_g: -30 }));
  store.dispatch(act.setClipGrade(id, null));
  assert.equal(store.getState().clips[0].grade, undefined);
});
