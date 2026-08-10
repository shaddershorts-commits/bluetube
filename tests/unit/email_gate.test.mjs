// tests/unit/email_gate.test.mjs — node --test
//
// 10/08/2026: o plano do Resend caiu pra 200 envios/dia e 3.000/mês. Um
// disparo do weekly-trends (que vai pra TODOS os ativos) queima a cota do dia
// e derruba junto o que não pode falhar — código de login, recibo, cobrança
// recusada, entrega do BlueScore.
//
// Estes testes garantem duas coisas opostas e igualmente importantes:
//   1. TODO job de marketing está barrado quando a chave está desligada;
//   2. NENHUM email transacional passou a depender desse interruptor.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const ORIGINAL_ENV = { ...process.env };

// Todo job de marketing conhecido. Se nascer um novo, ele tem que entrar aqui
// — e o teste de varredura lá embaixo avisa quando alguém esquece.
const JOBS_MARKETING = [
  'reactivation-emails', 'email-sequence', 'email-marketing', 'milestone-emails',
  'weekly-trends-email', 'blublu-emails', 'comunidade-emails', 'checkout-recovery',
];

// Estes mandam email porque a pessoa está ESPERANDO, ou porque é aviso pro
// dono. Nunca podem ser barrados.
//
// A conta que separa os dois grupos (medida em 10/08/2026):
//   • 465 contas free — é o público do marketing. UM disparo da sequência
//     estoura os 200/dia e come 15% da cota do mês.
//   • 39 assinantes Full+Master e 9 pessoas com o alerta diário da Virais
//     ligado. Volume que cabe folgado, e alerta diário é feature PAGA:
//     cortar seria tirar do assinante algo que ele comprou.
const TRANSACIONAIS = [
  'auth', 'webhook', 'bluescore', 'affiliate', 'affiliate-saques',
  'support-chat', 'delete-account', 'plan-expiry-sweep',
  'virais-canais',          // alerta diário 7:30 — feature paga, 9 destinatários
  'trial-expiry-warning',   // aviso de trial acabando — status da conta
  'pix-renewal-reminder',   // lembrete de renovação — dinheiro
  'pioneiros',              // qualificação e pagamento do programa
  'blublu-index',           // só alerta pro dono, 1 email
];

function resFalso() {
  const r = { _status: 0, _json: null };
  r.setHeader = () => {}; r.end = () => r;
  r.status = (s) => { r._status = s; return r; };
  r.json = (j) => { r._json = j; return r; };
  return r;
}

beforeEach(() => { delete process.env.EMAILS_MARKETING; });
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

test('sem a env, o padrão é DESLIGADO (o deploy já corta sozinho)', () => {
  const { marketingLiberado } = require('../../api/_helpers/emailGate.js');
  delete process.env.EMAILS_MARKETING;
  assert.equal(marketingLiberado(), false, 'padrão ligado dependeria de você lembrar de configurar');
  for (const v of ['off', 'false', '0', 'nao', '']) {
    process.env.EMAILS_MARKETING = v;
    assert.equal(marketingLiberado(), false, `"${v}" não pode ligar`);
  }
  for (const v of ['on', 'ON', 'true', '1', 'sim', ' ligado ']) {
    process.env.EMAILS_MARKETING = v;
    assert.equal(marketingLiberado(), true, `"${v}" deveria ligar`);
  }
});

test('todo job de marketing está barrado e NÃO chama a Resend', async () => {
  const fetchOriginal = globalThis.fetch;
  const chamadas = [];
  globalThis.fetch = async (url) => { chamadas.push(String(url)); return { ok: true, json: async () => ({}) }; };
  try {
    for (const job of JOBS_MARKETING) {
      const handler = require(`../../api/${job}.js`);
      const res = resFalso();
      await handler({ method: 'GET', headers: {}, query: {}, body: {} }, res);
      assert.equal(res._status, 200, `${job} devolveu ${res._status} — cron com erro vira alarme falso`);
      assert.equal(res._json?.pulado, true, `${job} NÃO foi barrado`);
      assert.equal(res._json?.enviados, 0);
    }
    assert.equal(chamadas.filter((u) => u.includes('resend.com')).length, 0,
      'algum job chamou a Resend mesmo com o marketing desligado');
  } finally { globalThis.fetch = fetchOriginal; }
});

test('email transacional NÃO passa pelo interruptor', () => {
  for (const nome of TRANSACIONAIS) {
    const fonte = readFileSync(new URL(`../../api/${nome}.js`, import.meta.url), 'utf8');
    assert.ok(!fonte.includes('barrarSeDesligado'),
      `${nome}.js ficou preso ao corte de marketing — cortar login/recibo/laudo é pior que estourar a cota`);
  }
});

test('varredura: nenhum job de email ficou de fora do corte', () => {
  // Pega quem manda email E é cron (está no vercel.json ou no GitHub Actions).
  const vercel = readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8');
  const workflows = readdirSync(new URL('../../.github/workflows/', import.meta.url))
    .map((f) => readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), 'utf8')).join('\n');
  const agendados = new Set();
  for (const m of (vercel + workflows).matchAll(/\/api\/([a-z0-9-]+)/g)) agendados.add(m[1]);

  const conhecidos = new Set([...JOBS_MARKETING, ...TRANSACIONAIS]);
  const suspeitos = [];
  for (const job of agendados) {
    if (conhecidos.has(job)) continue;
    let fonte;
    try { fonte = readFileSync(new URL(`../../api/${job}.js`, import.meta.url), 'utf8'); } catch (e) { continue; }
    if (!fonte.includes('resend.com/emails')) continue;
    // Alerta operacional pro dono não conta: é 1 email, não campanha.
    if (/ADMIN_EMAIL|ADMIN_ALERT/.test(fonte)) continue;
    suspeitos.push(job);
  }
  assert.deepEqual(suspeitos, [],
    `cron de email fora do corte: ${suspeitos.join(', ')} — decidir se é marketing (gate) ou transacional (lista)`);
});

test('o helper explica como religar (senão vira mistério em duas semanas)', () => {
  const fonte = readFileSync(new URL('../../api/_helpers/emailGate.js', import.meta.url), 'utf8');
  assert.match(fonte, /EMAILS_MARKETING=on/);
  assert.match(fonte, /deploy novo/, 'env nova só vale em deploy novo — já nos mordeu antes');
});
