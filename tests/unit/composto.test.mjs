// tests/unit/composto.test.mjs — o BLOCO COMPOSTO não pode ser um buraco
//
// Bug reportado 2026-07-29: "máscara em clipe composto não funciona; a máscara
// deve SEMPRE funcionar". Raiz (achada pela investigação com git): existiam
// DOIS mapeamentos paralelos e ninguém sabia quem era o dono da propriedade —
// o PREVIEW lia do bloco (mainTrackItems → stub) e o EXPORT lia do sub-clipe
// (timelineSegments), exatamente opostos. Aplicar no bloco sumia no arquivo;
// aplicar na cena de dentro não aparecia na tela.
// Regra canônica agora: valor DA CENA vence; na falta, herda do BLOCO.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/editor-v1/core/store.js';
import * as act from '../../public/editor-v1/core/actions.js';
import {
  exportPayload, propriedadeDaCena, timelineSegments, segmentAt,
} from '../../public/editor-v1/core/selectors.js';

/** projeto com 2 cenas, a 1ª virando composto */
function comComposto() {
  const store = createStore();
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 30, width: 1080, height: 1920, size_bytes: 1 }));
  store.dispatch(act.splitClipAt(10));
  const s0 = store.getState();
  store.dispatch(act.setMultiSelect([{ type: 'clip', id: s0.clips[0].id }]));
  store.dispatch(act.createCompound());
  return store;
}
const stubDe = (store) => store.getState().clips.find(c => c.compound_id != null);

test('máscara aplicada NO BLOCO composto chega no arquivo exportado', () => {
  const store = comComposto();
  const stub = stubDe(store);
  store.dispatch(act.setClipMask(stub.id, { shape: 'circle', x_pct: 0.5, y_pct: 0.5, w_pct: 0.5, h_pct: 0.5 }));
  const pay = exportPayload(store.getState());
  const comMascara = pay.clips.filter(c => c.mask);
  assert.ok(comMascara.length >= 1, 'a cena de dentro do composto herdou a máscara');
  assert.equal(comMascara[0].mask.shape, 'circle');
});

test('Retoque aplicado NO BLOCO composto chega no arquivo exportado', () => {
  const store = comComposto();
  store.dispatch(act.setClipGrade(stubDe(store).id, { contraste: 40 }));
  const pay = exportPayload(store.getState());
  assert.ok(pay.clips.some(c => c.grade && c.grade.contraste === 40), 'grade herdado');
  assert.ok(pay.clips.some(c => c.grade_render), 'e os números do render junto');
});

test('a CENA de dentro vence o bloco quando ela tem valor próprio', () => {
  const store = comComposto();
  const stub = stubDe(store);
  store.dispatch(act.setClipGrade(stub.id, { contraste: 40 }));
  // agora ajusta a cena DE DENTRO com outro valor
  const s = store.getState();
  const comp = s.compounds[0];
  const sub = comp.clips[0];
  store.replaceState({
    ...s,
    compounds: [{ ...comp, clips: [{ ...sub, grade: { contraste: -20 } }] }],
  });
  const pay = exportPayload(store.getState());
  const g = pay.clips.find(c => c.grade)?.grade;
  assert.equal(g.contraste, -20, 'o ajuste específico da cena manda');
});

test('propriedadeDaCena: sem composto, devolve o valor da própria cena', () => {
  const store = createStore();
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: 10, width: 1080, height: 1920, size_bytes: 1 }));
  store.dispatch(act.setClipMask(store.getState().clips[0].id, { shape: 'rect' }));
  const s = store.getState();
  const seg = timelineSegments(s)[0];
  assert.equal(propriedadeDaCena(s, seg, 'mask').shape, 'rect');
});

test('propriedadeDaCena: campo ausente nos dois lados = undefined (sem inventar)', () => {
  const store = comComposto();
  const s = store.getState();
  assert.equal(propriedadeDaCena(s, timelineSegments(s)[0], 'mask'), undefined);
});

test('espelhar/reverso aplicados no bloco valem pras cenas de dentro', () => {
  const store = comComposto();
  store.dispatch(act.setClipFx(stubDe(store).id, { mirrored: true }));
  const pay = exportPayload(store.getState());
  assert.ok(pay.clips.some(c => c.mirrored), 'a cena de dentro sai espelhada');
});

test('velocidade do payload é a EFETIVA (bloco multiplica a da cena)', () => {
  const store = comComposto();
  const stub = stubDe(store);
  store.dispatch(act.setSpeed('clip', stub.id, 2));      // bloco a 2x
  const pay = exportPayload(store.getState());
  const doComposto = pay.clips[0];
  assert.equal(doComposto.speed, 2, 'a cena de dentro sai a 2x no arquivo');
});

test('preview e export enxergam a MESMA máscara (mesmo resolvedor)', () => {
  const store = comComposto();
  store.dispatch(act.setClipMask(stubDe(store).id, { shape: 'circle', w_pct: 0.4 }));
  const s = store.getState();
  // o que o preview usaria no instante 2s
  const doPreview = propriedadeDaCena(s, segmentAt(s, 2), 'mask');
  // o que o export manda pra mesma cena
  const doExport = exportPayload(s).clips[0].mask;
  assert.deepEqual(doPreview, doExport, 'tela e arquivo concordam');
});
