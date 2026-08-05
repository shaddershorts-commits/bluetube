// tests/unit/silencio.test.mjs — detector de respiro (motor do "Cortar respiros")
//
// O user: "não quero apenas fachada, mas que realmente funcione". Estes testes
// são a régua: sinal sintético com fala e silêncio conhecidos, e o detector tem
// que achar as bordas certas — em gravação alta E em gravação baixinha.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectarFala, niveisRms, pisoDeRuido, resumoDoCorte, PADRAO,
} from '../../public/editor-v1/core/silencio.js';
import { createStore } from '../../public/editor-v1/core/store.js';
import * as act from '../../public/editor-v1/core/actions.js';
import { totalDuration } from '../../public/editor-v1/core/selectors.js';

const SR = 16000;

/** monta um sinal: trechos [{tipo:'tom'|'silencio'|'ruido', dur, amp}] */
function sinal(partes) {
  const total = partes.reduce((s, p) => s + Math.round(p.dur * SR), 0);
  const out = new Float32Array(total);
  let i = 0;
  for (const p of partes) {
    const n = Math.round(p.dur * SR);
    for (let k = 0; k < n; k++, i++) {
      if (p.tipo === 'tom') out[i] = (p.amp ?? 0.5) * Math.sin(2 * Math.PI * 220 * k / SR);
      else if (p.tipo === 'ruido') out[i] = (p.amp ?? 0.001) * (Math.random() * 2 - 1);
      else out[i] = 0;
    }
  }
  return out;
}

test('acha 2 falas separadas por um silêncio', () => {
  const s = sinal([
    { tipo: 'tom', dur: 1 }, { tipo: 'silencio', dur: 0.8 }, { tipo: 'tom', dur: 1 },
  ]);
  const r = detectarFala(s, SR);
  assert.equal(r.falas.length, 2, 'duas falas');
  assert.equal(r.cortes.length, 1, 'um respiro no meio');
});

test('as bordas caem perto do lugar certo (±80ms com a folga)', () => {
  const s = sinal([
    { tipo: 'tom', dur: 1 }, { tipo: 'silencio', dur: 0.8 }, { tipo: 'tom', dur: 1 },
  ]);
  const r = detectarFala(s, SR);
  assert.ok(Math.abs(r.falas[0].in - 0) < 0.08, 'começo: ' + r.falas[0].in);
  assert.ok(Math.abs(r.falas[0].out - 1) < 0.16, 'fim da 1ª: ' + r.falas[0].out);
  assert.ok(Math.abs(r.falas[1].in - 1.8) < 0.16, 'início da 2ª: ' + r.falas[1].in);
});

test('gravação BAIXINHA é detectada igual (piso adaptativo, não limiar fixo)', () => {
  const alto = sinal([{ tipo: 'tom', dur: 1, amp: 0.9 }, { tipo: 'silencio', dur: 0.8 }, { tipo: 'tom', dur: 1, amp: 0.9 }]);
  const baixo = sinal([{ tipo: 'tom', dur: 1, amp: 0.02 }, { tipo: 'silencio', dur: 0.8 }, { tipo: 'tom', dur: 1, amp: 0.02 }]);
  assert.equal(detectarFala(alto, SR).falas.length, 2);
  assert.equal(detectarFala(baixo, SR).falas.length, 2, 'gravação baixa NÃO pode virar "tudo silêncio"');
});

test('ruído de fundo constante NÃO vira fala', () => {
  const s = sinal([{ tipo: 'ruido', dur: 2, amp: 0.002 }]);
  const r = detectarFala(s, SR);
  assert.equal(r.falas.length, 0, 'chiado não é fala');
});

test('sala com chiado + fala: só a fala é mantida', () => {
  const s = sinal([
    { tipo: 'ruido', dur: 0.7, amp: 0.003 },
    { tipo: 'tom', dur: 1, amp: 0.4 },
    { tipo: 'ruido', dur: 0.9, amp: 0.003 },
  ]);
  const r = detectarFala(s, SR);
  assert.equal(r.falas.length, 1, 'uma fala no meio do chiado');
  assert.ok(r.cortes.length >= 1, 'o chiado virou respiro pra cortar');
});

test('estalo de UM quadro no meio do silêncio NÃO abre fala (histerese)', () => {
  const s = sinal([
    { tipo: 'tom', dur: 0.6 }, { tipo: 'silencio', dur: 0.5 },
    { tipo: 'tom', dur: 0.004 },                    // clique de 4ms
    { tipo: 'silencio', dur: 0.5 }, { tipo: 'tom', dur: 0.6 },
  ]);
  const r = detectarFala(s, SR);
  assert.equal(r.falas.length, 2, 'o estalo não pode virar uma 3ª fala');
});

test('pausa CURTA (ritmo da frase) não é cortada', () => {
  const s = sinal([
    { tipo: 'tom', dur: 0.8 }, { tipo: 'silencio', dur: 0.15 }, { tipo: 'tom', dur: 0.8 },
  ]);
  const r = detectarFala(s, SR);
  assert.equal(r.falas.length, 1, 'vírgula não é respiro — vira uma fala só');
});

test('áudio 100% falado não tem o que cortar', () => {
  const r = detectarFala(sinal([{ tipo: 'tom', dur: 2 }]), SR);
  assert.equal(r.falas.length, 1);
  assert.equal(r.removido, 0);
});

test('áudio 100% silêncio não devolve fala nenhuma', () => {
  const r = detectarFala(sinal([{ tipo: 'silencio', dur: 2 }]), SR);
  assert.equal(r.falas.length, 0);
  assert.equal(r.cortes.length, 1);
});

test('as falas nunca se sobrepõem e estão em ordem', () => {
  const s = sinal([
    { tipo: 'tom', dur: 0.5 }, { tipo: 'silencio', dur: 0.5 },
    { tipo: 'tom', dur: 0.5 }, { tipo: 'silencio', dur: 0.5 },
    { tipo: 'tom', dur: 0.5 },
  ]);
  const r = detectarFala(s, SR);
  for (let i = 1; i < r.falas.length; i++) {
    assert.ok(r.falas[i].in >= r.falas[i - 1].out, 'sem sobreposição');
  }
});

test('falas + cortes cobrem o áudio inteiro, sem buraco nem sobra', () => {
  const s = sinal([
    { tipo: 'tom', dur: 0.6 }, { tipo: 'silencio', dur: 0.6 }, { tipo: 'tom', dur: 0.6 },
  ]);
  const r = detectarFala(s, SR);
  const soma = [...r.falas, ...r.cortes].reduce((a, x) => a + (x.out - x.in), 0);
  assert.ok(Math.abs(soma - r.duracao) < 0.05, `${soma.toFixed(2)} vs ${r.duracao.toFixed(2)}`);
});

test('nenhum trecho tem duração negativa ou zero', () => {
  const s = sinal([{ tipo: 'tom', dur: 0.4 }, { tipo: 'silencio', dur: 0.5 }, { tipo: 'tom', dur: 0.4 }]);
  const r = detectarFala(s, SR);
  for (const x of [...r.falas, ...r.cortes]) assert.ok(x.out > x.in, JSON.stringify(x));
});

test('sensibilidade MENOR corta menos (o ajuste do usuário tem efeito)', () => {
  const s = sinal([
    { tipo: 'tom', dur: 0.6, amp: 0.5 }, { tipo: 'ruido', dur: 0.6, amp: 0.02 },
    { tipo: 'tom', dur: 0.6, amp: 0.5 },
  ]);
  const agressivo = detectarFala(s, SR, { margemDb: 14 });
  const suave = detectarFala(s, SR, { margemDb: 2 });
  assert.ok(agressivo.removido >= suave.removido, 'mais margem = corta mais');
});

test('o resumo bate com o que foi detectado', () => {
  const s = sinal([{ tipo: 'tom', dur: 1 }, { tipo: 'silencio', dur: 1 }, { tipo: 'tom', dur: 1 }]);
  const r = detectarFala(s, SR);
  const res = resumoDoCorte(r);
  assert.equal(res.respiros, r.cortes.length);
  assert.ok(res.duracaoFinal < r.duracao, 'o vídeo encurta');
  assert.ok(res.ganhoPct > 0 && res.ganhoPct < 100);
});

test('piso de ruído fica ABAIXO do nível da fala', () => {
  const s = sinal([{ tipo: 'tom', dur: 1, amp: 0.5 }, { tipo: 'ruido', dur: 1, amp: 0.002 }]);
  const { niveis } = niveisRms(s, SR);
  const piso = pisoDeRuido(niveis);
  assert.ok(piso < -40, 'piso do chiado: ' + piso.toFixed(1) + ' dBFS');
});

test('sinal vazio não quebra', () => {
  const r = detectarFala(new Float32Array(0), SR);
  assert.deepEqual(r.falas, []);
  assert.equal(r.duracao, 0);
});

// ── APLICAÇÃO: as falas viram pedaços colados, em UM undo ──

function projetoVideo(dur = 30) {
  const store = createStore();
  store.dispatch(act.setVideo({ url: 'u', path: 'p', filename: 'v.mp4', duration: dur, width: 1080, height: 1920, size_bytes: 1 }));
  return store;
}

test('VÍDEO: cortar respiros entrega um clipe COMPOSTO com as falas', () => {
  const store = projetoVideo();
  const id = store.getState().clips[0].id;
  store.dispatch(act.cutSilence('clip', id, [{ in: 0, out: 3 }, { in: 5, out: 9 }, { in: 12, out: 14 }]));
  const s = store.getState();
  assert.equal(s.compounds.length, 1, 'virou composto');
  assert.equal(s.compounds[0].clips.length, 3, 'uma cena por fala');
  assert.ok(s.clips.some(c => c.compound_id === s.compounds[0].id), 'com stub na timeline');
});

test('VÍDEO: a duração final é a soma das falas (os respiros saíram)', () => {
  const store = projetoVideo();
  store.dispatch(act.cutSilence('clip', store.getState().clips[0].id,
    [{ in: 0, out: 3 }, { in: 5, out: 9 }]));
  assert.ok(Math.abs(totalDuration(store.getState()) - 7) < 0.01,
    'dur=' + totalDuration(store.getState()));
});

test('VÍDEO: UM Ctrl+Z desfaz o corte inteiro', () => {
  const store = projetoVideo();
  const antes = JSON.stringify(store.getState().clips);
  store.dispatch(act.cutSilence('clip', store.getState().clips[0].id,
    [{ in: 0, out: 3 }, { in: 5, out: 9 }, { in: 12, out: 14 }]));
  store.undo();
  assert.equal(JSON.stringify(store.getState().clips), antes, 'voltou tudo num undo só');
  assert.equal(store.getState().compounds.length, 0);
});

test('ÁUDIO: as falas viram pedaços ENCOSTADOS (sem buraco)', () => {
  const store = projetoVideo();
  store.dispatch(act.addAudioClip({ url: 'https://x/a.mp3', filename: 'a', duration: 20 }));
  const aid = store.getState().audio_clips[0].id;
  store.dispatch(act.cutSilence('audio', aid, [{ in: 0, out: 2 }, { in: 5, out: 8 }, { in: 10, out: 11 }]));
  const as = store.getState().audio_clips.slice().sort((a, b) => a.start - b.start);
  assert.equal(as.length, 3);
  for (let i = 1; i < as.length; i++) {
    const fimAnterior = as[i - 1].start + (as[i - 1].source_out - as[i - 1].source_in);
    assert.ok(Math.abs(as[i].start - fimAnterior) < 1e-6,
      `buraco entre ${i - 1} e ${i}: ${as[i].start} vs ${fimAnterior}`);
  }
});

test('pedaço menor que o mínimo é descartado, não vira clipe inválido', () => {
  const store = projetoVideo();
  store.dispatch(act.cutSilence('clip', store.getState().clips[0].id,
    [{ in: 0, out: 3 }, { in: 4, out: 4.01 }]));   // 10ms
  const s = store.getState();
  assert.equal(s.compounds[0].clips.length, 1, 'só a fala de verdade');
});

test('sem falas detectadas, o corte NÃO mexe no projeto', () => {
  const store = projetoVideo();
  const antes = store.getState();
  store.dispatch(act.cutSilence('clip', antes.clips[0].id, []));
  assert.equal(store.getState(), antes, 'mesma referência');
});

test('as falas fora da faixa do clipe são recortadas na borda', () => {
  const store = projetoVideo(10);
  store.dispatch(act.cutSilence('clip', store.getState().clips[0].id,
    [{ in: 0, out: 5 }, { in: 8, out: 999 }]));
  const subs = store.getState().compounds[0].clips;
  assert.ok(subs.every(c => c.source_out <= 10 + 1e-6), 'nada além do fim do vídeo');
});
