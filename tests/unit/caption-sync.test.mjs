// tests/unit/caption-sync.test.mjs
// A legenda ancorada na fala (item 5 do teste do user, 2026-08-05).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arquivoParaTimeline, timelineParaArquivo, assinaturaDoPlano, ancorar, ressincronizar,
} from '../../public/editor-v1/core/caption-sync.js';

const planoSimples = {
  url: 'a.mp4',
  segments: [{ tStart: 0, fileIn: 0, fileOut: 30, speed: 1 }],
};
// o user tirou o pedaço 1s..2s do arquivo: o que vinha depois andou 1s pra trás
const planoCortado = {
  url: 'a.mp4',
  segments: [
    { tStart: 0, fileIn: 0, fileOut: 1, speed: 1 },
    { tStart: 1, fileIn: 2, fileOut: 30, speed: 1 },
  ],
};
const planoRapido = {
  url: 'a.mp4',
  segments: [{ tStart: 0, fileIn: 0, fileOut: 30, speed: 2 }],
};

const legenda = (p = {}) => ({
  id: 1, caption: true, content: 'oi',
  start_sec: 5, end_sec: 5.4, src_in: 5, src_out: 5.4, src_url: 'a.mp4',
  ...p,
});

test('arquivo -> timeline: identidade quando nada foi cortado', () => {
  assert.equal(arquivoParaTimeline(5, planoSimples.segments), 5);
});

test('arquivo -> timeline: respeita o corte no meio', () => {
  assert.equal(arquivoParaTimeline(0.5, planoCortado.segments), 0.5);
  assert.equal(arquivoParaTimeline(5, planoCortado.segments), 4);
});

test('arquivo -> timeline: fala dentro do trecho removido devolve null', () => {
  assert.equal(arquivoParaTimeline(1.5, planoCortado.segments), null);
});

test('arquivo -> timeline: velocidade 2x corta o tempo pela metade', () => {
  assert.equal(arquivoParaTimeline(10, planoRapido.segments), 5);
});

test('timeline -> arquivo é a volta exata (inclusive com velocidade)', () => {
  for (const p of [planoSimples, planoCortado, planoRapido]) {
    for (const ft of [0.2, 3, 7.5]) {
      const t = arquivoParaTimeline(ft, p.segments);
      if (t == null) continue;
      assert.ok(Math.abs(timelineParaArquivo(t, p.segments) - ft) < 1e-9,
        `ida e volta falhou em ${ft}`);
    }
  }
});

test('assinatura muda quando o mapa muda e só quando ele muda', () => {
  assert.equal(assinaturaDoPlano(planoSimples), assinaturaDoPlano({ ...planoSimples }));
  assert.notEqual(assinaturaDoPlano(planoSimples), assinaturaDoPlano(planoCortado));
  assert.notEqual(assinaturaDoPlano(planoSimples), assinaturaDoPlano(planoRapido));
  assert.equal(assinaturaDoPlano(null), '');
});

test('ancorar grava onde a fala está dentro do arquivo', () => {
  const t = ancorar({ start_sec: 4, end_sec: 4.5 }, planoCortado);
  assert.equal(t.src_in, 5);      // 4s de timeline = 5s de arquivo
  assert.equal(t.src_out, 5.5);
  assert.equal(t.src_url, 'a.mp4');
});

test('o user corta o vídeo: a legenda anda junto com a fala', () => {
  const antes = [legenda()];
  const sig = assinaturaDoPlano(planoSimples);
  const r = ressincronizar(antes, planoCortado, sig);
  assert.equal(r.mudou, true);
  assert.equal(r.texts[0].start_sec, 4);
  assert.ok(Math.abs(r.texts[0].end_sec - 4.4) < 1e-9);
});

test('fala que caiu no trecho removido some da tela mas guarda a âncora', () => {
  const antes = [legenda({ start_sec: 1.5, end_sec: 1.8, src_in: 1.5, src_out: 1.8 })];
  const r = ressincronizar(antes, planoCortado, assinaturaDoPlano(planoSimples));
  assert.equal(r.texts[0].active, false);
  assert.equal(r.texts[0].src_in, 1.5, 'a âncora sobrevive: desfazer o corte traz a legenda de volta');
});

test('desfazer o corte reativa a legenda no lugar certo', () => {
  const some = ressincronizar(
    [legenda({ start_sec: 1.5, end_sec: 1.8, src_in: 1.5, src_out: 1.8 })],
    planoCortado, assinaturaDoPlano(planoSimples));
  const volta = ressincronizar(some.texts, planoSimples, some.sig);
  assert.equal(volta.texts[0].active, true);
  assert.equal(volta.texts[0].start_sec, 1.5);
});

test('mapa igual: legenda arrastada pela mão do user é RE-ANCORADA (não volta)', () => {
  const sig = assinaturaDoPlano(planoSimples);
  const arrastada = [legenda({ start_sec: 12, end_sec: 12.4 })];
  const r = ressincronizar(arrastada, planoSimples, sig);
  assert.equal(r.texts[0].start_sec, 12, 'não pode teleportar de volta');
  assert.equal(r.texts[0].src_in, 12, 'a âncora acompanha a mão');
  // e no corte seguinte ela anda a partir do NOVO lugar
  const r2 = ressincronizar(r.texts, planoCortado, r.sig);
  assert.equal(r2.texts[0].start_sec, 11);
});

test('dividir a legenda (muda só o fim) também re-ancora', () => {
  const sig = assinaturaDoPlano(planoSimples);
  const metade = [legenda({ end_sec: 5.2 })]; // Ctrl+B cortou no meio
  const r = ressincronizar(metade, planoSimples, sig);
  assert.equal(r.texts[0].src_out, 5.2);
  const r2 = ressincronizar(r.texts, planoCortado, r.sig);
  assert.ok(Math.abs((r2.texts[0].end_sec - r2.texts[0].start_sec) - 0.2) < 1e-9,
    'a metade continua metade depois do corte de vídeo');
});

test('texto comum (não legenda) nunca é tocado', () => {
  const comum = [{ id: 9, caption: false, start_sec: 5, end_sec: 6 }];
  const r = ressincronizar(comum, planoCortado, assinaturaDoPlano(planoSimples));
  assert.equal(r.mudou, false);
  assert.equal(r.texts[0].start_sec, 5);
});

test('legenda antiga sem âncora é deixada em paz (projeto salvo antes disso)', () => {
  const antiga = [{ id: 9, caption: true, start_sec: 5, end_sec: 6 }];
  const r = ressincronizar(antiga, planoCortado, assinaturaDoPlano(planoSimples));
  assert.equal(r.mudou, false);
});

test('âncora de OUTRA fonte de áudio não é sincronizada por engano', () => {
  const outra = [legenda({ src_url: 'b.mp3' })];
  const r = ressincronizar(outra, planoCortado, assinaturaDoPlano(planoSimples));
  assert.equal(r.mudou, false);
  assert.equal(r.texts[0].start_sec, 5);
});

test('sem plano de áudio nenhuma legenda é destruída', () => {
  const r = ressincronizar([legenda()], null, 'sig-velha');
  assert.equal(r.mudou, false);
  assert.equal(r.texts[0].start_sec, 5);
  assert.equal(r.sig, 'sig-velha', 'a assinatura antiga é preservada');
});

test('chamar duas vezes seguidas não muda nada (idempotente)', () => {
  const sig = assinaturaDoPlano(planoSimples);
  const r1 = ressincronizar([legenda()], planoCortado, sig);
  const r2 = ressincronizar(r1.texts, planoCortado, r1.sig);
  assert.equal(r2.mudou, false);
  assert.equal(r2.texts, r1.texts, 'devolve o MESMO array quando nada muda');
});

test('300 legendas: uma passada só, sem cópia quando nada muda', () => {
  const muitas = Array.from({ length: 300 }, (_, i) => legenda({
    id: i, start_sec: i * 0.1, end_sec: i * 0.1 + 0.09,
    src_in: i * 0.1, src_out: i * 0.1 + 0.09,
  }));
  const sig = assinaturaDoPlano(planoSimples);
  const r = ressincronizar(muitas, planoSimples, sig);
  assert.equal(r.mudou, false);
  assert.equal(r.texts, muitas);
});
