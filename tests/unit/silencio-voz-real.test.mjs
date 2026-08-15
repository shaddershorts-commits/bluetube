// tests/unit/silencio-voz-real.test.mjs
//
// A FALHA QUE O USER PEGOU (2026-08-05, print antes/depois idênticos):
// "Cortar respiros não funciona. Continua com vários momentos de linha reta de
//  áudio... Motor por trás tá bem amador e fraco: Fachada."
//
// O detector antigo ancorava o limiar SÓ no piso de ruído, então o limiar caía
// ABAIXO do respiro e o respiro contava como fala. Como sobrava menos silêncio
// contínuo do que `minSilencio` de cada lado do respiro, o trecho nunca fechava:
// a gravação inteira virava UM bloco de fala, ZERO corte — e a tela ainda
// dizia "o áudio já está justo ✓". 15 de 36 cenários realistas falhavam assim.
//
// Estes testes são a régua permanente. O RMS não liga pro timbre, só pro NÍVEL,
// então dá pra reproduzir uma gravação de voz fielmente: fala com modulação
// silábica, sala com chiado, respiro entre as frases. Gerador DETERMINÍSTICO
// (nada de Math.random: teste que pisca não trava regressão nenhuma).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectarFala, resumoDoCorte } from '../../public/editor-v1/core/silencio.js';

const SR = 16000;
const dbParaAmp = (db) => Math.pow(10, db / 20);

/** ruído pseudoaleatório reprodutível (LCG) */
function criarRuido(semente) {
  let s = semente >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return (s / 4294967296) * 2 - 1; };
}

/** trecho de ruído com RMS no nível pedido */
function ruido(n, db, rnd) {
  const a = dbParaAmp(db) * Math.sqrt(3);   // uniforme [-a,a] tem RMS a/√3
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rnd() * a;
  return out;
}

/** fala: nível base com modulação silábica de 4 Hz que mergulha 14 dB nos vales */
function fala(n, db, rnd) {
  const out = ruido(n, db, rnd);
  for (let i = 0; i < n; i++) {
    const silaba = 0.5 + 0.5 * Math.cos(2 * Math.PI * 4 * (i / SR));
    out[i] *= dbParaAmp(-14 * (1 - silaba));
  }
  return out;
}

/**
 * Gravação realista: 4 frases de 2s separadas por pausas de 1s.
 * @param {{sala:number, voz:number, respiro:number|null, semente?:number}} cfg
 */
function gravacao({ sala, voz, respiro, semente = 7 }) {
  const rnd = criarRuido(semente);
  const partes = [];
  const pausas = [];
  const push = (tipo, dur, db) => {
    const n = Math.round(dur * SR);
    partes.push(tipo === 'fala' ? fala(n, db, rnd) : ruido(n, db, rnd));
  };
  push('sala', 0.6, sala);
  let t = 0.6;
  for (let k = 0; k < 4; k++) {
    push('fala', 2, voz); t += 2;
    if (k === 3) break;
    const ini = t;
    if (respiro == null) push('sala', 1, sala);
    else { push('sala', 0.3, sala); push('sala', 0.4, respiro); push('sala', 0.3, sala); }
    t += 1;
    pausas.push({ in: ini, out: t });
  }
  const total = partes.reduce((s, p) => s + p.length, 0);
  const sinal = new Float32Array(total);
  let o = 0;
  for (const p of partes) { sinal.set(p, o); o += p.length; }
  return { sinal, pausas, frases: [0.6, 3.6, 6.6, 9.6] };
}

/** quanto das pausas saiu, e se algum corte invadiu o miolo de uma frase */
function avaliar(g, r) {
  let dasPausas = 0;
  for (const p of g.pausas) {
    for (const c of r.cortes) {
      const inter = Math.min(c.out, p.out) - Math.max(c.in, p.in);
      if (inter > 0) dasPausas += inter;
    }
  }
  let dentroDaFala = 0;
  for (const ini of g.frases) {
    for (const c of r.cortes) {
      const inter = Math.min(c.out, ini + 1.85) - Math.max(c.in, ini + 0.15);
      if (inter > 0.05) dentroDaFala += inter;
    }
  }
  return { pctPausa: dasPausas / g.pausas.length, dentroDaFala };
}

// ── o caso EXATO do print do user: fala densa com respiro entre as frases ──
test('gravação com RESPIRO entre as frases: corta de verdade (era 0%)', () => {
  const g = gravacao({ sala: -50, voz: -12, respiro: -35 });
  const r = detectarFala(g.sinal, SR);
  const a = avaliar(g, r);
  assert.equal(r.falas.length, 4, 'as 4 frases têm que ser reconhecidas separadamente');
  assert.ok(a.pctPausa > 0.5,
    `só ${Math.round(a.pctPausa * 100)}% da pausa saiu — o respiro está emendando as frases de novo`);
  assert.equal(a.dentroDaFala, 0, 'não pode cortar dentro da fala');
});

test('e o resumo NÃO pode dizer que está tudo certo quando não cortou nada', () => {
  const g = gravacao({ sala: -50, voz: -12, respiro: -35 });
  const r = detectarFala(g.sinal, SR);
  const res = resumoDoCorte(r);
  assert.ok(res.respiros >= 3, 'tem que anunciar os respiros achados: ' + res.respiros);
  assert.ok(res.removidoSeg > 1.5, 'tem que anunciar tempo removido: ' + res.removidoSeg);
});

// ── matriz: a gravação do user pode cair em qualquer uma destas células ──
const SALAS = [-60, -50, -42, -35];
const VOZES = [-6, -12, -20];
const RESPIROS = [null, -40, -32];

for (const sala of SALAS) {
  for (const voz of VOZES) {
    for (const respiro of RESPIROS) {
      const nome = `sala ${sala}dB · voz ${voz}dB · respiro ${respiro ?? 'nenhum'}`;
      test(`acha as pausas sem comer a fala — ${nome}`, () => {
        const g = gravacao({ sala, voz, respiro });
        const r = detectarFala(g.sinal, SR);
        const a = avaliar(g, r);
        assert.ok(a.pctPausa >= 0.5,
          `removeu só ${Math.round(a.pctPausa * 100)}% da pausa (limiar ${r.limiar.toFixed(1)}dB)`);
        assert.ok(a.dentroDaFala < 0.25,
          `comeu ${a.dentroDaFala.toFixed(2)}s DENTRO da fala`);
      });
    }
  }
}

// ── as travas de segurança: o que ele NÃO pode fazer ──
test('frase falada BAIXINHO não é confundida com respiro', () => {
  // a 3ª frase sai 16 dB abaixo das outras — é fala, tem sílaba, tem que ficar
  const rnd = criarRuido(11);
  const partes = [];
  const push = (t, d, db) => {
    const n = Math.round(d * SR);
    partes.push(t === 'fala' ? fala(n, db, rnd) : ruido(n, db, rnd));
  };
  push('sala', 0.5, -55);
  push('fala', 2, -10); push('sala', 1, -55);
  push('fala', 0.8, -26); push('sala', 1, -55);   // a frase baixinha, CURTA
  push('fala', 2, -10);
  const total = partes.reduce((s, p) => s + p.length, 0);
  const sinal = new Float32Array(total);
  let o = 0; for (const p of partes) { sinal.set(p, o); o += p.length; }

  const r = detectarFala(sinal, SR);
  const sobrevive = r.falas.some(f => f.in < 3.9 && f.out > 3.6);
  assert.ok(sobrevive,
    'a frase baixinha foi APAGADA — apagar palavra do usuário é pior que deixar respiro passar');
});

test('silêncio digital puro no meio é sempre cortado', () => {
  const rnd = criarRuido(3);
  const partes = [];
  const push = (t, d, db) => {
    const n = Math.round(d * SR);
    if (t === 'zero') partes.push(new Float32Array(n));
    else partes.push(t === 'fala' ? fala(n, db, rnd) : ruido(n, db, rnd));
  };
  push('fala', 2, -12); push('zero', 1.5, 0); push('fala', 2, -12);
  const total = partes.reduce((s, p) => s + p.length, 0);
  const sinal = new Float32Array(total);
  let o = 0; for (const p of partes) { sinal.set(p, o); o += p.length; }

  const r = detectarFala(sinal, SR);
  const cortouOBuraco = r.cortes.some(c => c.in < 2.3 && c.out > 3.2);
  assert.ok(cortouOBuraco, 'linha reta de áudio TEM que sair');
});

test('gravação sem nenhuma pausa não inventa corte', () => {
  const rnd = criarRuido(5);
  const n = Math.round(8 * SR);
  const r = detectarFala(fala(n, -12, rnd), SR);
  const res = resumoDoCorte(r);
  assert.ok(res.removidoSeg < 0.5, 'inventou ' + res.removidoSeg + 's de corte');
});
