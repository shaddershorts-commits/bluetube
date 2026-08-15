// tests/unit/corte-tudo.test.mjs
//
// Q/W SEM NADA SELECIONADO = corta a timeline INTEIRA (user 2026-08-05):
// "Ao apertar w e q sem selecionar nenhuma faixa, apenas o vídeo é cortado, o
//  áudio fica intacto. É pra cortar TUUUUDO, incluindo texto ou qualquer outra
//  coisa que exista na timeline. Pode clipe composto, muitas camadas."
//
// Regra: quem é ATRAVESSADO pela agulha é cortado. Quem nem passa por ali fica
// intacto — "cortar" alguém que não está no ponto não quer dizer nada.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/editor-v1/core/store.js';
import * as act from '../../public/editor-v1/core/actions.js';

function projeto() {
  const store = createStore();
  store.dispatch(act.setVideo({
    url: 'https://x/v.mp4', path: 'p', filename: 'v.mp4',
    duration: 30, width: 1080, height: 1920, size_bytes: 1,
  }));
  // áudio de 0 a 20s
  store.dispatch(act.addAudioClip({ url: 'https://x/a.mp3', filename: 'a', duration: 20 }));
  // texto de 2 a 12s
  store.dispatch(act.addText({ content: 'oi', start_sec: 2, end_sec: 12 }));
  // camada de vídeo: precisa de um 2º pedaço (converter o único clipe
  // esvaziaria a faixa principal), e depois vai pro começo pra cruzar a agulha
  store.dispatch(act.splitClipAt(20));
  const segundo = store.getState().clips[1].id;
  store.dispatch(act.convertToOverlay(segundo, 20));
  store.dispatch(act.moveOverlay(store.getState().overlays[0].id, 0));
  store.dispatch({ type: 'CLEAR_SELECTION' });
  return store;
}

const pegar = (st) => ({
  audio: st.audio_clips[0],
  texto: st.texts[0],
  overlay: st.overlays[0],
});

test('W sem seleção corta áudio, texto e camada — não só o vídeo', () => {
  const store = projeto();
  const antes = pegar(store.getState());
  assert.ok(antes.audio && antes.texto && antes.overlay, 'o projeto de teste tem as 3 faixas');

  store.dispatch(act.deleteRangeRight(8));
  const dep = pegar(store.getState());

  assert.ok(dep.audio.source_out < antes.audio.source_out,
    'o ÁUDIO tinha que encurtar — é a queixa exata do user');
  assert.equal(dep.texto.end_sec, 8, 'o TEXTO tinha que terminar na agulha');
  assert.ok(dep.overlay.source_out < antes.overlay.source_out, 'a CAMADA tinha que encurtar');
});

test('Q sem seleção corta áudio, texto e camada', () => {
  const store = projeto();
  const antes = pegar(store.getState());
  store.dispatch(act.deleteRangeLeft(6));
  const dep = pegar(store.getState());

  assert.ok(dep.audio.source_in > antes.audio.source_in, 'o ÁUDIO perdeu o começo');
  assert.equal(dep.texto.start_sec, 6, 'o TEXTO começa na agulha');
  assert.ok(dep.overlay.source_in > antes.overlay.source_in, 'a CAMADA perdeu o começo');
});

test('quem NÃO é atravessado pela agulha fica intacto', () => {
  const store = projeto();
  // texto curto lá no fim, longe da agulha
  store.dispatch(act.addText({ content: 'longe', start_sec: 24, end_sec: 28 }));
  store.dispatch({ type: 'CLEAR_SELECTION' });
  const longeAntes = JSON.stringify(store.getState().texts.find(t => t.content === 'longe'));

  store.dispatch(act.deleteRangeRight(8));
  const longeDepois = JSON.stringify(store.getState().texts.find(t => t.content === 'longe'));
  assert.equal(longeDepois, longeAntes, 'texto fora da agulha não pode ser tocado');
});

test('corta a timeline inteira em UM passo de desfazer', () => {
  const store = projeto();
  const antes = JSON.stringify(store.getState().audio_clips) + JSON.stringify(store.getState().texts);
  store.dispatch(act.deleteRangeRight(8));
  store.undo();
  const depois = JSON.stringify(store.getState().audio_clips) + JSON.stringify(store.getState().texts);
  assert.equal(depois, antes, 'um Ctrl+Z devolve TUDO');
});

test('CLIPE COMPOSTO também é cortado quando nada está selecionado', () => {
  const store = createStore();
  store.dispatch(act.setVideo({
    url: 'https://x/v.mp4', path: 'p', filename: 'v.mp4',
    duration: 30, width: 1080, height: 1920, size_bytes: 1,
  }));
  store.dispatch(act.splitClipAt(10));
  const ids = store.getState().clips.map(c => c.id);
  store.dispatch(act.setMultiSelect(ids.map(id => ({ type: 'clip', id }))));
  store.dispatch(act.createCompound());
  store.dispatch({ type: 'CLEAR_SELECTION' });
  const comp = store.getState().compounds[0];
  assert.ok(comp, 'o composto foi criado');
  const durAntes = comp.clips.reduce((s, c) => s + (c.source_out - c.source_in), 0);

  store.dispatch(act.deleteRangeRight(6));
  const durDepois = store.getState().compounds[0].clips
    .reduce((s, c) => s + (c.source_out - c.source_in), 0);
  assert.ok(durDepois < durAntes, `composto não foi cortado (${durAntes} -> ${durDepois})`);
});

test('com uma faixa SELECIONADA, só ela é cortada (não virou vale-tudo)', () => {
  const store = projeto();
  const st0 = store.getState();
  store.dispatch(act.selectAudioClip(st0.audio_clips[0].id));
  const textoAntes = JSON.stringify(store.getState().texts[0]);

  store.dispatch(act.deleteRangeRight(8));
  const st1 = store.getState();
  assert.ok(st1.audio_clips[0].source_out < st0.audio_clips[0].source_out, 'o áudio selecionado cortou');
  assert.equal(JSON.stringify(st1.texts[0]), textoAntes,
    'o texto NÃO podia ser tocado — havia seleção');
});

test('LEGENDAS entram no corte geral (são texto como qualquer outro)', () => {
  const store = projeto();
  store.dispatch(act.setCaptions([
    { content: 'um', start_sec: 3, end_sec: 9 },
    { content: 'dois', start_sec: 20, end_sec: 24 },
  ]));
  store.dispatch({ type: 'CLEAR_SELECTION' });
  store.dispatch(act.deleteRangeRight(7));
  const caps = store.getState().texts.filter(t => t.caption);
  const atravessada = caps.find(c => c.content === 'um');
  const longe = caps.find(c => c.content === 'dois');
  assert.equal(atravessada.end_sec, 7, 'a legenda sob a agulha foi cortada');
  assert.equal(longe.end_sec, 24, 'a legenda distante ficou intacta');
});
