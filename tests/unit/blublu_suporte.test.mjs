// tests/unit/blublu_suporte.test.mjs — node --test
//
// Agente "Como usar?" da Comunidade. O pedido do dono foi explícito: um Claude
// de verdade respondendo, com a personalidade do Blublu, treinado pra ENSINAR
// o BlueTube — nada de árvore de resposta pronta.
//
// Estes testes travam o que não pode regredir: o portão, o isolamento da chave
// do estúdio, a ausência de respostas canned, e a veracidade das rotas que ele
// ensina (ensinar um caminho que não existe é o pior defeito de um suporte).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const handler = require('../../api/blublu-suporte.js');
const FONTE = readFileSync(new URL('../../api/blublu-suporte.js', import.meta.url), 'utf8');
const FRONT = readFileSync(new URL('../../public/blublu-suporte.js', import.meta.url), 'utf8');
const TOOLBAR = readFileSync(new URL('../../public/toolbar.js', import.meta.url), 'utf8');

// ═══ É UM CLAUDE DE VERDADE, NÃO UM MENU ═════════════════════════════════

test('não existe resposta pronta: quem responde é o modelo', () => {
  assert.match(FONTE, /api\.anthropic\.com\/v1\/messages/, 'tem que chamar a API');
  // sinais de árvore de decisão / respostas canned
  assert.doesNotMatch(FONTE, /const RESPOSTAS\s*=|const FAQ\s*=|respostasProntas/,
    'dicionário de respostas prontas foi exatamente o que o dono NÃO quis');
  assert.doesNotMatch(FONTE, /if \(\/como (baixo|faço)\/i\.test\(mensagem\)\)/,
    'casar a pergunta por regex e devolver texto fixo é menu disfarçado');
});

test('o histórico volta pro modelo (é conversa, não pergunta isolada)', () => {
  assert.match(FONTE, /const mensagens = \[\]/);
  assert.match(FONTE, /for \(const t of historico\)/, 'sem histórico ele esquece o contexto a cada turno');
  assert.match(FONTE, /role: papel, content: texto/);
});

// ═══ CHAVE E ORÇAMENTO ═══════════════════════════════════════════════════

test('NÃO usa a chave do estúdio (orçamento isolado da BlueTendências)', () => {
  // O comentário do topo EXPLICA a regra e naturalmente cita a env proibida.
  // O que importa é USO, então tira comentário antes de julgar.
  const codigo = FONTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(codigo, /process\.env\.ANTHROPIC_API_KEY_STUDIO/,
    'a chave do estúdio é exclusiva da BlueTendências — regra da casa');
  assert.match(codigo, /process\.env\.ANTHROPIC_API_KEY \|\| ''/, 'usa a reserva');
});

test('sem configuração, falha claro em vez de vazar erro cru', () => {
  assert.match(FONTE, /if \(!SU \|\| !SK \|\| !ANTHROPIC\) return res\.status\(500\)/);
});

// ═══ PORTÃO ══════════════════════════════════════════════════════════════

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };

function resFalso() {
  const r = { _status: 200, _json: null };
  r.setHeader = () => {}; r.end = () => r;
  r.status = (s) => { r._status = s; return r; };
  r.json = (j) => { r._json = j; return r; };
  return r;
}

function dublar({ email = 'a@b.c', plano = 'master', chamadas }) {
  return async (url, opts) => {
    const u = String(url);
    if (chamadas) chamadas.push(u.replace(/https?:\/\/[^/]+/, ''));
    if (u.includes('/auth/v1/user')) return { ok: !!email, json: async () => ({ email }) };
    if (u.includes('/rest/v1/subscribers')) {
      return { ok: true, json: async () => [{ plan: plano, plan_expires_at: null, is_manual: false, name: 'Felipe Teste' }] };
    }
    if (u.includes('anthropic.com')) {
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Abre /baixaBlue e cola o link.' }] }) };
    }
    return { ok: true, json: async () => ({}) };
  };
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'sk';
  process.env.SUPABASE_ANON_KEY = 'ak';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-teste';
});
afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; process.env = { ...ORIGINAL_ENV }; });

const chamar = async (body, cen = {}) => {
  const chamadas = [];
  globalThis.fetch = dublar({ ...cen, chamadas });
  const res = resFalso();
  await handler({ method: 'POST', headers: {}, body }, res);
  return { res, chamadas };
};

test('sem token → 401 e a Anthropic nem é chamada (custo)', async () => {
  const { res, chamadas } = await chamar({ mensagem: 'como uso?' });
  assert.equal(res._status, 401);
  assert.equal(chamadas.filter((c) => c.includes('anthropic')).length, 0);
});

test('mensagem vazia → 400 sem gastar chamada', async () => {
  const { res, chamadas } = await chamar({ token: 't', mensagem: '   ' });
  assert.equal(res._status, 400);
  assert.equal(chamadas.filter((c) => c.includes('anthropic')).length, 0);
});

test('free não entra (o suporte é da Comunidade, que é de assinante)', async () => {
  const { res, chamadas } = await chamar({ token: 't', mensagem: 'oi' }, { plano: 'free' });
  assert.equal(res._status, 403);
  assert.equal(res._json.error, 'plano_necessario');
  assert.equal(chamadas.filter((c) => c.includes('anthropic')).length, 0);
});

test('full e master entram', async () => {
  for (const plano of ['full', 'master']) {
    const { res } = await chamar({ token: 't', mensagem: 'como faço roteiro?' }, { plano });
    assert.equal(res._status, 200, `${plano} deveria entrar`);
    assert.ok(res._json.resposta);
  }
});

test('o plano vai no prompt (não ensina a usar o que a pessoa não tem)', () => {
  assert.match(FONTE, /## COM QUEM VOCÊ ESTÁ FALANDO AGORA/);
  assert.match(FONTE, /plano === 'full'[\s\S]{0,300}é do Master/,
    'Full precisa ser avisado do que é Master, em vez de procurar botão que não existe');
});

// ═══ O QUE ELE ENSINA TEM QUE SER VERDADE ════════════════════════════════

test('todas as rotas que ele ensina existem de verdade na toolbar', () => {
  const i = FONTE.indexOf('const CONHECIMENTO');
  const conhecimento = FONTE.slice(i, FONTE.indexOf('const PERSONALIDADE'));
  // formato real no conhecimento: "**🔥 Virais — em /virais**"
  const rotas = [...conhecimento.matchAll(/— em (\/[A-Za-z]*)\*\*/g)].map((m) => m[1]);
  assert.ok(rotas.length >= 8, `só achei ${rotas.length} rotas ensinadas`);
  for (const rota of rotas) {
    if (rota === '/') continue;                       // home = Roteiro
    if (rota === '/comunidade' || rota === '/afiliado') continue;  // não estão na toolbar
    assert.ok(TOOLBAR.includes("href:'" + rota + "'"),
      `ensina ${rota}, que não existe na toolbar — ensinar caminho falso é o pior defeito`);
  }
});

test('proíbe inventar funcionalidade, prometer resultado e citar concorrente', () => {
  const i = FONTE.indexOf('const PERSONALIDADE');
  const p = FONTE.slice(i, FONTE.indexOf('module.exports'));
  assert.match(p, /Não inventa funcionalidade/);
  assert.match(p, /Não promete resultado/);
  assert.match(p, /Não fala de ferramenta de fora/, 'regra da casa: nunca citar concorrente');
  assert.match(p, /Não cita preço de plano/, 'preço muda por país e promoção');
});

test('tem instrução de PUXAR DE VOLTA quando o assunto desvia', () => {
  const i = FONTE.indexOf('const PERSONALIDADE');
  const p = FONTE.slice(i, FONTE.indexOf('module.exports'));
  assert.match(p, /QUANDO A PESSOA SAI DO ASSUNTO/);
  assert.match(p, /PUXA DE VOLTA/);
  assert.match(p, /Varie|varie/, 'recusa idêntica toda vez soa robô — o dono pediu inteligência');
});

test('manda admitir que não sabe em vez de inventar tela', () => {
  const i = FONTE.indexOf('QUANDO VOCÊ NÃO SABE');
  assert.ok(i > 0, 'falta a instrução de admitir ignorância');
  const bloco = FONTE.slice(i, i + 400);
  assert.match(bloco, /nunca invent/i);
});

// ═══ ROBUSTEZ ════════════════════════════════════════════════════════════

test('modelo fora do ar → mensagem humana, não stack', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return { ok: true, json: async () => ({ email: 'a@b.c' }) };
    if (u.includes('/rest/v1/subscribers')) return { ok: true, json: async () => [{ plan: 'master' }] };
    if (u.includes('anthropic.com')) return { ok: false, status: 529, text: async () => 'overloaded' };
    return { ok: true, json: async () => ({}) };
  };
  const res = resFalso();
  await handler({ method: 'POST', headers: {}, body: { token: 't', mensagem: 'oi' } }, res);
  assert.equal(res._status, 502);
  assert.ok(res._json.detail && !/stack|Error:|529/.test(res._json.detail),
    'o usuário não pode ver erro técnico: ' + res._json.detail);
});

test('mensagem e histórico têm teto (custo e prompt injection por volume)', () => {
  assert.match(FONTE, /MAX_CHARS_MSG/, 'mensagem precisa de teto');
  assert.match(FONTE, /MAX_TURNOS/, 'histórico precisa de teto');
  assert.match(FONTE, /historico\.slice\(-MAX_TURNOS\)/);
});

test('o log de auditoria não bloqueia a resposta', () => {
  const i = FONTE.indexOf('blublu_suporte_logs');
  const bloco = FONTE.slice(i - 200, i + 700);
  assert.match(bloco, /\.catch\(\(\) => \{\}\)/,
    'falha ao gravar log não pode derrubar a resposta do usuário');
});

// ═══ FRONT ═══════════════════════════════════════════════════════════════

test('a entrada fica ACIMA das abas, como pedido', () => {
  assert.match(FRONT, /cbtTabs/, 'precisa ancorar na barra de abas');
  assert.match(FRONT, /insertBefore\(el, alvo\)/, 'antes das abas, não depois');
  assert.match(FRONT, /Como usar\?/);
});

test('o Blublu flutua num círculo, em azul brilhante', () => {
  assert.match(FRONT, /blublu-pointing\.png/, 'avatar do Blublu');
  assert.match(FRONT, /border-radius:50%/, 'dentro de um círculo');
  assert.match(FRONT, /@keyframes bspFlut/, 'flutuando');
  assert.match(FRONT, /#5fe3ff/, 'azul claro brilhante');
  assert.match(FRONT, /prefers-reduced-motion/, 'quem desliga animação precisa ser respeitado');
});

test('o front é isolado: não chama função do comunidade.js', () => {
  for (const fn of ['ComunidadeBT.setTab', 'ComunidadeBT.open', 'ComunidadeBT.load']) {
    assert.ok(!FRONT.includes(fn), `chama ${fn} — quebra o isolamento`);
  }
});

test('escapa o que vem do modelo (XSS)', () => {
  assert.match(FRONT, /function esc\(t\)/);
  assert.match(FRONT, /replace\(\/</, 'precisa escapar < antes de jogar no innerHTML');
  const i = FRONT.indexOf('function fmt(t)');
  const bloco = FRONT.slice(i, i + 300);
  assert.match(bloco, /esc\(t\)/, 'o formatador tem que escapar ANTES de aplicar markdown');
});

test('erro de rede no front vira mensagem legível', () => {
  assert.match(FRONT, /Sem conexão aqui/);
  assert.match(FRONT, /login_obrigatorio:/, 'cada erro do backend precisa de tradução');
  assert.match(FRONT, /plano_necessario:/);
});
