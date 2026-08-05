// tests/unit/audiofx.test.mjs — Aprimorar áudio + locução (núcleo puro)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/editor-v1/core/store.js';
import * as act from '../../public/editor-v1/core/actions.js';
import { exportPayload } from '../../public/editor-v1/core/selectors.js';
import { normalizeLoadedState } from '../../public/editor-v1/core/schema.js';

function comVideoEAudio() {
  const store = createStore();
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 30, width: 1080, height: 1920, size_bytes: 1 }));
  store.dispatch(act.addAudioClip({ url: 'https://x/a.mp3', filename: 'a', duration: 10 }));
  return store;
}
const audioDe = (store) => store.getState().audio_clips[0];

test('SET_AUDIO_FX liga efeito a efeito', () => {
  const store = comVideoEAudio();
  store.dispatch(act.setAudioFx(audioDe(store).id, { fx_ruido: true }));
  assert.equal(audioDe(store).fx_ruido, true);
  assert.ok(!audioDe(store).fx_voz, 'os outros continuam desligados');
});

test('ativar todos = os 3 de uma vez (botão geral)', () => {
  const store = comVideoEAudio();
  store.dispatch(act.setAudioFx(audioDe(store).id, { fx_ruido: true, fx_voz: true, fx_norm: true }));
  const a = audioDe(store);
  assert.ok(a.fx_ruido && a.fx_voz && a.fx_norm);
});

test('intensidade da voz clampa em 0..100', () => {
  const store = comVideoEAudio();
  const id = audioDe(store).id;
  store.dispatch(act.setAudioFx(id, { fx_voz: true, fx_voz_int: 999 }));
  assert.equal(audioDe(store).fx_voz_int, 100);
  store.dispatch(act.setAudioFx(id, { fx_voz_int: -5 }));
  assert.equal(audioDe(store).fx_voz_int, 0);
});

test('patch igual nao cria snapshot de undo fantasma', () => {
  const store = comVideoEAudio();
  const id = audioDe(store).id;
  store.dispatch(act.setAudioFx(id, { fx_ruido: true }));
  const st = store.getState();
  store.dispatch(act.setAudioFx(id, { fx_ruido: true }));
  assert.equal(store.getState(), st, 'mesmo valor = mesma referencia');
});

test('os efeitos VIAJAM no payload do export', () => {
  const store = comVideoEAudio();
  store.dispatch(act.setAudioFx(audioDe(store).id, { fx_ruido: true, fx_voz: true, fx_voz_int: 40 }));
  const a = exportPayload(store.getState()).audio_clips[0];
  assert.equal(a.fx_ruido, true);
  assert.equal(a.fx_voz, true);
  assert.equal(a.fx_voz_int, 40);
  assert.equal(a.fx_norm, undefined, 'desligado nao engorda o payload');
});

test('os efeitos SOBREVIVEM a reabrir o projeto (a classe de bug do grade)', () => {
  const store = comVideoEAudio();
  store.dispatch(act.setAudioFx(audioDe(store).id, { fx_voz: true, fx_voz_int: 60, fx_norm: true }));
  const salvo = JSON.parse(JSON.stringify(store.getState()));
  const re = normalizeLoadedState(salvo);
  assert.equal(re.audio_clips[0].fx_voz, true);
  assert.equal(re.audio_clips[0].fx_voz_int, 60);
  assert.equal(re.audio_clips[0].fx_norm, true);
  assert.ok(!re.audio_clips[0].fx_ruido);
});

// ── locução: o clipe nasce onde o fantasma estava ──

test('ADD_AUDIO_CLIP aceita start e lane (a locucao cai onde gravou)', () => {
  const store = createStore();
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 30, width: 1080, height: 1920, size_bytes: 1 }));
  store.dispatch(act.addAudioClip({ url: 'https://x/loc.webm', filename: 'Locução', duration: 5, start: 7.5, lane: 2 }));
  const a = store.getState().audio_clips[0];
  assert.equal(a.start, 7.5);
  assert.equal(a.lane, 2);
});

test('sem start/lane o comportamento antigo continua (0 e faixa automatica)', () => {
  const store = comVideoEAudio();
  const a = audioDe(store);
  assert.equal(a.start, 0);
  assert.equal(a.lane, undefined);
});

// ── SET_VIDEO nao pode APAGAR o que ja esta na timeline (bug do user) ──

test('gravar locucao SEM video e depois adicionar o video PRESERVA a locucao', () => {
  const store = createStore();
  store.dispatch(act.addAudioClip({ url: 'https://x/loc.webm', filename: 'Locução', duration: 8, start: 2, lane: 0 }));
  assert.equal(store.getState().audio_clips.length, 1, 'gravou sem video');
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 30, width: 1080, height: 1920, size_bytes: 1 }));
  const s = store.getState();
  assert.equal(s.audio_clips.length, 1, 'a locucao NAO sumiu');
  assert.equal(s.audio_clips[0].start, 2, 'e continua onde estava');
  assert.equal(s.clips.length, 1, 'o video entrou na faixa principal');
});

test('imagem e texto tambem sobrevivem ao video chegar depois', () => {
  const store = createStore();
  store.dispatch(act.addImageOverlay({ url: 'i.png', width: 10, height: 10 }, 0));
  store.dispatch(act.addText({ content: 'titulo', start_sec: 0, end_sec: 3 }));
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 30, width: 1080, height: 1920, size_bytes: 1 }));
  const s = store.getState();
  assert.equal(s.overlays.length, 1, 'a imagem ficou');
  assert.equal(s.texts.length, 1, 'o texto ficou');
});

test('ids nao colidem depois do video chegar (next_* preservados)', () => {
  const store = createStore();
  store.dispatch(act.addAudioClip({ url: 'https://x/a.webm', filename: 'a', duration: 3 }));
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 30, width: 1080, height: 1920, size_bytes: 1 }));
  store.dispatch(act.addAudioClip({ url: 'https://x/b.webm', filename: 'b', duration: 3 }));
  const ids = store.getState().audio_clips.map(a => a.id);
  assert.equal(new Set(ids).size, ids.length, 'ids unicos: ' + ids.join(','));
});
