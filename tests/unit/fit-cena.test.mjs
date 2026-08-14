// tests/unit/fit-cena.test.mjs — node --test
// Vídeo horizontal num projeto vertical entra INTEIRO (tamanho real), não
// esmagado/estourado pelo cover global (acordo com o user, 2026-08-07).
// A regra é DERIVADA das dimensões da mídia e vale IGUAL no preview e no
// export (fitDaCena) — é o que impede o WYSIWYG de mentir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/editor-v1/core/store.js';
import * as act from '../../public/editor-v1/core/actions.js';
import { fitDaCena, exportPayload, segmentAt } from '../../public/editor-v1/core/selectors.js';

function storeComVideo(w, h) {
  const store = createStore();
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 10, width: w, height: h, size_bytes: 1 }));
  return store;
}

test('vídeo principal VERTICAL segue o padrão do projeto (sem fit próprio)', () => {
  const st = storeComVideo(1080, 1920).getState();
  assert.equal(fitDaCena(st, segmentAt(st, 1)), null);
});

test('vídeo principal HORIZONTAL entra inteiro (contain)', () => {
  const st = storeComVideo(1920, 1080).getState();
  assert.equal(fitDaCena(st, segmentAt(st, 1)), 'contain');
});

test('take horizontal importado num projeto vertical entra inteiro', () => {
  const store = storeComVideo(1080, 1920);
  store.dispatch(act.addMediaClip({ url: 'take', filename: 't.mp4', duration: 8, width: 1920, height: 1080 }));
  const st = store.getState();
  assert.equal(fitDaCena(st, segmentAt(st, 5)), null, 'a cena principal continua no padrão');
  assert.equal(fitDaCena(st, segmentAt(st, 12)), 'contain', 'o take horizontal ganha contain');
});

test('mídia QUADRADA também difere do quadro → contain', () => {
  const store = storeComVideo(1080, 1920);
  store.dispatch(act.addMediaClip({ url: 'q', filename: 'q.png', duration: 3, width: 1000, height: 1000 }));
  const st = store.getState();
  assert.equal(fitDaCena(st, segmentAt(st, 11)), 'contain');
});

test('mídia sem dimensões (probe falhou) NÃO inventa fit', () => {
  const store = storeComVideo(1080, 1920);
  store.dispatch(act.addMediaClip({ url: 'x', filename: 'x.mp4', duration: 5, width: 0, height: 0 }));
  const st = store.getState();
  assert.equal(fitDaCena(st, segmentAt(st, 11)), null);
});

test('tolerância de 5%: 1088x1920 (arredondamento de encoder) segue cover', () => {
  const st = storeComVideo(1088, 1920).getState();
  assert.equal(fitDaCena(st, segmentAt(st, 1)), null);
});

test('o fit VIAJA no payload de export (o Railway normaliza aquela cena)', () => {
  const store = storeComVideo(1080, 1920);
  store.dispatch(act.addMediaClip({ url: 'take', filename: 't.mp4', duration: 8, width: 1920, height: 1080 }));
  const p = exportPayload(store.getState());
  assert.equal(p.clips[0].fit, undefined, 'cena vertical não carrega fit');
  assert.equal(p.clips[1].fit, 'contain', 'o take horizontal leva contain');
});
