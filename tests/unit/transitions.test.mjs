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

// ── A MATEMÁTICA DO XFADE ───────────────────────────────────────────────────
// Réplica do cálculo do render (railway-ffmpeg/server.js). Se esta conta
// diverge, o vídeo sai com as cenas fora do lugar depois da 1ª transição.
function cadeiaXfade(duracoes, transicoes) {
  const porJuncao = new Map(transicoes.map(t => [t.between, t]));
  const fc = [];
  let rotulo = '0:v';
  let acumulado = duracoes[0];
  for (let i = 1; i < duracoes.length; i++) {
    const tr = porJuncao.get(i - 1);
    const saida = (i === duracoes.length - 1) ? 'vout' : `vx${i}`;
    const dur = tr ? Math.min(tr.duration, duracoes[i - 1] - 0.05, duracoes[i] - 0.05) : 0.04;
    const nome = tr ? tr.xfade : 'fade';
    const offset = Math.max(0, acumulado - dur);
    fc.push({ nome, dur, offset, saida });
    acumulado = acumulado + duracoes[i] - dur;
    rotulo = saida;
  }
  return { fc, total: acumulado, rotulo };
}

test('offset do xfade: cada transição sobrepoe, e a seguinte compensa', () => {
  // 3 clipes de 10s, transição de 1s nas duas junções
  const r = cadeiaXfade([10, 10, 10], [
    { between: 0, duration: 1, xfade: 'fade' },
    { between: 1, duration: 1, xfade: 'slidedown' },
  ]);
  assert.equal(r.fc[0].offset, 9, '1a transição começa 1s antes do fim do 1o clip');
  // depois da 1a sobreposição a cadeia tem 19s; a 2a começa em 18
  assert.equal(r.fc[1].offset, 18, '2a transição tem que descontar a sobreposição anterior');
  assert.equal(r.total, 28, '3x10s com 2 sobreposições de 1s = 28s');
});

test('duração da transição nunca engole o clipe inteiro', () => {
  // clipe de 0,5s com transição pedida de 3s
  const r = cadeiaXfade([0.5, 10], [{ between: 0, duration: 3, xfade: 'fade' }]);
  assert.ok(r.fc[0].dur < 0.5, 'encurtou pra caber: ' + r.fc[0].dur);
  assert.ok(r.fc[0].offset >= 0, 'offset nunca negativo');
});

test('junção SEM transição não desalinha as seguintes', () => {
  const r = cadeiaXfade([10, 10, 10], [{ between: 1, duration: 1, xfade: 'fade' }]);
  assert.ok(Math.abs(r.total - (30 - 0.04 - 1)) < 0.001, 'total: ' + r.total);
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
