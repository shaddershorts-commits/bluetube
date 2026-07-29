// tests/unit/roteiro_chat_endpoint.test.mjs — node --test
//
// Testa os PORTÕES do endpoint sem rede real: fetch global é dublado.
// Cobre as regras de acesso definidas pelo user (29/07):
//   sem conta → popup de cadastro | free → 5/dia | full e master → ilimitado
//
// E cobre a garantia central da Fase 0: em NENHUM caminho de falha o
// roteiro do usuário pode ser perdido.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler, { classificarErro, montarPrompt, LIMITE_FREE_DIA, LIVRE_SEM_CONTA } from '../../api/roteiro-chat.js';

const ROTEIRO = 'Uma garota decidiu sacudir a ponte ao máximo para desestabilizar os outros competidores. O desafio era ficar de pé até o final, mas ela não derrubou ninguém e acabou desistindo.';

// ── dublês ──────────────────────────────────────────────────────────────────
function resFalso() {
  const r = { _status: 200, _json: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (s) => { r._status = s; return r; };
  r.json = (j) => { r._json = j; return r; };
  r.end = () => r;
  return r;
}

// cenario: quem é o usuário, quanto já usou hoje, e quantas vezes esse IP já
// experimentou sem conta
function dublarFetch({ user = null, plano = 'free', usado = 0, anonUsado = 0 } = {}) {
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) {
      return user
        ? { ok: true, json: async () => ({ id: 'uid-1', email: user }) }
        : { ok: false, status: 401, json: async () => ({}) };
    }
    if (u.includes('/subscribers')) {
      return { ok: true, json: async () => [{ plan: plano, plan_expires_at: null, is_manual: false }] };
    }
    if (u.includes('roteiro_chat_usage') && (!opts || opts.method === undefined)) {
      return { ok: true, json: async () => (usado ? [{ count: usado }] : []) };
    }
    if (u.includes('rate_limits') && u.includes('%23anon') && (!opts || opts.method === undefined)) {
      return { ok: true, json: async () => Array.from({ length: anonUsado }, () => ({ count: 1 })) };
    }
    // POST/PATCH de uso, freio por IP e log
    return { ok: true, json: async () => ({}) };
  };
}

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'chave-de-teste';
  process.env.SUPABASE_ANON_KEY = 'anon-de-teste';
  // sem chave de IA: a chamada de IA falha de proposito nos testes que chegam lá
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; process.env = { ...ORIGINAL_ENV }; });

const chamar = async (body, cenario) => {
  globalThis.fetch = dublarFetch(cenario);
  const res = resFalso();
  await handler({ method: 'POST', body, headers: { 'x-forwarded-for': '203.0.113.7' }, socket: {} }, res);
  return res;
};

// ════════════════════════════════════════════════════════════════════════════
// PORTÃO 1 — precisa de conta
// ════════════════════════════════════════════════════════════════════════════

// Regra do user (29/07): sem conta a pessoa EXPERIMENTA 2 vezes. Só na 3ª
// aparece o convite — e falando de cadastro, nunca de pagamento.
test('sem conta, a 1ª e a 2ª vez PASSAM (ninguém é barrado antes de usar)', async () => {
  for (const jaUsou of [0, 1]) {
    const r = await chamar({ transcript: ROTEIRO, instruction: 'encurta' }, { user: null, anonUsado: jaUsou });
    assert.notEqual(r._status, 401, `barrou no uso nº ${jaUsou + 1}`);
  }
});

test('na 3ª vez sem conta → convite pra CRIAR CONTA', async () => {
  const r = await chamar({ transcript: ROTEIRO, instruction: 'encurta' }, { user: null, anonUsado: LIVRE_SEM_CONTA });
  assert.equal(r._status, 401);
  assert.equal(r._json.needs_account, true);
  assert.equal(r._json.limite_free, LIMITE_FREE_DIA);
});

test('o convite de cadastro NÃO fala em pagar (ele nem usou direito ainda)', async () => {
  const r = await chamar({ transcript: ROTEIRO, instruction: 'encurta' }, { user: null, anonUsado: LIVRE_SEM_CONTA });
  const m = r._json.mensagem;
  assert.match(m, /de graça|gratuit/i, 'não deixa claro que é grátis: ' + m);
  assert.match(m, /5 por dia|5 ajustes/, 'não diz o que ele ganha: ' + m);
  assert.equal(/plano|assin|pag|upgrade|full|master|R\$/i.test(m), false,
    'está empurrando plano pra quem nem tem conta: ' + m);
});

test('token inválido é tratado como sem conta (não vaza erro interno)', async () => {
  const r = await chamar({ token: 'lixo', transcript: ROTEIRO, instruction: 'encurta' },
    { user: null, anonUsado: LIVRE_SEM_CONTA });
  assert.equal(r._status, 401);
  assert.equal(r._json.needs_account, true);
  assert.equal(/stack|jwt|supabase/i.test(JSON.stringify(r._json)), false);
});

// ════════════════════════════════════════════════════════════════════════════
// PORTÃO 2 — cota diária
// ════════════════════════════════════════════════════════════════════════════

test('free que já usou 5 → 429 com convite pro upgrade', async () => {
  const r = await chamar({ token: 't', transcript: ROTEIRO, instruction: 'encurta' },
    { user: 'a@b.c', plano: 'free', usado: 5 });
  assert.equal(r._status, 429);
  assert.equal(r._json.limit_reached, true);
  assert.equal(r._json.limite, 5);
  assert.match(r._json.mensagem, /planos pagos|24 horas/);
});

test('free no 5º pedido (usou 4) ainda PASSA do portão', async () => {
  const r = await chamar({ token: 't', transcript: ROTEIRO, instruction: 'encurta' },
    { user: 'a@b.c', plano: 'free', usado: 4 });
  assert.notEqual(r._status, 429, 'bloqueou cedo demais — o 5º é direito dele');
});

test('full e master nunca batem no limite, mesmo com uso alto', async () => {
  for (const plano of ['full', 'master']) {
    const r = await chamar({ token: 't', transcript: ROTEIRO, instruction: 'encurta' },
      { user: 'a@b.c', plano, usado: 999 });
    assert.notEqual(r._status, 429, plano + ' foi barrado');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GARANTIA CENTRAL — o roteiro do usuário nunca se perde
// ════════════════════════════════════════════════════════════════════════════

test('IA fora do ar → responde 200, avisa, e DEVOLVE O ROTEIRO ORIGINAL', async () => {
  // sem nenhuma chave de IA configurada, callAI falha
  const r = await chamar({ token: 't', transcript: ROTEIRO, instruction: 'encurta' },
    { user: 'a@b.c', plano: 'master' });
  assert.equal(r._status, 200, 'não pode ser 500 — o front trataria como erro cru');
  assert.equal(r._json.ok, false);
  assert.equal(r._json.aplicado, false);
  assert.equal(r._json.texto, ROTEIRO, 'PERDEU O ROTEIRO DO USUÁRIO');
  assert.ok(r._json.mensagem && r._json.mensagem.length > 10, 'sem mensagem pro usuário');
});

test('falha de IA NÃO queima cota do free', async () => {
  let gravouUso = false;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('roteiro_chat_usage') && opts?.method) { gravouUso = true; return { ok: true, json: async () => ({}) }; }
    return dublarFetch({ user: 'a@b.c', plano: 'free', usado: 1 })(url, opts);
  };
  const res = resFalso();
  await handler({ method: 'POST', body: { token: 't', transcript: ROTEIRO, instruction: 'encurta' }, headers: {}, socket: {} }, res);
  assert.equal(res._json.aplicado, false);
  assert.equal(gravouUso, false, 'cobrou um ajuste que nunca aconteceu');
});

// ════════════════════════════════════════════════════════════════════════════
// VALIDAÇÃO DE ENTRADA
// ════════════════════════════════════════════════════════════════════════════

test('entradas inválidas respondem com mensagem, nunca com stack', async () => {
  const casos = [
    [{ token: 't', transcript: '', instruction: 'encurta' }, 'sem_roteiro'],
    [{ token: 't', transcript: ROTEIRO, instruction: '  ' }, 'sem_instrucao'],
    [{ token: 't', transcript: 'x'.repeat(5001), instruction: 'encurta' }, 'roteiro_grande'],
  ];
  for (const [body, erro] of casos) {
    const r = await chamar(body, { user: 'a@b.c', plano: 'master' });
    assert.equal(r._status, 400);
    assert.equal(r._json.error, erro);
    assert.ok(r._json.mensagem, 'sem mensagem em ' + erro);
  }
});

test('body ausente não derruba o endpoint', async () => {
  globalThis.fetch = dublarFetch({ user: null });
  const res = resFalso();
  await assert.doesNotReject(() => handler({ method: 'POST', headers: {}, socket: {} }, res));
  assert.equal(res._status, 400);
});

test('método errado é recusado antes de qualquer trabalho', async () => {
  const res = resFalso();
  await handler({ method: 'GET', headers: {}, socket: {} }, res);
  assert.equal(res._status, 405);
});

// ════════════════════════════════════════════════════════════════════════════
// PEÇAS
// ════════════════════════════════════════════════════════════════════════════

test('classificação de erro de infra cobre os casos reais', () => {
  assert.equal(classificarErro('401 Unauthorized: invalid api key'), 'IA-AUTH');
  assert.equal(classificarErro('You exceeded your current quota'), 'IA-CREDITO');
  assert.equal(classificarErro('429 Too Many Requests'), 'IA-FILA');
  assert.equal(classificarErro('The operation was aborted due to timeout'), 'IA-TIMEOUT');
  assert.equal(classificarErro('coisa estranha'), 'GERAL');
  assert.equal(classificarErro(null), 'GERAL');
});

test('o prompt manda a regra que faltava: não narrar a instrução', () => {
  const { system, user } = montarPrompt({ roteiro: ROTEIRO, instrucao: 'encurta', lang: 'Português (Brasil)' });
  assert.match(system, /NUNCA escreva a instrução do usuário dentro do roteiro/);
  assert.match(system, /Português \(Brasil\)/);
  assert.ok(user.includes(ROTEIRO));
});

test('instrução gigante é cortada antes de virar prompt', () => {
  const { user } = montarPrompt({ roteiro: ROTEIRO, instrucao: 'x'.repeat(5000), lang: 'English' });
  assert.ok(user.length < 4200, 'prompt inflou: ' + user.length);
});
