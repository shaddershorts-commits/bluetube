// tests/unit/bluelens_gate_rotacao.test.mjs — node --test
//
// Duas mudanças de 2026-07-30 no BlueLens:
//  1. ROTAÇÃO de chaves YouTube — antes YT_KEY era fixo (KEY_5 || KEY_1); a
//     KEY_5 estava suspensa e a KEY_1 nem existia, então TODA análise saía
//     "metadata indisponível" enquanto a KEY_3 vivia ociosa.
//  2. PORTÃO Full/Master — a página sempre exigiu plano, mas a API aceitava
//     qualquer um com a URL, e cada chamada queima 1 busca da SerpAPI
//     (plano de 250/mês). Sem cota por usuário (decisão do user) — só fecha
//     a porta pra quem não é cliente.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const mod = require('../../api/bluelens-fingerprint.js');
const { listYtKeys, ytFetch } = mod;

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function limparChaves() {
  for (const k of Object.keys(process.env)) {
    if (/^(BLUELENS_YT_KEY|YOUTUBE_API_KEY)/.test(k)) delete process.env[k];
  }
}
beforeEach(limparChaves);
afterEach(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

// ── ROTAÇÃO ─────────────────────────────────────────────────────────────────

test('chaves dedicadas (BLUELENS_YT_KEY*) vêm ANTES do pool da Virais', () => {
  process.env.YOUTUBE_API_KEY_3 = 'pool-3';
  process.env.BLUELENS_YT_KEY_1 = 'dedicada-1';
  process.env.YOUTUBE_API_KEY_5 = 'pool-5';
  process.env.BLUELENS_YT_KEY_2 = 'dedicada-2';
  const keys = listYtKeys();
  assert.deepEqual(keys.slice(0, 2), ['dedicada-1', 'dedicada-2'],
    'o pedido do user foi sair do balde da Virais — dedicadas primeiro');
  assert.ok(keys.includes('pool-3') && keys.includes('pool-5'), 'pool continua como fallback');
});

test('sem nenhuma chave, listYtKeys devolve vazio e ytFetch devolve null', async () => {
  assert.deepEqual(listYtKeys(), []);
  assert.equal(await ytFetch('videos?id=x', 1000), null);
});

test('chave suspensa (403) é PULADA e a próxima atende — o bug de 30/07', async () => {
  process.env.BLUELENS_YT_KEY_1 = 'morta';
  process.env.BLUELENS_YT_KEY_2 = 'viva';
  const usadas = [];
  globalThis.fetch = async (url) => {
    const key = String(url).match(/key=([^&]+)/)?.[1];
    usadas.push(key);
    return key === 'viva'
      ? { ok: true, status: 200, json: async () => ({ items: [] }) }
      : { ok: false, status: 403, json: async () => ({}) };
  };
  const r = await ytFetch('videos?id=abc', 1000);
  assert.ok(r && r.ok, 'não achou a chave viva');
  assert.ok(usadas.includes('viva'), 'nunca tentou a viva: ' + usadas.join(','));
});

test('todas mortas → null (e o pipeline segue com safeMeta, sem 500)', async () => {
  process.env.BLUELENS_YT_KEY_1 = 'm1';
  process.env.BLUELENS_YT_KEY_2 = 'm2';
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
  assert.equal(await ytFetch('videos?id=abc', 1000), null);
});

test('erro que NÃO é culpa da chave (5xx) não queima a rotação inteira', async () => {
  process.env.BLUELENS_YT_KEY_1 = 'unica';
  let chamadas = 0;
  globalThis.fetch = async () => { chamadas++; return { ok: false, status: 503, json: async () => ({}) }; };
  const r = await ytFetch('videos?id=abc', 1000);
  assert.equal(r.status, 503, '5xx deve voltar pro caller decidir');
  assert.equal(chamadas, 1, 'não adianta martelar as outras chaves num 5xx');
});

// ── PORTÃO ──────────────────────────────────────────────────────────────────

function resFalso() {
  const r = { _status: 200, _json: null };
  r.setHeader = () => {};
  r.status = (s) => { r._status = s; return r; };
  r.json = (j) => { r._json = j; return r; };
  r.end = () => r;
  return r;
}

// dublê: auth devolve o usuário, subscribers devolve o plano, e o cache do
// BlueLens devolve uma análise pronta (pra o handler retornar cedo, sem SerpAPI)
function dublarFetch({ user, plano, expirado = false, manual = false }) {
  return async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) {
      return user
        ? { ok: true, json: async () => ({ id: 'u1', email: user }) }
        : { ok: false, status: 401, json: async () => ({}) };
    }
    if (u.includes('/subscribers')) {
      return { ok: true, json: async () => [{
        plan: plano,
        plan_expires_at: expirado ? '2020-01-01T00:00:00Z' : null,
        is_manual: manual,
      }] };
    }
    if (u.includes('bluelens_cache')) {
      return { ok: true, json: async () => [{
        response: { ok: true, matches: [], engine: 'teste' },
        hits: 1,
        created_at: new Date().toISOString(),
      }] };
    }
    return { ok: true, json: async () => ({}) };
  };
}

const chamar = async (cenario, headers = {}) => {
  process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'sk-teste';
  process.env.SERPAPI_KEY = 'serp-teste';
  globalThis.fetch = dublarFetch(cenario);
  const res = resFalso();
  await mod(
    { method: 'GET', query: { url: 'https://www.youtube.com/shorts/abc123def45' }, headers },
    res
  );
  return res;
};

test('sem token → 403 com upgrade (a porta que estava aberta)', async () => {
  const r = await chamar({ user: null });
  assert.equal(r._status, 403);
  assert.equal(r._json.upgrade, true);
  assert.match(r._json.error, /Full e Master/);
});

test('free → 403 (a página promete exclusividade; a API agora cumpre)', async () => {
  const r = await chamar({ user: 'a@b.c', plano: 'free' }, { authorization: 'Bearer tok' });
  assert.equal(r._status, 403);
});

test('full e master passam — SEM limite de uso (decisão do user)', async () => {
  for (const plano of ['full', 'master']) {
    const r = await chamar({ user: 'a@b.c', plano }, { authorization: 'Bearer tok' });
    assert.equal(r._status, 200, plano + ' foi barrado');
    assert.equal(r._json.cached, true, 'não chegou na resposta cacheada');
  }
});

test('full VENCIDO → 403 (mesma régua dos outros portões do site)', async () => {
  const r = await chamar({ user: 'a@b.c', plano: 'full', expirado: true }, { authorization: 'Bearer tok' });
  assert.equal(r._status, 403);
});

test('manual (presente/parceiro) passa mesmo com data vencida', async () => {
  const r = await chamar({ user: 'a@b.c', plano: 'master', expirado: true, manual: true }, { authorization: 'Bearer tok' });
  assert.equal(r._status, 200);
});

test('token também pode vir por query (?token=) — o front usa header, mas o formato antigo não quebra', async () => {
  process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'sk-teste';
  process.env.SERPAPI_KEY = 'serp-teste';
  globalThis.fetch = dublarFetch({ user: 'a@b.c', plano: 'full' });
  const res = resFalso();
  await mod({ method: 'GET', query: { url: 'https://youtu.be/abc123def45', token: 'tok' }, headers: {} }, res);
  assert.equal(res._status, 200);
});
