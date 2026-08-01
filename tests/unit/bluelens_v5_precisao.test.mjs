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
const { scoreV5, mergeSerpResults, extractTikTokId, PISO_EXIBICAO } =
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


// ── v5.1: CONFIRMAÇÃO POR QUADRO (2026-08-01) ──────────────────────────────
// "A única forma mais confiável é por frame" (user). dHash perceptual:
// mesmo quadro recomprimido tem que bater; quadro diferente tem que divergir.
const { aplicarPixel, cortarWeb, dhashFromJpeg, hamming } = require('../../api/bluelens-fingerprint.js');

function jpegSintetico(pintar) {
  const jpeg = require('jpeg-js');
  const W = 64, H = 48, data = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = pintar(x / W, y / H);
    const i = (y * W + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return jpeg.encode({ data, width: W, height: H }, 80).data;
}

test('dHash: mesmo quadro RECOMPRIMIDO bate (o caso real de repost)', () => {
  const gradiente = (fx, fy) => [Math.round(fx * 255), Math.round(fy * 255), 128];
  const jpeg = require('jpeg-js');
  const a = dhashFromJpeg(jpegSintetico(gradiente));
  // recomprime a mesma imagem em qualidade bem menor (reupload típico)
  const dec = jpeg.decode(jpegSintetico(gradiente), { useTArray: true });
  const rec = jpeg.encode({ data: Buffer.from(dec.data), width: dec.width, height: dec.height }, 35).data;
  const b = dhashFromJpeg(rec);
  assert.ok(a != null && b != null, 'hash falhou');
  assert.ok(hamming(a, b) <= 6, 'mesmo quadro divergiu: ' + hamming(a, b));
});

test('dHash: quadros DIFERENTES divergem (flores vs xadrez)', () => {
  const flores = (fx, fy) => [200, Math.round(100 + 100 * Math.sin(fx * 20)), 80];
  const xadrez = (fx, fy) => ((Math.floor(fx * 8) + Math.floor(fy * 6)) % 2 ? [255, 255, 255] : [0, 0, 0]);
  const d = hamming(dhashFromJpeg(jpegSintetico(flores)), dhashFromJpeg(jpegSintetico(xadrez)));
  assert.ok(d > 16, 'imagens diferentes ficaram próximas: ' + d);
});

test('dHash: buffer inválido devolve null, nunca explode', () => {
  assert.equal(dhashFromJpeg(Buffer.from('nao sou jpeg')), null);
  assert.equal(dhashFromJpeg(Buffer.alloc(0)), null);
});

test('aplicarPixel: confirmado sobe pra 92+, rejeitado despenca pra <=35', () => {
  assert.equal(aplicarPixel(40, { minFull: 4, comparacoes: 8 }).pixel, 'confirmado');
  assert.ok(aplicarPixel(40, { minFull: 4, comparacoes: 8 }).score >= 92);
  assert.equal(aplicarPixel(80, { minFull: 40, minCentro: 38, comparacoes: 8 }).pixel, 'rejeitado');
  assert.ok(aplicarPixel(80, { minFull: 40, minCentro: 38, comparacoes: 8 }).score <= 35);
  assert.equal(aplicarPixel(50, { minFull: 13, comparacoes: 8 }).pixel, 'provavel');
});

test('aplicarPixel: sem evidência suficiente é NEUTRO (falha de rede não pune)', () => {
  assert.equal(aplicarPixel(70, { comparacoes: 0 }).pixel, null);
  assert.equal(aplicarPixel(70, { comparacoes: 0 }).score, 70);
  assert.equal(aplicarPixel(70, { minFull: 5, comparacoes: 1 }).pixel, null, 'uma comparação só não é prova');
});

test('cortarWeb: o caso do user — 1 confirmado + 30 flores aleatórias', () => {
  const lista = [
    { pixel: 'confirmado', confidence_pct: 92, frames: 1, platform: 'tiktok' },
    ...Array.from({ length: 30 }, () => ({ frames: 1, platform: 'instagram' })),
  ];
  const c = cortarWeb(lista);
  assert.equal(c.mostrar.length, 1, 'era pra sobrar SÓ o confirmado');
  assert.equal(c.ocultos, 30);
});

test('cortarWeb: rejeitado por pixel NUNCA aparece, mesmo com score alto', () => {
  const c = cortarWeb([
    { pixel: 'rejeitado', confidence_pct: 80, frames: 2 },
    { pixel: 'confirmado', confidence_pct: 92, frames: 1 },
  ]);
  assert.equal(c.mostrar.length, 1);
  assert.equal(c.mostrar[0].pixel, 'confirmado');
});

test('cortarWeb: ninguém com evidência → mostra topo 5, não lista vazia', () => {
  const c = cortarWeb(Array.from({ length: 12 }, () => ({ frames: 1 })));
  assert.equal(c.mostrar.length, 5);
  assert.equal(c.ocultos, 7);
});

// ── LEI DO FRAME (user, 01/08): "A ÚNICA FORMA TEM QUE SER FRAME" ──────────
// Caso real: "Bouquet dorato" (67%, quadro provável) e 2 "Touching wedding
// customs" (55%) apareciam como "postaram o mesmo vídeo". Cena parecida de
// casamento NÃO é o mesmo vídeo. Agora só quadro CONFIRMADO exibe.
const { filtrarMatchesYt } = require('../../api/bluelens-fingerprint.js');

test('o caso do print: só o confirmado fica; os 3 prováveis somem', () => {
  const f = filtrarMatchesYt([
    { pixel: 'confirmado', confidence_pct: 92, title: 'Bride Tapped A Lotus Bud' },
    { pixel: 'provavel', confidence_pct: 67, title: 'Bouquet dorato' },
    { pixel: 'provavel', confidence_pct: 55, title: 'Touching wedding customs' },
    { pixel: 'provavel', confidence_pct: 55, title: 'Touching wedding customs 2' },
  ], 10);
  assert.equal(f.matches.length, 1);
  assert.equal(f.matches[0].confidence_pct, 92);
  assert.equal(f.descartados, 3);
});

test('score alto SEM confirmação de quadro não exibe (nem 95% de heurística)', () => {
  const f = filtrarMatchesYt([{ confidence_pct: 95, frames: 2 }], 10);
  assert.equal(f.matches.length, 0, 'heurística sozinha não pode mais exibir');
});

test('zero confirmados = lista vazia honesta (não rebaixa o critério)', () => {
  const f = filtrarMatchesYt([
    { pixel: 'provavel', confidence_pct: 80 },
    { pixel: 'rejeitado', confidence_pct: 20 },
  ], 10);
  assert.equal(f.matches.length, 0);
  assert.equal(f.descartados, 2);
});

// ── v5.2: MIOLO DO QUADRO (2026-08-01) ─────────────────────────────────────
// O caso de uso central do produto (user): achar o MESMO vídeo sem as edições
// — legenda queimada, seta, moldura. O overlay vive nas bordas; o miolo 70%
// fica intacto. E texto saiu 100% do cérebro.
const { hashesDuplos } = require('../../api/bluelens-fingerprint.js');

test('LEGENDA QUEIMADA não engana o miolo: full diverge, centro bate', () => {
  const cena = (fx, fy) => [Math.round(fx * 255), Math.round((1 - fy) * 200), Math.round(fy * 255)];
  const comLegenda = (fx, fy) => (fy > 0.82 ? [255, 255, 255] : cena(fx, fy));   // faixa branca embaixo
  const a = hashesDuplos(jpegSintetico(cena));
  const b = hashesDuplos(jpegSintetico(comLegenda));
  const dFull = hamming(a.full, b.full), dCentro = hamming(a.centro, b.centro);
  assert.ok(dCentro <= 6, 'miolo deveria bater (overlay é na borda): ' + dCentro);
  assert.ok(dCentro < dFull || dFull <= 10, 'o miolo tem que ser mais robusto que o quadro cheio (full=' + dFull + ' centro=' + dCentro + ')');
});

test('miolo ≤8 confirma QUANDO a duração não conflita', () => {
  const r = aplicarPixel(45, { minFull: 14, minCentro: 5, comparacoes: 8, durConflito: false });
  assert.equal(r.pixel, 'confirmado');
  assert.equal(r.via, 'miolo');
  assert.ok(r.score >= 92);
});

test('miolo parecido + duração INCOMPATÍVEL = coincidência, não confirma', () => {
  const r = aplicarPixel(45, { minFull: 14, minCentro: 5, comparacoes: 8, durConflito: true });
  assert.notEqual(r.pixel, 'confirmado', 'vídeo de 5min não é repost de Short só porque o miolo parece');
});

test('quadro cheio ≤10 confirma mesmo com duração conflitante (compilação contém o clipe)', () => {
  const r = aplicarPixel(45, { minFull: 6, minCentro: 30, comparacoes: 8, durConflito: true });
  assert.equal(r.pixel, 'confirmado');
});

test('scoreV5 não tem MAIS nenhum sinal de texto', () => {
  const sem = scoreV5({ frames: 2, bestRank: 0, duration: 34 }, USER);
  const com = scoreV5({ frames: 2, bestRank: 0, duration: 34, title: USER.title }, USER);
  assert.equal(sem, com, 'título idêntico mudou o score — texto ainda participa');
});
