// tests/unit/timeline.test.mjs — layout, hittest, snap (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/editor-v1/core/store.js';
import * as act from '../../public/editor-v1/core/actions.js';
import { computeLayout, timeToX, xToTime, zoomAt, zoomToFit, rulerTicks, METRICS } from '../../public/editor-v1/timeline/layout.js';
import { hitTest } from '../../public/editor-v1/timeline/hittest.js';
import { snapTime, defaultSnapPoints } from '../../public/editor-v1/timeline/snap.js';

const VP = { pxPerSec: 10, scrollX: 0, width: 800, height: 200 };

function makeState(clipsSpec = [[0, 60]]) {
  const store = createStore();
  store.dispatch(act.setVideo({ url: 'u', duration: 60, width: 1080, height: 1920 }));
  // aplica splits pra gerar os clips desejados (simples: 1 clip default)
  return store;
}

test('timeToX/xToTime sao inversas', () => {
  for (const t of [0, 1.5, 30, 59.99]) {
    const x = timeToX(VP, t);
    assert.ok(Math.abs(xToTime(VP, x) - t) < 1e-9);
  }
});

test('layout posiciona clip com PAD_LEFT e largura zoom', () => {
  const store = makeState();
  const layout = computeLayout(store.getState(), VP);
  assert.equal(layout.clips.length, 1);
  assert.equal(layout.clips[0].x, METRICS.PAD_LEFT);
  assert.equal(layout.clips[0].w, 600); // 60s * 10px
});

test('zoomAt mantem o tempo sob o cursor', () => {
  const anchorX = 300;
  const tBefore = xToTime(VP, anchorX);
  const z = zoomAt(VP, 2, anchorX);
  const tAfter = xToTime({ ...VP, ...z }, anchorX);
  assert.ok(Math.abs(tBefore - tAfter) < 1e-6);
  assert.equal(z.pxPerSec, 20);
});

test('zoomAt clampa em MIN/MAX', () => {
  const z1 = zoomAt(VP, 1e9, 0);
  assert.equal(z1.pxPerSec, METRICS.MAX_PX_PER_SEC);
  const z2 = zoomAt(VP, 1e-9, 0);
  assert.equal(z2.pxPerSec, METRICS.MIN_PX_PER_SEC);
});

test('zoomToFit cabe a timeline inteira', () => {
  const store = makeState();
  const z = zoomToFit(store.getState(), 800);
  const totalPx = 60 * z.pxPerSec;
  assert.ok(totalPx <= 800 - METRICS.PAD_LEFT);
});

test('rulerTicks: majors espacados >= 80px', () => {
  const layout = computeLayout(makeState().getState(), VP);
  const ticks = rulerTicks(layout).filter(t => t.major);
  for (let i = 1; i < ticks.length; i++) {
    assert.ok(ticks[i].x - ticks[i - 1].x >= 79.9);
  }
});

test('hitTest: corpo do clip', () => {
  const store = makeState();
  const layout = computeLayout(store.getState(), VP);
  const c = layout.clips[0];
  const hit = hitTest(layout, c.x + c.w / 2, c.y + c.h / 2);
  assert.equal(hit.type, 'clip-body');
  assert.equal(hit.clipId, c.clipId);
});

test('hitTest: trim handles SO no clip selecionado', () => {
  const store = makeState();
  let layout = computeLayout(store.getState(), VP);
  const c = layout.clips[0];
  // sem selecao: borda e clip-body
  let hit = hitTest(layout, c.x + 1, c.y + c.h / 2);
  assert.equal(hit.type, 'clip-body');
  // seleciona -> borda vira trim-in
  store.dispatch(act.selectClip(c.clipId));
  layout = computeLayout(store.getState(), VP);
  hit = hitTest(layout, c.x + 1, c.y + c.h / 2);
  assert.equal(hit.type, 'trim-in');
  hit = hitTest(layout, c.x + c.w - 1, c.y + c.h / 2);
  assert.equal(hit.type, 'trim-out');
});

test('hitTest: regua', () => {
  const layout = computeLayout(makeState().getState(), VP);
  const hit = hitTest(layout, 100, layout.yRuler + 5);
  assert.equal(hit.type, 'ruler');
});

test('hitTest: touch expande area do handle', () => {
  const store = makeState();
  store.dispatch(act.selectClip(store.getState().clips[0].id));
  const layout = computeLayout(store.getState(), VP);
  const c = layout.clips[0];
  const justOutside = c.x - (METRICS.HANDLE_HIT_W / 2) - 4;
  assert.notEqual(hitTest(layout, justOutside, c.y + 5).type, 'trim-in');
  assert.equal(hitTest(layout, justOutside, c.y + 5, { touch: true }).type, 'trim-in');
});

test('hitTest: ghost de clip desativado', () => {
  const store = makeState();
  store.dispatch(act.splitClipAt(30));
  const id = store.getState().clips[0].id;
  store.dispatch(act.toggleClip(id));
  const layout = computeLayout(store.getState(), VP);
  assert.equal(layout.ghosts.length, 1);
  const g = layout.ghosts[0];
  const hit = hitTest(layout, g.x + 5, g.y + 5);
  assert.equal(hit.type, 'ghost');
  assert.equal(hit.clipId, id);
});

test('snap: gruda dentro do threshold, ignora fora', () => {
  const pts = defaultSnapPoints([0, 10, 20], 15);
  // threshold 8px a 10px/s = 0.8s
  let r = snapTime(10.5, pts, 10);
  assert.equal(r.t, 10);
  assert.ok(r.snapped);
  r = snapTime(12, pts, 10);
  assert.equal(r.t, 12);
  assert.ok(!r.snapped);
  // playhead tambem e ponto de snap
  r = snapTime(15.3, pts, 10);
  assert.equal(r.t, 15);
});

test('snap: threshold escala com zoom', () => {
  const pts = [10];
  // 100px/s -> 0.08s de alcance
  assert.ok(!snapTime(10.5, pts, 100).snapped);
  assert.ok(snapTime(10.05, pts, 100).snapped);
});
