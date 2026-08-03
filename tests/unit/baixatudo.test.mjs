// tests/unit/baixatudo.test.mjs — node --test
//
// BaixaTudo é feature ISOLADA: nada dela pode encostar no download normal.
// O que este arquivo trava:
//  1. Reconhecimento de link de canal (@handle, /channel/UC, /c/, /user/) e
//     recusa de link que não é canal — errar aqui manda o yt-dlp pro lugar errado
//  2. Tradução de erro técnico do yt-dlp pra mensagem amigável + status certo
//  3. O portão de plano do endpoint Vercel: sem token/free não passa, e o
//     Railway não é chamado quando o portão barra (custo e abuso)
//  4. Teto de shorts por lote (canal com 800 não vira job infinito)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

// railway-ffmpeg não tem node_modules local (Docker instala no build) — o
// express vira um stub só pra conseguir carregar o módulo e ler os helpers.
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
const { _interno } = require('../../railway-ffmpeg/baixatudo.js');
Module._resolveFilename = _resolve;

const vercelHandler = require('../../api/baixatudo.js');

// ── 1. reconhecimento de canal ──────────────────────────────────────────────
test('reconhece as formas de link de canal e aponta pra aba /shorts', () => {
  const casos = [
    ['https://www.youtube.com/@XiroRanks/shorts', 'https://www.youtube.com/@XiroRanks/shorts'],
    ['https://www.youtube.com/@XiroRanks', 'https://www.youtube.com/@XiroRanks/shorts'],
    ['@XiroRanks', 'https://www.youtube.com/@XiroRanks/shorts'],
    ['youtube.com/channel/UCabcdefghijklmnopqrstuv', 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv/shorts'],
    ['https://youtube.com/c/AlgumCanal', 'https://www.youtube.com/c/AlgumCanal/shorts'],
    ['https://youtube.com/user/AlgumCanal', 'https://www.youtube.com/user/AlgumCanal/shorts'],
  ];
  for (const [entrada, esperado] of casos) {
    assert.equal(_interno.urlDoCanal(entrada), esperado, `falhou pra: ${entrada}`);
  }
});

test('recusa o que não é canal (vídeo avulso, vazio, outro site)', () => {
  for (const ruim of ['', null, undefined, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                      'https://www.youtube.com/shorts/BUqlzukB1Mc', 'https://tiktok.com/@alguem', 'texto solto']) {
    assert.equal(_interno.urlDoCanal(ruim), null, `deveria recusar: ${ruim}`);
  }
});

// ── 2. erros amigáveis ──────────────────────────────────────────────────────
test('traduz erro do yt-dlp pra mensagem amigável com status certo', () => {
  const bot = _interno.amigavel('ERROR: Sign in to confirm you are not a bot');
  assert.equal(bot.status, 503);
  assert.equal(bot.error, 'bot_check');
  assert.doesNotMatch(bot.detail, /yt-dlp|ERROR|cookies/i, 'não pode vazar termo técnico');

  assert.equal(_interno.amigavel('This channel does not have a shorts tab').status, 404);
  assert.equal(_interno.amigavel('Video is private').error, 'indisponivel');
  assert.equal(_interno.amigavel('timeout').status, 504);
  const generico = _interno.amigavel('coisa estranha qualquer');
  assert.equal(generico.status, 500);
});

// ── 3. portão de plano no endpoint da Vercel ────────────────────────────────
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };

function resFalso() {
  const r = { _status: 200, _json: null };
  r.setHeader = () => {}; r.end = () => r;
  r.status = (s) => { r._status = s; return r; };
  r.json = (j) => { r._json = j; return r; };
  return r;
}

function dublar({ plano = 'master', email = 'a@b.c', chamadas }) {
  return async (url, opts) => {
    const u = String(url);
    if (chamadas) chamadas.push(u.replace(/https?:\/\/[^/]+/, ''));
    if (u.includes('/auth/v1/user')) return { ok: !!email, json: async () => ({ email }) };
    if (u.includes('/rest/v1/subscribers')) {
      return { ok: true, json: async () => [{ plan: plano, plan_expires_at: null, is_manual: false }] };
    }
    if (u.includes('/baixatudo-list')) {
      return { ok: true, status: 200, json: async () => ({ canal: 'Xiro', total: 2, shorts: [{ id: 'a'.repeat(11) }, { id: 'b'.repeat(11) }] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'sk';
  process.env.SUPABASE_ANON_KEY = 'ak';
});
afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; process.env = { ...ORIGINAL_ENV }; });

const chamar = async (body, cen = {}) => {
  const chamadas = [];
  globalThis.fetch = dublar({ ...cen, chamadas });
  const res = resFalso();
  await vercelHandler({ method: 'POST', headers: {}, body, query: {} }, res);
  return { res, chamadas };
};

test('sem token → 401 e o Railway nem é chamado', async () => {
  const { res, chamadas } = await chamar({ channel_url: '@XiroRanks' });
  assert.equal(res._status, 401);
  assert.equal(chamadas.filter((c) => c.includes('baixatudo-list')).length, 0);
});

test('plano free → 403 e o Railway nem é chamado (custo e abuso)', async () => {
  const { res, chamadas } = await chamar({ token: 'tok', channel_url: '@XiroRanks' }, { plano: 'free' });
  assert.equal(res._status, 403);
  assert.equal(res._json.error, 'plano_master_necessario');
  assert.equal(chamadas.filter((c) => c.includes('baixatudo-list')).length, 0);
});

test('plano full também não passa — BaixaBlue é Master', async () => {
  const { res } = await chamar({ token: 'tok', channel_url: '@XiroRanks' }, { plano: 'full' });
  assert.equal(res._status, 403);
});

test('master passa e recebe a base de download do Railway', async () => {
  const { res, chamadas } = await chamar({ token: 'tok', channel_url: '@XiroRanks' });
  assert.equal(res._status, 200);
  assert.equal(res._json.total, 2);
  assert.match(res._json.base_download, /baixatudo-video$/);
  assert.equal(chamadas.filter((c) => c.includes('baixatudo-list')).length, 1);
});

test('sem channel_url → 400 antes de qualquer consulta', async () => {
  const { res, chamadas } = await chamar({ token: 'tok' });
  assert.equal(res._status, 400);
  assert.equal(chamadas.length, 0);
});

// ── 4. isolamento e motor ───────────────────────────────────────────────────
const FONTE = readFileSync(new URL('../../railway-ffmpeg/baixatudo.js', import.meta.url), 'utf8');

test('cookies do BaixaTudo são PRÓPRIOS — não herdam os do BaixaBlue', () => {
  assert.match(FONTE, /process\.env\.BAIXATUDO_COOKIES/, 'deve ler a env própria');
  assert.doesNotMatch(FONTE, /process\.env\.YOUTUBE_COOKIES/,
    'não pode cair na env do BaixaBlue: cookie do lote queimar não pode derrubar o download avulso');
});

test('o DOWNLOAD usa Cobalt, não yt-dlp direto', () => {
  const trecho = FONTE.slice(FONTE.indexOf("router.get('/baixatudo-video'"));
  assert.doesNotMatch(trecho, /rodar\('yt-dlp'/,
    'yt-dlp direto bate em n-challenge/PO Token nesta imagem — o download é do Cobalt');
  assert.match(trecho, /pedirAoCobalt/, 'deve pedir o link ao Cobalt');
});

test('pede 1080 antes de 720 e nunca aceita menos', () => {
  const trecho = FONTE.slice(FONTE.indexOf("router.get('/baixatudo-video'"));
  const m = trecho.match(/for \(const q of \[([^\]]+)\]/);
  assert.ok(m, 'cascata de qualidade não encontrada');
  const qualidades = m[1].replace(/['\s]/g, '').split(',');
  assert.deepEqual(qualidades, ['1080', '720'], 'a cascata deve ser 1080 → 720, sem degrau abaixo de HD');
});

test('pede h264 ao Cobalt (entrega direta, sem transcode)', () => {
  assert.match(FONTE, /youtubeVideoCodec:\s*'h264'/, 'vp9/av1 forçariam transcode e matariam a velocidade');
});

test('o módulo isolado não importa nada do server.js', () => {
  assert.doesNotMatch(FONTE, /require\(['"]\.\/server/, 'importar o server.js quebraria o isolamento');
});

// ── 5. tetos ────────────────────────────────────────────────────────────────
test('teto de shorts e de processos simultâneos existem e são sãos', () => {
  assert.ok(_interno.TETO_SHORTS > 0 && _interno.TETO_SHORTS <= 200, 'teto de shorts fora do razoável');
  assert.ok(_interno.TETO_SIMULTANEO >= 1 && _interno.TETO_SIMULTANEO <= 4,
    'muitos yt-dlp simultâneos roubariam CPU do download normal');
});
