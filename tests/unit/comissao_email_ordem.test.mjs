// tests/unit/comissao_email_ordem.test.mjs — node --test
//
// CASO DANIEL/invectgames (04/08): o afiliado recebeu email prometendo
// R$ 27,00 e o saldo ficou R$ 13,50.
//
// O dinheiro no banco SEMPRE esteve certo. O que estava errado era a ORDEM:
//   1. auth.js cria a comissão sobre o PREÇO DE TABELA (89,99 × 30% = 27,00)
//   2. o webhook mandava o email lendo esse valor          ← aqui mentia
//   3. applyCommissionCorrection ajustava pro valor REAL pago (44,99 × 30%)
//
// Com o cupom de 50% dos afiliados a diferença virou o dobro, e ficou visível.
// Estes testes impedem o email de voltar pra antes da correção.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WEBHOOK = readFileSync(new URL('../../api/webhook.js', import.meta.url), 'utf8');

test('o email de comissão sai DEPOIS da correção do valor', () => {
  const correcao = WEBHOOK.indexOf('const result = await applyCommissionCorrection(');
  const email = WEBHOOK.indexOf('enviarEmailComissao(');
  assert.ok(correcao > 0, 'applyCommissionCorrection não encontrado');
  assert.ok(email > 0, 'enviarEmailComissao não encontrado');
  assert.ok(email > correcao,
    'o email voltou pra antes da correção — é exatamente o bug do caso Daniel');
});

test('o email usa o valor CORRIGIDO, não o que estava gravado antes', () => {
  const i = WEBHOOK.indexOf('enviarEmailComissao(');
  const bloco = WEBHOOK.slice(i - 700, i + 300);
  assert.match(bloco, /commission_amount: valorFinal/,
    'tem que mandar o valor corrigido');
  assert.match(bloco, /const valorFinal = result\.correctedAmount/,
    'valorFinal precisa vir do resultado da correção');
  assert.doesNotMatch(bloco, /commission_amount: comm\.commission_amount/,
    'ler a linha do banco de novo traz o valor pré-correção se o PATCH ainda não fechou');
});

test('não manda email quando a correção não completou', () => {
  const i = WEBHOOK.indexOf('enviarEmailComissao(');
  const bloco = WEBHOOK.slice(i - 700, i + 300);
  assert.match(bloco, /if \(result\.ok && !result\.flagged\)/,
    'correção na fila de retry = valor final desconhecido; email errado de novo é pior que email nenhum');
});

test('comissão flaggada como suspeita não dispara email', () => {
  const i = WEBHOOK.indexOf('enviarEmailComissao(');
  const bloco = WEBHOOK.slice(i - 700, i + 300);
  assert.match(bloco, /!result\.flagged/,
    'auto-indicação flaggada precisa de revisão antes de avisar o afiliado');
});

test('só existe UM ponto de envio do email de comissão', () => {
  const ocorrencias = (WEBHOOK.match(/enviarEmailComissao\(/g) || []).length;
  assert.equal(ocorrencias, 1,
    `${ocorrencias} pontos de envio — dois caminhos = afiliado recebe dois valores diferentes`);
});

test('a correção continua calculando sobre o valor REALMENTE pago', () => {
  const i = WEBHOOK.indexOf('async function applyCommissionCorrection');
  const bloco = WEBHOOK.slice(i, i + 400);
  assert.match(bloco, /const correctedAmount = parseFloat\(\(paidAmount \* rate\)/,
    'a base tem que ser paidAmount (com cupom), nunca o preço de tabela');
});

test('a correção grava trilha de auditoria', () => {
  const i = WEBHOOK.indexOf('async function applyCommissionCorrection');
  const bloco = WEBHOOK.slice(i, i + 2500);
  assert.match(bloco, /commission_history/, 'sem histórico não dá pra auditar mudança de valor');
  assert.match(bloco, /prev_amount: prev/, 'precisa registrar o valor anterior');
  assert.match(bloco, /coupon_applied/, 'e se houve cupom, que é a causa da diferença');
});
