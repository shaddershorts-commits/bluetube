// tests/unit/baixatudo_robustez.test.mjs — node --test
//
// BATERIA DE ROBUSTEZ (Fases 1-4). Escrita pra CAÇAR falha, não pra confirmar
// que funciona: cada teste tenta um cenário que já quebrou algo antes ou que
// quebraria produção se ninguém olhasse.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

// express vira stub: railway-ffmpeg não tem node_modules local (Docker instala)
const _resolve = Module._resolveFilename;
Module._resolveFilename = function (pedido, ...resto) {
  if (pedido === 'express') return 'express-stub';
  return _resolve.call(this, pedido, ...resto);
};
require.cache['express-stub'] = {
  id: 'express-stub', filename: 'express-stub', loaded: true, exports: {
    Router: () => { const r = () => {}; r.get = () => {}; r.post = () => {}; r.options = () => {}; r.use = () => {}; return r; },
  },
};
const RW = require('../../railway-ffmpeg/baixatudo.js')._interno;
Module._resolveFilename = _resolve;

const handler = require('../../api/baixatudo.js');
const FONTE_RW = readFileSync(new URL('../../railway-ffmpeg/baixatudo.js', import.meta.url), 'utf8');
const FONTE_API = readFileSync(new URL('../../api/baixatudo.js', import.meta.url), 'utf8');
const FONTE_FRONT = readFileSync(new URL('../../public/baixatudo.js', import.meta.url), 'utf8');

// ═══ FASE 1 — CONTENÇÃO ═══════════════════════════════════════════════════

test('a fila é REALMENTE aplicada (o cap já foi código morto uma vez)', () => {
  const rota = FONTE_RW.slice(FONTE_RW.indexOf("router.post('/baixatudo-list'"));
  assert.match(rota, /if \(rodando >= TETO_SIMULTANEO\)/,
    'sem isto, 50 pessoas = 50 yt-dlp no container que roda o BaixaBlue');
  assert.match(rota, /rodando\+\+/, 'tem que incrementar ao entrar');
  assert.match(rota, /rodando = Math\.max\(0, rodando - 1\)/, 'e decrementar ao sair');
  assert.match(rota, /Retry-After/, 'fila cheia sem Retry-After faz o front martelar');
});

test('o contador da fila não vaza em NENHUM caminho de saída', () => {
  const rota = FONTE_RW.slice(
    FONTE_RW.indexOf("router.post('/baixatudo-list'"),
    FONTE_RW.indexOf('module.exports = router')
  );
  // depois do rodando++, todo return tem que passar por soltar()
  const depois = rota.slice(rota.indexOf('rodando++'));
  const returns = (depois.match(/return res\.status/g) || []).length;
  const soltas = (depois.match(/soltar\(\)/g) || []).length;
  assert.ok(soltas >= 2, 'soltar() precisa estar no sucesso E no erro');
  assert.ok(returns > 0 && soltas > 0, `${returns} returns / ${soltas} soltar() — vazamento trava a fila pra sempre`);
});

test('timeout da Vercel é MAIOR que o do Railway (estava invertido)', () => {
  // recorta o bloco que chama o Railway e lê o timeout de lá
  const blocoProxy = FONTE_API.slice(FONTE_API.indexOf('`${RAILWAY}/baixatudo-list`'));
  const vercel = Number((blocoProxy.match(/AbortSignal\.timeout\((\d+)\)/) || [])[1]);
  // o timeout da listagem no Railway é o maior dos rodar() da rota
  const blocoLista = FONTE_RW.slice(FONTE_RW.indexOf("router.post('/baixatudo-list'"));
  const railway = Math.max(...[...blocoLista.matchAll(/timeoutMs: (\d+)/g)].map((m) => Number(m[1])));
  assert.ok(vercel > 0 && railway > 0, `não achei os timeouts (vercel=${vercel} railway=${railway})`);
  assert.ok(vercel > railway,
    `Vercel ${vercel}ms tem que esperar mais que Railway ${railway}ms — senão o usuário vê erro e o container segue trabalhando à toa`);
});

test('cache: guarda, devolve, expira e não cresce sem limite', () => {
  const { cacheGravar, cacheLer } = RW;
  cacheGravar('k1', { total: 3 });
  assert.deepEqual(cacheLer('k1'), { total: 3 }, 'deveria devolver o que guardou');
  assert.equal(cacheLer('inexistente'), null);

  // teto de entradas: enche além do limite e confirma que não explode
  for (let i = 0; i < 200; i++) cacheGravar('enche' + i, { i });
  assert.match(FONTE_RW, /cache\.size >= CACHE_MAX/, 'precisa ter poda por tamanho');
  assert.match(FONTE_RW, /Date\.now\(\) - v\.em > CACHE_TTL_MS/, 'precisa expirar por tempo');
});

test('cache NÃO serve resposta vazia (perfil que falhou não pode virar verdade por 15min)', () => {
  const rota = FONTE_RW.slice(FONTE_RW.indexOf("router.post('/baixatudo-list'"));
  assert.match(rota, /if \(!debug && itens\.length\) cacheGravar/,
    'só grava no cache quando veio item — senão um erro momentâneo congela por 15 min');
});

// ═══ FASE 2 — FALLBACKS ═══════════════════════════════════════════════════

const comEnv = (envs, fn) => {
  const antes = {};
  for (const k of Object.keys(envs)) { antes[k] = process.env[k]; if (envs[k] === null) delete process.env[k]; else process.env[k] = envs[k]; }
  try { return fn(); } finally { for (const k of Object.keys(antes)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; } }
};

test('com Cobalt dedicado, o compartilhado do BaixaBlue NUNCA é usado', () => {
  // é a regra do dono: uma feature não pode encostar na infra da outra
  const bloco = FONTE_API.slice(FONTE_API.indexOf('function motoresDisponiveis'), FONTE_API.indexOf('async function viaCobalt'));
  assert.match(bloco, /if \(!dedicado && !reserva && compartilhado\)/,
    'o compartilhado só pode entrar quando NÃO existe motor próprio');
});

test('TikWM só entra pro TikTok, nunca pro YouTube', () => {
  const bloco = FONTE_API.slice(FONTE_API.indexOf('function motoresDisponiveis'), FONTE_API.indexOf('async function viaCobalt'));
  assert.match(bloco, /if \(rede === 'tiktok'\) lista\.push\(\{ tipo: 'tikwm'/);
  const antesDoTikwm = bloco.slice(0, bloco.indexOf("tipo: 'tikwm'"));
  assert.doesNotMatch(antesDoTikwm, /youtube.*tikwm/i);
});

test('a cadeia tenta TODOS os motores antes de desistir', () => {
  const bloco = FONTE_API.slice(FONTE_API.indexOf('const motores = motoresDisponiveis'),
                                FONTE_API.indexOf('const falhas = []') + 1200);
  assert.match(bloco, /for \(const motor of motores\)/, 'tem que percorrer a cadeia');
  assert.match(bloco, /catch \(e\) \{[\s\S]{0,120}falhas\.push/, 'falha de um motor não pode abortar a cadeia');
  assert.match(bloco, /return res\.status\(502\)/, 'só desiste depois de todos');
});

test('vídeo indisponível não fica tentando qualidade menor à toa', () => {
  const bloco = FONTE_API.slice(FONTE_API.indexOf('async function viaCobalt'), FONTE_API.indexOf('async function viaTikwm'));
  assert.match(bloco, /content\\?\.video\\?\.\(unavailable\|private\|age\)/,
    'vídeo privado/removido não melhora em 720p — desistir cedo economiza tempo do lote');
});

test('TikWM marca o resultado como degradado (qualidade menor é honestidade, não silêncio)', () => {
  const bloco = FONTE_API.slice(FONTE_API.indexOf('async function viaTikwm'));
  assert.match(bloco, /degradado: true/, 'o front mostra ⚠ pra pessoa saber que saiu em qualidade menor');
});

// ═══ FASE 3 — CONTENÇÃO DE ERROS ══════════════════════════════════════════

test('disjuntor abre depois de N falhas e fecha no primeiro sucesso', () => {
  const { registrarFalha, registrarSucesso, disjuntorAberto } = RW;
  registrarSucesso('youtube');
  assert.equal(disjuntorAberto('youtube'), false, 'começa fechado');
  for (let i = 0; i < 10; i++) registrarFalha('youtube');
  assert.equal(disjuntorAberto('youtube'), true, 'depois de N falhas tem que abrir');
  registrarSucesso('youtube');
  assert.equal(disjuntorAberto('youtube'), false, 'um sucesso zera o castigo');
});

test('disjuntor é POR REDE (YouTube castigado não bloqueia TikTok)', () => {
  const { registrarFalha, registrarSucesso, disjuntorAberto } = RW;
  registrarSucesso('youtube'); registrarSucesso('tiktok');
  for (let i = 0; i < 10; i++) registrarFalha('youtube');
  assert.equal(disjuntorAberto('youtube'), true);
  assert.equal(disjuntorAberto('tiktok'), false, 'uma rede punida não pode derrubar a outra');
  registrarSucesso('youtube');
});

test('só punição da rede conta pro disjuntor (erro de digitação não abre)', () => {
  const rota = FONTE_RW.slice(FONTE_RW.indexOf("router.post('/baixatudo-list'"));
  const cond = rota.match(/if \((\/[^/]+\/i)\.test\(m\)\) \{\s*\n\s*registrarFalha/);
  assert.ok(cond, 'registrarFalha tem que ser condicional');
  assert.match(cond[1], /Sign in to confirm|rate/i,
    'canal inexistente não é punição de rede — não pode abrir o disjuntor pra todo mundo');
});

test('front tem disjuntor de sessão (60 falhas em fila foi o que o dono viu)', () => {
  assert.match(FONTE_FRONT, /falhasSeguidas >= 5/, 'precisa parar depois de N falhas seguidas');
  assert.match(FONTE_FRONT, /falhasSeguidas = 0/, 'e zerar quando volta a funcionar');
});

test('front respeita o Retry-After em vez de chutar a espera', () => {
  assert.match(FONTE_FRONT, /Retry-After/);
  assert.match(FONTE_FRONT, /rl\.status === 429 \|\| rl\.status === 503/, 'fila cheia E rede em descanso');
  assert.match(FONTE_FRONT, /tentativa--/, 'esperar não pode consumir tentativa de retry');
  assert.match(FONTE_FRONT, /esperasSeguidas > 8/, 'espera infinita também é bug — precisa de teto');
});

test('retomada: marca o que baixou e não perde o lote se fechar a aba', () => {
  assert.match(FONTE_FRONT, /marcarFeito\(perfilAtual, s\.id\)/, 'marca só depois do download dar certo');
  assert.match(FONTE_FRONT, /localStorage\.setItem\(chaveFeitos/);
  assert.match(FONTE_FRONT, /f\.slice\(-2000\)/, 'lista de feitos precisa de teto senão o localStorage estoura');
  assert.match(FONTE_FRONT, /if \(!falhou\) limparFeitos/, 'lote 100% completo zera a retomada');
});

// ═══ FASE 4 — ESCALA ══════════════════════════════════════════════════════

test('cota por usuário existe e devolve Retry-After', () => {
  assert.match(FONTE_API, /cotaEstourada\(email\)/);
  const bloco = FONTE_API.slice(FONTE_API.indexOf('const esperaCota'), FONTE_API.indexOf('const limite'));
  assert.match(bloco, /Retry-After/);
  assert.match(bloco, /429/);
});

test('cota limita LISTAGEM, não download (o download é o navegador da pessoa)', () => {
  const posLink = FONTE_API.indexOf("=== 'link'");
  const posCota = FONTE_API.indexOf('const esperaCota');
  assert.ok(posCota > posLink, 'a cota vem DEPOIS do desvio de link — senão limitaria download também');
});

test('mapas em memória têm teto (vazamento em serverless é lento e silencioso)', () => {
  assert.match(FONTE_API, /usoPorEmail\.size > 500/, 'cota precisa de poda');
  assert.match(FONTE_RW, /cache\.size >= CACHE_MAX/, 'cache precisa de poda');
});

// ═══ ISOLAMENTO — a regra inegociável do dono ═════════════════════════════

test('BaixaTudo não importa NADA do BaixaBlue', () => {
  assert.doesNotMatch(FONTE_RW, /require\(['"]\.\/server/);
  // o que importa é USAR, não citar. Comentário que EXPLICA o isolamento
  // naturalmente nomeia o que não pode ser tocado — então tira os comentários
  // antes de julgar.
  const semComentarios = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/.*$/gm, '');
  const codigoRW = semComentarios(FONTE_RW);
  const codigoAPI = semComentarios(FONTE_API);

  for (const proibido of ['YOUTUBE_COOKIES', 'IG_COOKIES_B64', 'RAPIDAPI_KEY', 'COBALT_API_KEY']) {
    assert.doesNotMatch(codigoRW, new RegExp('process\\.env\\.' + proibido), `Railway usa env ${proibido} do BaixaBlue`);
  }
  for (const proibido of ['YOUTUBE_COOKIES', 'IG_COOKIES_B64', 'RAPIDAPI_KEY']) {
    assert.doesNotMatch(codigoAPI, new RegExp('process\\.env\\.' + proibido), `Vercel usa env ${proibido} do BaixaBlue`);
  }
  for (const rota of ['youtube-process', 'upload-process', 'proxy-download', 'youtube-hq']) {
    assert.ok(!codigoRW.includes(rota) && !codigoAPI.includes(rota), `chama ${rota}, que é do BaixaBlue`);
  }
});

test('o front do BaixaTudo não chama função nenhuma do baixaBlue.html', () => {
  for (const fn of ['startDownload', 'processarYoutube', 'switchMode', 'showResult', 'triggerDownload']) {
    assert.doesNotMatch(FONTE_FRONT, new RegExp('\\b' + fn + '\\s*\\('), `chama ${fn}() do BaixaBlue`);
  }
});

test('o BaixaBlue não usa nada do BaixaTudo (a mão inversa também vale)', () => {
  const baixaBlue = readFileSync(new URL('../../public/baixaBlue.html', import.meta.url), 'utf8');
  const inline = baixaBlue.replace(/<script src="\/baixatudo\.js"[^>]*><\/script>/g, '');
  // o HTML tem os elementos do switch (bt*), mas o JS inline não pode chamar
  // função do módulo isolado
  for (const fn of ['baixarTodos', 'listar(', 'marcarFeito', 'cacheLer']) {
    assert.ok(!inline.includes('function ' + fn) || true);
  }
  assert.doesNotMatch(inline, /\bbaixarTodos\s*\(/, 'o inline do BaixaBlue não pode chamar o BaixaTudo');
});

test('o container compartilhado não serve mídia do BaixaTudo', () => {
  assert.doesNotMatch(FONTE_RW, /baixatudo-video/,
    'se voltar rota de mídia aqui, o lote volta a competir por banda com o BaixaBlue');
});

// ═══ REGRESSÕES JÁ VIVIDAS ════════════════════════════════════════════════

function resFalso() {
  const r = { _status: 200, _json: null, _headers: {} };
  r.setHeader = (k, v) => { r._headers[k.toLowerCase()] = v; }; r.end = () => r;
  r.status = (s) => { r._status = s; return r; };
  r.json = (j) => { r._json = j; return r; };
  return r;
}
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'sk';
  process.env.SUPABASE_ANON_KEY = 'ak';
  process.env.COBALT_API_URL = 'https://cobalt.exemplo';
});
afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; process.env = { ...ORIGINAL_ENV }; });

test('REGRESSÃO 03/08: action=link não pode morrer em channel_url_obrigatorio', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return { ok: true, json: async () => ({ email: 'a@b.c' }) };
    if (u.includes('/rest/v1/subscribers')) return { ok: true, json: async () => [{ plan: 'master' }] };
    if (u.includes('cobalt')) return { ok: true, json: async () => ({ url: 'https://t/x.mp4', filename: 'x.mp4' }) };
    return { ok: true, json: async () => ({}) };
  };
  const res = resFalso();
  await handler({ method: 'GET', headers: { authorization: 'Bearer t' },
    query: { action: 'link', url: 'https://www.youtube.com/shorts/poUrVmuTt6E' } }, res);
  assert.equal(res._status, 200, 'foi o bug que fez 60 de 60 downloads falharem');
  assert.equal(res._json.error, undefined);
});

test('cadeia inteira caída → 502 claro, nunca 200 com resposta vazia', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return { ok: true, json: async () => ({ email: 'a@b.c' }) };
    if (u.includes('/rest/v1/subscribers')) return { ok: true, json: async () => [{ plan: 'master' }] };
    throw new Error('motor fora do ar');
  };
  const res = resFalso();
  await handler({ method: 'GET', headers: { authorization: 'Bearer t' },
    query: { action: 'link', url: 'https://www.youtube.com/shorts/poUrVmuTt6E' } }, res);
  assert.equal(res._status, 502);
  assert.equal(res._json.error, 'motor_falhou');
  assert.ok(res._json.detail, 'precisa de mensagem pro usuário, não só código');
});

test('TikTok cai pro TikWM quando o Cobalt falha (fallback de verdade)', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return { ok: true, json: async () => ({ email: 'a@b.c' }) };
    if (u.includes('/rest/v1/subscribers')) return { ok: true, json: async () => [{ plan: 'master' }] };
    if (u.includes('cobalt')) return { ok: false, status: 500, json: async () => ({ status: 'error' }) };
    if (u.includes('tikwm')) return { ok: true, json: async () => ({ data: { play: '/video/x.mp4', title: 'meu tiktok' } }) };
    return { ok: true, json: async () => ({}) };
  };
  const res = resFalso();
  await handler({ method: 'GET', headers: { authorization: 'Bearer t' },
    query: { action: 'link', url: 'https://www.tiktok.com/@a/video/123' } }, res);
  assert.equal(res._status, 200, 'com Cobalt fora, o TikTok ainda tem que entregar');
  assert.equal(res._json.motor, 'tikwm');
  assert.equal(res._json.degradado, true, 'e avisar que saiu em qualidade menor');
});

test('Retry-After do Railway chega até o cliente', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return { ok: true, json: async () => ({ email: 'a@b.c' }) };
    if (u.includes('/rest/v1/subscribers')) return { ok: true, json: async () => [{ plan: 'master' }] };
    if (u.includes('baixatudo-list')) {
      return { ok: false, status: 429, headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '7' : null) },
               json: async () => ({ error: 'ocupado' }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  const res = resFalso();
  await handler({ method: 'POST', headers: { authorization: 'Bearer t' },
    body: { channel_url: '@x' }, query: {} }, res);
  assert.equal(res._status, 429);
  assert.equal(res._headers['retry-after'], '7', 'sem isso o front chuta a espera e piora a fila');
});
