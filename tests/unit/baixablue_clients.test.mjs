// tests/unit/baixablue_clients.test.mjs — node --test
//
// A CAUSA RAIZ do teto de 360p (achada em 04/08): a lista de player_client
// no server.js citava clients que NÃO EXISTEM MAIS no yt-dlp. Ele descarta
// client inválido em silêncio ("Skipping unsupported client") e sobrava só o
// que oferece o format 18 — 360p. Não era bloqueio de IP, era configuração
// morta.
//
// Medido dentro do container de produção com a lista corrigida:
//   48 MB · 1920x1080 · h264+aac · 3 segundos
//   12 downloads simultâneos · 12/12 · 4 segundos · zero 403
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SERVER = readFileSync(new URL('../../railway-ffmpeg/server.js', import.meta.url), 'utf8');

// Clients que o yt-dlp de fato conhece (INNERTUBE_CLIENTS). Se um dia
// mudarem, este teste avisa antes do usuário descobrir baixando 360p.
const CLIENTS_VALIDOS = new Set([
  'web', 'web_safari', 'web_embedded', 'web_music', 'web_creator',
  'android', 'android_vr', 'ios', 'visionos', 'mweb',
  'tv', 'tv_downgraded', 'tv_simply', 'default',
]);

test('nenhum player_client inexistente (é o que causava o teto de 360p)', () => {
  const listas = [...SERVER.matchAll(/youtube:player_client=([\w,]+)/g)].map((m) => m[1]);
  assert.ok(listas.length > 0, 'nenhuma lista de client encontrada');
  for (const lista of listas) {
    for (const c of lista.split(',')) {
      assert.ok(CLIENTS_VALIDOS.has(c),
        `"${c}" não existe no yt-dlp — ele descarta em silêncio e sobra 360p`);
    }
  }
});

test('os clients mortos específicos não voltam', () => {
  for (const morto of ['tv_embedded', 'android_testsuite']) {
    assert.ok(!SERVER.includes('player_client=' + morto) && !SERVER.includes(',' + morto),
      `${morto} foi removido do yt-dlp — era metade da lista antiga`);
  }
});

test('não usa player_client=default (vira tv_downgraded,web e mata o HD)', () => {
  // Medido: com cookies VÁLIDOS, default resolve pra ('tv_downgraded','web'),
  // e web precisa de runtime JS que a imagem não tem → "Requested format is
  // not available", zero formatos. Fixar os clients deixa o comportamento
  // igual com ou sem cookie.
  assert.ok(!SERVER.includes('player_client=default'),
    'default é uma bomba-relógio: quebra no dia em que o cookie for renovado');
});

test('não usa tv_simply (dá bot-check em IP de datacenter)', () => {
  assert.ok(!SERVER.includes('tv_simply'),
    'medido: tv_simply sozinho → "Sign in to confirm you are not a bot"');
});

test('todas as listas de client são iguais entre si', () => {
  const listas = [...SERVER.matchAll(/youtube:player_client=([\w,]+)/g)].map((m) => m[1]);
  const unicas = [...new Set(listas)];
  assert.equal(unicas.length, 1,
    `${unicas.length} listas diferentes (${unicas.join(' | ')}) — divergência faz um caminho entregar HD e outro 360p`);
});

test('o seletor prioriza h264+AAC, não AV1+Opus', () => {
  // AV1/Opus não abre em Premiere, player nativo do Windows nem iPhone antigo.
  // Produto de download precisa entregar arquivo que a pessoa consiga usar.
  const seletores = [...SERVER.matchAll(/'-f', '(bv\*[^']+)'/g)].map((m) => m[1]);
  assert.ok(seletores.length >= 3, `achei ${seletores.length} seletores, esperava 3+`);
  for (const sel of seletores) {
    assert.ok(sel.startsWith('bv*[height<='),
      `seletor não começa pedindo altura limitada: ${sel.slice(0, 50)}`);
    assert.match(sel, /^bv\*\[height<=\d+\]\[vcodec\^=avc1\]\+ba\[acodec\^=mp4a\]/,
      `primeira escolha tem que ser avc1+mp4a: ${sel.slice(0, 60)}`);
    assert.ok(sel.includes('/'), 'precisa de degraus de fallback');
  }
});

test('o seletor ainda tem rede de segurança (não fica preso em avc1)', () => {
  const seletores = [...SERVER.matchAll(/'-f', '(bv\*[^']+)'/g)].map((m) => m[1]);
  for (const sel of seletores) {
    const degraus = sel.split('/');
    assert.ok(degraus.length >= 3,
      `só ${degraus.length} degraus: vídeo sem avc1 falharia em vez de cair pra outro codec`);
    assert.ok(degraus[degraus.length - 1].startsWith('best') || degraus[degraus.length - 1].startsWith('b'),
      'o último degrau tem que ser o mais permissivo');
  }
});
