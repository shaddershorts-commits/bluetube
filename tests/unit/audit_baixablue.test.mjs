// tests/unit/audit_baixablue.test.mjs — node --test
//
// O vigia dos provedores deu VERDE em todos os 5 enquanto o Cobalt estava
// caído há semanas e o download de produção levava 45s. Três causas:
//   1. testava só o dQw4w9WgXcQ — o vídeo com tratamento especial no Google,
//      que funciona quando todo o resto falha
//   2. aceitava "o provedor respondeu" como sucesso, sem verificar bytes
//   3. o teste do Railway só perguntava se o serviço estava vivo, e não o que
//      de fato quebra: o Google devolve 403 pro IP de datacenter
// Estes testes impedem cada uma dessas de voltar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FONTE = readFileSync(new URL('../../api/audit-baixablue.js', import.meta.url), 'utf8');

test('não testa mais com um vídeo só — e nem com o que é exceção', () => {
  assert.doesNotMatch(FONTE, /const TEST_VIDEO_ID = 'dQw4w9WgXcQ'/,
    'esse vídeo passa quando todo o resto falha — testar com ele é o falso verde');
  assert.match(FONTE, /const POOL_VIDEOS = \[/, 'precisa de pool');
  const pool = FONTE.slice(FONTE.indexOf('const POOL_VIDEOS'), FONTE.indexOf('const TEST_VIDEO_ID'));
  const ids = pool.match(/'[\w-]{11}'/g) || [];
  assert.ok(ids.length >= 4, `pool com ${ids.length} vídeos é pouco pra variar`);
  assert.ok(!pool.includes('dQw4w9WgXcQ'), 'o vídeo-exceção não pode estar no pool');
});

test('o vídeo do teste varia com o tempo', () => {
  assert.match(FONTE, /POOL_VIDEOS\[new Date\(\)\.getUTCHours\(\) % POOL_VIDEOS\.length\]/,
    'sem rotação, o pool não serve de nada — testaria sempre o mesmo');
});

test('todo provedor precisa ENTREGAR BYTES, não só responder', () => {
  assert.match(FONTE, /async function entregaBytes/, 'precisa do verificador de bytes');
  // os 3 provedores que devolvem link têm que passar pelo verificador
  for (const p of ['cobalt', 'ytstream', 'youtube_media']) {
    const i = FONTE.indexOf(`async function test${p === 'cobalt' ? 'Cobalt' : p === 'ytstream' ? 'Ytstream' : 'YoutubeMedia'}`);
    assert.ok(i > 0, `função de teste do ${p} não encontrada`);
    const bloco = FONTE.slice(i, i + 2200);
    assert.match(bloco, /entregaBytes\(/, `${p} marca ok sem verificar bytes — foi assim que o Cobalt passou quebrado`);
    assert.match(bloco, /link sem bytes/, `${p} precisa reportar quando o link não entrega`);
  }
});

test('a amostra é pequena o bastante pra rodar de 6 em 6h sem pesar', () => {
  const bytes = Number((FONTE.match(/const AMOSTRA_BYTES = (\d+)/) || [])[1]);
  assert.ok(bytes >= 65536, 'amostra muito pequena não prova que o vídeo baixa');
  assert.ok(bytes <= 2 * 1024 * 1024, `amostra de ${bytes} bytes × 5 provedores × 4x/dia pesa à toa`);
});

test('existe teste do que realmente quebra: o IP do container', () => {
  assert.match(FONTE, /async function testRailwayMedia/,
    'o Google 403a o IP de datacenter na mídia — é isso que derruba a cadeia');
  assert.match(FONTE, /testRailwayMedia\(\),/, 'de nada adianta existir e não ser chamado no handler');
  const bloco = FONTE.slice(FONTE.indexOf('async function testRailwayMedia'), FONTE.indexOf('async function testInvidious'));
  assert.match(bloco, /proxy-download/, 'tem que exercitar o caminho real de busca de mídia');
  assert.match(bloco, /IP do container bloqueado/, 'e dizer claramente o que aconteceu');
});

test('provedor sem chave configurada não vira falso verde', () => {
  for (const marca of ['COBALT_API_URL nao configurada', 'RAPIDAPI_KEY nao configurada']) {
    assert.ok(FONTE.includes(marca), `falta tratar ausência de config: ${marca}`);
  }
});

test('o resultado de cada checagem é gravado pra dar histórico', () => {
  assert.match(FONTE, /download_health_log/, 'sem histórico não dá pra ver degradação chegando');
  assert.match(FONTE, /getConsecutiveFailures/, 'alerta só depois de N falhas evita alarme por soluço');
});
