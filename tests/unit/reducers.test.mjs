// tests/unit/reducers.test.mjs — node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/editor-v1/core/store.js';
import { createInitialState, MIN_CLIP_DURATION } from '../../public/editor-v1/core/schema.js';
import * as act from '../../public/editor-v1/core/actions.js';
import { mainTrackItems, mediaUrlFor, effectiveClips, totalDuration, timelineToSource, sourceToTimeline, exportPayload, canExport, segmentAt, playableDuration, clipDuration, captionAudioPlan, effectiveAudioClips } from '../../public/editor-v1/core/selectors.js';

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

test('DELETE_RANGE_LEFT (Q) trima SÓ o clip sob o playhead — vizinhos intactos', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.splitClipAt(20));
  store.dispatch(act.selectClip(null)); // sem seleção: age no clip sob o playhead
  store.dispatch(act.deleteRangeLeft(30)); // t=30 dentro do 2o clip (20-60)
  const s = store.getState();
  assert.equal(s.clips.length, 2);               // NADA é deletado (fix: user perdia o projeto)
  assert.equal(s.clips[0].source_out, 20);       // 1o clip intacto
  assert.equal(s.clips[1].source_in, 30);        // 2o clip trimado até o playhead
  assert.equal(totalDuration(s), 20 + 30);
});

test('DELETE_RANGE_LEFT (Q) respeita a SELEÇÃO: playhead fora do clip selecionado = no-op', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.splitClipAt(20));
  const firstId = store.getState().clips[0].id;
  store.dispatch(act.selectClip(firstId));       // seleciona o 1o (0-20)
  store.dispatch(act.deleteRangeLeft(30));       // playhead no 2o → não mexe
  assert.equal(totalDuration(store.getState()), 60);
  store.dispatch(act.deleteRangeLeft(10));       // playhead DENTRO do selecionado
  const s = store.getState();
  assert.equal(s.clips[0].source_in, 10);        // trimou só o selecionado
  assert.equal(s.clips[1].source_in, 20);        // vizinho intacto
});

test('DELETE_RANGE_RIGHT (W) trima SÓ o clip alvo depois do playhead', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.splitClipAt(40));
  store.dispatch(act.selectClip(null));
  store.dispatch(act.deleteRangeRight(20)); // t=20 dentro do 1o clip (0-40)
  const s = store.getState();
  assert.equal(s.clips.length, 2);          // 2o clip NÃO some
  assert.equal(s.clips[0].source_out, 20);  // 1o trimado no playhead
  assert.equal(s.clips[1].source_in, 40);   // 2o intacto
  assert.equal(totalDuration(s), 20 + 20);
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
  assert.deepEqual(p.clips[0], { source_in: 20, source_out: 60, media_url: null, scale: 1, opacity: 1, speed: 1 });
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

test('F4: Alt+G cria composto (offsets relativos) e Shift+Alt+G desfaz', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.splitClipAt(20));
  store.dispatch(act.splitClipAt(40));
  store.dispatch(act.addText({ content: 'T', start_sec: 25, end_sec: 30 }));
  const [c1, c2, c3] = store.getState().clips.map(c => c.id);
  const tid = store.getState().texts[0].id;
  // seleciona c2 + c3 + texto via ctrl+click
  store.dispatch(act.toggleMultiSelect('clip', c2));
  store.dispatch(act.toggleMultiSelect('clip', c3));
  store.dispatch(act.toggleMultiSelect('text', tid));
  store.dispatch(act.createCompound());
  let s = store.getState();
  assert.equal(s.compounds.length, 1);
  assert.equal(s.clips.length, 2);                    // c1 + bloco composto
  assert.ok(s.clips[1].compound_id);
  assert.equal(s.texts.length, 0);                    // texto entrou no composto
  assert.equal(s.compounds[0].clips.length, 2);
  assert.equal(s.compounds[0].texts[0].start_sec, 5); // 25 - base(20) = offset relativo
  assert.equal(totalDuration(s), 60);                 // duracao total preservada
  // player expande: t=30 continua mapeando pro source 30
  assert.equal(timelineToSource(s, 30), 30);
  // export achata
  const p = exportPayload(s);
  assert.equal(p.clips.length, 3);
  assert.equal(p.texts.length, 1);
  assert.equal(p.texts[0].start_sec, 25);             // offset absoluto de volta
  // desagrupar restaura
  store.dispatch(act.ungroupCompound(s.compounds[0].id));
  s = store.getState();
  assert.equal(s.compounds.length, 0);
  assert.equal(s.clips.length, 3);
  assert.equal(s.texts.length, 1);
  assert.equal(s.texts[0].start_sec, 25);
  assert.equal(totalDuration(s), 60);
});

// ── CAMADAS (CapCut lanes) ──
test('CONVERT_TO_OVERLAY: lane do drop + scale 1.0 (camada cheia)', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.splitClipAt(30));
  const id = store.getState().clips[0].id;
  store.dispatch(act.convertToOverlay(id, 5, 2));
  const s = store.getState();
  assert.equal(s.overlays.length, 1);
  assert.equal(s.overlays[0].lane, 2);
  assert.equal(s.overlays[0].scale, 1);
  assert.equal(s.clips.length, 1); // saiu da main
});

test('SET_ITEM_LANE muda camada de overlay e texto (com clamp)', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.splitClipAt(30));
  store.dispatch(act.convertToOverlay(store.getState().clips[0].id, 0, 1));
  store.dispatch(act.addText({ content: 'oi', start_sec: 0, end_sec: 3 }));
  const ovId = store.getState().overlays[0].id;
  const txId = store.getState().texts[0].id;
  assert.equal(store.getState().texts[0].lane, 4); // default topo
  store.dispatch(act.setItemLane('overlay', ovId, 3));
  store.dispatch(act.setItemLane('text', txId, 1)); // texto DESCE pra tras do video
  const s = store.getState();
  assert.equal(s.overlays[0].lane, 3);
  assert.equal(s.texts[0].lane, 1);
  store.dispatch(act.setItemLane('text', txId, 99)); // clamp em MAX_LANE
  assert.equal(store.getState().texts[0].lane, 5);
});

// ── rodada 2026-07-20: multi-midia, compostos any-type, split geral, legendas ──

test('ADD_MEDIA_CLIP acrescenta take SEM resetar o projeto', () => {
  const store = storeWithVideo(10);
  store.dispatch(act.splitClipAt(5)); // edicao em andamento
  const clipsAntes = store.getState().clips.length;
  store.dispatch(act.addMediaClip({ url: 'https://x/take2.mp4', duration: 4, filename: 'take2.mp4' }));
  const s = store.getState();
  assert.equal(s.clips.length, clipsAntes + 1);   // ACRESCENTOU no fim
  assert.equal(s.media.length, 1);
  assert.equal(s.clips.at(-1).media_id, s.media[0].id);
  assert.equal(s.clips.at(-1).source_out, 4);
  // undo desfaz o take, edicao anterior intacta
  store.undo();
  assert.equal(store.getState().clips.length, clipsAntes);
});

test('ADD_MEDIA_CLIP com mediaId reusa o pool sem duplicar', () => {
  const store = storeWithVideo(10);
  store.dispatch(act.addMediaClip({ url: 'https://x/t.mp4', duration: 3 }));
  const mid = store.getState().media[0].id;
  store.dispatch(act.addClipFromMedia(mid));
  const s = store.getState();
  assert.equal(s.media.length, 1);       // pool NAO duplicou
  assert.equal(s.clips.length, 3);       // principal + 2 takes
  assert.equal(s.clips[1].media_id, mid);
  assert.equal(s.clips[2].media_id, mid);
});

test('REMOVE_MEDIA tira o take do pool E remove todos os clips que o usam', () => {
  const store = storeWithVideo(10);
  store.dispatch(act.addMediaClip({ url: 'https://x/t.mp4', duration: 3 }));
  const mid = store.getState().media[0].id;
  store.dispatch(act.addClipFromMedia(mid)); // 2 clips do mesmo take
  const principalClips = store.getState().clips.filter(c => c.media_id == null).length;
  store.dispatch(act.removeMedia(mid));
  const s = store.getState();
  assert.equal(s.media.length, 0);                                  // saiu do pool
  assert.equal(s.clips.filter(c => c.media_id === mid).length, 0);  // clips do take sumiram
  assert.equal(s.clips.filter(c => c.media_id == null).length, principalClips); // principal intacto
  // undo restaura pool + clips do take
  store.undo();
  assert.equal(store.getState().media.length, 1);
  assert.equal(store.getState().clips.filter(c => c.media_id === mid).length, 2);
});

test('OVERLAY_TO_CLIP: camada de vídeo volta pra faixa principal na posição do drop', () => {
  const store = storeWithVideo(10);
  store.dispatch(act.splitClipAt(5));
  const rightId = store.getState().selected_clip_id;      // clip 5..10
  store.dispatch(act.convertToOverlay(rightId, 8, 1));    // vira camada em t=8
  let s = store.getState();
  assert.equal(s.overlays.length, 1);
  assert.equal(s.clips.length, 1);                        // main ficou só com 0..5
  const ovId = s.overlays[0].id;
  // #2: a agulha/playback enxergam a extensão REAL (main 5 + camada 8..13)
  assert.equal(playableDuration(s), 13);
  // volta pra principal (drop na main)
  store.dispatch(act.overlayToClip(ovId, 10));
  s = store.getState();
  assert.equal(s.overlays.length, 0);
  assert.equal(s.clips.length, 2);                        // voltou pro fim da main
  assert.equal(s.clips[1].source_in, 5);
  assert.equal(s.clips[1].source_out, 10);
  assert.equal(playableDuration(s), 10);                  // timeline volta a 10s
});

test('olhinho (TOGGLE_LANE_VIS): camada some do export/preview e volta', () => {
  const store = storeWithVideo(10);
  store.dispatch(act.splitClipAt(5));
  store.dispatch(act.convertToOverlay(store.getState().selected_clip_id, 0, 2));
  // esconde a lane 2 → overlay fora do payload (preview e export)
  store.dispatch(act.toggleLaneVisibility('overlay', 2));
  assert.equal(exportPayload(store.getState()).overlays.length, 0);
  store.dispatch(act.toggleLaneVisibility('overlay', 2));
  assert.equal(exportPayload(store.getState()).overlays.length, 1);
  // áudio: lane 0 escondida = mudo/fora, como se não estivesse na timeline
  store.dispatch({ type: 'ADD_AUDIO_CLIP', media: { url: 'https://x/a.mp3', filename: 'a', duration: 4 } });
  store.dispatch(act.toggleLaneVisibility('audio', 0));
  assert.equal(effectiveAudioClips(store.getState()).length, 0);
  assert.equal(exportPayload(store.getState()).audio_clips.length, 0);
  store.dispatch(act.toggleLaneVisibility('audio', 0));
  assert.equal(effectiveAudioClips(store.getState()).length, 1);
});

test('SET_AUDIO_LANE fixa a lane manual e ADD_EXTRA_LANE respeita o cap', () => {
  const store = storeWithVideo(10);
  store.dispatch({ type: 'ADD_AUDIO_CLIP', media: { url: 'https://x/a.mp3', filename: 'a', duration: 4 } });
  const aid = store.getState().audio_clips[0].id;
  store.dispatch(act.setAudioLane(aid, 2));               // drop 2 rows abaixo
  assert.equal(store.getState().audio_clips[0].lane, 2);
  // camadas extras vazias (menu do botão direito no vazio): cap em 4
  for (let i = 0; i < 6; i++) store.dispatch(act.addExtraLane('video'));
  for (let i = 0; i < 6; i++) store.dispatch(act.addExtraLane('audio'));
  assert.equal(store.getState().extra_overlay_lanes, 4);
  assert.equal(store.getState().extra_audio_lanes, 4);
});

test('mudo POR CENA (muted): só o clip selecionado, sobrevive e sai no payload', () => {
  const store = storeWithVideo(10);
  store.dispatch(act.splitClipAt(5));
  const c0 = store.getState().clips[0].id;
  store.dispatch(act.setClipFx(c0, { muted: true }));
  const s = store.getState();
  assert.equal(s.clips[0].muted, true);
  assert.equal(!!s.clips[1].muted, false);          // a OUTRA cena não muda
  const pay = exportPayload(s);
  assert.equal(pay.clips[0].muted, true);
  assert.equal('muted' in pay.clips[1], false);
  // undo restaura
  store.undo();
  assert.equal(!!store.getState().clips[0].muted, false);
});

test('SET_CLIP_MASK: cria com defaults, faz merge com clamps, null remove', () => {
  const store = storeWithVideo(10);
  const id = store.getState().clips[0].id;
  store.dispatch(act.setClipMask(id, { shape: 'rect' }));
  let m = store.getState().clips[0].mask;
  assert.equal(m.shape, 'rect');
  assert.equal(m.x_pct, 0.5);                        // defaults centrados
  store.dispatch(act.setClipMask(id, { feather: 250, w_pct: 3, radius: -5 }));
  m = store.getState().clips[0].mask;
  assert.equal(m.feather, 100);                      // clamp 0-100
  assert.equal(m.w_pct, 1);                          // clamp 0.05-1
  assert.equal(m.radius, 0);                         // clamp 0-100
  assert.equal(m.shape, 'rect');                     // merge preserva o resto
  // sai no payload do export
  assert.equal(exportPayload(store.getState()).clips[0].mask.shape, 'rect');
  // trocar de forma preserva geometria
  store.dispatch(act.setClipMask(id, { shape: 'circle' }));
  assert.equal(store.getState().clips[0].mask.shape, 'circle');
  // null remove
  store.dispatch(act.setClipMask(id, null));
  assert.equal(store.getState().clips[0].mask, undefined);
  assert.equal('mask' in exportPayload(store.getState()).clips[0], false);
});

test('REMOVE_MEDIA com id inexistente é no-op (nao muda o state)', () => {
  const store = storeWithVideo(10);
  store.dispatch(act.addMediaClip({ url: 'https://x/t.mp4', duration: 3 }));
  const antes = store.getState();
  store.dispatch(act.removeMedia(9999));
  assert.equal(store.getState(), antes); // mesma referencia = state inalterado
});

test('TRIM_CLIP de take respeita a duracao da PROPRIA midia', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.addMediaClip({ url: 'https://x/t.mp4', duration: 4 }));
  const take = store.getState().clips.at(-1);
  store.dispatch(act.trimClip(take.id, 'out', 30)); // alem do fim da midia (4s)
  assert.equal(store.getState().clips.at(-1).source_out, 4); // clampou na midia, nao no 60
});

test('exportPayload leva media_url por clip (null = principal)', () => {
  const store = storeWithVideo(10);
  store.dispatch(act.addMediaClip({ url: 'https://x/take.mp4', duration: 4 }));
  const pay = exportPayload(store.getState());
  assert.equal(pay.clips[0].media_url, null);
  assert.equal(pay.clips[1].media_url, 'https://x/take.mp4');
});

test('CREATE_COMPOUND aceita SO AUDIO (any-type) e conta na duracao', () => {
  const store = storeWithVideo(10);
  store.dispatch({ type: 'ADD_AUDIO_CLIP', media: { url: 'https://x/a.mp3', filename: 'a', duration: 8 } });
  const aid = store.getState().audio_clips[0].id;
  store.dispatch(act.setMultiSelect([{ type: 'audio', id: aid }]));
  store.dispatch(act.createCompound());
  const s = store.getState();
  assert.equal(s.compounds.length, 1);
  assert.equal(s.compounds[0].clips.length, 0);          // sem video interno
  assert.equal(s.compounds[0].audio_clips.length, 1);
  assert.equal(s.audio_clips.length, 0);                 // saiu da faixa solta
  const bloco = s.clips.find(c => c.compound_id === s.compounds[0].id);
  assert.ok(bloco, 'composto vira bloco na main');
  assert.equal(clipDuration(s, bloco), 8);               // duracao = audio interno
  assert.equal(playableDuration(s), 18);                 // 10 video + 8 do bloco
});

test('Q/W trima a FAIXA DE ÁUDIO selecionada (não só vídeo)', () => {
  const store = storeWithVideo(10);
  store.dispatch({ type: 'ADD_AUDIO_CLIP', media: { url: 'https://x/a.mp3', filename: 'a', duration: 8 } });
  const aid = store.getState().audio_clips[0].id;
  store.dispatch(act.selectAudioClip(aid));
  // W corta a DIREITA do playhead (t=5) dentro do áudio [0..8]
  store.dispatch(act.deleteRangeRight(5));
  let a = store.getState().audio_clips[0];
  assert.equal(a.source_out, 5);
  assert.equal(a.start, 0);
  // Q corta a ESQUERDA do playhead (t=2) e encosta o áudio no playhead
  store.dispatch(act.deleteRangeLeft(2));
  a = store.getState().audio_clips[0];
  assert.equal(a.source_in, 2);
  assert.equal(a.source_out, 5);
  assert.equal(a.start, 2);
  // playhead FORA do áudio = no-op (não mexe em vídeo por engano)
  const antes = store.getState();
  store.dispatch(act.deleteRangeRight(9));
  assert.equal(store.getState(), antes);
});

test('CREATE_COMPOUND respeita o maximo de 4 compostos', () => {
  const store = storeWithVideo(40);
  for (let i = 0; i < 5; i++) {
    store.dispatch({ type: 'ADD_AUDIO_CLIP', media: { url: 'https://x/a' + i + '.mp3', filename: 'a', duration: 2 } });
    const aid = store.getState().audio_clips.at(-1).id;
    store.dispatch(act.setMultiSelect([{ type: 'audio', id: aid }]));
    store.dispatch(act.createCompound());
  }
  assert.equal(store.getState().compounds.length, 4); // o 5o foi bloqueado
});

test('UNGROUP de composto so-audio devolve o audio sem afetar o resto', () => {
  const store = storeWithVideo(10);
  store.dispatch(act.addText({ content: 'fora', start_sec: 0, end_sec: 2 }));
  store.dispatch({ type: 'ADD_AUDIO_CLIP', media: { url: 'https://x/a.mp3', filename: 'a', duration: 6 } });
  const aid = store.getState().audio_clips[0].id;
  store.dispatch(act.setMultiSelect([{ type: 'audio', id: aid }]));
  store.dispatch(act.createCompound());
  const compId = store.getState().compounds[0].id;
  store.dispatch(act.ungroupCompound(compId));
  const s = store.getState();
  assert.equal(s.compounds.length, 0);
  assert.equal(s.audio_clips.length, 1);            // audio voltou
  assert.equal(s.texts.length, 1);                  // texto de fora intacto
  assert.equal(s.clips.filter(c => c.compound_id).length, 0);
});

test('SPLIT_OVERLAY corta a camada sob o tempo', () => {
  const store = storeWithVideo(20);
  store.dispatch(act.splitClipAt(10));
  store.dispatch(act.convertToOverlay(store.getState().clips[1].id, 2, 1)); // camada 10s em t=2
  store.dispatch(act.splitOverlayAt(5));
  const s = store.getState();
  assert.equal(s.overlays.length, 2);
  assert.ok(Math.abs(s.overlays[1].start - 5) < 1e-6);
  // fora da camada = no-op
  store.dispatch(act.splitOverlayAt(0.5));
  assert.equal(store.getState().overlays.length, 2);
});

test('SET_CAPTIONS troca todas as legendas em 1 dispatch sem roubar selecao', () => {
  const store = storeWithVideo(10);
  store.dispatch(act.selectClip(store.getState().clips[0].id));
  store.dispatch(act.setCaptions([
    { content: 'ola', start_sec: 0.5, end_sec: 1 },
    { content: 'mundo', start_sec: 1, end_sec: 2 },
  ]));
  let s = store.getState();
  assert.equal(s.texts.filter(t => t.caption).length, 2);
  assert.equal(s.selected_text_id, null);                    // NAO selecionou texto
  assert.equal(s.selected_clip_id, s.clips[0].id);           // clip continua
  // regenerar SUBSTITUI (nao acumula)
  store.dispatch(act.setCaptions([{ content: 'x', start_sec: 0, end_sec: 1 }]));
  s = store.getState();
  assert.equal(s.texts.filter(t => t.caption).length, 1);
  // 1 undo volta as 2
  store.undo();
  assert.equal(store.getState().texts.filter(t => t.caption).length, 2);
});

test('legenda com tarja (box): cor por palavra sobrevive e sai no exportPayload', () => {
  const store = storeWithVideo(10);
  // template "highlight": cada palavra com tarja colorida + cor própria
  store.dispatch(act.setCaptions([
    { content: 'isso', start_sec: 0.2, end_sec: 0.6, color: '#ffffff', box: '#22c55e' },
    { content: 'vai',  start_sec: 0.6, end_sec: 1.0, color: '#ffd32a', box: null },
  ]));
  const caps = store.getState().texts.filter(t => t.caption).sort((a, b) => a.start_sec - b.start_sec);
  assert.equal(caps[0].box, '#22c55e');   // tarja preservada
  assert.equal(caps[0].color, '#ffffff');
  assert.equal(caps[1].box, null);        // sem tarja
  assert.equal(caps[1].color, '#ffd32a'); // cor por palavra (rotate)
  // box inválido vira null (nunca vaza lixo pro render)
  store.dispatch(act.setCaptions([{ content: 'x', start_sec: 0, end_sec: 1, box: 'verde' }]));
  assert.equal(store.getState().texts.find(t => t.caption).box, null);
  // exportPayload leva o box só quando existe
  store.dispatch(act.setCaptions([
    { content: 'a', start_sec: 0, end_sec: 1, box: '#ff2d78' },
    { content: 'b', start_sec: 1, end_sec: 2 },
  ]));
  const pay = exportPayload(store.getState());
  const byTxt = pay.texts.reduce((m, t) => { m[t.content] = t; return m; }, {});
  assert.equal(byTxt.a.box, '#ff2d78');
  assert.equal('box' in byTxt.b, false);  // sem box = campo ausente no payload
});

test('playableDuration cobre projeto com audio alem do video (e so-audio toca)', () => {
  const store = storeWithVideo(5);
  store.dispatch({ type: 'ADD_AUDIO_CLIP', media: { url: 'https://x/a.mp3', filename: 'a', duration: 12 } });
  assert.equal(playableDuration(store.getState()), 12);
  // exclui o video da timeline -> playable segue pelo audio
  store.dispatch(act.deleteClip(store.getState().clips[0].id));
  assert.equal(totalDuration(store.getState()), 0);
  assert.equal(playableDuration(store.getState()), 12);
});

// ── rodada 2026-07-20 (2): transform da cena + plano de legenda por áudio real ──

test('SET_CLIP_TRANSFORM aplica escala/opacidade com clamp e undo', () => {
  const store = storeWithVideo(10);
  const id = store.getState().clips[0].id;
  store.dispatch(act.setClipTransform(id, { scale: 0.9, opacity: 0.4 }));
  let c = store.getState().clips[0];
  assert.equal(c.scale, 0.9);
  assert.equal(c.opacity, 0.4);
  store.dispatch(act.setClipTransform(id, { scale: 99 }));   // clamp <=3
  assert.equal(store.getState().clips[0].scale, 3);
  store.dispatch(act.setClipTransform(id, { opacity: -5 })); // clamp >=0
  assert.equal(store.getState().clips[0].opacity, 0);
  store.undo();
  assert.equal(store.getState().clips[0].opacity, 0.4);
});

test('exportPayload leva scale/opacity por clip', () => {
  const store = storeWithVideo(10);
  store.dispatch(act.setClipTransform(store.getState().clips[0].id, { scale: 0.8, opacity: 0.5 }));
  const p = exportPayload(store.getState());
  assert.equal(p.clips[0].scale, 0.8);
  assert.equal(p.clips[0].opacity, 0.5);
});

test('captionAudioPlan escolhe a fonte de áudio REAL (voz > vídeo > nada)', () => {
  const store = storeWithVideo(10);
  // vídeo intacto -> plano do vídeo
  let p = captionAudioPlan(store.getState());
  assert.equal(p.url, 'https://x/video.mp4');
  assert.ok(p.segments.length >= 1);

  // separa o áudio do vídeo E remove -> sem voz -> null (não gera fantasma)
  store.dispatch(act.detachAudio());
  for (const a of [...store.getState().audio_clips]) store.dispatch(act.deleteAudioClip(a.id));
  p = captionAudioPlan(store.getState());
  assert.equal(p, null);

  // editor sobe o próprio áudio (narração) -> plano usa ele
  store.dispatch({ type: 'ADD_AUDIO_CLIP', media: { url: 'https://x/narracao.mp3', filename: 'voz', duration: 6 } });
  p = captionAudioPlan(store.getState());
  assert.equal(p.url, 'https://x/narracao.mp3');
});

test('captionAudioPlan mapeia áudio próprio pra timeline pela posição do clip', () => {
  const store = storeWithVideo(10);
  store.dispatch({ type: 'ADD_AUDIO_CLIP', media: { url: 'https://x/voz.mp3', filename: 'voz', duration: 5 } });
  // move o áudio pra começar em t=2 (posição na timeline)
  const aid = store.getState().audio_clips[0].id;
  store.dispatch(act.moveAudio(aid, 2));
  const p = captionAudioPlan(store.getState());
  assert.equal(p.url, 'https://x/voz.mp3');
  assert.equal(p.segments[0].tStart, 2);      // fala do arquivo aparece a partir de t=2
  assert.equal(p.segments[0].fileIn, 0);
});

// ── rodada 2026-07-20 (3): velocidade por faixa + registries por fonte ──

test('SET_SPEED muda a duração do clip na timeline (2x = metade) com clamp', () => {
  const store = storeWithVideo(10);
  const id = store.getState().clips[0].id;
  store.dispatch(act.setSpeed('clip', id, 2));
  assert.equal(store.getState().clips[0].speed, 2);
  assert.equal(totalDuration(store.getState()), 5);       // 10s a 2x = 5s
  store.dispatch(act.setSpeed('clip', id, 0.5));
  assert.equal(totalDuration(store.getState()), 20);      // 10s a 0.5x = 20s
  store.dispatch(act.setSpeed('clip', id, 999));
  assert.equal(store.getState().clips[0].speed, 100);     // clamp máx
  store.dispatch(act.setSpeed('clip', id, 0.01));
  assert.equal(store.getState().clips[0].speed, 0.1);     // clamp mín
  store.undo();
  assert.equal(store.getState().clips[0].speed, 100);
});

test('SET_SPEED só afeta a FAIXA selecionada, não as vizinhas', () => {
  const store = storeWithVideo(20);
  store.dispatch(act.splitClipAt(10));
  const [a, b] = store.getState().clips;
  store.dispatch(act.setSpeed('clip', b.id, 4));
  const s = store.getState();
  assert.equal(s.clips[0].speed ?? 1, 1);   // vizinho intacto
  assert.equal(s.clips[1].speed, 4);
  assert.equal(totalDuration(s), 10 + 2.5); // 1o 10s + 2o (10s/4)
});

test('SET_SPEED audio muda a duração do áudio na timeline', () => {
  const store = storeWithVideo(5);
  store.dispatch({ type: 'ADD_AUDIO_CLIP', media: { url: 'a.mp3', filename: 'a', duration: 12 } });
  const aid = store.getState().audio_clips[0].id;
  store.dispatch(act.setSpeed('audio', aid, 2));
  assert.equal(store.getState().audio_clips[0].speed, 2);
  assert.equal(playableDuration(store.getState()), 6);   // 12s a 2x = 6s
});

test('timelineToSource/sourceToTimeline respeitam velocidade', () => {
  const store = storeWithVideo(10);
  store.dispatch(act.setSpeed('clip', store.getState().clips[0].id, 2));
  const s = store.getState();
  assert.equal(timelineToSource(s, 2.5), 5);   // t=2.5 na timeline = 5s do arquivo
  assert.equal(sourceToTimeline(s, 5), 2.5);
});

test('SPLIT_CLIP de take preserva media_id + speed nas duas metades', () => {
  const store = storeWithVideo(10);
  store.dispatch(act.addMediaClip({ url: 'https://x/take.mp4', duration: 8 }));
  const takeId = store.getState().clips.at(-1).id;
  store.dispatch(act.setSpeed('clip', takeId, 2));  // take dura 4s na timeline
  store.dispatch(act.selectClip(takeId));
  // playhead no meio do take: principal=10s, take começa em 10, dura 4 -> t=12
  store.dispatch(act.splitClipAt(12));
  const takes = store.getState().clips.filter(c => c.media_id != null);
  assert.equal(takes.length, 2);
  assert.ok(takes.every(c => c.speed === 2), 'ambas as metades speed 2');
  assert.ok(takes.every(c => c.media_id === takes[0].media_id), 'ambas com o media_id');
});

// ── rodada 2026-07-20 (4): copiar/colar, menu Editar (congelar/reverso/espelho) ──

test('PASTE clip cria CÓPIA (Ctrl+C/V) sem mexer no original', () => {
  const store = storeWithVideo(10);
  const c0 = { ...store.getState().clips[0] };
  store.dispatch(act.paste('clip', c0, 0));
  const s = store.getState();
  assert.equal(s.clips.length, 2);
  assert.equal(s.clips[0].id, c0.id);        // original intacto
  assert.notEqual(s.clips[1].id, c0.id);     // cópia com novo id
  assert.equal(s.clips[1].source_out, c0.source_out);
});

test('PASTE audio cola no playhead', () => {
  const store = storeWithVideo(10);
  store.dispatch({ type: 'ADD_AUDIO_CLIP', media: { url: 'a.mp3', filename: 'a', duration: 4 } });
  const a0 = { ...store.getState().audio_clips[0] };
  store.dispatch(act.paste('audio', a0, 5));
  const s = store.getState();
  assert.equal(s.audio_clips.length, 2);
  assert.equal(s.audio_clips[1].start, 5);
});

test('SET_CLIP_FX toggla reverso e espelho', () => {
  const store = storeWithVideo(10);
  const id = store.getState().clips[0].id;
  store.dispatch(act.setClipFx(id, { reversed: true }));
  assert.equal(store.getState().clips[0].reversed, true);
  store.dispatch(act.setClipFx(id, { mirrored: true }));
  assert.equal(store.getState().clips[0].mirrored, true);
  assert.equal(store.getState().clips[0].reversed, true); // não perde o outro
});

test('FREEZE_FRAME divide e insere cena congelada de 3s; estica com SET_FREEZE_DUR', () => {
  const store = storeWithVideo(10);
  store.dispatch(act.freezeFrame(store.getState().clips[0].id, 4));
  let s = store.getState();
  assert.equal(s.clips.length, 3);                 // left + frozen + right
  const fr = s.clips.find(c => c.frozen);
  assert.ok(fr);
  assert.equal(fr.freeze_src, 4);
  assert.equal(clipDuration(s, fr), 3);            // duração inicial 3s
  assert.equal(totalDuration(s), 13);              // 10 + 3
  // estica pra 8s
  store.dispatch(act.setFreezeDur(fr.id, 8));
  assert.equal(clipDuration(store.getState(), store.getState().clips.find(c => c.frozen)), 8);
  // clamp 60
  store.dispatch(act.setFreezeDur(fr.id, 999));
  assert.equal(store.getState().clips.find(c => c.frozen).freeze_dur, 60);
});

test('reverso mapeia timeline->source ao contrário', () => {
  const store = storeWithVideo(10);
  store.dispatch(act.setClipFx(store.getState().clips[0].id, { reversed: true }));
  const s = store.getState();
  assert.equal(timelineToSource(s, 0), 10);   // início da timeline = fim do arquivo
  assert.equal(timelineToSource(s, 3), 7);
});

// ── rodada 2026-07-20 (5): imagens (PNG/sticker com transparência) ──

test('ADD_IMAGE_OVERLAY cria camada de imagem no topo, 3s, no playhead', () => {
  const store = storeWithVideo(10);
  store.dispatch(act.addImageOverlay({ url: 'https://x/circulo.png', width: 300, height: 300 }, 4));
  const s = store.getState();
  assert.equal(s.overlays.length, 1);
  const o = s.overlays[0];
  assert.equal(o.kind, 'image');
  assert.equal(o.url, 'https://x/circulo.png');
  assert.equal(o.start, 4);
  assert.equal(o.source_out - o.source_in, 3);   // 3s de duração inicial
  assert.equal(s.selected_overlay_id, o.id);
});

test('imagem exporta com kind/image_url e trim vai até 60s (sem arquivo limitando)', () => {
  const store = storeWithVideo(5);
  store.dispatch(act.addImageOverlay({ url: 'https://x/seta.png', width: 400, height: 100 }, 1));
  const oid = store.getState().overlays[0].id;
  const pay = exportPayload(store.getState());
  assert.equal(pay.overlays[0].kind, 'image');
  assert.equal(pay.overlays[0].image_url, 'https://x/seta.png');
  store.dispatch(act.trimOverlay(oid, 'out', 40));  // estica além do vídeo (5s)
  assert.equal(store.getState().overlays[0].source_out, 40);
  store.dispatch(act.trimOverlay(oid, 'out', 999)); // clamp 60
  assert.equal(store.getState().overlays[0].source_out, 60);
});

test('múltiplas imagens empilham em lanes crescentes (uma na frente da outra)', () => {
  const store = storeWithVideo(10);
  store.dispatch(act.addImageOverlay({ url: 'https://x/a.png', width: 100, height: 100 }, 0));
  store.dispatch(act.addImageOverlay({ url: 'https://x/b.png', width: 100, height: 100 }, 0));
  const [a, b] = store.getState().overlays;
  assert.ok(b.lane > a.lane, '2ª imagem fica numa lane acima (na frente)');
});

// ── rodada 2026-07-20 (6): group drag, rotação, velocidade composto, áudio no composto ──

test('MOVE_MULTI arrasta a multi-seleção junto e clampa no 0', () => {
  const store = storeWithVideo(20);
  store.dispatch({ type: 'ADD_AUDIO_CLIP', media: { url: 'a.mp3', filename: 'a', duration: 5 } });
  store.dispatch(act.moveAudio(store.getState().audio_clips[0].id, 3));
  store.dispatch(act.addText({ content: 'oi', start_sec: 4, end_sec: 6 }));
  const aid = store.getState().audio_clips[0].id, tid = store.getState().texts[0].id;
  store.dispatch(act.setMultiSelect([{ type: 'audio', id: aid }, { type: 'text', id: tid }]));
  store.dispatch(act.moveMulti(2));
  let s = store.getState();
  assert.equal(s.audio_clips[0].start, 5);
  assert.equal(s.texts[0].start_sec, 6);
  assert.equal(s.texts[0].end_sec, 8);      // preserva duração
  store.dispatch(act.moveMulti(-10));        // clampa: o mais cedo (5) vai a 0
  s = store.getState();
  assert.equal(s.audio_clips[0].start, 0);
  assert.equal(s.texts[0].start_sec, 1);     // mantém o offset relativo
});

test('SET_OVERLAY_TRANSFORM gira a imagem (normaliza 0-360)', () => {
  const store = storeWithVideo(10);
  store.dispatch(act.addImageOverlay({ url: 'https://x/i.png', width: 100, height: 100 }, 1));
  const id = store.getState().overlays[0].id;
  store.dispatch(act.setOverlayTransform(id, { rotation: 45 }));
  assert.equal(store.getState().overlays[0].rotation, 45);
  store.dispatch(act.setOverlayTransform(id, { rotation: 400 }));
  assert.equal(store.getState().overlays[0].rotation, 40);  // wrap
  store.dispatch(act.setOverlayTransform(id, { rotation: -90 }));
  assert.equal(store.getState().overlays[0].rotation, 270);
});

test('velocidade do COMPOSTO acelera tudo dentro (vídeo + áudio)', () => {
  const store = storeWithVideo(10);
  store.dispatch({ type: 'ADD_AUDIO_CLIP', media: { url: 'a.mp3', filename: 'a', duration: 6 } });
  const aid = store.getState().audio_clips[0].id;
  store.dispatch(act.setMultiSelect([{ type: 'clip', id: store.getState().clips[0].id }, { type: 'audio', id: aid }]));
  store.dispatch(act.createCompound());
  const comp = store.getState().clips.find(c => c.compound_id);
  assert.equal(clipDuration(store.getState(), comp), 10);      // 1x
  store.dispatch(act.setSpeed('clip', comp.id, 2));
  const s = store.getState();
  const compAfter = s.clips.find(c => c.compound_id);
  assert.equal(clipDuration(s, compAfter), 5);                 // 2x = metade
  assert.equal(totalDuration(s), 5);
  const innerAudio = effectiveAudioClips(s).find(a => a._compound);
  assert.equal(innerAudio.speed, 2);                           // áudio interno acelerou junto
});

test('áudio dentro do composto continua editável (presente + com id)', () => {
  const store = storeWithVideo(10);
  store.dispatch({ type: 'ADD_AUDIO_CLIP', media: { url: 'a.mp3', filename: 'narração', duration: 4 } });
  const aid = store.getState().audio_clips[0].id;
  store.dispatch(act.setMultiSelect([{ type: 'clip', id: store.getState().clips[0].id }, { type: 'audio', id: aid }]));
  store.dispatch(act.createCompound());
  const comp = store.getState().compounds[0];
  assert.equal(comp.audio_clips.length, 1);                    // áudio foi pro composto
  assert.ok(comp.audio_clips[0].id != null);                   // tem id (selecionável)
  assert.equal(store.getState().audio_clips.length, 0);        // saiu da faixa solta
});

// ── EXCLUIR O VÍDEO PRINCIPAL (2026-07-29) ─────────────────────────────────
// Antes o principal era o único item da biblioteca sem botão de excluir: quem
// importava o arquivo errado primeiro ficava preso com ele. Aqui garantimos
// que dá pra tirar E que a timeline não fica apontando pro vazio.

test('REMOVE_PRIMARY sem takes: projeto volta a ficar vazio', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.removePrimary());
  const s = store.getState();
  assert.equal(s.video, null);
  assert.equal(s.clips.length, 0, 'clips do principal saem junto');
});

test('REMOVE_PRIMARY com take: o take VIRA o principal e continua tocando', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.addMediaClip({
    url: 'https://x/take.mp4', filename: 'take.mp4', duration: 30, width: 1080, height: 1920,
  }));
  const antes = store.getState();
  assert.equal(antes.media.length, 1);
  assert.equal(antes.clips.length, 2, 'principal + take na timeline');

  store.dispatch(act.removePrimary());
  const s = store.getState();
  assert.equal(s.video.url, 'https://x/take.mp4', 'take promovido a principal');
  assert.equal(s.media.length, 0, 'e sai do pool (virou o principal)');
  assert.equal(s.clips.length, 1, 'sobra o clip do take');
  assert.equal(s.clips[0].media_id, null, 'clip passa a resolver pelo principal');
  // o que importa de verdade: a fonte do clip resolve pra uma URL válida
  assert.equal(mediaUrlFor(s, s.clips[0]), 'https://x/take.mp4');
});

test('REMOVE_PRIMARY leva junto a trilha destacada do principal', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.detachAudio());
  assert.ok(store.getState().audio_clips.some(a => a.kind === 'video'), 'destacou');
  store.dispatch(act.removePrimary());
  const s = store.getState();
  assert.equal(s.audio_clips.filter(a => a.kind === 'video').length, 0,
    'áudio do vídeo que não existe mais nao pode sobrar na timeline');
  assert.equal(s.audio_detached, false);
});

test('REMOVE_PRIMARY é desfazível (Ctrl+Z devolve o vídeo)', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.removePrimary());
  assert.equal(store.getState().video, null);
  store.undo();
  assert.equal(store.getState().video.url, 'https://x/video.mp4');
  assert.equal(store.getState().clips.length, 1);
});

test('REMOVE_PRIMARY em projeto vazio nao quebra', () => {
  const store = createStore();
  store.dispatch(act.removePrimary());
  assert.equal(store.getState().video, null);
});

test('audio importado entra na timeline mesmo sem video no projeto', () => {
  // o user relatou "audio nao aparece em Midias": em projeto vazio a tela de
  // importacao cobria o editor. O estado sempre aceitou — provamos aqui.
  const store = createStore();
  store.dispatch(act.addAudioClip({ url: 'https://x/a.mp3', filename: 'a.mp3', duration: 12 }));
  const s = store.getState();
  assert.equal(s.audio_clips.length, 1);
  assert.equal(s.audio_clips[0].url, 'https://x/a.mp3');
  assert.equal(s.audio_clips[0].kind, 'extra');
});

// ── ALÉM DO FIM DO VÍDEO NÃO EXISTE IMAGEM (2026-07-29) ────────────────────
// Legenda/áudio podem passar do fim do vídeo. Nessa região não há segmento —
// o preview tem que apagar, não congelar o último frame.
test('segmentAt devolve null depois do fim do video', () => {
  const store = storeWithVideo(30);
  const s = store.getState();
  assert.ok(segmentAt(s, 15), 'dentro do video tem segmento');
  assert.equal(segmentAt(s, 31), null, 'depois do fim, nada');
});

test('audio que passa do video estica a duracao TOCAVEL, nao a de video', () => {
  const store = storeWithVideo(10);
  store.dispatch(act.addAudioClip({ url: 'https://x/a.mp3', filename: 'a.mp3', duration: 25 }));
  const s = store.getState();
  assert.equal(totalDuration(s), 10, 'a faixa de VIDEO continua com 10s');
  assert.ok(playableDuration(s) >= 25, 'mas da pra navegar ate o fim do audio');
  assert.equal(segmentAt(s, 20), null, 'e la nao ha imagem nenhuma');
});

// ── Q/W: COMPOSTO E MULTI-SELEÇÃO (2026-07-29) ─────────────────────────────
// Relato do user: "apaguei clipe composto com o W e não foi" e "selecionei
// todas as camadas e só a última foi cortada".

function storeComComposto() {
  const store = storeWithVideo(60);
  const s0 = store.getState();
  store.dispatch(act.splitClipAt(20));
  store.dispatch(act.toggleMultiSelect('clip', store.getState().clips[0].id));
  store.dispatch(act.createCompound());
  return store;
}

test('W corta CENA COMPOSTA (antes nao achava o alvo e nao fazia nada)', () => {
  const store = storeComComposto();
  const s = store.getState();
  const comp = s.clips.find(c => c.compound_id != null);
  assert.ok(comp, 'existe um composto na timeline');
  store.dispatch(act.selectClip(comp.id));
  // o composto NAO tem source_out proprio (a duracao vem do conteudo interno),
  // entao a prova de que foi cortado e o BLOCO encolher na timeline
  const bloco = () => {
    const it = mainTrackItems(store.getState()).find(i => i.clip.id === comp.id);
    return it ? it.tEnd - it.tStart : 0;
  };
  const antes = bloco();
  store.dispatch(act.deleteRangeRight(10));
  const depois = bloco();
  assert.ok(depois < antes, `composto nao encolheu: ${antes} -> ${depois}`);
  assert.ok(Math.abs(depois - 10) < 0.5, `deveria terminar em ~10s, ficou ${depois}`);
});

test('W com VARIAS faixas selecionadas corta TODAS, nao so a ultima', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.addAudioClip({ url: 'https://x/a.mp3', filename: 'a.mp3', duration: 40 }));
  store.dispatch(act.addText({ content: 'oi', start_sec: 0, end_sec: 30 }));
  const s = store.getState();
  store.dispatch(act.toggleMultiSelect('clip', s.clips[0].id));
  store.dispatch(act.toggleMultiSelect('audio', s.audio_clips[0].id));
  store.dispatch(act.toggleMultiSelect('text', s.texts[0].id));

  store.dispatch(act.deleteRangeRight(12));
  const d = store.getState();
  assert.equal(d.clips[0].source_out, 12, 'video cortado em 12');
  assert.equal(d.audio_clips[0].source_out, 12, 'audio cortado em 12');
  assert.equal(d.texts[0].end_sec, 12, 'texto cortado em 12');
});

test('Q com varias faixas tambem corta todas (espelho do W)', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.addAudioClip({ url: 'https://x/a.mp3', filename: 'a.mp3', duration: 40 }));
  const s = store.getState();
  store.dispatch(act.toggleMultiSelect('clip', s.clips[0].id));
  store.dispatch(act.toggleMultiSelect('audio', s.audio_clips[0].id));
  store.dispatch(act.deleteRangeLeft(8));
  const d = store.getState();
  assert.equal(d.clips[0].source_in, 8);
  assert.equal(d.audio_clips[0].source_in, 8);
});

test('faixa que a agulha nao atravessa fica INTACTA', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.addAudioClip({ url: 'https://x/a.mp3', filename: 'a.mp3', duration: 5 }));
  const s = store.getState();
  store.dispatch(act.toggleMultiSelect('clip', s.clips[0].id));
  store.dispatch(act.toggleMultiSelect('audio', s.audio_clips[0].id));
  store.dispatch(act.deleteRangeRight(20));  // audio termina em 5s
  const d = store.getState();
  assert.equal(d.clips[0].source_out, 20, 'video cortado');
  assert.equal(d.audio_clips[0].source_out, 5, 'audio intocado');
});

test('Q/W multi e UM passo de undo', () => {
  const store = storeWithVideo(60);
  store.dispatch(act.addAudioClip({ url: 'https://x/a.mp3', filename: 'a.mp3', duration: 40 }));
  const s = store.getState();
  store.dispatch(act.toggleMultiSelect('clip', s.clips[0].id));
  store.dispatch(act.toggleMultiSelect('audio', s.audio_clips[0].id));
  store.dispatch(act.deleteRangeRight(12));
  store.undo();
  const d = store.getState();
  assert.equal(d.clips[0].source_out, 60);
  assert.equal(d.audio_clips[0].source_out, 40);
});
