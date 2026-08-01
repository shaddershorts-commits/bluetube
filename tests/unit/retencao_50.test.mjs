// tests/unit/retencao_50.test.mjs — node --test
//
// A oferta de retenção mexe com DINHEIRO na assinatura de cliente real.
// O que este arquivo trava:
//  1. Ninguém sem login/plano aplica nada
//  2. Idempotência: quem já tem 50% forever não reaplica
//  3. O desconto vai pra ASSINATURA EXISTENTE (coupon forever) e desliga
//     cancelamento agendado (a pessoa decidiu ficar)
//  4. Pix anual/manual (sem Stripe sub) recebe mensagem de suporte, não erro cru
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const handler = require('../../api/retencao-50.js');

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };

function resFalso() {
  const r = { _status: 200, _json: null };
  r.setHeader = () => {}; r.end = () => r;
  r.status = (s) => { r._status = s; return r; };
  r.json = (j) => { r._json = j; return r; };
  return r;
}

function dublar({ email = 'a@b.c', plano = 'master', subId = 'sub_123', status = 'active',
                  jaTem = false, cancelAgendado = false, chamadas }) {
  return async (url, opts) => {
    const u = String(url);
    const met = opts?.method || 'GET';
    if (chamadas) chamadas.push(met + ' ' + u.replace(/https:\/\/[^/]+/, ''));
    if (u.includes('/auth/v1/user')) {
      return { ok: !!email, json: async () => ({ email }) };
    }
    if (u.includes('/rest/v1/subscribers') && met === 'GET') {
      return { ok: true, json: async () => [{
        plan: plano, plan_expires_at: null, is_manual: false,
        stripe_subscription_id: subId, currency: 'brl',
      }] };
    }
    if (u.includes('api.stripe.com/v1/subscriptions/') && met === 'GET') {
      return { ok: true, json: async () => ({
        status, cancel_at_period_end: cancelAgendado, currency: 'brl',
        discount: jaTem ? { coupon: { percent_off: 50, duration: 'forever' } } : null,
        items: { data: [{ price: { unit_amount: 8999 } }] },
      }) };
    }
    if (u.includes('api.stripe.com/v1/coupons')) return { ok: true, json: async () => ({ id: 'retencao-50-forever' }) };
    if (u.includes('api.stripe.com/v1/subscriptions/') && met === 'POST') return { ok: true, json: async () => ({ ok: true }) };
    return { ok: true, json: async () => ({}) };
  };
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'sk';
  process.env.SUPABASE_ANON_KEY = 'ak';
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
});
afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; process.env = { ...ORIGINAL_ENV }; });

const chamar = async (cen, headers = { authorization: 'Bearer tok' }) => {
  globalThis.fetch = dublar(cen);
  const res = resFalso();
  await handler({ method: 'POST', headers, body: {} }, res);
  return res;
};

test('sem token → 401, nada tocado', async () => {
  const chamadas = [];
  const r = await chamar({ chamadas }, {});
  assert.equal(r._status, 401);
  assert.equal(chamadas.filter(c => c.includes('stripe')).length, 0, 'tocou na Stripe sem auth');
});

test('free não recebe a oferta (403)', async () => {
  const r = await chamar({ plano: 'free' });
  assert.equal(r._status, 403);
});

test('Pix anual/manual (sem sub Stripe) → mensagem de suporte, não erro cru', async () => {
  const r = await chamar({ subId: null });
  assert.equal(r._status, 400);
  assert.match(r._json.error, /suporte/i);
});

test('caminho feliz: aplica coupon forever NA assinatura e espelha no banco', async () => {
  const chamadas = [];
  const r = await chamar({ chamadas });
  assert.equal(r._status, 200);
  assert.equal(r._json.ok, true);
  assert.equal(r._json.valor_cheio, 89.99);
  assert.equal(r._json.valor_novo, 44.995);
  const aplicou = chamadas.some(c => /POST .*subscriptions\/sub_123/.test(c));
  assert.ok(aplicou, 'não aplicou na assinatura: ' + JSON.stringify(chamadas));
});

test('idempotente: já tem 50% forever → ok sem reaplicar', async () => {
  const chamadas = [];
  const r = await chamar({ jaTem: true, chamadas });
  assert.equal(r._status, 200);
  assert.equal(r._json.ja_tinha, true);
  const reaplicou = chamadas.some(c => /POST .*coupons|POST .*subscriptions/.test(c));
  assert.equal(reaplicou, false, 'reaplicou desconto que já existia');
});

test('cancelamento agendado é DESLIGADO ao aceitar (a pessoa ficou)', async () => {
  const chamadas = [];
  await chamar({ cancelAgendado: true, chamadas });
  const posts = chamadas.filter(c => /POST .*subscriptions\/sub_123/.test(c));
  assert.ok(posts.length >= 2, 'não desligou o cancel_at_period_end: ' + JSON.stringify(posts));
});

test('assinatura cancelada de vez não ganha desconto', async () => {
  const r = await chamar({ status: 'canceled' });
  assert.equal(r._status, 400);
});
