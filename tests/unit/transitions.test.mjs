// tests/unit/transitions.test.mjs — node --test
// O catálogo e a MATEMÁTICA do xfade. O offset é onde erro passa despercebido:
// um cálculo errado só aparece como "áudio dessincronizado" depois da primeira
// transição, no vídeo pronto — caro demais pra descobrir tarde.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/editor-v1/core/store.js';
import * as act from '../../public/editor-v1/core/actions.js';
import { exportPayload } from '../../public/editor-v1/core/selectors.js';
import { TRANSICOES, CATEGORIAS, transicaoPorId, daCategoria, buscar } from '../../public/editor-v1/core/transitions.js';

// xfade que o ffmpeg realmente tem (subconjunto usado no catálogo)
const XFADE_FFMPEG = new Set([
  'fade', 'fadeblack', 'fadewhite', 'fadegrays', 'dissolve', 'pixelize', 'radial',
  'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'slideup', 'slidedown',
  'smoothleft', 'smoothright', 'smoothup', 'smoothdown',
  'circlecrop', 'circleopen', 'circleclose', 'rectcrop',
  'hlslice', 'hrslice', 'vuslice', 'vdslice', 'hblur',
  'zoomin', 'squeezeh', 'squeezev', 'hlwind', 'hrwind', 'vuwind', 'vdwind',
  'coverleft', 'coverright', 'coverup', 'coverdown',
]);

test('TODA transição do catálogo tem um xfade REAL do ffmpeg', () => {
  const invalidas = TRANSICOES.filter(t => !XFADE_FFMPEG.has(t.xfade));
  assert.equal(invalidas.length, 0,
    'sem par no ffmpeg (o preview prometeria o que o render não faz): ' +
    invalidas.map(t => t.nome + '→' + t.xfade).join(', '));
});

test('catálogo sem id repetido e com categoria válida', () => {
  const ids = TRANSICOES.map(t => t.id);
  assert.equal(new Set(ids).size, ids.length, 'id repetido');
  const cats = new Set(CATEGORIAS.map(c => c.id));
  for (const t of TRANSICOES) assert.ok(cats.has(t.cat), `${t.nome}: categoria ${t.cat} não existe`);
});

test('as transições do print do user existem', () => {
  for (const nome of ['Esmaecer preto', 'Deslizar baixo', 'Falha de TV', 'Zoom de choque', 'Flash do sol', 'Agitação X']) {
    assert.ok(TRANSICOES.some(t => t.nome === nome), `faltou: ${nome}`);
  }
});

test('busca acha sem acento e sem caixa', () => {
  assert.ok(buscar('ESMAECER').some(t => t.id === 'esmaecer_preto'));
  assert.ok(buscar('agitacao').some(t => t.id === 'agitacao_x'), 'busca sem acento');
  assert.equal(buscar(''), null, 'busca vazia não filtra');
});

test('categoria Favoritos vem do que o usuário marcou', () => {
  assert.deepEqual(daCategoria('favoritos', new Set()), []);
  const favs = new Set(['falha_tv']);
  assert.deepEqual(daCategoria('favoritos', favs).map(t => t.id), ['falha_tv']);
});

// ── estado ──────────────────────────────────────────────────────────────────
function storeCom2Clips() {
  const store = createStore();
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 20, width: 1080, height: 1920, size_bytes: 1 }));
  store.dispatch(act.splitClipAt(10));
  return store;
}

test('aplicar transição guarda o xfade junto (o render precisa dele)', () => {
  const store = storeCom2Clips();
  store.dispatch(act.setTransition(0, 'falha_tv', 0.8, 70));
  const t = store.getState().transitions[0];
  assert.equal(t.type, 'falha_tv');
  assert.equal(t.xfade, 'hlslice');
  assert.equal(t.duration, 0.8);
  assert.equal(t.intensity, 70);
});

test('id fora do catálogo é IGNORADO (não vira transição fantasma)', () => {
  const store = storeCom2Clips();
  store.dispatch(act.setTransition(0, 'inventada_xyz', 1));
  assert.equal(store.getState().transitions.length, 0);
});

test('"cut" remove a transição da junção', () => {
  const store = storeCom2Clips();
  store.dispatch(act.setTransition(0, 'dissolver', 0.5));
  assert.equal(store.getState().transitions.length, 1);
  store.dispatch(act.setTransition(0, 'cut'));
  assert.equal(store.getState().transitions.length, 0);
});

test('duração fica no limite util (0,1s a 3s)', () => {
  const store = storeCom2Clips();
  store.dispatch(act.setTransition(0, 'dissolver', 99));
  assert.equal(store.getState().transitions[0].duration, 3);
  store.dispatch(act.setTransition(0, 'dissolver', 0.01));
  assert.equal(store.getState().transitions[0].duration, 0.1);
});

test('transição entra no payload de export', () => {
  const store = storeCom2Clips();
  store.dispatch(act.setTransition(0, 'zoom_choque', 0.6, 80));
  const p = exportPayload(store.getState());
  assert.equal(p.transitions.length, 1);
  assert.equal(p.transitions[0].xfade, 'zoomin');
});

// ── A MATEMÁTICA DA CADEIA (modelo de EMPRÉSTIMO, 2026-08-07) ───────────────
// A função é extraída do FONTE do render (railway-ffmpeg/server.js) — não é
// réplica, não pode divergir. A régua é SAGRADA: o xfade antigo encurtava o
// vídeo em `dur` por junção enquanto o áudio ficava na régua cheia — todo
// arquivo com transição saía dessincronizado depois da primeira emenda.
import fs from 'node:fs';
const srvTxt = fs.readFileSync(new URL('../../railway-ffmpeg/server.js', import.meta.url), 'utf8');
const planejarCadeia = new Function(
  srvTxt.slice(srvTxt.indexOf('function planejarCadeia('), srvTxt.indexOf('// ── FIM planejarCadeia'))
  + '\nreturn planejarCadeia;')();

test('a régua NÃO encolhe: total = soma das cenas, com 2 transições', () => {
  const r = planejarCadeia(
    [{ idx: 0, dur: 10 }, { idx: 1, dur: 10 }, { idx: 2, dur: 10 }],
    [{ between: 0, duration: 1, xfade: 'fade' }, { between: 1, duration: 1, xfade: 'slidedown' }]);
  assert.equal(r.total, 30, '3x10s continuam 30s — o áudio depende disto');
  // janela CENTRADA na emenda: clip 0 termina (na régua) em 10 e ganhou 0,5s
  // de borda; o xfade começa 1s antes do fim do arquivo dele => offset 9,5
  assert.equal(r.passos[0].offset, 9.5, '1ª janela = [9,5 .. 10,5], centrada na emenda de t=10');
  assert.equal(r.passos[1].offset, 19.5, '2ª janela centrada na emenda de t=20');
});

test('cada vizinho empresta dur/2 de borda (é o que o xfade consome)', () => {
  const r = planejarCadeia(
    [{ idx: 0, dur: 10 }, { idx: 1, dur: 10 }, { idx: 2, dur: 10 }],
    [{ between: 0, duration: 1, xfade: 'fade' }]);
  assert.deepEqual(r.borrows.get(0), { antes: 0, depois: 0.5 });
  assert.deepEqual(r.borrows.get(1), { antes: 0.5, depois: 0 });
  assert.deepEqual(r.borrows.get(2), { antes: 0, depois: 0 });
});

test('duração da transição nunca engole o clipe inteiro', () => {
  const r = planejarCadeia([{ idx: 0, dur: 0.5 }, { idx: 1, dur: 10 }],
    [{ between: 0, duration: 3, xfade: 'fade' }]);
  assert.ok(r.passos[0].dur < 0.5, 'encurtou pra caber: ' + r.passos[0].dur);
  assert.ok(r.passos[0].offset >= 0, 'offset nunca negativo');
  assert.equal(r.total, 10.5, 'régua intacta mesmo com o clamp');
});

test('junção SEM transição é concat de verdade (o fade fake de 0,04s roubava régua)', () => {
  const r = planejarCadeia(
    [{ idx: 0, dur: 10 }, { idx: 1, dur: 10 }, { idx: 2, dur: 10 }],
    [{ between: 1, duration: 1, xfade: 'fade' }]);
  assert.equal(r.passos[0].tipo, 'concat');
  assert.equal(r.passos[1].tipo, 'xfade');
  assert.equal(r.total, 30);
});

test('clip pulado no trim (<0,05s) desloca a emenda: transição vira seca, nunca cai no lugar errado', () => {
  // idx 1 sumiu do plano (era minúsculo); a transição estava na junção 0
  const r = planejarCadeia([{ idx: 0, dur: 10 }, { idx: 2, dur: 10 }],
    [{ between: 0, duration: 1, xfade: 'fade' }]);
  assert.equal(r.passos[0].tipo, 'concat', 'não pode aplicar o xfade numa emenda que não é a dela');
  assert.equal(r.temXfade, false);
});

// ── REMAP DO between NO EXPORT (compostos achatados, 2026-08-07) ───────────
import { remapTransicoes } from '../../public/editor-v1/core/selectors.js';

test('composto antes da emenda: between é remapeado pro clip achatado', () => {
  const store = createStore();
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 30, width: 1080, height: 1920, size_bytes: 1 }));
  store.dispatch(act.splitClipAt(10));
  store.dispatch(act.splitClipAt(20));
  const [c1, c2] = store.getState().clips;
  store.dispatch(act.setMultiSelect([{ type: 'clip', id: c1.id }, { type: 'clip', id: c2.id }]));
  store.dispatch(act.createCompound());
  // main track agora: [composto(2 cenas), cena3] — 1 junção de ITEM (indice 0)
  store.dispatch(act.setTransition(0, 'dissolver', 0.5));
  const p = exportPayload(store.getState());
  assert.equal(p.clips.length, 3, 'export achata o composto');
  assert.equal(p.transitions.length, 1);
  assert.equal(p.transitions[0].between, 1,
    'a emenda do ITEM 0 é a junção entre o 2º e o 3º clip ACHATADO');
});

test('sem composto o remap é identidade', () => {
  const store = storeCom2Clips();
  store.dispatch(act.setTransition(0, 'dissolver', 0.5));
  assert.equal(remapTransicoes(store.getState())[0].between, 0);
});

// ── MARCADOR NA TIMELINE (2026-07-29) ──────────────────────────────────────
// Sem marcador a transicao era invisivel na timeline: o user aplicava e nao
// tinha como ver onde estava nem clicar pra ajustar.
import { computeLayout, timeToX } from '../../public/editor-v1/timeline/layout.js';
import { hitTest } from '../../public/editor-v1/timeline/hittest.js';
import { transition as fsmStep, idle as fsmIdle } from '../../public/editor-v1/timeline/interaction.js';

const VP = { width: 900, height: 320, scrollX: 0, pxPerSec: 40 };

test('a transicao vira um marcador na EMENDA das duas cenas', () => {
  const store = storeCom2Clips();
  store.dispatch(act.setTransition(0, 'deslizar_baixo', 0.6));
  const lay = computeLayout(store.getState(), VP);
  assert.equal(lay.transMarks.length, 1);
  // a emenda esta em t=10 (video de 20s cortado no meio)
  const esperado = timeToX(VP, 10);   // a funcao real, nao um numero chutado
  assert.ok(Math.abs(lay.transMarks[0].x - esperado) < 2,
    `marcador fora da emenda: ${lay.transMarks[0].x} vs ${esperado}`);
});

test('sem transicao nao ha marcador', () => {
  const lay = computeLayout(storeCom2Clips().getState(), VP);
  assert.equal((lay.transMarks || []).length, 0);
});

test('clicar no marcador ACHA a transicao (e nao o trim do clip)', () => {
  const store = storeCom2Clips();
  store.dispatch(act.setTransition(0, 'dissolver', 0.5));
  const lay = computeLayout(store.getState(), VP);
  const m = lay.transMarks[0];
  const hit = hitTest(lay, m.x, m.y);
  assert.equal(hit.type, 'transition', 'pegou: ' + hit.type);
  assert.equal(hit.between, 0);
});

test('clicar no marcador SELECIONA a emenda', () => {
  const store = storeCom2Clips();
  store.dispatch(act.setTransition(0, 'dissolver', 0.5));
  const lay = computeLayout(store.getState(), VP);
  const m = lay.transMarks[0];
  const r = fsmStep(fsmIdle(), { kind: 'down', x: m.x, y: m.y, hit: hitTest(lay, m.x, m.y) },
    { layout: lay, playhead: 0, cutPoints: [], snapEnabled: true });
  const ef = r.effects.find(e => e.do === 'select-transition');
  assert.ok(ef && ef.between === 0, JSON.stringify(r.effects));
});

test('clicar FORA fecha os parametros (user: "clico fora e fecha")', () => {
  const store = storeCom2Clips();
  store.dispatch(act.setTransition(0, 'dissolver', 0.5));
  const lay = computeLayout(store.getState(), VP);
  const r = fsmStep(fsmIdle(), { kind: 'down', x: 600, y: lay.yVideo + 5, hit: hitTest(lay, 600, lay.yVideo + 5) },
    { layout: lay, playhead: 0, cutPoints: [], snapEnabled: true });
  const ef = r.effects.find(e => e.do === 'select-transition');
  assert.ok(ef && ef.between === null, 'deveria limpar a selecao');
});

test('marcador selecionado fica aceso (o desenho distingue)', () => {
  const store = storeCom2Clips();
  store.dispatch(act.setTransition(0, 'dissolver', 0.5));
  const st = store.getState();
  assert.equal(computeLayout(st, VP).transMarks[0].selected, false);
  assert.equal(computeLayout({ ...st, _juncao_sel: 0 }, VP).transMarks[0].selected, true);
});
