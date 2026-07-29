// tests/unit/idioma.test.mjs — legenda em qualquer idioma (node --test)
//
// O Whisper sempre devolveu o idioma detectado e o editor ignorava. O
// agrupamento de palavras em frases era cravado em alfabeto latino: juntava
// tudo com espaco, cortava em 42 caracteres e so entendia ".!?" como fim de
// frase. Estes testes travam as regras por escrita.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizarIdioma, separadorDePalavras, temCaixa, ehRTL, textoEhRTL,
  podeMudarCaixa, limiteDeCaracteres, fimDeFrase, capitalizarFrase, agruparFrases,
} from '../../public/editor-v1/core/idioma.js';

const palavras = (arr) => arr.map(([word, start, end]) => ({ word, start, end }));

test('normaliza o que o Whisper manda (nome em ingles OU codigo)', () => {
  assert.equal(normalizarIdioma('portuguese'), 'pt');
  assert.equal(normalizarIdioma('Japanese'), 'ja');
  assert.equal(normalizarIdioma('pt-BR'), 'pt');
  assert.equal(normalizarIdioma('en'), 'en');
  assert.equal(normalizarIdioma(null), '');
});

test('japones/chines/tailandes NAO levam espaco entre palavras', () => {
  assert.equal(separadorDePalavras('ja'), '');
  assert.equal(separadorDePalavras('zh'), '');
  assert.equal(separadorDePalavras('th'), '');
  assert.equal(separadorDePalavras('pt'), ' ');
  assert.equal(separadorDePalavras('en'), ' ');
});

test('a legenda japonesa sai SEM espacos picotando as palavras', () => {
  const f = agruparFrases(palavras([['今日', 0, .4], ['は', .4, .6], ['いい', .6, 1], ['天気', 1, 1.4]]), 'japanese');
  assert.equal(f.length, 1);
  assert.equal(f[0].text, '今日はいい天気', 'juntou sem espaco');
});

test('a legenda em portugues continua com espaco', () => {
  const f = agruparFrases(palavras([['bom', 0, .3], ['dia', .3, .6]]), 'portuguese');
  assert.equal(f[0].text, 'Bom dia');
});

test('ideograma corta MUITO antes (ocupa o dobro da largura)', () => {
  assert.equal(limiteDeCaracteres('ja'), 20);
  assert.equal(limiteDeCaracteres('zh'), 20);
  assert.equal(limiteDeCaracteres('th'), 28);
  assert.equal(limiteDeCaracteres('pt'), 42);
});

test('nenhuma frase passa do limite do idioma', () => {
  const ws = palavras(Array.from({ length: 40 }, (_, i) => ['字', i * 0.2, i * 0.2 + 0.15]));
  for (const f of agruparFrases(ws, 'zh')) {
    assert.ok(f.text.length <= limiteDeCaracteres('zh'), `frase longa demais: ${f.text}`);
  }
});

test('fim de frase reconhece a pontuacao de cada escrita', () => {
  assert.ok(fimDeFrase('ja').test('です。'), 'ponto final japones');
  assert.ok(fimDeFrase('zh').test('好！'), 'exclamacao de largura dupla');
  assert.ok(fimDeFrase('ar').test('نعم؟'), 'interrogacao arabe');
  assert.ok(fimDeFrase('hi').test('नमस्ते।'), 'danda do hindi');
  assert.ok(fimDeFrase('pt').test('sim.'), 'ponto latino');
  assert.ok(!fimDeFrase('pt').test('sim'), 'sem pontuacao nao termina');
});

test('a frase quebra no ponto final japones', () => {
  const f = agruparFrases(palavras([['です。', 0, .5], ['次', .6, .9]]), 'ja');
  assert.equal(f.length, 2, 'o "。" fecha a frase');
});

test('pausa longa quebra a frase em qualquer idioma', () => {
  const f = agruparFrases(palavras([['a', 0, .2], ['b', 2, 2.2]]), 'pt');
  assert.equal(f.length, 2);
});

// ── caixa ──

test('capitaliza so onde a escrita TEM caixa', () => {
  assert.equal(capitalizarFrase('bom dia', 'pt'), 'Bom dia');
  assert.equal(capitalizarFrase('こんにちは', 'ja'), 'こんにちは', 'japones fica intacto');
  assert.equal(capitalizarFrase('مرحبا', 'ar'), 'مرحبا', 'arabe fica intacto');
});

test('capitalizar NAO mexe no resto da frase (sigla, nome proprio)', () => {
  assert.equal(capitalizarFrase('o BlueTube é bom', 'pt'), 'O BlueTube é bom');
  assert.equal(capitalizarFrase('a NASA respondeu', 'pt'), 'A NASA respondeu');
});

test('grafia de marca fica intacta (iPhone nao vira IPhone)', () => {
  assert.equal(capitalizarFrase('iPhone novo', 'en'), 'iPhone novo');
  assert.equal(capitalizarFrase('eBay caiu', 'en'), 'eBay caiu');
});

test('temCaixa por idioma', () => {
  assert.equal(temCaixa('pt'), true);
  assert.equal(temCaixa('ja'), false);
  assert.equal(temCaixa('ar'), false);
});

test('podeMudarCaixa detecta pelo TEXTO (serve pro que o user digita)', () => {
  assert.equal(podeMudarCaixa('bom dia'), true);
  assert.equal(podeMudarCaixa('今日は'), false);
  assert.equal(podeMudarCaixa('مرحبا'), false);
  assert.equal(podeMudarCaixa('123 !!'), false, 'so numero e pontuacao nao tem caixa');
});

// ── direcao ──

test('arabe e hebraico correm da direita pra esquerda', () => {
  assert.equal(ehRTL('ar'), true);
  assert.equal(ehRTL('he'), true);
  assert.equal(ehRTL('pt'), false);
  assert.equal(textoEhRTL('مرحبا بالعالم'), true);
  assert.equal(textoEhRTL('שלום'), true);
  assert.equal(textoEhRTL('bom dia'), false);
  assert.equal(textoEhRTL('今日は'), false, 'japones e horizontal da esquerda pra direita');
});

// ── duracao ──

test('frase curta demais ganha tempo minimo de leitura', () => {
  const f = agruparFrases(palavras([['oi', 0, 0.1]]), 'pt');
  assert.ok(f[0].end - f[0].start >= 0.7);
});

test('sem palavras, nao quebra nem inventa frase', () => {
  assert.deepEqual(agruparFrases([], 'pt'), []);
  assert.deepEqual(agruparFrases(null, 'pt'), []);
  assert.deepEqual(agruparFrases(palavras([['   ', 0, 1]]), 'pt'), [], 'palavra vazia e ignorada');
});

test('idioma desconhecido cai nas regras latinas (nao quebra)', () => {
  const f = agruparFrases(palavras([['aa', 0, .3], ['bb', .3, .6]]), 'klingon');
  assert.equal(f[0].text, 'Aa bb');
});
