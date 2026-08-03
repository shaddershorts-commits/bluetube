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

test('listar sem channel_url → 400, sem acionar Railway nem Cobalt', async () => {
  const { res, chamadas } = await chamar({ token: 'tok' });
  assert.equal(res._status, 400);
  assert.equal(res._json.error, 'channel_url_obrigatorio');
  // A autenticação roda antes (o portão precisa decidir), mas nada de trabalho caro
  assert.equal(chamadas.filter((c) => /baixatudo-list|cobalt/.test(c)).length, 0);
});

// ── REGRESSÃO 03/08: o bug que fez 60 de 60 downloads falharem ──────────────
// A validação de channel_url rodava ANTES do desvio de action=link. Como o
// pedido de link manda só o id, TODO download morria em 400 sem nunca chegar
// no Cobalt. O curl sem token devolvia 401 e mascarou o bug.
test('action=link NÃO exige channel_url (só o id)', async () => {
  const chamadas = [];
  globalThis.fetch = dublar({ chamadas });
  const res = resFalso();
  await vercelHandler(
    { method: 'GET', headers: { authorization: 'Bearer tok' }, query: { action: 'link', id: 'poUrVmuTt6E' } },
    res
  );
  assert.notEqual(res._status, 400,
    'action=link não pode ser barrado por falta de channel_url — foi o bug que quebrou o lote inteiro');
  assert.notEqual(res._json?.error, 'channel_url_obrigatorio');
});

test('action=link com id inválido → 400 de ID (não de channel_url)', async () => {
  const chamadas = [];
  globalThis.fetch = dublar({ chamadas });
  const res = resFalso();
  await vercelHandler(
    { method: 'GET', headers: { authorization: 'Bearer tok' }, query: { action: 'link', id: 'curto' } },
    res
  );
  assert.equal(res._status, 400);
  assert.equal(res._json.error, 'id_invalido');
});

test('o teto não corta mais canal de tamanho normal (76 shorts passavam a 60)', () => {
  const m = FONTE_API.match(/const TETO_SHORTS = (\d+)/);
  assert.ok(m, 'TETO_SHORTS não encontrado');
  assert.ok(Number(m[1]) >= 500, `teto ${m[1]} corta canal comum — o dono pediu o canal INTEIRO`);
});

test('thumbnail usa hqdefault (oardefault não existe pra todo Short)', () => {
  assert.match(FONTE, /hqdefault\.jpg/, 'oardefault dava 404 em massa no console');
  assert.doesNotMatch(FONTE, /oardefault\.jpg/);
});

// ── 4. isolamento e motor ───────────────────────────────────────────────────
const FONTE = readFileSync(new URL('../../railway-ffmpeg/baixatudo.js', import.meta.url), 'utf8');

test('cookies do BaixaTudo são PRÓPRIOS — não herdam os do BaixaBlue', () => {
  assert.match(FONTE, /process\.env\.BAIXATUDO_COOKIES/, 'deve ler a env própria');
  assert.doesNotMatch(FONTE, /process\.env\.YOUTUBE_COOKIES/,
    'não pode cair na env do BaixaBlue: cookie do lote queimar não pode derrubar o download avulso');
});

const FONTE_API = readFileSync(new URL('../../api/baixatudo.js', import.meta.url), 'utf8');

test('nenhum byte de mídia passa pelo container compartilhado', () => {
  assert.doesNotMatch(FONTE, /baixatudo-video/,
    'o Railway só lista: se voltar rota de download, a mídia volta a atravessar o container do BaixaBlue');
  assert.match(FONTE, /baixatudo-list/, 'a listagem tem que continuar aqui');
});

test('o DOWNLOAD usa Cobalt, não yt-dlp direto', () => {
  assert.match(FONTE_API, /COBALT_API_URL/, 'o motor é o Cobalt self-hosted');
  assert.doesNotMatch(FONTE_API, /yt-dlp/,
    'yt-dlp direto bate em n-challenge/PO Token nesta imagem e só entrega 360p');
});

test('pede 1080 antes de 720 e nunca aceita menos', () => {
  const m = FONTE_API.match(/for \(const q of \[([^\]]+)\]/);
  assert.ok(m, 'cascata de qualidade não encontrada');
  const qualidades = m[1].replace(/['\s]/g, '').split(',');
  assert.deepEqual(qualidades, ['1080', '720'], 'a cascata deve ser 1080 → 720, sem degrau abaixo de HD');
});

test('pede h264 ao Cobalt (entrega direta, sem transcode)', () => {
  assert.match(FONTE_API, /youtubeVideoCodec:\s*'h264'/, 'vp9/av1 forçariam transcode e matariam a velocidade');
});

test('o módulo isolado não importa nada do server.js', () => {
  assert.doesNotMatch(FONTE, /require\(['"]\.\/server/, 'importar o server.js quebraria o isolamento');
});

// ── 5. tetos ────────────────────────────────────────────────────────────────
test('teto de shorts é rede de segurança, não corte no uso normal', () => {
  // O dono pediu o canal INTEIRO. O teto só existe pra canal gigante não virar
  // job infinito — tem que caber com folga um canal comum (dezenas/centenas).
  assert.ok(_interno.TETO_SHORTS >= 500, `teto ${_interno.TETO_SHORTS} cortaria canal comum`);
  assert.ok(_interno.TETO_SHORTS <= 5000, 'sem teto nenhum, um canal gigante trava o job');
  assert.ok(_interno.TETO_SIMULTANEO >= 1 && _interno.TETO_SIMULTANEO <= 4,
    'muitos yt-dlp simultâneos roubariam CPU do download normal');
});
