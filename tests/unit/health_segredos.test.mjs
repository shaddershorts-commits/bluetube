// tests/unit/health_segredos.test.mjs — node --test
//
// /api/health é PÚBLICO. Em 2026-07-30 o token do Upstash foi servido no JSON
// do health: a URL tinha sido salva com o token colado junto, o fetch falhou
// com "Failed to parse URL from <valor>" e a mensagem inteira virou resposta.
// Estes testes travam a rede de segurança que varre segredo de QUALQUER erro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const fonte = fs.readFileSync(new URL('../../api/health.js', import.meta.url), 'utf8');

test('existe o varredor de segredos e ele é aplicado na captura de erro', () => {
  assert.match(fonte, /function limparSegredos/, 'sumiu o varredor');
  assert.match(fonte, /limparSegredos\(e\.message\)/, 'o varredor não está sendo usado no catch');
});

test('a checagem do upstash valida a URL antes de usar', () => {
  assert.match(fonte, /new URL\('\/ping', url\.trim\(\)\)/, 'voltou a concatenar a URL na mão');
  assert.match(fonte, /URL mal formada/, 'sem mensagem segura pra URL inválida');
});

test('nenhum erro do upstash monta mensagem com a variável crua', () => {
  // o padrão perigoso: interpolar a env direto na string de erro
  const perigo = /throw new Error\([^)]*\$\{(url|token)\}/;
  assert.equal(perigo.test(fonte), false, 'tem erro interpolando url/token cru');
});

// ── comportamento do varredor, replicado ────────────────────────────────────
function limparSegredos(msg, env) {
  let s = String(msg || '');
  for (const [k, v] of Object.entries(env)) {
    if (!v || String(v).length < 12) continue;
    if (!/KEY|TOKEN|SECRET|PASSWORD|URL|DSN|WEBHOOK/i.test(k)) continue;
    if (s.includes(v)) s = s.split(v).join(`«${k} omitido»`);
  }
  return s.slice(0, 300);
}

test('o token real some da mensagem', () => {
  const env = { UPSTASH_REDIS_REST_TOKEN: 'gQAAAAAAAjLXAAIgcDE5NmU5ZDAwNDYw' };
  const saida = limparSegredos('Failed to parse URL from gQAAAAAAAjLXAAIgcDE5NmU5ZDAwNDYw/ping', env);
  assert.equal(saida.includes('gQAAAAAAAjLXAAIgcDE5NmU5ZDAwNDYw'), false, 'TOKEN VAZOU');
  assert.match(saida, /omitido/);
});

test('valor curto não é confundido com segredo (evita mensagem ilegível)', () => {
  const env = { API_KEY: 'abc' };
  assert.equal(limparSegredos('erro no abc qualquer', env), 'erro no abc qualquer');
});

test('variável que não é segredo passa batido', () => {
  const env = { NODE_ENV: 'production-mode-longo' };
  assert.match(limparSegredos('falhou em production-mode-longo', env), /production-mode-longo/);
});

test('mensagem gigante é cortada (não vira despejo de dado)', () => {
  assert.ok(limparSegredos('x'.repeat(5000), {}).length <= 300);
});
