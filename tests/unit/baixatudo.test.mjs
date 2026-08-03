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

test('recusa o que não é perfil (vídeo avulso do YT, vazio, site aleatório)', () => {
  for (const ruim of ['', null, undefined, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                      'https://www.youtube.com/shorts/BUqlzukB1Mc', 'texto solto', 'https://vimeo.com/12345']) {
    assert.equal(_interno.urlDoCanal(ruim), null, `deveria recusar: ${ruim}`);
  }
});

// ── multi-plataforma (03/08) ────────────────────────────────────────────────
test('reconhece perfil de TikTok e Instagram', () => {
  const tt = _interno.resolverPerfil('https://www.tiktok.com/@artthuroficial_');
  assert.equal(tt.plataforma, 'tiktok');
  assert.equal(tt.url, 'https://www.tiktok.com/@artthuroficial_');
  assert.equal(tt.perfil, '@artthuroficial_');

  const ttComVideo = _interno.resolverPerfil('https://www.tiktok.com/@benji.gage/video/7643676827847757086');
  assert.equal(ttComVideo.plataforma, 'tiktok', 'link de vídeo deve cair no perfil dele');
  assert.equal(ttComVideo.url, 'https://www.tiktok.com/@benji.gage');

  const ig = _interno.resolverPerfil('https://www.instagram.com/nasa/');
  assert.equal(ig.plataforma, 'instagram');
  assert.equal(ig.url, 'https://www.instagram.com/nasa/');
});

test('não confunde POST do Instagram com PERFIL', () => {
  for (const post of ['https://www.instagram.com/reel/DZrtF6NNvqZ/',
                      'https://www.instagram.com/p/ABC123/',
                      'https://www.instagram.com/reels/XYZ/']) {
    const r = _interno.resolverPerfil(post);
    assert.notEqual(r?.perfil, '@reel', `tratou post como perfil: ${post}`);
    assert.notEqual(r?.perfil, '@p');
    assert.notEqual(r?.perfil, '@reels');
  }
});

test('monta a URL do vídeo certa por plataforma', () => {
  assert.equal(
    _interno.urlDoVideo('youtube', { id: 'poUrVmuTt6E' }, '@x'),
    'https://www.youtube.com/shorts/poUrVmuTt6E');
  // No TikTok o id sozinho não basta: o link carrega o @perfil
  assert.equal(
    _interno.urlDoVideo('tiktok', { id: '7637662127272021269' }, '@artthuroficial_'),
    'https://www.tiktok.com/@artthuroficial_/video/7637662127272021269');
  assert.equal(
    _interno.urlDoVideo('instagram', { id: 'DZrtF6NNvqZ' }, '@nasa'),
    'https://www.instagram.com/reel/DZrtF6NNvqZ/');
  // se o yt-dlp já devolveu url pronta, usa ela
  assert.equal(
    _interno.urlDoVideo('tiktok', { id: '1', url: 'https://www.tiktok.com/@a/video/9' }, '@b'),
    'https://www.tiktok.com/@a/video/9');
});

test('cookies são independentes POR REDE (uma queimar não derruba as outras)', () => {
  assert.match(FONTE, /BAIXATUDO_TIKTOK_COOKIES/);
  assert.match(FONTE, /BAIXATUDO_IG_COOKIES/);
  assert.doesNotMatch(FONTE, /process\.env\.YOUTUBE_COOKIES/, 'nunca a env do BaixaBlue');
});

test('TikTok pede H265 (é o que destrava 1080p; h264 dá 576x1024)', () => {
  const bloco = FONTE_API.slice(FONTE_API.indexOf('const tentativas'), FONTE_API.indexOf('let ultimo'));
  assert.ok(bloco.length > 20, 'bloco de tentativas não encontrado');
  assert.match(bloco, /rede === 'tiktok'/, 'o codec tem que ser decidido por rede');
  assert.match(bloco, /allowH265: true/, 'sem H265 o TikTok sai em 576x1024 — medido em 03/08');
});

test('action=link só aceita as 3 redes (nada de URL arbitrária)', async () => {
  globalThis.fetch = dublar({ chamadas: [] });
  const res = resFalso();
  await vercelHandler(
    { method: 'GET', headers: { authorization: 'Bearer tok' }, query: { action: 'link', url: 'https://evil.example.com/x' } },
    res
  );
  assert.equal(res._status, 400);
  assert.equal(res._json.error, 'url_invalida');
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
  const bloco = FONTE_API.slice(FONTE_API.indexOf('const tentativas'), FONTE_API.indexOf('let ultimo'));
  assert.ok(bloco.length > 20, 'cascata de qualidade não encontrada');
  const ordem = [...bloco.matchAll(/videoQuality: '(\w+)'/g)].map((m) => m[1]);
  assert.ok(ordem.length >= 2, 'deve haver cascata, não uma tentativa só');
  assert.ok(!ordem.includes('360') && !ordem.includes('480'),
    'nenhum degrau abaixo de HD — preferimos falhar a entregar 360p disfarçado');
  // no caminho não-TikTok a ordem é 1080 → 720
  assert.ok(bloco.includes("videoQuality: '1080'") && bloco.includes("videoQuality: '720'"));
  assert.ok(bloco.indexOf("'1080'") < bloco.indexOf("videoQuality: '720', youtubeVideoCodec"),
    '1080 tem que ser tentado antes de 720');
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
