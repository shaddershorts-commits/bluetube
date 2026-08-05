// tests/unit/checkout_recovery_dedupe.test.mjs — node --test
//
// CASO REAL (04/08): uma pessoa recebeu 4 emails idênticos "Você esqueceu
// algo?" no mesmo segundo. Ela clicou em assinar 4 vezes em 4 minutos (duas
// com 1 SEGUNDO de diferença — duplo-clique), o Stripe criou uma sessão por
// clique, e a trava contra repetição era por SESSÃO: cada linha checava a
// própria coluna e disparava seu próprio email.
//
// Enquanto todo mundo abandonava o checkout uma vez só, a trava bastava.
// Uma pessoa hesitante já vira spam — e as etapas de 24h e 72h repetiriam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FONTE = readFileSync(new URL('../../api/checkout-recovery.js', import.meta.url), 'utf8');
const ENVIO = FONTE.slice(FONTE.indexOf('async function sendBatch'));

test('as linhas são agrupadas por email antes de enviar', () => {
  assert.match(ENVIO, /const porEmail = new Map\(\)/,
    'sem agrupar por pessoa, cada sessão vira um email');
  assert.match(ENVIO, /String\(r\.email \|\| ''\)\.toLowerCase\(\)/,
    'a chave precisa ser normalizada — Email@x e email@x são a mesma pessoa');
});

test('cada pessoa recebe UM email por etapa, não um por sessão', () => {
  // rows (o que é iterado no envio) tem que sair do agrupamento, não da query
  const iter = ENVIO.slice(ENVIO.indexOf('for (const row of rows)'));
  assert.ok(iter.length > 0, 'laço de envio não encontrado');
  assert.match(ENVIO, /const rows = \[\];[\s\S]{0,400}rows\.push\(principal\)/,
    'o laço tem que percorrer os representantes, um por email');
});

test('o representante é a sessão MAIS RECENTE', () => {
  assert.match(ENVIO, /grupo\.sort\(\(a, b\) => new Date\(b\.session_created_at\) - new Date\(a\.session_created_at\)\)/,
    'a sessão mais nova tem os dados mais atuais de plano e valor');
  assert.match(ENVIO, /const principal = grupo\[0\]/);
});

test('ao enviar, marca TODAS as linhas da pessoa (não só a que gerou o email)', () => {
  assert.match(ENVIO, /principal\._irmas = grupo\.map\(\(g\) => g\.id\)/,
    'precisa guardar os ids irmãos');
  assert.match(ENVIO, /checkout_recovery\?id=in\.\(\$\{ids\.join\(','\)\}\)/,
    'o PATCH tem que atingir o grupo inteiro — senão as irmãs disparam na etapa seguinte');
  assert.match(ENVIO, /row\._irmas && row\._irmas\.length \? row\._irmas : \[row\.id\]/,
    'linha sem irmãs continua funcionando como antes');
});

test('a trava por etapa continua existindo (não removi a antiga)', () => {
  assert.match(ENVIO, /\$\{config\.column\}=is\.null/,
    'a query ainda tem que excluir quem já recebeu esta etapa');
});

test('os filtros de quem NÃO deve receber seguem intactos', () => {
  assert.match(ENVIO, /unsubSet\.has\(row\.email\)/, 'descadastrado não pode receber');
  assert.match(ENVIO, /paidSet\.has\(row\.email\)/, 'quem já virou pagante não pode receber cobrança de carrinho');
});

test('o colapso de duplicatas fica visível no log', () => {
  assert.match(ENVIO, /colapsada\(s\)/,
    'sem log, a deduplicação some e ninguém sabe que existiu');
});
