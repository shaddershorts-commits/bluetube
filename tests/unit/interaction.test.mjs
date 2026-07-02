// tests/unit/interaction.test.mjs — FSM de interacao (node --test)
// Tabela estado x evento + invariantes: todo caminho termina em idle,
// cancel nunca comita, 1 gestureId por gesto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/editor-v1/core/store.js';
import * as act from '../../public/editor-v1/core/actions.js';
import { computeLayout, METRICS, timeToX } from '../../public/editor-v1/timeline/layout.js';
import { hitTest } from '../../public/editor-v1/timeline/hittest.js';
import { transition, idle, DRAG_THRESHOLD_MOUSE } from '../../public/editor-v1/timeline/interaction.js';
import { cutPoints } from '../../public/editor-v1/core/selectors.js';

const VP = { pxPerSec: 10, scrollX: 0, width: 800, height: 200 };

function setup() {
  const store = createStore();
  store.dispatch(act.setVideo({ url: 'u', duration: 60, width: 1080, height: 1920 }));
  return store;
}

function ctxFor(store, playhead = 0) {
  const state = store.getState();
  const layout = computeLayout(state, VP);
  return { layout, playhead, cutPoints: cutPoints(state), snapEnabled: true };
}

/** executa efeitos 'dispatch' num store (mini-adapter de teste) */
function runFx(store, effects) {
  for (const e of effects || []) {
    if (e.do === 'dispatch') store.dispatch(e.action);
    if (e.do === 'end-gesture') store.endGesture();
    if (e.do === 'abort-gesture') store.undo();
  }
}

function downOn(store, hitPoint, opts = {}) {
  const ctx = ctxFor(store);
  const hit = hitTest(ctx.layout, hitPoint.x, hitPoint.y, { touch: !!opts.touch });
  return transition(idle(), { kind: 'down', x: hitPoint.x, y: hitPoint.y, touch: !!opts.touch, hit }, ctx);
}

test('click em clip = seleciona e termina idle', () => {
  const store = setup();
  const ctx = ctxFor(store);
  const c = ctx.layout.clips[0];
  let r = downOn(store, { x: c.x + c.w / 2, y: c.y + 10 });
  assert.equal(r.next.name, 'armed');
  r = transition(r.next, { kind: 'up', x: c.x + c.w / 2, y: c.y + 10 }, ctx);
  assert.equal(r.next.name, 'idle');
  assert.ok(r.effects.some(e => e.do === 'select-clip' && e.clipId === c.clipId));
});

test('touch em track vazia = panning (CapCut mobile), mouse = scrubbing', () => {
  const store = setup();
  const ctx = ctxFor(store);
  // ponto na track de video mas depois do fim do clip (track-empty)
  const c = ctx.layout.clips[0];
  const emptyX = c.x + c.w + 60;
  // touch -> panning
  let hit = hitTest(ctx.layout, emptyX, c.y + 10, { touch: true });
  assert.equal(hit.type, 'track-empty');
  let r = transition(idle(), { kind: 'down', x: emptyX, y: c.y + 10, touch: true, hit }, ctx);
  assert.equal(r.next.name, 'panning');
  // mouse -> scrubbing
  r = transition(idle(), { kind: 'down', x: emptyX, y: c.y + 10, touch: false, hit }, ctx);
  assert.equal(r.next.name, 'scrubbing');
});

test('down na regua = scrub imediato + seek no move + idle no up', () => {
  const store = setup();
  const ctx = ctxFor(store);
  let r = downOn(store, { x: 200, y: ctx.layout.yRuler + 5 });
  assert.equal(r.next.name, 'scrubbing');
  assert.ok(r.effects.some(e => e.do === 'seek'));
  r = transition(r.next, { kind: 'move', x: 300, y: 5 }, ctx);
  const seek = r.effects.find(e => e.do === 'seek');
  assert.ok(Math.abs(seek.t - (300 - METRICS.PAD_LEFT) / 10) < 1e-9);
  r = transition(r.next, { kind: 'up', x: 300, y: 5 }, ctx);
  assert.equal(r.next.name, 'idle');
});

test('mouse: armed vira dragging-clip apos threshold', () => {
  const store = setup();
  const ctx = ctxFor(store);
  const c = ctx.layout.clips[0];
  let r = downOn(store, { x: c.x + 50, y: c.y + 10 });
  // move abaixo do threshold: continua armed
  r = transition(r.next, { kind: 'move', x: c.x + 50 + DRAG_THRESHOLD_MOUSE - 1, y: c.y + 10 }, ctx);
  assert.equal(r.next.name, 'armed');
  // passa o threshold
  r = transition(r.next, { kind: 'move', x: c.x + 50 + DRAG_THRESHOLD_MOUSE + 2, y: c.y + 10 }, ctx);
  assert.equal(r.next.name, 'dragging-clip');
  assert.ok(r.next.gestureId);
});

test('touch: move antes do long-press vira panning (nao drag)', () => {
  const store = setup();
  const ctx = ctxFor(store);
  const c = ctx.layout.clips[0];
  let r = downOn(store, { x: c.x + 50, y: c.y + 10 }, { touch: true });
  assert.equal(r.next.name, 'armed');
  r = transition(r.next, { kind: 'move', x: c.x + 80, y: c.y + 10, touch: true }, ctx);
  assert.equal(r.next.name, 'panning');
});

test('touch: long-press em clip vira dragging-clip com haptic', () => {
  const store = setup();
  const ctx = ctxFor(store);
  const c = ctx.layout.clips[0];
  let r = downOn(store, { x: c.x + 50, y: c.y + 10 }, { touch: true });
  r = transition(r.next, { kind: 'longpress' }, ctx);
  assert.equal(r.next.name, 'dragging-clip');
  assert.ok(r.effects.some(e => e.do === 'haptic'));
});

test('trim: down no handle -> trimming -> move dispatcha TRIM coalescido -> up idle', () => {
  const store = setup();
  const cid = store.getState().clips[0].id;
  store.dispatch(act.selectClip(cid));
  let ctx = ctxFor(store);
  const c = ctx.layout.clips[0];
  // down no handle esquerdo
  let r = downOn(store, { x: c.x + 1, y: c.y + 10 });
  assert.equal(r.next.name, 'trimming');
  assert.equal(r.next.edge, 'in');
  const gid = r.next.gestureId;
  // arrasta pra t=5 (x = PAD + 50)
  r = transition(r.next, { kind: 'move', x: timeToX(VP, 5), y: c.y + 10 }, ctx);
  const disp = r.effects.filter(e => e.do === 'dispatch');
  assert.equal(disp.length, 1);
  assert.equal(disp[0].action.type, 'TRIM_CLIP');
  assert.equal(disp[0].action.gestureId, gid);
  runFx(store, r.effects);
  assert.ok(Math.abs(store.getState().clips[0].source_in - 5) < 0.5); // snap pode ajustar
  // up
  r = transition(r.next, { kind: 'up', x: timeToX(VP, 5), y: c.y + 10 }, ctx);
  assert.equal(r.next.name, 'idle');
  assert.ok(r.effects.some(e => e.do === 'end-gesture'));
});

test('trim continuo = 1 undo step (coalescing via gestureId)', () => {
  const store = setup();
  const cid = store.getState().clips[0].id;
  store.dispatch(act.selectClip(cid));
  let ctx = ctxFor(store);
  const c = ctx.layout.clips[0];
  let r = downOn(store, { x: c.x + 1, y: c.y + 10 });
  for (const t of [2, 3, 4, 5, 6]) {
    r = transition(r.next, { kind: 'move', x: timeToX(VP, t), y: c.y + 10, shiftKey: true }, ctx);
    runFx(store, r.effects);
    ctx = ctxFor(store); // layout atualiza durante o gesto
    // recoloca fsm com tStartSeg original (gesto continua)
  }
  r = transition(r.next, { kind: 'up', x: 0, y: 0 }, ctx);
  runFx(store, r.effects);
  assert.equal(store.getState().clips[0].source_in, 6);
  store.undo();
  assert.equal(store.getState().clips[0].source_in, 0); // UM undo desfaz o gesto todo
});

test('Esc durante trim aborta e restaura estado', () => {
  const store = setup();
  const cid = store.getState().clips[0].id;
  store.dispatch(act.selectClip(cid));
  let ctx = ctxFor(store);
  const c = ctx.layout.clips[0];
  let r = downOn(store, { x: c.x + 1, y: c.y + 10 });
  r = transition(r.next, { kind: 'move', x: timeToX(VP, 10), y: c.y + 10, shiftKey: true }, ctx);
  runFx(store, r.effects);
  assert.ok(store.getState().clips[0].source_in > 0);
  r = transition(r.next, { kind: 'esc' }, ctx);
  assert.equal(r.next.name, 'idle');
  runFx(store, r.effects); // abort-gesture -> undo
  assert.equal(store.getState().clips[0].source_in, 0);
});

test('pointercancel de QUALQUER estado termina idle', () => {
  const store = setup();
  const ctx = ctxFor(store);
  const c = ctx.layout.clips[0];
  const states = [];
  // colhe estados intermediarios reais
  let r = downOn(store, { x: c.x + 30, y: c.y + 10 });
  states.push(r.next);
  r = transition(r.next, { kind: 'move', x: c.x + 60, y: c.y + 10 }, ctx);
  states.push(r.next);
  states.push({ name: 'scrubbing' });
  states.push({ name: 'panning', x0: 0, scrollX0: 0 });
  states.push({ name: 'pinching', d0: 1, pxPerSec0: 10, cx: 0 });
  for (const s of states) {
    const rr = transition(s, { kind: 'cancel' }, ctx);
    assert.equal(rr.next.name, 'idle', `estado ${s.name} nao voltou pra idle`);
  }
});

test('click em ghost reativa clip', () => {
  const store = setup();
  store.dispatch(act.splitClipAt(30));
  const id = store.getState().clips[0].id;
  store.dispatch(act.toggleClip(id));
  const ctx = ctxFor(store);
  const g = ctx.layout.ghosts[0];
  let r = downOn(store, { x: g.x + 5, y: g.y + 5 });
  assert.equal(r.next.name, 'armed');
  r = transition(r.next, { kind: 'up', x: g.x + 5, y: g.y + 5 }, ctx);
  runFx(store, r.effects);
  assert.equal(store.getState().clips.find(c => c.id === id).active, true);
});

test('wheel: ctrl = zoom ancorado, sem ctrl = scroll', () => {
  const store = setup();
  const ctx = ctxFor(store);
  let r = transition(idle(), { kind: 'wheel', x: 300, deltaY: -100, deltaX: 0, ctrlKey: true }, ctx);
  assert.ok(r.effects.some(e => e.do === 'zoom' && e.pxPerSec > VP.pxPerSec));
  r = transition(idle(), { kind: 'wheel', x: 300, deltaY: 50, deltaX: 0, ctrlKey: false }, ctx);
  const sc = r.effects.find(e => e.do === 'scroll');
  assert.equal(sc.scrollX, 50);
});

test('fuzz: 200 eventos aleatorios nunca quebram e Esc sempre reseta', () => {
  const store = setup();
  store.dispatch(act.splitClipAt(20));
  store.dispatch(act.splitClipAt(40));
  let fsm = idle();
  const kinds = ['down', 'move', 'up', 'cancel', 'longpress', 'wheel', 'esc', 'second-down', 'pinch-move', 'pinch-end'];
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 200; i++) {
    const ctx = ctxFor(store);
    const kind = kinds[Math.floor(rnd() * kinds.length)];
    const x = rnd() * 800, y = rnd() * 200;
    const ev = { kind, x, y, touch: rnd() > 0.5, d: 1 + rnd(), cx: x, deltaY: rnd() * 100 - 50, deltaX: 0, ctrlKey: rnd() > 0.5 };
    if (kind === 'down') ev.hit = hitTest(ctx.layout, x, y, { touch: ev.touch });
    const r = transition(fsm, ev, ctx);
    assert.ok(r.next && typeof r.next.name === 'string', 'FSM retornou estado invalido');
    runFx(store, r.effects);
    fsm = r.next;
  }
  const final = transition(fsm, { kind: 'esc' }, ctxFor(store));
  assert.equal(final.next.name, 'idle');
});
