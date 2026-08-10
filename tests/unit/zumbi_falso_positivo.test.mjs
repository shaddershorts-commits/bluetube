// tests/unit/zumbi_falso_positivo.test.mjs — node --test
//
// CASO REAL 10/08/2026 — kevembeserra@gmail.com
// ---------------------------------------------------------------------------
// O cliente assinou o Full. Cinco segundos depois a assinatura dele estava
// cancelada e os R$ 29,99 estornados. Ninguém pediu isso: foi a blindagem
// anti-zumbi do nosso webhook.
//
// Linha do tempo do Stripe:
//   20:35:18  invoice.payment_succeeded   (billing_reason=subscription_create)
//   20:35:19  checkout.session.completed  ← é ESTE que faz o upgrade pra full
//   20:35:20  subscription.deleted        ← nosso código, via API
//   20:35:21  refund.created              ← nosso código, via API
//
// O Stripe não garante ordem entre eventos. Quando o payment_succeeded ganha a
// corrida, o banco ainda diz plan='free' — e a B2 lia isso como "está pagando
// sem ter acesso", que é a definição de zumbi. Só que zumbi é quem RENOVA
// nessa situação; primeira fatura é cliente novo.
//
// Estes testes travam a distinção. Se alguém remover a guarda, um cliente
// pagante vira estorno em 5 segundos de novo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WEBHOOK = readFileSync(new URL('../../api/webhook.js', import.meta.url), 'utf8');
const AUDIT = readFileSync(new URL('../../api/audit-stripe-zumbis.js', import.meta.url), 'utf8');

// O bloco da B2, isolado — as asserções abaixo falam só dele.
const B2 = WEBHOOK.slice(
  WEBHOOK.indexOf('── Fase B2 — Recovery anti-zumbi'),
  WEBHOOK.indexOf('[B2] Falha ao auto-corrigir'));

test('a B2 reconhece a primeira fatura pelo billing_reason', () => {
  assert.match(B2, /billing_reason === 'subscription_create'/,
    'é o sinal exato: primeira fatura de assinatura nova nunca é zumbi');
});

test('a B2 tem plano B se o billing_reason sumir (a API já mudou de campo antes)', () => {
  // O bug dahlia de julho foi exatamente campo trocado de lugar entre versões.
  // Confiar num campo só repetiria a lição não aprendida.
  assert.match(B2, /idadeSeg/, 'precisa medir a idade da assinatura como segundo critério');
  assert.match(B2, /idadeSeg < 600/, 'janela de 10min, igual à das outras camadas');
});

test('NENHUM cancel/refund da B2 roda sem passar pela guarda', () => {
  // Os dois ifs que agem (o is_manual e o de ação real) precisam do !assinaturaNova.
  const acoes = [...B2.matchAll(/if \(([^)]*plan === 'free'[^)]*)\)/g)].map((m) => m[1]);
  assert.ok(acoes.length >= 2, `esperava ao menos 2 ramos da B2, achei ${acoes.length}`);
  for (const cond of acoes) {
    assert.match(cond, /!assinaturaNova/,
      `ramo "${cond.trim().slice(0, 60)}…" age sem checar se a assinatura é nova`);
  }
});

test('assinatura nova com plan=free vira ALERTA, não estorno', () => {
  assert.match(B2, /Falso zumbi evitado/, 'você precisa ficar sabendo que a guarda atuou');
  const i = B2.indexOf('Falso zumbi evitado');
  const bloco = B2.slice(i - 400, i + 700);
  assert.ok(!/v1\/refunds/.test(bloco), 'o caminho do falso zumbi não pode chamar refund');
  assert.ok(!/method: 'DELETE'/.test(bloco), 'nem cancelar a assinatura');
});

test('o cron de auditoria também não refunda assinatura recém-criada', () => {
  // Ele chama refund-and-cancel SOZINHO, até 5 por rodada, a cada 4h — mesmo
  // engano ali custa dinheiro sem ninguém no volante.
  assert.match(AUDIT, /refund-and-cancel/, 'confirma que este cron move dinheiro');
  assert.match(AUDIT, /recemCriada/);
  assert.match(AUDIT, /idadeSubSeg < 1800/, 'janela de 30min pro upgrade pousar');
  const i = AUDIT.indexOf('const recemCriada');
  const bloco = AUDIT.slice(i, i + 700);
  assert.match(bloco, /if \(sub\.plan === 'free' && recemCriada/,
    'a guarda tem que vir ANTES de entrar na lista de zumbis');
});

test('a renovação de verdade continua sendo pega (a blindagem não virou enfeite)', () => {
  // Se a guarda fosse larga demais, o zumbi real — que renova com plan=free —
  // deixaria de ser detectado, e a proteção que nasceu de prejuízo real
  // morreria em silêncio.
  assert.match(B2, /ZUMBI PAGANTE/);
  assert.match(B2, /v1\/refunds/, 'o caminho de refund do zumbi real segue existindo');
  // subscription_cycle (renovação) NÃO pode ser tratada como assinatura nova
  assert.ok(!/subscription_cycle/.test(B2.split('assinaturaNova')[0] || ''),
    'renovação jamais pode entrar na guarda de assinatura nova');
});

test('a camada de tempo real mantém a janela que ela já tinha', () => {
  // Essa nunca teve o bug — o comentário dela explica por quê. Se alguém
  // "limpar" isso, o furo volta por outra porta.
  assert.match(WEBHOOK, /Checkout em andamento \(< 10min/,
    'a janela temporal da camada de tempo real é o que impede refund de checkout novo');
});
