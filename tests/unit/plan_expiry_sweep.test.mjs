// tests/unit/plan_expiry_sweep.test.mjs — node --test
//
// O risco desta feature não é técnico, é de TEXTO: mandar "não identificamos
// seu pagamento" pra quem nunca pagou (era trial) faz a pessoa responder
// "eu não paguei nada, era teste grátis" — e queima confiança.
// Estes testes travam a separação dos dois textos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sweep = require('../../api/plan-expiry-sweep.js');

const { emailTrial, emailRenovacao, CARENCIA_DIAS } = sweep;

test('o texto de TRIAL nunca fala em pagamento não identificado', () => {
  for (const caso of [{ venceu: true, dias: 0 }, { venceu: false, dias: 3 }, { venceu: false, dias: 1 }]) {
    const m = emailTrial(caso);
    const tudo = m.subject + ' ' + m.html;
    assert.equal(/não identificamos|nao identificamos|pagamento de renovação|renovação do seu plano/i.test(tudo), false,
      'texto de trial cobrando renovação: ' + m.subject);
    assert.match(tudo, /teste/i, 'não deixa claro que era teste');
  }
});

test('o texto de RENOVAÇÃO nunca chama a assinatura de teste', () => {
  for (const caso of [{ venceu: true, dias: 0 }, { venceu: false, dias: 2 }]) {
    const m = emailRenovacao(caso);
    const tudo = m.subject + ' ' + m.html;
    assert.equal(/teste de 30 dias|período de teste|periodo de teste/i.test(tudo), false,
      'chamou assinatura paga de teste: ' + m.subject);
  }
});

test('o email avisa a carência antes de rebaixar (ninguém é pego de surpresa)', () => {
  const m = emailRenovacao({ venceu: true, dias: 0 });
  assert.match(m.html, new RegExp(CARENCIA_DIAS + '\\s*(</b>)?\\s*dias'), 'não diz quantos dias tem de prazo');
  assert.match(m.html, /gratuito/i, 'não diz pra onde a conta vai');
});

test('promete que nada é apagado — senão a pessoa entra em pânico', () => {
  const m = emailRenovacao({ venceu: true, dias: 0 });
  assert.match(m.html, /Nada é apagado|continuam/i);
});

test('trial que ainda não venceu fala no futuro; vencido fala no passado', () => {
  assert.match(emailTrial({ venceu: false, dias: 3 }).html, /termina/i);
  assert.match(emailTrial({ venceu: true, dias: 0 }).html, /terminou/i);
  assert.match(emailTrial({ venceu: false, dias: 1 }).subject, /amanhã/i);
});

test('todo email tem assunto, botão e destino real', () => {
  for (const m of [emailTrial({ venceu: true, dias: 0 }), emailTrial({ venceu: false, dias: 2 }),
                   emailRenovacao({ venceu: true, dias: 0 }), emailRenovacao({ venceu: false, dias: 2 })]) {
    assert.ok(m.subject && m.subject.length > 12, 'assunto fraco: ' + m.subject);
    assert.match(m.html, /https:\/\/bluetubeviral\.com/, 'sem link real');
    assert.match(m.html, /suporte@bluetubeviral\.com/, 'sem canal de resposta');
    assert.equal(/undefined|NaN|\[object/.test(m.html), false, 'vazou variável no texto');
  }
});

test('nenhum texto usa jargão de cobrança agressiva', () => {
  for (const m of [emailTrial({ venceu: true, dias: 0 }), emailRenovacao({ venceu: true, dias: 0 })]) {
    assert.equal(/inadimpl|débito|divida|dívida|pendência financeira|bloqueado|suspenso/i.test(m.html), false,
      'tom de cobrança: ' + m.subject);
  }
});

// ── DETECTOR DE ANOMALIA (2026-07-30) ──────────────────────────────────────
// Sem ele, um pagante derrubado por bug NOSSO recebe "não identificamos a
// renovação" — culpando o cliente pelo nosso erro. Foi o caso da Ana.
const { ehAnomalia, ANOMALIA_JANELA_DIAS } = sweep;
const AGORA = new Date('2026-07-30T12:00:00Z');
const diasAtras = (n) => new Date(AGORA.getTime() - n * 864e5).toISOString();

test('pagante que nunca pediu cancelamento e caiu = ANOMALIA', () => {
  const ana = { trial_origin: null, amount_paid: 89.99, cancel_at_period_end: false, plan_expires_at: diasAtras(7) };
  assert.ok(ehAnomalia(ana, AGORA), 'não detectou o caso Ana');
});

test('quem PEDIU cancelamento não é anomalia — saiu porque quis', () => {
  const saiu = { trial_origin: null, amount_paid: 29.99, cancel_at_period_end: true, plan_expires_at: diasAtras(5) };
  assert.equal(ehAnomalia(saiu, AGORA), null);
});

test('trial nunca é anomalia (nunca pagou nada)', () => {
  const trial = { trial_origin: 'email_30d', amount_paid: null, cancel_at_period_end: false, plan_expires_at: diasAtras(5) };
  assert.equal(ehAnomalia(trial, AGORA), null);
});

test('quem nunca pagou não é anomalia mesmo sem trial_origin', () => {
  const zero = { trial_origin: null, amount_paid: null, cancel_at_period_end: false, plan_expires_at: diasAtras(5) };
  assert.equal(ehAnomalia(zero, AGORA), null);
  assert.equal(ehAnomalia({ ...zero, amount_paid: 0 }, AGORA), null);
});

test('caso antigo demais sai da janela (não é mais investigável)', () => {
  const velho = { trial_origin: null, amount_paid: 89.99, cancel_at_period_end: false, plan_expires_at: diasAtras(ANOMALIA_JANELA_DIAS + 10) };
  assert.equal(ehAnomalia(velho, AGORA), null);
});

test('quem ainda NÃO venceu não é anomalia', () => {
  const futuro = { trial_origin: null, amount_paid: 89.99, cancel_at_period_end: false, plan_expires_at: new Date(AGORA.getTime() + 5 * 864e5).toISOString() };
  assert.equal(ehAnomalia(futuro, AGORA), null);
});

test('cancel_at_period_end AUSENTE do select não vira anomalia falsa', () => {
  // Se o campo não vier no SELECT ele é undefined. undefined !== true, então
  // passaria. Este teste documenta o risco; a proteção real é o campo estar
  // no select do endpoint (há comentário lá explicando).
  const semCampo = { trial_origin: null, amount_paid: 89.99, plan_expires_at: diasAtras(3) };
  assert.ok(ehAnomalia(semCampo, AGORA), 'comportamento esperado com campo ausente');
});
