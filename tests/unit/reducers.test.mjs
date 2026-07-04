// tests/unit/reducers.test.mjs — node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/editor-v1/core/store.js';
import { createInitialState, MIN_CLIP_DURATION } from '../../public/editor-v1/core/schema.js';
import * as act from '../../public/editor-v1/core/actions.js';
import { effectiveClips, totalDuration, timelineToSource, sourceToTimeline, exportPayload, canExport, segmentAt } from '../../public/editor-v1/core/selectors.js';

function storeWithVideo(duration = 60) {
  const store = createStore();
  store.dispatch(act.setVideo({
    url: 'https://x/video.mp4', path: 'p', filename: 'v.mp4',
    duration, width: 1080, height: 1920, size_bytes: 1000,
  }));
  return store;
}

test('SET_VIDEO cria clip cobrindo o video inteiro', () => {
  const s = storeWithVideo(60).getState();
  assert.equal(s.clips.length, 1);
  assert.equal(s.clips[0].source_in, 0);
  assert.equal(s.clips[0].source_out, 60);
  assert.equal(totalDuration(s), 60);
});

test('SPLIT no meio cria 2 clips contiguos', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.splitClipAt(20));
  const s = store.getState();
  assert.equal(s.clips.length, 2);
  assert.equal(s.clips[0].source_out, 20);
  assert.equal(s.clips[1].source_in, 20);
  assert.equal(totalDuration(s), 60);
});

test('SPLIT rejeitado se fatia < MIN_CLIP_DURATION', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.splitClipAt(0.01));
  assert.equal(store.getState().clips.length, 1);
  store.dispatch(act.splitClipAt(59.99));
  assert.equal(store.getState().clips.length, 1);
});

test('TRIM in nunca ultrapassa out - MIN', () => {
  const store = storeWithVideo(60);
  const id = store.getState().clips[0].id;
  store.dispatch(act.trimClip(id, 'in', 59.99)); // tenta invadir
  const c = store.getState().clips[0];
  assert.ok(c.source_in <= c.source_out - MIN_CLIP_DURATION + 1e-9);
});

test('TRIM out clampa na duracao do video', () => {
  const store = storeWithVideo(60);
  const id = store.getState().clips[0].id;
  store.dispatch(act.trimClip(id, 'out', 500));
  assert.equal(store.getState().clips[0].source_out, 60);
});

test('MOVE_CLIP reordena e preserva duracao total', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.splitClipAt(20));
  store.dispatch(act.splitClipAt(40));
  const ids = store.getState().clips.map(c => c.id);
  store.dispatch(act.moveClip(ids[2], 0));
  const after = store.getState().clips.map(c => c.id);
  assert.deepEqual(after, [ids[2], ids[0], ids[1]]);
  assert.equal(totalDuration(store.getState()), 60);
});

test('DELETE_CLIP remove e limpa selecao', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.splitClipAt(30));
  const id = store.getState().clips[0].id;
  store.dispatch(act.selectClip(id));
  store.dispatch(act.deleteClip(id));
  const s = store.getState();
  assert.equal(s.clips.length, 1);
  assert.equal(s.selected_clip_id, null);
  assert.equal(totalDuration(s), 30);
});

test('TOGGLE_CLIP tira clip do corte efetivo', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.splitClipAt(30));
  const id = store.getState().clips[0].id;
  store.dispatch(act.toggleClip(id));
  const s = store.getState();
  assert.equal(effectiveClips(s).length, 1);
  assert.equal(totalDuration(s), 30);
  store.dispatch(act.toggleClip(id));
  assert.equal(totalDuration(store.getState()), 60);
});

test('DELETE_RANGE_LEFT (tecla Q) trima antes do playhead', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.splitClipAt(20));
  store.dispatch(act.deleteRangeLeft(30)); // playhead em t=30 (dentro do 2o clip)
  const s = store.getState();
  assert.equal(s.clips.length, 1);
  assert.equal(s.clips[0].source_in, 30);
  assert.equal(totalDuration(s), 30);
});

test('DELETE_RANGE_RIGHT (tecla W) trima depois do playhead', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.splitClipAt(40));
  store.dispatch(act.deleteRangeRight(20));
  const s = store.getState();
  assert.equal(s.clips.length, 1);
  assert.equal(s.clips[0].source_out, 20);
  assert.equal(totalDuration(s), 20);
});

test('tempo virtual <-> source com clip inativo no meio', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.splitClipAt(20));
  store.dispatch(act.splitClipAt(40));
  const midId = store.getState().clips[1].id;
  store.dispatch(act.toggleClip(midId)); // desativa 20-40
  const s = store.getState();
  assert.equal(totalDuration(s), 40);
  // t=25 virtual deve cair no 3o clip (source 45)
  assert.equal(timelineToSource(s, 25), 45);
  // source 45 -> t=25
  assert.equal(sourceToTimeline(s, 45), 25);
  // source 30 (dentro do clip inativo) -> null
  assert.equal(sourceToTimeline(s, 30), null);
});

test('undo/redo restaura documento exato', () => {
  const store = storeWithVideo(60);
  const before = store.getState();
  store.dispatch(act.splitClipAt(20));
  store.dispatch(act.deleteClip(store.getState().clips[0].id));
  assert.equal(store.getState().clips.length, 1);
  store.undo();
  assert.equal(store.getState().clips.length, 2);
  store.undo();
  assert.deepEqual(store.getState().clips, before.clips);
  store.redo();
  assert.equal(store.getState().clips.length, 2);
});

test('selecao NAO entra no undo', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.splitClipAt(20));
  store.dispatch(act.selectClip(store.getState().clips[0].id));
  store.dispatch(act.selectClip(store.getState().clips[1].id));
  store.undo(); // deve desfazer o SPLIT, nao a selecao
  assert.equal(store.getState().clips.length, 1);
});

test('coalescing por gestureId = 1 undo step', () => {
  const store = storeWithVideo(60);
  const id = store.getState().clips[0].id;
  // simula drag continuo de trim: varias actions do mesmo gesto
  for (let i = 1; i <= 5; i++) {
    store.dispatch({ ...act.trimClip(id, 'in', i), gestureId: 'g1' });
  }
  store.endGesture();
  assert.equal(store.getState().clips[0].source_in, 5);
  store.undo(); // UM undo volta ao inicio do gesto
  assert.equal(store.getState().clips[0].source_in, 0);
});

test('ADD_TEXT com defaults validos + UPDATE_TEXT sanitiza', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.addText({ content: 'OLA', start_sec: 2, end_sec: 5 }));
  let t = store.getState().texts[0];
  assert.equal(t.font, 'Anton');
  assert.equal(t.size, 'medium');
  store.dispatch(act.updateText(t.id, { font: 'FonteInvalida', color: 'red', x_pct: 5 }));
  t = store.getState().texts[0];
  assert.equal(t.font, 'Anton');      // invalida ignorada
  assert.equal(t.color, '#ffffff');   // invalida ignorada
  assert.equal(t.x_pct, 1);           // 5 clampado pra 1
});

test('exportPayload espelha contrato edit-v0', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.splitClipAt(20));
  store.dispatch(act.toggleClip(store.getState().clips[0].id));
  store.dispatch(act.addText({ content: 'X', start_sec: 1, end_sec: 3 }));
  const p = exportPayload(store.getState());
  assert.equal(p.clips.length, 1);
  assert.deepEqual(p.clips[0], { source_in: 20, source_out: 60 });
  assert.equal(p.texts.length, 1);
  assert.ok(p.texts[0].x_pct >= 0 && p.texts[0].x_pct <= 1);
  assert.ok(canExport(store.getState()));
});

test('canExport falso sem video ou duracao < 0.5', () => {
  const store = createStore();
  assert.equal(canExport(store.getState()), false);
});

test('volumes clampados 0-2', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.setVolume('video', 9));
  assert.equal(store.getState().volumes.video, 2);
  store.dispatch(act.setVolume('audio_extra', -1));
  assert.equal(store.getState().volumes.audio_extra, 0);
});

test('transitions: fade adiciona, cut remove', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.splitClipAt(30));
  store.dispatch(act.setTransition(0, 'fade', 0.5));
  assert.equal(store.getState().transitions.length, 1);
  store.dispatch(act.setTransition(0, 'cut'));
  assert.equal(store.getState().transitions.length, 0);
});

test('segmentAt encontra clip certo apos reorder', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.splitClipAt(20));
  const [c1, c2] = store.getState().clips;
  store.dispatch(act.moveClip(c2.id, 0));
  const s = store.getState();
  // ordem agora: c2 (20-60, dur 40), c1 (0-20, dur 20)
  assert.equal(segmentAt(s, 10).clip.id, c2.id);
  assert.equal(segmentAt(s, 45).clip.id, c1.id);
});

test('DETACH_AUDIO (Ctrl+Shift+S): 1 clip de audio POR segmento, video muda', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.splitClipAt(20)); // 2 segmentos
  store.dispatch(act.detachAudio());
  let s = store.getState();
  assert.equal(s.audio_detached, true);
  assert.equal(s.audio_clips.length, 2);            // 1 por segmento (CapCut)
  assert.equal(s.audio_clips[0].kind, 'video');
  assert.equal(s.audio_clips[0].start, 0);
  assert.equal(s.audio_clips[1].start, 20);
  assert.equal(s.audio_clips[1].source_in, 20);
  // idempotente + undo
  store.dispatch(act.detachAudio());
  assert.equal(store.getState().audio_clips.length, 2);
  store.undo();
  assert.equal(store.getState().audio_detached, false);
  assert.equal(store.getState().audio_clips.length, 0);
});

test('audio clips: split/trim/move/volume/delete funcionam', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.addAudioClip({ url: 'https://x/a.mp3', filename: 'a.mp3', duration: 30 }));
  let a = store.getState().audio_clips[0];
  assert.equal(a.start, 0);
  // move
  store.dispatch(act.moveAudio(a.id, 5));
  assert.equal(store.getState().audio_clips[0].start, 5);
  // split em t=15 (offset 10 do clip)
  store.dispatch(act.selectAudioClip(a.id));
  store.dispatch(act.splitAudioAt(15));
  let clips = store.getState().audio_clips;
  assert.equal(clips.length, 2);
  assert.equal(clips[0].source_out, 10);
  assert.equal(clips[1].start, 15);
  assert.equal(clips[1].source_in, 10);
  // trim-in do segundo: borda esquerda pra t=18 (start=18, source_in=13)
  store.dispatch(act.trimAudio(clips[1].id, 'in', 18));
  const c1 = store.getState().audio_clips[1];
  assert.equal(c1.start, 18);
  assert.equal(c1.source_in, 13);
  // volume + delete
  store.dispatch(act.setAudioVolume(c1.id, 0.4));
  assert.equal(store.getState().audio_clips[1].volume, 0.4);
  store.dispatch(act.deleteAudioClip(c1.id));
  assert.equal(store.getState().audio_clips.length, 1);
});

test('exportPayload: audio_clips no contrato + video mudo pos-detach', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.detachAudio());
  const p = exportPayload(store.getState());
  assert.equal(p.audio_detached, true);
  assert.equal(p.volumes.video, 0);            // video mudo no render
  assert.equal(p.audio_clips.length, 1);
  assert.equal(p.audio_clips[0].kind, 'video');
  assert.equal(p.audio_clips[0].source_out, 60);
});

test('SELECT_AUDIO_CLIP limpa selecao de clip/texto e vice-versa', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.detachAudio());
  const aid = store.getState().audio_clips[0].id;
  store.dispatch(act.selectClip(store.getState().clips[0].id));
  assert.equal(store.getState().selected_audio_id, null);
  store.dispatch(act.selectAudioClip(aid));
  const s = store.getState();
  assert.equal(s.selected_audio_id, aid);
  assert.equal(s.selected_clip_id, null);
});

test('SPLIT_TEXT divide texto no cursor (CapCut)', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.addText({ content: 'OI', start_sec: 2, end_sec: 8 }));
  const id = store.getState().texts[0].id;
  store.dispatch(act.splitTextAt(id, 5));
  const ts = store.getState().texts;
  assert.equal(ts.length, 2);
  assert.equal(ts[0].end_sec, 5);
  assert.equal(ts[1].start_sec, 5);
  assert.equal(ts[1].content, 'OI');
});

test('F3: CONVERT_TO_OVERLAY move clip pra camada (nunca esvazia a principal)', () => {
  const store = storeWithVideo(60);
  // com 1 clip so, nao pode virar overlay (main esvaziaria)
  store.dispatch(act.convertToOverlay(store.getState().clips[0].id, 5));
  assert.equal(store.getState().overlays.length, 0);
  // com 2 clips, o segundo sobe
  store.dispatch(act.splitClipAt(20));
  const c2 = store.getState().clips[1].id;
  store.dispatch(act.convertToOverlay(c2, 3));
  const s = store.getState();
  assert.equal(s.clips.length, 1);
  assert.equal(s.overlays.length, 1);
  assert.equal(s.overlays[0].start, 3);
  assert.equal(s.overlays[0].source_in, 20);
  assert.equal(s.selected_overlay_id, s.overlays[0].id);
  // undo devolve o clip pra principal
  store.undo();
  assert.equal(store.getState().clips.length, 2);
  assert.equal(store.getState().overlays.length, 0);
});

test('F3: overlay trim/move/transform/delete', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.splitClipAt(20));
  store.dispatch(act.convertToOverlay(store.getState().clips[1].id, 0));
  const id = store.getState().overlays[0].id;
  store.dispatch(act.moveOverlay(id, 7));
  assert.equal(store.getState().overlays[0].start, 7);
  store.dispatch(act.trimOverlay(id, 'in', 10)); // borda esquerda pra t=10: delta 3
  let o = store.getState().overlays[0];
  assert.equal(o.start, 10);
  assert.equal(o.source_in, 23);
  store.dispatch(act.setOverlayTransform(id, { x_pct: 0.2, scale: 5 }));
  o = store.getState().overlays[0];
  assert.equal(o.x_pct, 0.2);
  assert.equal(o.scale, 2); // clamp
  const p = exportPayload(store.getState());
  assert.equal(p.overlays.length, 1);
  store.dispatch(act.deleteOverlay(id));
  assert.equal(store.getState().overlays.length, 0);
});
