// tests/unit/separar-audio.test.mjs — node --test
// Separar voz × música (14/08/2026): o clipe é TROCADO por dois stems que
// nascem com o MESMO recorte/posição/volume (soar idêntico é o contrato), e
// a troca inteira é UM undo — desfazer devolve o clipe original.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/editor-v1/core/store.js';
import * as act from '../../public/editor-v1/core/actions.js';

function storeComAudio() {
  const store = createStore();
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 30, width: 1080, height: 1920, size_bytes: 1 }));
  store.dispatch(act.addAudioClip({ url: 'https://cdn/x.mp3', filename: 'musica.mp3', duration: 20, start: 2, lane: 1 }));
  return store;
}

test('ADD_AUDIO_CLIP aceita recorte/volume/speed opcionais (stems herdam do original)', () => {
  const store = createStore();
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 30, width: 1080, height: 1920, size_bytes: 1 }));
  store.dispatch(act.addAudioClip({ url: 'https://cdn/voz.mp3', filename: 'voz', duration: 20, start: 2, lane: 1, source_in: 3, source_out: 11, volume: 0.8, speed: 1.5 }));
  const a = store.getState().audio_clips[0];
  assert.equal(a.source_in, 3);
  assert.equal(a.source_out, 11);
  assert.equal(a.volume, 0.8);
  assert.equal(a.speed, 1.5);
  assert.equal(a.start, 2);
  assert.equal(a.lane, 1);
});

test('sem os campos novos, o contrato ANTIGO segue intacto (locução não regride)', () => {
  const store = createStore();
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 30, width: 1080, height: 1920, size_bytes: 1 }));
  store.dispatch(act.addAudioClip({ url: 'https://cdn/loc.mp3', filename: 'loc', duration: 8 }));
  const a = store.getState().audio_clips[0];
  assert.equal(a.source_in, 0);
  assert.equal(a.source_out, 8);
  assert.equal(a.volume, 1);
  assert.equal(a.speed, undefined);
});

test('recorte inválido é normalizado (source_out > duration cai pro fim)', () => {
  const store = createStore();
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 30, width: 1080, height: 1920, size_bytes: 1 }));
  store.dispatch(act.addAudioClip({ url: 'https://cdn/a.mp3', filename: 'a', duration: 10, source_in: 4, source_out: 99 }));
  const a = store.getState().audio_clips[0];
  assert.equal(a.source_in, 4);
  assert.equal(a.source_out, 10);
});

test('a TROCA inteira (2 stems entram, original sai) com gestureId = UM undo', () => {
  const store = createStore();
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 30, width: 1080, height: 1920, size_bytes: 1 }));
  store.dispatch(act.addAudioClip({ url: 'https://cdn/x.mp3', filename: 'mix.mp3', duration: 20, start: 2, lane: 1, source_in: 3, source_out: 11 }));
  const orig = store.getState().audio_clips[0];
  const base = { duration: orig.media_duration, start: orig.start, source_in: orig.source_in, source_out: orig.source_out, volume: orig.volume };
  const g = 'sepvoz-teste';
  store.dispatch({ ...act.addAudioClip({ ...base, url: 'https://cdn/voz.mp3', filename: '🎙 voz', lane: 1 }), gestureId: g });
  store.dispatch({ ...act.addAudioClip({ ...base, url: 'https://cdn/mus.mp3', filename: '🎵 música', lane: 2 }), gestureId: g });
  store.dispatch({ ...act.deleteAudioClip(orig.id), gestureId: g });

  const depois = store.getState().audio_clips;
  assert.equal(depois.length, 2, 'original saiu, 2 stems entraram');
  assert.ok(depois.every((a) => a.start === 2 && a.source_in === 3 && a.source_out === 11),
    'stems nascem com o MESMO recorte e posição');
  assert.deepEqual(depois.map((a) => a.lane), [1, 2], 'voz na lane original, música na de baixo');

  store.undo();
  const restaurado = store.getState().audio_clips;
  assert.equal(restaurado.length, 1, 'UM undo desfaz a troca inteira');
  assert.equal(restaurado[0].url, 'https://cdn/x.mp3', 'o clipe original voltou');
});
