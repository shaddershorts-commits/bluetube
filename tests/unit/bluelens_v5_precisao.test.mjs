// tests/unit/bluelens_v5_precisao.test.mjs — node --test
//
// A v5 nasceu de um probe real (31/07): busca pela CAPA e busca por um QUADRO
// do mesmo viral devolveram 7+7 candidatos SEM UM em comum — prova de que uma
// imagem sozinha mede "se parece", não "é o mesmo vídeo".
//
// O que este arquivo trava:
//  1. O random típico do probe fica ABAIXO do piso (era ele o "vídeo aleatório")
//  2. O repost de verdade (interseção e/ou duração idêntica) fica ACIMA
//  3. A fusão de duas buscas conta frames certo
//  4. TikTok é canonicalizado pra interseção funcionar entre URLs diferentes
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { scoreV5, titleSim, mergeSerpResults, extractTikTokId, PISO_EXIBICAO } =
  require('../../api/bluelens-fingerprint.js');

const USER = { title: 'Homem levanta 300kg só com técnica impressionante', channel: 'CanalDoUser', duration: 34 };

// ── 1. o que TEM que ficar abaixo do piso ──────────────────────────────────
test('o random do probe (1 quadro, rank bom, duração desconhecida) fica ABAIXO do piso', () => {
  const s = scoreV5({ frames: 1, bestRank: 1, title: 'Gato dança forró engraçado demais', channel: 'OutroCanal' }, USER);
  assert.ok(s < PISO_EXIBICAO, `random passou: ${s} >= ${PISO_EXIBICAO}`);
});

test('duração MUITO diferente agora SUBTRAI (no v4 esse caso saía com 60%)', () => {
  const comConflito = scoreV5({ frames: 1, bestRank: 1, duration: 300, title: 'x', channel: 'Outro' }, USER);
  const semDuracao = scoreV5({ frames: 1, bestRank: 1, title: 'x', channel: 'Outro' }, USER);
  assert.ok(comConflito < semDuracao, 'conflito de duração não puniu');
  assert.ok(comConflito < PISO_EXIBICAO, 'vídeo de 5min "parecido" com Short de 34s passou: ' + comConflito);
});

// ── 2. o que TEM que ficar acima ───────────────────────────────────────────
test('interseção (2 quadros) + duração idêntica = quase certeza', () => {
  const s = scoreV5({ frames: 2, bestRank: 0, duration: 34, title: 'homem levanta 300kg tecnica', channel: 'Repostador' }, USER);
  assert.ok(s >= 90, 'repost óbvio ficou baixo: ' + s);
  assert.ok(s <= 95, 'nunca afirmar 100% sem fingerprint: ' + s);
});

test('interseção sozinha (sem metadata nenhuma) já passa do piso', () => {
  // YT API fora do ar: sem duração/título. O sinal dos 2 quadros segura.
  const s = scoreV5({ frames: 2, bestRank: 2 }, USER);
  assert.ok(s >= PISO_EXIBICAO, 'interseção não segurou sozinha: ' + s);
});

test('1 quadro + duração idêntica ao segundo também passa (repost com capa própria)', () => {
  const s = scoreV5({ frames: 1, bestRank: 4, duration: 34, channel: 'Outro' }, USER);
  assert.ok(s >= PISO_EXIBICAO, 'repost de capa própria ficou fora: ' + s);
});

// ── 3. fusão das buscas ────────────────────────────────────────────────────
test('mergeSerpResults marca frames=2 pra quem aparece nas duas', () => {
  const A = { youtube_ids: ['aaa', 'bbb'], other_platforms: [{ url: 'https://www.tiktok.com/@x/video/123456789', platform: 'tiktok' }] };
  const B = { youtube_ids: ['bbb', 'ccc'], other_platforms: [{ url: 'https://tiktok.com/@x/video/123456789?lang=pt', platform: 'tiktok' }] };
  const f = mergeSerpResults(A, B);
  const porId = Object.fromEntries(f.youtube.map(c => [c.id, c]));
  assert.equal(porId.aaa.frames, 1);
  assert.equal(porId.bbb.frames, 2, 'bbb apareceu nas duas e não foi marcado');
  assert.equal(porId.ccc.frames, 1);
  assert.equal(f.web.length, 1, 'o MESMO TikTok em URLs diferentes tinha que fundir');
  assert.equal(f.web[0].frames, 2);
});

test('mergeSerpResults com uma busca só (degradação) não quebra', () => {
  const f = mergeSerpResults({ youtube_ids: ['x1'], other_platforms: [] }, null);
  assert.equal(f.youtube.length, 1);
  assert.equal(f.youtube[0].frames, 1);
});

test('bestRank guarda o MELHOR rank entre as duas buscas', () => {
  const f = mergeSerpResults(
    { youtube_ids: ['a', 'b', 'c', 'z'], other_platforms: [] },   // z em rank 3
    { youtube_ids: ['z'], other_platforms: [] }                    // z em rank 0
  );
  assert.equal(f.youtube.find(c => c.id === 'z').bestRank, 0);
});

// ── 4. TikTok ──────────────────────────────────────────────────────────────
test('extractTikTokId cobre os formatos reais de URL', () => {
  assert.equal(extractTikTokId('https://www.tiktok.com/@fulano/video/7301234567890123456'), '7301234567890123456');
  assert.equal(extractTikTokId('https://tiktok.com/@a.b_c/video/999888777?is_from_webapp=1'), '999888777');
  assert.equal(extractTikTokId('https://www.tiktok.com/embed/v2/7301234567890123456'), '7301234567890123456');
  assert.equal(extractTikTokId('https://vm.tiktok.com/ZMabcdef/'), null, 'link curto não tem id — não chutar');
  assert.equal(extractTikTokId('https://www.youtube.com/watch?v=abc'), null);
});

// ── 5. título ──────────────────────────────────────────────────────────────
test('titleSim tolera acento e pontuação; e nunca vira pena no score', () => {
  assert.ok(titleSim('Homem levanta 300kg só com TÉCNICA!', 'homem levanta 300kg so com tecnica') >= 0.9);
  assert.equal(titleSim('', 'qualquer coisa'), 0);
  // título totalmente diferente NÃO pode reduzir o score (repost traduzido)
  const sem = scoreV5({ frames: 2, bestRank: 0, duration: 34 }, USER);
  const com = scoreV5({ frames: 2, bestRank: 0, duration: 34, title: '完全に違うタイトル' }, USER);
  assert.ok(com >= sem, 'título diferente puniu — quebraria repost traduzido');
});
