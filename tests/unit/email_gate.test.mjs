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

// ═══ TETO DIÁRIO (14/08/2026) ════════════════════════════════════════════════
//
// O dono mandou religar o marketing com no máximo ~30 envios/dia, porque a cota
// do Resend precisa sobrar pro código de cadastro. O interruptor sozinho não
// resolve isso: ele é binário, e os 8 jobs não se conhecem — cada um
// respeitando "30 por dia" viraria 8 × 30 = 240 e derrubaria o OTP.
//
// Por isso o teto é UM SÓ, contado no banco. Estes testes travam o que não pode
// regredir: o teto ser compartilhado, a falha ser FECHADA, e todo laço de envio
// ter a trava dentro dele (e não só um corte de lista lá em cima, que qualquer
// refatoração futura desfaz sem perceber).

const GATE_FONTE = readFileSync(new URL('../../api/_helpers/emailGate.js', import.meta.url), 'utf8');

test('o teto padrão é 30/dia, como o dono pediu', () => {
  delete process.env.EMAILS_MARKETING_LIMITE_DIA;
  const gate = require('../../api/_helpers/emailGate.js');
  assert.equal(gate.limiteDoDia(), 30);
});

test('o teto é ajustável por env sem mexer em código', () => {
  process.env.EMAILS_MARKETING_LIMITE_DIA = '80';
  const gate = require('../../api/_helpers/emailGate.js');
  assert.equal(gate.limiteDoDia(), 80);
  delete process.env.EMAILS_MARKETING_LIMITE_DIA;
});

test('a reserva nunca passa do teto (senão sobra 0 pro marketing comum)', () => {
  process.env.EMAILS_MARKETING_LIMITE_DIA = '10';
  process.env.EMAILS_MARKETING_RESERVA_ALTA = '999';
  const gate = require('../../api/_helpers/emailGate.js');
  assert.equal(gate.reservaAlta(), 10);
  delete process.env.EMAILS_MARKETING_LIMITE_DIA;
  delete process.env.EMAILS_MARKETING_RESERVA_ALTA;
});

test('sem banco a cota é ZERO — falha fechada, nunca aberta', async () => {
  const su = process.env.SUPABASE_URL, sk = process.env.SUPABASE_SERVICE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;
  const gate = require('../../api/_helpers/emailGate.js');
  const r = await gate.reservarCota('teste', 5, 'normal');
  assert.equal(r.concedido, 0, 'sem saber quanto já foi gasto, o certo é não mandar nada');
  if (su) process.env.SUPABASE_URL = su;
  if (sk) process.env.SUPABASE_SERVICE_KEY = sk;
});

test('a carteira desiste depois do primeiro "não" (não martela o banco)', async () => {
  const su = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  const gate = require('../../api/_helpers/emailGate.js');
  const cota = gate.abrirCota('teste');
  assert.equal(await cota.pegarUm(), false);
  assert.equal(await cota.pegarUm(), false);
  assert.equal(cota.esgotou(), true);
  assert.equal(cota.gastos(), 0);
  if (su) process.env.SUPABASE_URL = su;
});

test('o incremento é compare-and-swap (dois crons no mesmo minuto não se atropelam)', () => {
  assert.match(GATE_FONTE, /enviados=eq\.\$\{usado\}/,
    'sem filtrar pelo valor lido, dois jobs leem 0, gravam 1, e o teto vira decoração');
  assert.match(GATE_FONTE, /return=representation/,
    'preciso ver se o UPDATE casou alguma linha pra saber se perdi a corrida');
});

test('a linha do dia é criada sem ZERAR quem já gastou', () => {
  assert.match(GATE_FONTE, /ignore-duplicates/,
    'merge-duplicates faria INSERT…ON CONFLICT e sobrescreveria o contador com 0');
  assert.ok(!/resolution=merge-duplicates/.test(GATE_FONTE),
    'merge-duplicates no orçamento zera o contador de quem chegou primeiro');
});

test('TODO job de marketing tem a trava DENTRO do laço de envio', () => {
  for (const job of JOBS_MARKETING) {
    const fonte = readFileSync(new URL(`../../api/${job}.js`, import.meta.url), 'utf8');
    assert.match(fonte, /abrirCota\(/, `${job}: não abre carteira — manda sem teto`);
    assert.match(fonte, /await cota\.pegarUm\(\)/,
      `${job}: sem a trava no laço, o teto depende do job ter cortado a lista certo`);
  }
});

test('a trava vem ANTES do envio, não depois', () => {
  for (const job of JOBS_MARKETING) {
    const fonte = readFileSync(new URL(`../../api/${job}.js`, import.meta.url), 'utf8');
    const iTrava = fonte.indexOf('await cota.pegarUm()');
    const iEnvio = fonte.lastIndexOf('api.resend.com/emails');
    assert.ok(iTrava > 0 && iTrava < iEnvio,
      `${job}: a trava está depois do envio — o email já saiu quando a cota é conferida`);
  }
});

test('nenhum transacional passou a depender da cota', () => {
  for (const job of TRANSACIONAIS) {
    let fonte;
    try { fonte = readFileSync(new URL(`../../api/${job}.js`, import.meta.url), 'utf8'); } catch (e) { continue; }
    assert.ok(!/abrirCota|cota\.pegarUm/.test(fonte),
      `${job} é transacional: a pessoa está esperando, não pode morrer por cota de marketing`);
  }
});

test('existe o SQL da tabela, com RLS ligada', () => {
  const sql = readFileSync(new URL('../../sql/email_orcamento.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table if not exists email_orcamento/i);
  assert.match(sql, /dia\s+date\s+primary key/i, 'a PK em dia é o que garante uma linha por dia');
  assert.match(sql, /enable row level security/i, 'igual ao resto do banco depois do lockdown');
});
