// tests/unit/baixablue_carga.test.mjs — node --test
//
// Proteção de carga do BaixaBlue (2026-08-03). O /youtube-process fazia
// re-encode libx264 -preset medium SEM teto nenhum: um punhado de downloads
// simultâneos saturava a CPU do container e derrubava todo mundo junto.
// Mesma classe do bug que a fila do BaixaTudo tinha (cap virou código morto).
//
// Estes testes leem a fonte porque o server.js do Railway não roda aqui
// (sem node_modules local — Docker instala no build).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SERVER = readFileSync(new URL('../../railway-ffmpeg/server.js', import.meta.url), 'utf8');
const FRONT = readFileSync(new URL('../../public/baixaBlue.html', import.meta.url), 'utf8');

test('o BlueMetadata tem teto de jobs simultâneos', () => {
  assert.match(SERVER, /const BM_TETO = parseInt\(process\.env\.BLUEMETADATA_CONCURRENCY/,
    'sem teto, re-encode simultâneo satura a CPU do container');
  assert.match(SERVER, /if \(bmRodando >= BM_TETO\)/, 'o teto precisa ser verificado');
  assert.match(SERVER, /bmRodando\+\+/, 'e o contador incrementado');
});

test('o teto é generoso mas não infinito', () => {
  const padrao = Number((SERVER.match(/BLUEMETADATA_CONCURRENCY \|\| '(\d+)'/) || [])[1]);
  assert.ok(padrao >= 2, `teto ${padrao} é apertado demais pro uso normal`);
  assert.ok(padrao <= 6, `teto ${padrao} não protege: re-encode é a operação mais cara do container`);
});

test('o contador NÃO vaza — solta no cleanup e também se o cliente sumir', () => {
  assert.match(SERVER, /const bmSoltar = \(\) => \{ if \(!bmSolto\)/,
    'soltar tem que ser idempotente: chamar duas vezes não pode zerar contador dos outros');
  assert.match(SERVER, /res\.on\('close', bmSoltar\)/,
    'cliente que fecha a aba no meio precisa liberar a vaga');
  assert.match(SERVER, /const cleanup = \(\) => \{ bmSoltar\(\);/,
    'o cleanup do job também solta');
});

test('fila cheia responde 429 com Retry-After (não 500 nem silêncio)', () => {
  // ⚠️ o índice final PRECISA começar do início do bloco: 'const jobId =
  // uuidv4()' aparece em vários handlers, e indexOf sem posição pega o
  // primeiro do arquivo → recorte vazio → teste falha por motivo errado.
  const ini = SERVER.indexOf('if (bmRodando >= BM_TETO)');
  const bloco = SERVER.slice(ini, SERVER.indexOf('const jobId = uuidv4()', ini));
  assert.ok(bloco.length > 50, 'recorte do bloco falhou');
  assert.match(bloco, /Retry-After/, 'sem Retry-After o front martela e piora a fila');
  assert.match(bloco, /res\.status\(429\)/);
  assert.doesNotMatch(bloco, /error: 'erro'|500/, 'fila cheia não é erro do servidor');
});

test('o front do BaixaBlue explica o 429 em vez de culpar o vídeo', () => {
  assert.match(FRONT, /r\.status === 429/, 'precisa tratar 429 explicitamente');
  const trecho = FRONT.slice(FRONT.indexOf('r.status === 429'), FRONT.indexOf('r.status === 429') + 400);
  assert.match(trecho, /friendly =/, 'tem que virar mensagem amigável');
  assert.doesNotMatch(trecho, /não foi possível baixar esse vídeo/i,
    'cair no genérico faz o usuário achar que o vídeo é que tem problema');
});

test('a fila do BaixaBlue é INDEPENDENTE da do BaixaTudo', () => {
  // contadores distintos: uma feature encher a fila não pode travar a outra
  assert.match(SERVER, /let bmRodando = 0/);
  const baixatudo = readFileSync(new URL('../../railway-ffmpeg/baixatudo.js', import.meta.url), 'utf8');
  assert.match(baixatudo, /let rodando = 0/);
  assert.doesNotMatch(baixatudo, /bmRodando|BM_TETO/, 'BaixaTudo não pode enxergar a fila do BaixaBlue');
  assert.doesNotMatch(SERVER.slice(SERVER.indexOf('app.post(\'/youtube-process\'')),
    /TETO_SIMULTANEO/, 'BaixaBlue não pode enxergar a fila do BaixaTudo');
});

test('o vigia dos provedores finalmente tem cron', () => {
  const wf = readFileSync(new URL('../../.github/workflows/audit-baixablue.yml', import.meta.url), 'utf8');
  assert.match(wf, /cron: '[\d\s*\/]+'/, 'precisa de agendamento');
  assert.match(wf, /api\/audit-baixablue/, 'precisa chamar o endpoint certo');
  // memória da casa: GH Actions cron abaixo de 1h é best-effort e falha muito
  const minutos = wf.match(/cron: '(\d+) \*\/(\d+)/);
  assert.ok(minutos, 'formato de cron esperado: minuto + intervalo de horas');
  assert.ok(Number(minutos[2]) >= 1, 'cadência mínima de 1h — abaixo disso o GH Actions não entrega');
  assert.notEqual(minutos[1], '0', 'minuto :00 pega o pico do GitHub Actions');
});
