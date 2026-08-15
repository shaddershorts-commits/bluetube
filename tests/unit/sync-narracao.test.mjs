// tests/unit/sync-narracao.test.mjs — node --test
// O solver âncora+empurra do Criar com IA: fala em cima do acontecimento
// quando cabe, espera a anterior quando não cabe, e é HONESTO nos números
// (atraso máximo e estouro) em vez de cortar fala em silêncio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { montarLinhaDoTempo } from '../../public/editor-v1/core/sync-narracao.js';

test('quando as falas CABEM nas janelas, cada uma começa NA ÂNCORA', () => {
  const r = montarLinhaDoTempo({ duracaoVideo: 20, chunks: [
    { offset_ms: 0, dur: 3, texto: 'a' },
    { offset_ms: 5000, dur: 3, texto: 'b' },
    { offset_ms: 12000, dur: 4, texto: 'c' },
  ] });
  assert.deepEqual(r.itens.map((i) => i.start), [0, 5, 12]);
  assert.equal(r.atraso_max_s, 0);
  assert.equal(r.estouro_s, 0);
});

test('fala mais longa que a janela EMPURRA a seguinte (nunca sobrepõe, nunca corta)', () => {
  const r = montarLinhaDoTempo({ duracaoVideo: 20, chunks: [
    { offset_ms: 0, dur: 7, texto: 'a' },     // invade a janela da 2ª (âncora 5s)
    { offset_ms: 5000, dur: 3, texto: 'b' },
  ] });
  assert.equal(r.itens[1].start, 7.15, '2ª espera a 1ª acabar + folga');
  assert.equal(r.atraso_max_s, 2.15, 'o atraso é medido e reportado');
  // sem sobreposição:
  assert.ok(r.itens[1].start >= r.itens[0].start + r.itens[0].dur);
});

test('narração maior que o vídeo → estouro REPORTADO (quem chama decide avisar)', () => {
  const r = montarLinhaDoTempo({ duracaoVideo: 10, chunks: [
    { offset_ms: 0, dur: 6, texto: 'a' },
    { offset_ms: 6000, dur: 6, texto: 'b' },
  ] });
  assert.ok(r.estouro_s > 2, 'estourou: ' + r.estouro_s);
  assert.equal(r.itens.length, 2, 'nenhuma fala é descartada');
});

test('entradas vazias/duração zero não explodem', () => {
  const r0 = montarLinhaDoTempo({ duracaoVideo: 10, chunks: [] });
  assert.equal(r0.fim, 0);
  const r1 = montarLinhaDoTempo({ duracaoVideo: 10, chunks: [{ offset_ms: 0, dur: 0, texto: 'x' }] });
  assert.ok(r1.itens[0].dur > 0, 'duração mínima de segurança');
});
