// tests/unit/cupom_checkout.test.mjs — node --test
//
// Cupom pré-aplicado via link (?cupom=Blue50) mexe com o PREÇO que cliente
// real paga. O que este arquivo trava:
//  1. Cupom válido → checkout Stripe abre com o desconto JÁ aplicado
//     (discounts[0][promotion_code]) e NUNCA junto de allow_promotion_codes
//     (Stripe rejeita os dois ao mesmo tempo — quebraria TODO checkout)
//  2. Cupom inválido/Stripe fora → checkout NORMAL com campo de código aberto
//     (degrada, nunca bloqueia venda)
//  3. Oferta de ativação NÃO empilha com cupom de link
//  4. Pix anual: desconto só depois de validar na Stripe; valor com desconto
//     vai pro Asaas e cupom/desconto viajam no externalReference até o webhook
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.ASAAS_API_KEY = 'chave_teste_sandbox'; // asaas.js lê no load do módulo
const checkoutMod = require('../../api/create-checkout.js');
const checkoutHandler = checkoutMod.default || checkoutMod;
const pixHandler = require('../../api/asaas-create-pix.js');

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };

function resFalso() {
  const r = { _status: 200, _json: null };
  r.setHeader = () => {}; r.end = () => r;
  r.status = (s) => { r._status = s; return r; };
  r.json = (j) => { r._json = j; return r; };
  return r;
}

const resposta = (obj, ok = true) => ({
  ok,
  status: ok ? 200 : 400,
  json: async () => obj,
  text: async () => JSON.stringify(obj), // helper asaas usa .text()
});

// Dublê de fetch pros DOIS fluxos (cartão Stripe e Pix Asaas)
function dublar({ promo = null, promoQuebra = false, sessaoRecusaPromo = false, capturas }) {
  return async (url, opts) => {
    const u = String(url);
    const met = opts?.method || 'GET';
    if (u.includes('/auth/v1/user')) return resposta({ email: 'cliente@teste.com' });
    if (u.includes('api.stripe.com/v1/promotion_codes')) {
      capturas.lookups = (capturas.lookups || 0) + 1;
      capturas.lookupUrl = u;
      capturas.lookupHeaders = opts?.headers || {};
      if (promoQuebra) throw new Error('stripe fora do ar');
      return resposta({ data: promo ? [promo] : [] });
    }
    if (u.includes('api.stripe.com/v1/customers')) return resposta({ data: [] });
    if (u.includes('api.stripe.com/v1/checkout/sessions')) {
      capturas.sessionBody = new URLSearchParams(String(opts.body));
      if (sessaoRecusaPromo && capturas.sessionBody.get('discounts[0][promotion_code]')) {
        return resposta({ error: { message: 'This promotion code cannot be applied.' } }, false);
      }
      return resposta({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/cs_test_1' });
    }
    if (u.includes('asaas.com') && u.includes('/customers') && met === 'GET') {
      return resposta({ data: [{ id: 'cus_as1', cpfCnpj: '12345678901' }] });
    }
    if (u.includes('asaas.com') && u.includes('/pixQrCode')) {
      return resposta({ encodedImage: 'img64', payload: 'copiaecola', expirationDate: '2026-08-03' });
    }
    if (u.includes('asaas.com') && u.includes('/payments') && met === 'POST') {
      capturas.pixBody = JSON.parse(opts.body);
      return resposta({ id: 'pay_1', value: capturas.pixBody.value });
    }
    return resposta({});
  };
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'sk';
  process.env.SUPABASE_ANON_KEY = 'ak';
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
});
afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; process.env = { ...ORIGINAL_ENV }; });

const PROMO_50 = { id: 'promo_test123', code: 'Blue50', coupon: { percent_off: 50, duration: 'forever' } };

async function checkout(body, cen = {}) {
  const capturas = {};
  globalThis.fetch = dublar({ ...cen, capturas });
  const res = resFalso();
  await checkoutHandler({ method: 'POST', headers: {}, body }, res);
  return { res, capturas };
}

test('cupom válido → sessão nasce com desconto aplicado, sem allow_promotion_codes', async () => {
  const { res, capturas } = await checkout(
    { plan: 'master', billing: 'monthly', currency: 'brl', cupom: 'Blue50' },
    { promo: PROMO_50 }
  );
  assert.equal(res._status, 200);
  const b = capturas.sessionBody;
  assert.equal(b.get('discounts[0][promotion_code]'), 'promo_test123');
  assert.equal(b.get('metadata[cupom]'), 'Blue50');
  assert.equal(b.get('allow_promotion_codes'), null, 'Stripe rejeita discounts + allow_promotion_codes juntos');
  assert.match(capturas.lookupUrl, /code=Blue50/);
  assert.equal(capturas.lookupHeaders['Stripe-Version'], '2024-06-20', 'dahlia muda o shape sem a versão pinada');
});

test('cupom inválido → checkout normal com campo de código aberto (nunca bloqueia)', async () => {
  const { res, capturas } = await checkout(
    { plan: 'full', billing: 'monthly', currency: 'brl', cupom: 'NaoExiste' },
    { promo: null }
  );
  assert.equal(res._status, 200);
  assert.equal(capturas.sessionBody.get('allow_promotion_codes'), 'true');
  assert.equal(capturas.sessionBody.get('discounts[0][promotion_code]'), null);
});

test('Stripe fora do ar no lookup → checkout segue sem desconto (fail-soft)', async () => {
  const { res, capturas } = await checkout(
    { plan: 'master', billing: 'annual', currency: 'brl', cupom: 'Blue50' },
    { promoQuebra: true }
  );
  assert.equal(res._status, 200);
  assert.equal(capturas.sessionBody.get('allow_promotion_codes'), 'true');
});

test('sem cupom → comportamento antigo intacto (allow_promotion_codes)', async () => {
  const { res, capturas } = await checkout({ plan: 'full', billing: 'monthly', currency: 'brl' });
  assert.equal(res._status, 200);
  assert.equal(capturas.sessionBody.get('allow_promotion_codes'), 'true');
});

test('cupom só-espaço → NEM consulta a Stripe (lista vazia devolveria promo aleatório)', async () => {
  const { res, capturas } = await checkout(
    { plan: 'master', billing: 'monthly', currency: 'brl', cupom: '  ' },
    { promo: PROMO_50 }
  );
  assert.equal(res._status, 200);
  assert.equal(capturas.lookups || 0, 0, 'lookup com code vazio lista TODOS os promos');
  assert.equal(capturas.sessionBody.get('allow_promotion_codes'), 'true');
});

test('Stripe recusa o promo na sessão (restrição) → refaz sem desconto, venda não morre', async () => {
  const { res, capturas } = await checkout(
    { plan: 'master', billing: 'monthly', currency: 'brl', cupom: 'Blue50' },
    { promo: PROMO_50, sessaoRecusaPromo: true }
  );
  assert.equal(res._status, 200, 'promo restrito não pode matar o checkout');
  assert.equal(capturas.sessionBody.get('discounts[0][promotion_code]'), null);
  assert.equal(capturas.sessionBody.get('allow_promotion_codes'), 'true');
});

async function pix(body, cen = {}) {
  const capturas = {};
  globalThis.fetch = dublar({ ...cen, capturas });
  const res = resFalso();
  await pixHandler({ method: 'POST', headers: {}, body }, res);
  return { res, capturas };
}

const PIX_BASE = { plan: 'master', token: 'tok', cpfCnpj: '123.456.789-01' };

test('Pix anual com cupom 50% → Asaas recebe metade e webhook recebe o cupom', async () => {
  const { res, capturas } = await pix({ ...PIX_BASE, cupom: 'Blue50' }, { promo: PROMO_50 });
  assert.equal(res._status, 200);
  assert.equal(capturas.pixBody.value, 404.94, 'master anual 809,88 → 404,94 com 50%');
  const meta = JSON.parse(capturas.pixBody.externalReference);
  assert.equal(meta.cupom, 'Blue50');
  assert.equal(meta.desconto, 50);
  assert.equal(meta.desconto_valor, 404.94, 'coupon_discount no subscribers guarda VALOR em R$');
  assert.equal(meta.kind, 'pix_annual');
  assert.equal(res._json.valor_original, 809.88);
  assert.equal(res._json.cupom_aplicado, 'Blue50');
  assert.equal(res._json.desconto_pct, 50);
});

test('Pix com coupon once/repeating → valor CHEIO (descontaria os 13 meses inteiros)', async () => {
  const { res, capturas } = await pix({ ...PIX_BASE, cupom: 'Ativa50' },
    { promo: { id: 'promo_x', code: 'Ativa50', coupon: { percent_off: 50, duration: 'repeating' } } });
  assert.equal(res._status, 200);
  assert.equal(capturas.pixBody.value, 809.88);
  assert.equal(res._json.cupom_aplicado, null);
});

test('Pix com cupom 100% → valor cheio (piso R$5 do Asaas; nunca 500)', async () => {
  const { res, capturas } = await pix({ ...PIX_BASE, cupom: 'Gratis100' },
    { promo: { id: 'promo_y', code: 'Gratis100', coupon: { percent_off: 100, duration: 'forever' } } });
  assert.equal(res._status, 200);
  assert.equal(capturas.pixBody.value, 809.88);
  assert.equal(res._json.cupom_aplicado, null);
});

test('Pix com cupom inválido → valor CHEIO, nada de desconto às cegas', async () => {
  const { res, capturas } = await pix({ ...PIX_BASE, plan: 'full', cupom: 'NaoExiste' }, { promo: null });
  assert.equal(res._status, 200);
  assert.equal(capturas.pixBody.value, 269.88);
  const meta = JSON.parse(capturas.pixBody.externalReference);
  assert.equal(meta.cupom, null);
  assert.equal(meta.desconto, 0);
  assert.equal(res._json.cupom_aplicado, null);
});

test('Pix com Stripe fora do ar → valor cheio (validação indisponível ≠ desconto grátis)', async () => {
  const { res, capturas } = await pix({ ...PIX_BASE, cupom: 'Blue50' }, { promoQuebra: true });
  assert.equal(res._status, 200);
  assert.equal(capturas.pixBody.value, 809.88);
});

test('Pix sem cupom → fluxo antigo intacto', async () => {
  const { res, capturas } = await pix(PIX_BASE);
  assert.equal(res._status, 200);
  assert.equal(capturas.pixBody.value, 809.88);
  const meta = JSON.parse(capturas.pixBody.externalReference);
  assert.equal(meta.cupom, null);
});
