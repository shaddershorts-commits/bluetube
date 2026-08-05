// tests/unit/audiofx.test.mjs — Aprimorar áudio + locução (núcleo puro)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/editor-v1/core/store.js';
import * as act from '../../public/editor-v1/core/actions.js';
import { exportPayload, compoundTemAudio } from '../../public/editor-v1/core/selectors.js';
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
  store.dispatch(act.setAudioFx('audio', audioDe(store).id, { fx_ruido: true }));
  assert.equal(audioDe(store).fx_ruido, true);
  assert.ok(!audioDe(store).fx_voz, 'os outros continuam desligados');
});

test('ativar todos = os 3 de uma vez (botão geral)', () => {
  const store = comVideoEAudio();
  store.dispatch(act.setAudioFx('audio', audioDe(store).id, { fx_ruido: true, fx_voz: true, fx_norm: true }));
  const a = audioDe(store);
  assert.ok(a.fx_ruido && a.fx_voz && a.fx_norm);
});

test('intensidade da voz clampa em 0..100', () => {
  const store = comVideoEAudio();
  const id = audioDe(store).id;
  store.dispatch(act.setAudioFx('audio', id, { fx_voz: true, fx_voz_int: 999 }));
  assert.equal(audioDe(store).fx_voz_int, 100);
  store.dispatch(act.setAudioFx('audio', id, { fx_voz_int: -5 }));
  assert.equal(audioDe(store).fx_voz_int, 0);
});

test('patch igual nao cria snapshot de undo fantasma', () => {
  const store = comVideoEAudio();
  const id = audioDe(store).id;
  store.dispatch(act.setAudioFx('audio', id, { fx_ruido: true }));
  const st = store.getState();
  store.dispatch(act.setAudioFx('audio', id, { fx_ruido: true }));
  assert.equal(store.getState(), st, 'mesmo valor = mesma referencia');
});

test('os efeitos VIAJAM no payload do export', () => {
  const store = comVideoEAudio();
  store.dispatch(act.setAudioFx('audio', audioDe(store).id, { fx_ruido: true, fx_voz: true, fx_voz_int: 40 }));
  const a = exportPayload(store.getState()).audio_clips[0];
  assert.equal(a.fx_ruido, true);
  assert.equal(a.fx_voz, true);
  assert.equal(a.fx_voz_int, 40);
  assert.equal(a.fx_norm, undefined, 'desligado nao engorda o payload');
});

test('os efeitos SOBREVIVEM a reabrir o projeto (a classe de bug do grade)', () => {
  const store = comVideoEAudio();
  store.dispatch(act.setAudioFx('audio', audioDe(store).id, { fx_voz: true, fx_voz_int: 60, fx_norm: true }));
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

// ── O ALVO GENERICO: audio solto, CENA DE VIDEO com som, e COMPOSTO ──
// O user pegou que a feature so valia pro audio solto: "tem que funcionar em
// video que tenha audio" e "no composto o editor acha que nao tem audio".

test('efeitos na CENA DE VIDEO (audio embutido) entram no clip', () => {
  const store = comVideoEAudio();
  const clipId = store.getState().clips[0].id;
  store.dispatch(act.setAudioFx('clip', clipId, { fx_ruido: true, fx_voz: true, fx_voz_int: 55 }));
  const c = store.getState().clips[0];
  assert.equal(c.fx_ruido, true);
  assert.equal(c.fx_voz_int, 55);
});

test('e VIAJAM no payload da cena (o render aplica na extracao do audio dela)', () => {
  const store = comVideoEAudio();
  store.dispatch(act.setAudioFx('clip', store.getState().clips[0].id, { fx_norm: true }));
  const c = exportPayload(store.getState()).clips[0];
  assert.equal(c.fx_norm, true);
});

test('efeitos da cena SOBREVIVEM a reabrir o projeto', () => {
  const store = comVideoEAudio();
  store.dispatch(act.setAudioFx('clip', store.getState().clips[0].id, { fx_voz: true, fx_voz_int: 33 }));
  const re = normalizeLoadedState(JSON.parse(JSON.stringify(store.getState())));
  assert.equal(re.clips[0].fx_voz, true);
  assert.equal(re.clips[0].fx_voz_int, 33);
});

test('COMPOSTO: efeito no bloco cascateia pro audio de dentro no export', () => {
  const store = comVideoEAudio();
  const s0 = store.getState();
  store.dispatch(act.setMultiSelect([
    { type: 'clip', id: s0.clips[0].id }, { type: 'audio', id: s0.audio_clips[0].id },
  ]));
  store.dispatch(act.createCompound());
  const stub = store.getState().clips.find(c => c.compound_id != null);
  assert.ok(stub, 'compos criado');
  store.dispatch(act.setAudioFx('clip', stub.id, { fx_ruido: true, fx_norm: true }));
  const pay = exportPayload(store.getState());
  const audioDoComposto = pay.audio_clips.find(a => a.fx_ruido);
  assert.ok(audioDoComposto, 'o audio de dentro do composto leva o efeito');
  assert.equal(audioDoComposto.fx_norm, true);
});

test('COMPOSTO com audio dentro e reconhecido como tendo som', () => {
  const store = comVideoEAudio();
  const s0 = store.getState();
  store.dispatch(act.setMultiSelect([
    { type: 'clip', id: s0.clips[0].id }, { type: 'audio', id: s0.audio_clips[0].id },
  ]));
  store.dispatch(act.createCompound());
  const s = store.getState();
  assert.equal(compoundTemAudio(s, s.compounds[0].id), true);
});

test('COMPOSTO so com video mudo NAO e tratado como tendo som', () => {
  const store = createStore();
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 20, width: 1080, height: 1920, size_bytes: 1 }));
  store.dispatch(act.splitClipAt(10));
  const s0 = store.getState();
  store.dispatch(act.setClipFx(s0.clips[0].id, { muted: true }));
  store.dispatch(act.setMultiSelect([{ type: 'clip', id: s0.clips[0].id }]));
  store.dispatch(act.createCompound());
  const s = store.getState();
  assert.equal(compoundTemAudio(s, s.compounds[0].id), false);
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

test('CLIPE COMPOSTO sobrevive ao video chegar depois (achado da revisao)', () => {
  const store = createStore();
  store.dispatch(act.addAudioClip({ url: 'https://x/loc.webm', filename: 'Locução', duration: 6, start: 0 }));
  store.dispatch(act.addText({ content: 'legenda', start_sec: 0, end_sec: 3 }));
  const s0 = store.getState();
  store.dispatch(act.setMultiSelect([
    { type: 'audio', id: s0.audio_clips[0].id }, { type: 'text', id: s0.texts[0].id },
  ]));
  store.dispatch(act.createCompound());
  const comAgrupado = store.getState();
  assert.equal(comAgrupado.compounds.length, 1, 'agrupou');
  const stubs = comAgrupado.clips.filter(c => c.compound_id != null).length;
  assert.equal(stubs, 1, 'o composto tem stub na faixa principal');

  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 30, width: 1080, height: 1920, size_bytes: 1 }));
  const s = store.getState();
  assert.equal(s.compounds.length, 1, 'o COMPOSTO nao pode sumir');
  assert.equal(s.compounds[0].audio_clips.length, 1, 'com a locucao dentro');
  assert.equal(s.clips.filter(c => c.compound_id != null).length, 1, 'e o stub voltou pra timeline');
  assert.equal(s.clips.filter(c => c.compound_id == null).length, 1, 'mais o video novo');
  const ids = s.clips.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, 'sem id repetido: ' + ids.join(','));
});

test('video novo NAO nasce mudo por volume herdado de projeto sem principal', () => {
  const store = createStore();
  store.dispatch(act.setVolume('video', 0));       // usuario mutou antes
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 10, width: 1080, height: 1920, size_bytes: 1 }));
  assert.equal(store.getState().volumes.video, 1, 'o canal do principal volta a 1');
});

test('trocar o arquivo de um projeto que JA tinha video preserva o volume ajustado', () => {
  const store = createStore();
  store.dispatch(act.setVideo({ url: 'a', path: 'p', filename: 'a.mp4', duration: 10, width: 1080, height: 1920, size_bytes: 1 }));
  store.dispatch(act.setVolume('video', 0.3));
  store.dispatch(act.setVideo({ url: 'b', path: 'p', filename: 'b.mp4', duration: 10, width: 1080, height: 1920, size_bytes: 1 }));
  assert.equal(store.getState().volumes.video, 0.3, 'ajuste consciente do usuario fica');
});

test('ids nao colidem depois do video chegar (next_* preservados)', () => {
  const store = createStore();
  store.dispatch(act.addAudioClip({ url: 'https://x/a.webm', filename: 'a', duration: 3 }));
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 30, width: 1080, height: 1920, size_bytes: 1 }));
  store.dispatch(act.addAudioClip({ url: 'https://x/b.webm', filename: 'b', duration: 3 }));
  const ids = store.getState().audio_clips.map(a => a.id);
  assert.equal(new Set(ids).size, ids.length, 'ids unicos: ' + ids.join(','));
});
