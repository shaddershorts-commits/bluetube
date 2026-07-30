// tests/unit/cache_helper.test.mjs — node --test
//
// Trava a lição de 2026-07-30: o cache procurava UPSTASH_REDIS_URL enquanto a
// Vercel só tinha UPSTASH_REDIS_REST_URL. Nomes diferentes = cache desligado em
// silêncio = zero comando no Upstash = banco gratuito apagado por inatividade
// depois de 14 dias. Ninguém percebeu porque o fallback é silencioso por
// desenho — que é o certo pro usuário, e péssimo pra diagnóstico.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const ORIGINAL = { ...process.env };
const VARS = ['UPSTASH_REDIS_URL', 'UPSTASH_REDIS_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];

// cada teste precisa de módulo novo: o helper guarda a conexão em memória
function carregar() {
  const require = createRequire(import.meta.url);
  const p = require.resolve('../../api/_helpers/cache.js');
  delete require.cache[p];
  return require(p);
}

beforeEach(() => { for (const v of VARS) delete process.env[v]; });
afterEach(() => { process.env = { ...ORIGINAL }; });

test('funciona com os nomes REST_ (os que a Vercel realmente tem)', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://exemplo.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token-de-teste';
  const c = carregar();
  // se getRedis devolvesse null, cacheSet seria no-op e cacheGet daria null
  // sem nem tentar. Com config válida ele CONSTRÓI o cliente — a chamada falha
  // na rede (host falso), mas o caminho foi exercitado.
  assert.equal(typeof c.cacheGet, 'function');
  assert.equal(await c.cacheGet('qualquer'), null, 'host falso: erro vira null, não exceção');
});

test('funciona também com os nomes antigos (compatibilidade)', async () => {
  process.env.UPSTASH_REDIS_URL = 'https://exemplo.upstash.io';
  process.env.UPSTASH_REDIS_TOKEN = 'token-de-teste';
  const c = carregar();
  assert.equal(await c.cacheGet('qualquer'), null);
});

test('sem nenhuma variável, degrada em silêncio e NÃO explode', async () => {
  const c = carregar();
  assert.equal(await c.cacheGet('x'), null);
  await assert.doesNotReject(() => c.cacheSet('x', { a: 1 }, 60));
  await assert.doesNotReject(() => c.cacheDel('x'));
});

test('cacheGetOrSet devolve o valor real quando não há cache', async () => {
  const c = carregar();   // sem Redis configurado
  let chamou = 0;
  const v = await c.cacheGetOrSet('chave', async () => { chamou++; return { ok: 42 }; }, 60);
  assert.deepEqual(v, { ok: 42 }, 'sem Redis o resultado tem que passar direto');
  assert.equal(chamou, 1);
});

test('Redis fora do ar não derruba quem chama (o feed não pode quebrar)', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://host-que-nao-existe-123456.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
  const c = carregar();
  const v = await c.cacheGetOrSet('chave', async () => ({ vindo: 'do banco' }), 60);
  assert.deepEqual(v, { vindo: 'do banco' }, 'com Redis morto tem que cair pro fetch original');
});
