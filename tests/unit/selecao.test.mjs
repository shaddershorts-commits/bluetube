// tests/unit/selecao.test.mjs — a seleção não pode ficar VIVA E INVISÍVEL
//
// Bug reportado 2026-07-29: "apertar W ou Q sem selecionar NENHUMA faixa CORTA
// TUDO da onde a agulha está". Raiz: CLEAR_SELECTION limpava selected_clip_id/
// text/audio/overlay mas NÃO multi_selected — Ctrl+A (ou marquee) + clique no
// vazio deixava a multi-seleção viva sem nada aceso na tela, e Q/W/Delete
// agiam sobre ela. Num editor profissional isso apaga o trabalho do usuário.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/editor-v1/core/store.js';
import * as act from '../../public/editor-v1/core/actions.js';
import { mainTrackItems, totalDuration } from '../../public/editor-v1/core/selectors.js';

function projeto() {
  const store = createStore();
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 30, width: 1080, height: 1920, size_bytes: 1 }));
  store.dispatch(act.splitClipAt(10));
  store.dispatch(act.splitClipAt(20));   // 3 cenas
  store.dispatch(act.addAudioClip({ url: 'https://x/a.mp3', filename: 'a', duration: 30 }));
  store.dispatch(act.addText({ content: 'oi', start_sec: 0, end_sec: 5 }));
  return store;
}

test('limpar seleção limpa TAMBÉM a multi-seleção', () => {
  const store = projeto();
  store.dispatch(act.selectAll());
  assert.ok(store.getState().multi_selected.length > 0, 'Ctrl+A selecionou');
  store.dispatch(act.clearSelection());
  assert.deepEqual(store.getState().multi_selected, [], 'clicar no vazio limpa tudo');
});

test('W sem NENHUMA seleção e com a agulha fora de tudo NÃO corta nada', () => {
  const store = projeto();
  store.dispatch(act.selectAll());
  store.dispatch(act.clearSelection());        // usuário clicou no vazio
  const antes = JSON.stringify(store.getState().clips);
  store.dispatch(act.deleteRangeRight(999));   // agulha além do fim
  assert.equal(JSON.stringify(store.getState().clips), antes, 'nada mudou');
});

test('Q depois de Ctrl+A + clicar no vazio corta SÓ a cena sob a agulha', () => {
  const store = projeto();
  store.dispatch(act.selectAll());
  store.dispatch(act.clearSelection());
  const antes = mainTrackItems(store.getState());
  store.dispatch(act.deleteRangeLeft(15));     // agulha DENTRO da 2ª cena
  const depois = mainTrackItems(store.getState());
  assert.equal(depois.length, antes.length, 'nenhuma cena foi destruída');
  // só a cena sob a agulha encurtou
  const mudou = depois.filter((d, i) => (d.tEnd - d.tStart) !== (antes[i].tEnd - antes[i].tStart));
  assert.equal(mudou.length, 1, 'exatamente uma cena mudou, não a timeline toda');
});

test('a multi-seleção DE VERDADE continua funcionando (não matei a feature)', () => {
  const store = projeto();
  const s = store.getState();
  store.dispatch(act.setMultiSelect([
    { type: 'clip', id: s.clips[0].id }, { type: 'clip', id: s.clips[1].id },
  ]));
  const antes = mainTrackItems(store.getState()).map(i => i.tEnd - i.tStart);
  store.dispatch(act.deleteRangeRight(5));     // dentro da 1ª cena
  const depois = mainTrackItems(store.getState()).map(i => i.tEnd - i.tStart);
  assert.notDeepEqual(depois, antes, 'com multi-seleção real, o corte acontece');
});

test('Delete depois de limpar a seleção não apaga o projeto', () => {
  const store = projeto();
  store.dispatch(act.selectAll());
  store.dispatch(act.clearSelection());
  const antes = store.getState();
  store.dispatch(act.deleteMulti());
  const s = store.getState();
  assert.equal(s.clips.length, antes.clips.length, 'cenas intactas');
  assert.equal(s.audio_clips.length, antes.audio_clips.length, 'áudio intacto');
  assert.equal(s.texts.length, antes.texts.length, 'textos intactos');
});

test('selecionar UM item depois do Ctrl+A não deixa resto preso na multi', () => {
  const store = projeto();
  store.dispatch(act.selectAll());
  const s = store.getState();
  store.dispatch(act.clearSelection());
  store.dispatch(act.selectClip(s.clips[0].id));
  assert.deepEqual(store.getState().multi_selected, [], 'multi vazia');
  assert.equal(store.getState().selected_clip_id, s.clips[0].id);
});

test('limpar seleção duas vezes é no-op (sem snapshot fantasma)', () => {
  const store = projeto();
  store.dispatch(act.clearSelection());
  const st = store.getState();
  store.dispatch(act.clearSelection());
  assert.equal(store.getState(), st, 'mesma referência');
});
