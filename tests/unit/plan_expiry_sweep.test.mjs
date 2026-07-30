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
