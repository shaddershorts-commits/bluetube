// tests/unit/caption-styles.test.mjs — catalogo de modelos de legenda
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAT_LEGENDA, MODELOS_LEGENDA, modeloPorId, daCategoriaLegenda,
  buscarLegenda, estiloDaPalavra,
} from '../../public/editor-v1/core/caption-styles.js';
import { TEXT_FONTS, TEXT_SIZES } from '../../public/editor-v1/core/schema.js';
import { IDS_ANIM } from '../../public/editor-v1/core/text-anim.js';

test('todo modelo tem id unico', () => {
  const ids = MODELOS_LEGENDA.map(m => m.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('todo modelo usa fonte, tamanho e animacao que EXISTEM', () => {
  for (const m of MODELOS_LEGENDA) {
    assert.ok(TEXT_FONTS.includes(m.font), `fonte fora do catalogo: ${m.id} -> ${m.font}`);
    assert.ok(TEXT_SIZES.includes(m.size), `tamanho invalido: ${m.id} -> ${m.size}`);
    assert.ok(IDS_ANIM.includes(m.anim), `animacao inexistente: ${m.id} -> ${m.anim}`);
  }
});

test('toda categoria tem modelo (nenhuma aba vazia), menos favoritos', () => {
  for (const c of CAT_LEGENDA) {
    if (c.id === 'favoritos') continue;
    assert.ok(daCategoriaLegenda(c.id, new Set()).length > 0, `categoria vazia: ${c.id}`);
  }
});

test('todo modelo pertence a uma categoria conhecida', () => {
  const cats = new Set(CAT_LEGENDA.map(c => c.id));
  for (const m of MODELOS_LEGENDA) assert.ok(cats.has(m.cat), `categoria estranha: ${m.id} -> ${m.cat}`);
});

test('a galeria cresceu (o user pediu MAIS modelos)', () => {
  assert.ok(MODELOS_LEGENDA.length >= 18, 'sao ' + MODELOS_LEGENDA.length);
});

test('favoritos vem do que o usuario marcou', () => {
  assert.deepEqual(daCategoriaLegenda('favoritos', new Set()), []);
  const f = daCategoriaLegenda('favoritos', new Set(['neon', 'fogo']));
  assert.deepEqual(f.map(m => m.id).sort(), ['fogo', 'neon']);
});

test('busca acha sem acento e sem caixa', () => {
  assert.ok(buscarLegenda('KARAOKE').some(m => m.id === 'karaoke'));
  assert.ok(buscarLegenda('narracao').length > 0, 'acha pela categoria');
  assert.equal(buscarLegenda(''), null, 'busca vazia = mostra a categoria');
});

test('modelo inexistente cai no primeiro (nao quebra a geracao)', () => {
  assert.ok(modeloPorId('nao-existe'));
  assert.equal(modeloPorId('neon').id, 'neon');
});

// ── estilo por palavra ──

test('modo rotate gira a cor palavra a palavra', () => {
  const m = modeloPorId('neon');
  const c0 = estiloDaPalavra(m, 0).color;
  const c1 = estiloDaPalavra(m, 1).color;
  assert.notEqual(c0, c1);
  assert.equal(estiloDaPalavra(m, m.palette.length).color, c0, 'e volta ao inicio');
});

test('modo tarja leva a caixa colorida junto', () => {
  const e = estiloDaPalavra(modeloPorId('caixaVerde'), 0);
  assert.equal(e.box, '#22c55e');
});

test('modo cor unica nao leva tarja', () => {
  assert.equal(estiloDaPalavra(modeloPorId('classico'), 3).box, null);
});

test('o estilo CARREGA a animacao do modelo (coordenado com a narracao)', () => {
  assert.equal(estiloDaPalavra(modeloPorId('karaoke'), 0).anim, 'pop');
  assert.equal(estiloDaPalavra(modeloPorId('sussurro'), 0).anim, 'fade');
  assert.equal(estiloDaPalavra(modeloPorId('classico'), 0).anim, 'nenhuma');
});

test('o estilo so devolve campos que o texto aceita', () => {
  const permitidos = new Set(['font', 'size', 'color', 'box', 'anim']);
  for (const m of MODELOS_LEGENDA) {
    for (const k of Object.keys(estiloDaPalavra(m, 0))) {
      assert.ok(permitidos.has(k), `campo inesperado "${k}" em ${m.id}`);
    }
  }
});
