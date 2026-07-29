// tests/unit/lanes.test.mjs — REGRAS DE CAMADA (node --test)
//
// Estas sao as invariantes que o user pediu em 29/07. Elas existem pra travar
// o comportamento ANTES da implementacao mexer em laneForY/hittest/FSM/reducer:
//
//   R1. faixa de TEXTO so aceita TEXTO (hoje da pra soltar video nela)
//   R2. AUDIO sempre ABAIXO do video; TEXTO sempre ACIMA da faixa principal
//   R3. arrastar take de video/audio cria camada nova NA HORA
//   R4. arrastar pelo OLHINHO reordena as camadas
//   R5. dois itens nao se sobrepoem na mesma camada: se repelem, e a tentativa
//       de sobrepor cria camada nova ACIMA
//
// Excecao consciente: LEGENDAS (caption:true) ficam FORA da regra de
// sobreposicao — sao geradas em lote (uma por palavra, ate ~300) e cascatear
// isso em camadas novas destruiria o projeto.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/editor-v1/core/store.js';
import * as act from '../../public/editor-v1/core/actions.js';
import { MAX_LANE, TEXT_DEFAULT_LANE, OVERLAY_DEFAULT_LANE, LANES_POR_TIPO, MAX_AUDIO_LANE } from '../../public/editor-v1/core/schema.js';
import { hitTest } from '../../public/editor-v1/timeline/hittest.js';
import {
  laneKind, itensDaLane, laneAceita, laneDestino, repelirStart, reordenarLanes,
} from '../../public/editor-v1/core/lanes.js';
import { computeLayout, laneForY } from '../../public/editor-v1/timeline/layout.js';
import { audioLaneMap } from '../../public/editor-v1/core/selectors.js';

const VP = { pxPerSec: 10, scrollX: 0, width: 800, height: 400 };

function base(duration = 60) {
  const store = createStore();
  store.dispatch(act.setVideo({
    url: 'https://x/v.mp4', path: 'p', filename: 'v.mp4',
    duration, width: 1080, height: 1920, size_bytes: 1000,
  }));
  return store;
}

/** overlay direto no state (sem passar pelo drag) pra montar cenarios */
function comOverlay(store, { lane = 1, start = 0, dur = 5, id = null } = {}) {
  const st = store.getState();
  const ov = {
    id: id ?? st.next_overlay_id,
    source_in: 0, source_out: dur, start,
    x_pct: 0.5, y_pct: 0.5, scale: 1, lane, active: true,
  };
  store.replaceState({
    ...st,
    overlays: [...st.overlays, ov],
    next_overlay_id: (id ?? st.next_overlay_id) + 1,
  });
  return ov;
}

function comTexto(store, { lane = TEXT_DEFAULT_LANE, start = 0, end = 3, caption = false } = {}) {
  store.dispatch(act.addText({ content: 'oi', start_sec: start, end_sec: end, lane, caption }));
  const st = store.getState();
  return st.texts[st.texts.length - 1];
}

// ─────────────────────────── R1: tipo da camada ───────────────────────────

test('R1 laneKind classifica a camada pelo conteudo', () => {
  const store = base();
  comTexto(store, { lane: 4 });
  comOverlay(store, { lane: 2 });
  const st = store.getState();
  assert.equal(laneKind(st, 4), 'texto');
  assert.equal(laneKind(st, 2), 'video');
  assert.equal(laneKind(st, 5), 'livre');
});

test('R1 camada de texto RECUSA video', () => {
  const store = base();
  comTexto(store, { lane: 4, start: 0, end: 3 });
  const st = store.getState();
  assert.equal(laneAceita(st, 4, { tipo: 'overlay', id: 99, start: 10, end: 15 }), false);
});

test('R1 camada de video RECUSA texto', () => {
  const store = base();
  comOverlay(store, { lane: 2, start: 0, dur: 5 });
  const st = store.getState();
  assert.equal(laneAceita(st, 2, { tipo: 'text', id: 99, start: 20, end: 22 }), false);
});

test('R1 soltar video numa camada de texto joga pra camada LIVRE acima', () => {
  const store = base();
  comTexto(store, { lane: 3 });
  const st = store.getState();
  const destino = laneDestino(st, { tipo: 'overlay', id: 99, laneAlvo: 3, start: 0, end: 5 });
  assert.ok(destino > 3, 'tem que subir, nao ficar na faixa de texto');
  assert.equal(laneKind(st, destino), 'livre');
});

test('R1 camada livre aceita qualquer um dos dois', () => {
  const st = base().getState();
  assert.equal(laneAceita(st, 2, { tipo: 'overlay', id: 1, start: 0, end: 5 }), true);
  assert.equal(laneAceita(st, 2, { tipo: 'text', id: 1, start: 0, end: 5 }), true);
});

// ──────────────────── R2: audio embaixo, texto em cima ────────────────────

test('R2 no layout, TODA row de audio fica abaixo da faixa principal', () => {
  const store = base();
  store.dispatch(act.addAudioClip({ url: 'a.mp3', filename: 'a', duration: 10, kind: 'extra' }));
  const lay = computeLayout(store.getState(), VP);
  assert.ok(lay.audioLaneRows.length > 0);
  for (const r of lay.audioLaneRows) {
    assert.ok(r.y >= lay.yVideo + lay.videoTrackH, `row de audio em y=${r.y} tem que ficar abaixo do video (${lay.yVideo + lay.videoTrackH})`);
  }
});

test('R2 no layout, TODA row de camada (texto/video) fica acima da principal', () => {
  const store = base();
  comTexto(store, { lane: 4 });
  comOverlay(store, { lane: 1 });
  const lay = computeLayout(store.getState(), VP);
  assert.ok(lay.laneRows.length >= 2);
  for (const r of lay.laneRows) {
    assert.ok(r.y + r.h <= lay.yVideo, `row de camada em y=${r.y} tem que ficar acima do video (${lay.yVideo})`);
  }
});

test('R2 texto nunca resolve pra uma lane fora de 1..MAX_LANE', () => {
  const store = base();
  const st = store.getState();
  for (const alvo of [-3, 0, 1, 5, 9, 99]) {
    const d = laneDestino(st, { tipo: 'text', id: 1, laneAlvo: alvo, start: 0, end: 2 });
    if (d != null) {
      assert.ok(d >= 1 && d <= MAX_LANE, `lane resolvida ${d} fora da faixa valida`);
    }
  }
});

test('R2 audio continua num espaco de lane proprio (nao invade 1..5 de video)', () => {
  const store = base();
  store.dispatch(act.addAudioClip({ url: 'a.mp3', filename: 'a', duration: 10, kind: 'extra' }));
  const st = store.getState();
  const lanes = [...audioLaneMap(st).values()];
  assert.deepEqual(lanes, [0], 'primeiro audio ocupa a lane 0 do espaco de audio');
});

// ─────────────────── R5: sem sobreposicao na mesma camada ───────────────────

test('R5 laneAceita recusa quando ha sobreposicao temporal na mesma camada', () => {
  const store = base();
  comOverlay(store, { lane: 2, start: 5, dur: 5 }); // ocupa 5..10
  const st = store.getState();
  assert.equal(laneAceita(st, 2, { tipo: 'overlay', id: 99, start: 7, end: 12 }), false, 'sobrepoe no meio');
  assert.equal(laneAceita(st, 2, { tipo: 'overlay', id: 99, start: 0, end: 6 }), false, 'sobrepoe na borda de entrada');
  assert.equal(laneAceita(st, 2, { tipo: 'overlay', id: 99, start: 10, end: 15 }), true, 'encostar NAO e sobrepor');
  assert.equal(laneAceita(st, 2, { tipo: 'overlay', id: 99, start: 0, end: 5 }), true, 'encostar por tras NAO e sobrepor');
});

test('R5 o proprio item nao conta como obstaculo de si mesmo', () => {
  const store = base();
  const ov = comOverlay(store, { lane: 2, start: 5, dur: 5 });
  const st = store.getState();
  assert.equal(laneAceita(st, 2, { tipo: 'overlay', id: ov.id, start: 5, end: 10 }), true);
});

test('R5 tentar sobrepor cria camada nova ACIMA (nao empurra pra baixo)', () => {
  const store = base();
  comOverlay(store, { lane: 2, start: 5, dur: 5 });
  const st = store.getState();
  const destino = laneDestino(st, { tipo: 'overlay', id: 99, laneAlvo: 2, start: 6, end: 9 });
  assert.ok(destino > 2, `esperava camada acima de 2, veio ${destino}`);
});

test('R5 repelir: encosta no vizinho em vez de sobrepor', () => {
  const store = base();
  comOverlay(store, { lane: 2, start: 10, dur: 5 }); // ocupa 10..15
  const st = store.getState();
  // chegando pela esquerda: para ANTES do vizinho
  const a = repelirStart(st, { tipo: 'overlay', id: 99, lane: 2, start: 8, dur: 4 }); // 8..12
  assert.equal(a, 6, 'tem que encostar o fim em 10');
  // chegando pela direita: comeca DEPOIS do vizinho
  const b = repelirStart(st, { tipo: 'overlay', id: 99, lane: 2, start: 13, dur: 4 }); // 13..17
  assert.equal(b, 15, 'tem que comecar no fim do vizinho');
});

test('R5 repelir nunca produz start negativo', () => {
  const store = base();
  comOverlay(store, { lane: 2, start: 0, dur: 5 });
  const st = store.getState();
  const r = repelirStart(st, { tipo: 'overlay', id: 99, lane: 2, start: 1, dur: 4 });
  assert.ok(r >= 0, `start ${r} nao pode ser negativo`);
});

test('R5 sem camada livre acima, o movimento e RECUSADO (null) em vez de sobrepor', () => {
  const store = base();
  // ocupa as 5 lanes com video sobreposto no mesmo intervalo
  for (let l = 1; l <= MAX_LANE; l++) comOverlay(store, { lane: l, start: 0, dur: 10 });
  const st = store.getState();
  const destino = laneDestino(st, { tipo: 'overlay', id: 99, laneAlvo: 1, start: 2, end: 8 });
  assert.equal(destino, null);
});

test('R5 LEGENDA e isenta: 200 palavras coladas ficam todas na mesma camada', () => {
  const store = base();
  const caps = [];
  for (let i = 0; i < 200; i++) caps.push({ content: 'p' + i, start_sec: i * 0.3, end_sec: i * 0.3 + 0.3 });
  store.dispatch(act.setCaptions(caps));
  const st = store.getState();
  const lanes = new Set(st.texts.filter(t => t.caption).map(t => t.lane));
  assert.equal(st.texts.filter(t => t.caption).length, 200);
  assert.equal(lanes.size, 1, 'legenda nao pode cascatear em varias camadas');
});

test('R5 legenda nao bloqueia texto normal na mesma camada', () => {
  const store = base();
  store.dispatch(act.setCaptions([{ content: 'a', start_sec: 0, end_sec: 10 }]));
  const st = store.getState();
  const laneCap = st.texts.find(t => t.caption).lane;
  assert.equal(laneAceita(st, laneCap, { tipo: 'text', id: 999, start: 2, end: 5 }), true);
});

// ──────────────────────── R4: reordenar pelo olhinho ────────────────────────

test('R4 reordenar troca a ordem visual das camadas de video', () => {
  const store = base();
  const a = comOverlay(store, { lane: 1, start: 0, dur: 3 });
  const b = comOverlay(store, { lane: 2, start: 10, dur: 3 });
  const st2 = reordenarLanes(store.getState(), { kind: 'overlay', de: 1, para: 2 });
  const ovA = st2.overlays.find(o => o.id === a.id);
  const ovB = st2.overlays.find(o => o.id === b.id);
  assert.equal(ovA.lane, 2, 'quem estava embaixo sobe');
  assert.equal(ovB.lane, 1, 'quem estava em cima desce');
});

test('R4 reordenar leva junto o olhinho fechado da camada', () => {
  const store = base();
  comOverlay(store, { lane: 1, start: 0, dur: 3 });
  comOverlay(store, { lane: 2, start: 10, dur: 3 });
  store.dispatch(act.toggleLaneVisibility('overlay', 1));
  const st2 = reordenarLanes(store.getState(), { kind: 'overlay', de: 1, para: 2 });
  assert.ok(st2.hidden_overlay_lanes.includes(2), 'a camada escondida virou a 2');
  assert.ok(!st2.hidden_overlay_lanes.includes(1), 'a 1 nao pode continuar escondida');
});

test('R4 reordenar NAO mistura texto com video (cada tipo anda com sua camada)', () => {
  const store = base();
  const tx = comTexto(store, { lane: 4, start: 0, end: 3 });
  const ov = comOverlay(store, { lane: 1, start: 0, dur: 3 });
  const st2 = reordenarLanes(store.getState(), { kind: 'overlay', de: 1, para: 4 });
  const t2 = st2.texts.find(t => t.id === tx.id);
  const o2 = st2.overlays.find(o => o.id === ov.id);
  assert.equal(o2.lane, 4, 'a camada de video foi pro topo');
  assert.equal(t2.lane, 1, 'a de texto desceu junto (troca de posicao, nao merge)');
  assert.equal(laneKind(st2, 4), 'video');
  assert.equal(laneKind(st2, 1), 'texto');
});

test('R4 reordenar audio permuta so o espaco de audio', () => {
  const store = base();
  store.dispatch(act.addAudioClip({ url: 'a.mp3', filename: 'a', duration: 10, kind: 'extra' }));
  store.dispatch(act.addAudioClip({ url: 'b.mp3', filename: 'b', duration: 10, kind: 'extra' }));
  const st = store.getState();
  const ids = st.audio_clips.map(a => a.id);
  const st2 = reordenarLanes(st, { kind: 'audio', de: 0, para: 1 });
  const m = audioLaneMap(st2);
  assert.equal(m.get(ids[0]), 1);
  assert.equal(m.get(ids[1]), 0);
});

test('R4 reordenar pra mesma posicao nao muda nada (sem snapshot de undo fantasma)', () => {
  const store = base();
  comOverlay(store, { lane: 1, start: 0, dur: 3 });
  const st = store.getState();
  assert.equal(reordenarLanes(st, { kind: 'overlay', de: 1, para: 1 }), st);
});

// ───────────────── itensDaLane: base compartilhada dos testes ─────────────────

test('itensDaLane lista texto e video da camada com intervalo resolvido', () => {
  const store = base();
  comOverlay(store, { lane: 2, start: 4, dur: 6 });
  const itens = itensDaLane(store.getState(), 2);
  assert.equal(itens.length, 1);
  assert.equal(itens[0].tipo, 'overlay');
  assert.equal(itens[0].start, 4);
  assert.equal(itens[0].end, 10);
});

test('itensDaLane ignora item desativado', () => {
  const store = base();
  const ov = comOverlay(store, { lane: 2, start: 4, dur: 6 });
  const st = store.getState();
  store.replaceState({ ...st, overlays: st.overlays.map(o => o.id === ov.id ? { ...o, active: false } : o) });
  assert.equal(itensDaLane(store.getState(), 2).length, 0);
});

test('OVERLAY_DEFAULT_LANE e TEXT_DEFAULT_LANE nao colidem (nasce separado)', () => {
  assert.notEqual(OVERLAY_DEFAULT_LANE, TEXT_DEFAULT_LANE);
});

// ── CAPACIDADE: 9 de video + 9 de texto + 9 de audio (user 2026-07-29) ──

test('cabem 9 camadas de VIDEO e 9 de TEXTO ao mesmo tempo', () => {
  const store = base();
  for (let i = 0; i < LANES_POR_TIPO; i++) comOverlay(store, { lane: i + 1, start: 0, dur: 2 });
  for (let i = 0; i < LANES_POR_TIPO; i++) comTexto(store, { lane: LANES_POR_TIPO + i + 1, start: 0, end: 2 });
  const st = store.getState();
  const lanesVideo = new Set(st.overlays.map(o => o.lane));
  const lanesTexto = new Set(st.texts.map(t => t.lane));
  assert.equal(lanesVideo.size, 9, 'nove camadas de video');
  assert.equal(lanesTexto.size, 9, 'nove camadas de texto');
  assert.equal([...lanesVideo].filter(l => lanesTexto.has(l)).length, 0, 'nenhuma camada mistura os dois');
  for (const l of [...lanesVideo, ...lanesTexto]) assert.ok(l >= 1 && l <= MAX_LANE);
});

test('as 18 camadas viram 18 faixas no desenho', () => {
  const store = base();
  for (let i = 1; i <= MAX_LANE; i++) comOverlay(store, { lane: i, start: 0, dur: 2 });
  const lay = computeLayout(store.getState(), VP);
  assert.equal(lay.laneRows.length, MAX_LANE);
});

test('cabem 9 camadas de AUDIO', () => {
  const store = base();
  for (let i = 0; i < 9; i++) {
    store.dispatch(act.addAudioClip({ url: `a${i}.mp3`, filename: 'a' + i, duration: 5 }));
    const st = store.getState();
    store.dispatch(act.setAudioLane(st.audio_clips[st.audio_clips.length - 1].id, i));
  }
  const lanes = new Set(audioLaneMap(store.getState()).values());
  assert.equal(lanes.size, 9, [...lanes].join(','));
  assert.equal(Math.max(...lanes), MAX_AUDIO_LANE);
});

test('a camada de audio 9 nao e engolida pelo clamp', () => {
  const store = base();
  store.dispatch(act.addAudioClip({ url: 'a.mp3', filename: 'a', duration: 5 }));
  const id = store.getState().audio_clips[0].id;
  store.dispatch(act.setAudioLane(id, MAX_AUDIO_LANE));
  assert.equal(store.getState().audio_clips[0].lane, MAX_AUDIO_LANE);
});

// ── ROLAGEM VERTICAL: sem ela a camada 9 existe mas fica inalcancavel ──

test('com muitas faixas, o conteudo passa da altura e da pra rolar', () => {
  const store = base();
  for (let i = 1; i <= MAX_LANE; i++) comOverlay(store, { lane: i, start: 0, dur: 2 });
  const vpBaixo = { ...VP, height: 200 };
  const lay = computeLayout(store.getState(), vpBaixo);
  assert.ok(lay.contentH > vpBaixo.height, 'conteudo maior que a janela');
  assert.ok(lay.maxScrollY > 0, 'existe rolagem disponivel');
});

test('rolar desloca as faixas mas NAO mexe na regua nem no eixo do tempo', () => {
  const store = base();
  for (let i = 1; i <= MAX_LANE; i++) comOverlay(store, { lane: i, start: 0, dur: 2 });
  const vp0 = { ...VP, height: 200 };
  const a = computeLayout(store.getState(), vp0);
  const b = computeLayout(store.getState(), { ...vp0, scrollY: 100 });
  assert.equal(b.laneRows[0].y, a.laneRows[0].y - 100, 'as faixas sobem 100px');
  assert.equal(b.yVideo, a.yVideo - 100);
  assert.equal(b.yRuler, a.yRuler, 'a regua fica no lugar');
  assert.equal(b.clips[0].x, a.clips[0].x, 'o eixo do tempo nao se mexe');
  assert.equal(b.vp.pxPerSec, a.vp.pxPerSec, 'o zoom nao se mexe');
});

test('o limite de rolagem nao encolhe conforme se rola (nao trava no meio)', () => {
  const store = base();
  for (let i = 1; i <= MAX_LANE; i++) comOverlay(store, { lane: i, start: 0, dur: 2 });
  const vp0 = { ...VP, height: 200 };
  const a = computeLayout(store.getState(), vp0);
  const b = computeLayout(store.getState(), { ...vp0, scrollY: a.maxScrollY });
  assert.equal(b.maxScrollY, a.maxScrollY, 'o fim da rolagem e o mesmo');
  assert.equal(b.contentH, a.contentH);
});

test('rolado ate o fim, a ultima faixa de audio fica dentro da vista', () => {
  const store = base();
  for (let i = 1; i <= MAX_LANE; i++) comOverlay(store, { lane: i, start: 0, dur: 2 });
  store.dispatch(act.addAudioClip({ url: 'a.mp3', filename: 'a', duration: 5 }));
  const vp0 = { ...VP, height: 200 };
  const max = computeLayout(store.getState(), vp0).maxScrollY;
  const lay = computeLayout(store.getState(), { ...vp0, scrollY: max });
  const ultima = lay.audioLaneRows[lay.audioLaneRows.length - 1];
  assert.ok(ultima.y + ultima.h <= vp0.height + 1, `fim da ultima faixa ${ultima.y + ultima.h} > janela ${vp0.height}`);
});

test('clique acerta a faixa certa DEPOIS de rolar (ver = clicar)', () => {
  const store = base();
  for (let i = 1; i <= MAX_LANE; i++) comOverlay(store, { lane: i, start: 0, dur: 2 });
  const vp0 = { ...VP, height: 200, scrollY: 120 };
  const lay = computeLayout(store.getState(), vp0);
  const visivel = lay.overlayItems.find(o => o.y >= 0 && o.y + o.h <= vp0.height);
  assert.ok(visivel, 'ha camada visivel apos rolar');
  const hit = hitTest(lay, visivel.x + visivel.w / 2, visivel.y + visivel.h / 2);
  assert.equal(hit.type, 'overlay-body');
  assert.equal(hit.overlayId, visivel.overlayId);
});

// ───────────── R3: a camada nova aparece NA HORA (row fantasma) ─────────────

test('R3 o layout desenha a camada fantasma que ainda nao existe no projeto', () => {
  const store = base();
  const semFantasma = computeLayout(store.getState(), VP);
  const comFantasma = computeLayout(store.getState(), VP, { laneExtra: 1 });
  assert.equal(semFantasma.laneRows.length, 0);
  assert.equal(comFantasma.laneRows.length, 1);
  assert.equal(comFantasma.laneRows[0].lane, 1);
  assert.ok(comFantasma.yVideo > semFantasma.yVideo, 'a faixa principal desce pra abrir espaco');
});

test('R3 a camada fantasma NAO mexe no projeto (zero dispatch)', () => {
  const store = base();
  const antes = store.getState();
  computeLayout(antes, VP, { laneExtra: 3 });
  assert.equal(store.getState(), antes, 'calcular layout nao pode alterar o estado');
});

test('R3 o drop cai na camada fantasma que o usuario esta vendo', () => {
  const store = base();
  const lay = computeLayout(store.getState(), VP, { laneExtra: 1 });
  const row = lay.laneRows[0];
  assert.equal(laneForY(lay, row.y + row.h / 2), 1);
});

test('R3 fantasma de audio abre uma row a mais embaixo', () => {
  const store = base();
  store.dispatch(act.addAudioClip({ url: 'a.mp3', filename: 'a', duration: 10, kind: 'extra' }));
  const semF = computeLayout(store.getState(), VP);
  const comF = computeLayout(store.getState(), VP, { laneAudioExtra: semF.audioLanes });
  assert.equal(comF.audioLanes, semF.audioLanes + 1);
  assert.equal(comF.audioLaneRows.length, semF.audioLaneRows.length + 1);
});

// ───────── caminhos REAIS (via dispatch), nao so as funcoes puras ─────────

test('SET_ITEM_LANE: video solto na faixa de texto vai pra camada de cima', () => {
  const store = base();
  const ov = comOverlay(store, { lane: 1, start: 0, dur: 5 });
  comTexto(store, { lane: 2, start: 0, end: 5 });
  store.dispatch(act.setItemLane('overlay', ov.id, 2));   // tenta entrar no texto
  const depois = store.getState().overlays.find(o => o.id === ov.id);
  assert.notEqual(depois.lane, 2, 'nao pode ficar na faixa de texto');
  assert.equal(depois.lane, 3, 'sobe pra primeira camada livre acima');
});

test('CONVERT_TO_OVERLAY: arrastar cena pra faixa de texto nao invade o texto', () => {
  const store = base();
  store.dispatch(act.splitClipAt(20));                 // 2 clips (senao recusa)
  comTexto(store, { lane: 4, start: 0, end: 30 });
  const clipId = store.getState().clips[0].id;
  store.dispatch(act.convertToOverlay(clipId, 0, 4));  // drop na row do texto
  const ov = store.getState().overlays[0];
  assert.ok(ov, 'a camada foi criada');
  assert.notEqual(ov.lane, 4);
  assert.equal(ov.lane, 5);
});

test('ADD_IMAGE_OVERLAY nao nasce em cima de uma legenda', () => {
  const store = base();
  for (const l of [1, 2, 3]) comOverlay(store, { lane: l, start: 0, dur: 5 });
  store.dispatch(act.setCaptions([{ content: 'oi', start_sec: 0, end_sec: 5 }])); // lane 4
  store.dispatch(act.addImageOverlay({ url: 'i.png', width: 100, height: 100 }, 0));
  const img = store.getState().overlays.find(o => o.kind === 'image');
  assert.ok(img);
  assert.notEqual(img.lane, 4, 'a camada 4 e da legenda');
  assert.equal(img.lane, 5);
});

test('MOVE_OVERLAY encosta no vizinho em vez de sobrepor', () => {
  const store = base();
  comOverlay(store, { lane: 1, start: 0, dur: 5 });          // ocupa 0..5
  const b = comOverlay(store, { lane: 1, start: 10, dur: 5 });
  store.dispatch(act.moveOverlay(b.id, 3));                  // tenta 3..8
  const depois = store.getState().overlays.find(o => o.id === b.id);
  assert.equal(depois.start, 5, 'para encostado no fim do vizinho');
});

test('UPDATE_TEXT: arrastar texto por cima de outro encosta (nao sobrepoe)', () => {
  const store = base();
  comTexto(store, { lane: 4, start: 0, end: 3 });
  const t2 = comTexto(store, { lane: 4, start: 10, end: 13 });
  store.dispatch(act.updateText(t2.id, { start_sec: 1, end_sec: 4 }));
  const depois = store.getState().texts.find(t => t.id === t2.id);
  assert.equal(depois.start_sec, 3);
  assert.equal(depois.end_sec, 6, 'a duracao e preservada ao repelir');
});

test('UPDATE_TEXT: LEGENDA nao e repelida (as palavras vivem coladas)', () => {
  const store = base();
  store.dispatch(act.setCaptions([
    { content: 'a', start_sec: 0, end_sec: 3 },
    { content: 'b', start_sec: 3, end_sec: 6 },
  ]));
  const caps = store.getState().texts.filter(t => t.caption);
  store.dispatch(act.updateText(caps[1].id, { start_sec: 1, end_sec: 4 }));
  const depois = store.getState().texts.find(t => t.id === caps[1].id);
  assert.equal(depois.start_sec, 1, 'legenda vai exatamente pra onde mandaram');
});

test('REORDER_LANES pelo dispatch troca as camadas e mantem 1 undo', () => {
  const store = base();
  const a = comOverlay(store, { lane: 1, start: 0, dur: 3 });
  const b = comOverlay(store, { lane: 2, start: 10, dur: 3 });
  store.dispatch(act.reorderLanes('overlay', 1, 2));
  assert.equal(store.getState().overlays.find(o => o.id === a.id).lane, 2);
  assert.equal(store.getState().overlays.find(o => o.id === b.id).lane, 1);
  store.undo();
  assert.equal(store.getState().overlays.find(o => o.id === a.id).lane, 1, 'um undo desfaz a reordenacao inteira');
});

// ── ARRASTO DIAGONAL (bug pego pela revisao adversarial) ──
// Mover no tempo E trocar de camada eram dois dispatches: o repelir olhava a
// camada de ORIGEM e o item pousava no tempo do vizinho que ele estava DEIXANDO.

test('arrasto diagonal pousa no tempo do drop, nao no do vizinho da camada velha', () => {
  const store = base();
  comOverlay(store, { lane: 1, start: 0, dur: 10 });          // A ocupa 0..10 na 1
  const b = comOverlay(store, { lane: 1, start: 12, dur: 3 }); // B vem de 12s
  store.dispatch(act.moveItemTo('overlay', b.id, 2, 2));       // sobe pra 2 em t=2
  const dep = store.getState().overlays.find(o => o.id === b.id);
  assert.equal(dep.lane, 2, 'foi pra camada 2');
  assert.equal(dep.start, 2, 'e ficou EM 2s (a camada 2 estava vazia)');
});

test('soltar em OUTRA camada ja ocupada sobe mais uma (nao sobrepoe)', () => {
  const store = base();
  comOverlay(store, { lane: 2, start: 0, dur: 10 });           // ocupa a 2
  const b = comOverlay(store, { lane: 1, start: 12, dur: 3 });
  store.dispatch(act.moveItemTo('overlay', b.id, 2, 2));       // mira a 2, ocupada
  const dep = store.getState().overlays.find(o => o.id === b.id);
  assert.equal(dep.lane, 3, 'a regra "sobrepor cria camada acima" vale aqui');
  assert.equal(dep.start, 2, 'e o tempo do drop e respeitado');
});

test('arrastar de lado na MESMA camada repele (nao pula de camada sozinho)', () => {
  const store = base();
  comOverlay(store, { lane: 2, start: 0, dur: 10 });
  const b = comOverlay(store, { lane: 2, start: 12, dur: 3 });
  store.dispatch(act.moveItemTo('overlay', b.id, 2, 2));       // mesma camada
  const dep = store.getState().overlays.find(o => o.id === b.id);
  assert.equal(dep.lane, 2, 'continua na camada dele');
  assert.equal(dep.start, 10, 'encostou no vizinho');
});

test('texto tambem pousa no tempo certo ao subir de camada', () => {
  const store = base();
  comTexto(store, { lane: 4, start: 0, end: 10 });
  const t2 = comTexto(store, { lane: 4, start: 12, end: 15 });
  store.dispatch(act.moveItemTo('text', t2.id, 2, 5));
  const dep = store.getState().texts.find(t => t.id === t2.id);
  assert.equal(dep.lane, 5);
  assert.equal(dep.start_sec, 2);
  assert.equal(dep.end_sec, 5, 'a duracao vai junto');
});

test('durante o arrasto o texto NAO e repelido (so no fim do gesto)', () => {
  const store = base();
  comTexto(store, { lane: 4, start: 0, end: 10 });
  const t2 = comTexto(store, { lane: 4, start: 12, end: 15 });
  // dispatch com gestureId = quadro do meio do arrasto
  store.dispatch({ ...act.updateText(t2.id, { start_sec: 2, end_sec: 5 }), gestureId: 'g1' });
  const meio = store.getState().texts.find(t => t.id === t2.id);
  assert.equal(meio.start_sec, 2, 'segue o cursor livremente enquanto arrasta');
  // e o fecho do gesto acerta a posicao final
  store.dispatch(act.moveItemTo('text', t2.id, 2, 4));
  const fim = store.getState().texts.find(t => t.id === t2.id);
  assert.equal(fim.start_sec, 10, 'ao soltar na MESMA camada, encosta no vizinho');
});

test('soltar fora das faixas de camada mantem a camada atual', () => {
  const store = base();
  const ov = comOverlay(store, { lane: 3, start: 5, dur: 2 });
  store.dispatch(act.moveItemTo('overlay', ov.id, 8, null));
  const dep = store.getState().overlays.find(o => o.id === ov.id);
  assert.equal(dep.lane, 3);
  assert.equal(dep.start, 8);
});

// ── R1 no NASCIMENTO do texto (bug relatado pelo user com print) ──
// "fui adicionar um texto e olha o que aconteceu, entrou na parte de camada de
// video, E ERRADO". O texto nascia SEMPRE na camada padrao, sem olhar quem
// estava la.

test('texto NOVO nao nasce em cima de uma camada de video', () => {
  const store = base();
  comOverlay(store, { lane: TEXT_DEFAULT_LANE, start: 0, dur: 10 }); // video ocupa a padrao
  store.dispatch(act.addText({ content: 'oi', start_sec: 0, end_sec: 3 }));
  const tx = store.getState().texts[0];
  assert.notEqual(tx.lane, TEXT_DEFAULT_LANE, 'nao pode entrar na camada do video');
  assert.equal(laneKind(store.getState(), tx.lane), 'texto');
});

test('texto novo cai numa camada que ja e de texto (nao cria uma toa)', () => {
  const store = base();
  comOverlay(store, { lane: TEXT_DEFAULT_LANE, start: 0, dur: 10 });
  store.dispatch(act.addText({ content: 'a', start_sec: 0, end_sec: 3 }));
  const lane1 = store.getState().texts[0].lane;
  store.dispatch(act.addText({ content: 'b', start_sec: 20, end_sec: 23 }));
  assert.equal(store.getState().texts[1].lane, lane1, 'os dois textos dividem a camada');
});

test('LEGENDA gerada tambem foge da camada de video', () => {
  const store = base();
  comOverlay(store, { lane: TEXT_DEFAULT_LANE, start: 0, dur: 30 });
  store.dispatch(act.setCaptions([
    { content: 'a', start_sec: 0, end_sec: 1 },
    { content: 'b', start_sec: 1, end_sec: 2 },
  ]));
  const caps = store.getState().texts.filter(t => t.caption);
  const lanes = new Set(caps.map(c => c.lane));
  assert.equal(lanes.size, 1, 'a legenda inteira numa camada so');
  assert.notEqual([...lanes][0], TEXT_DEFAULT_LANE, 'e nao na do video');
});

// ── REPELIR NO AUDIO (user: "a camada de audio nao ta se repelindo") ──

function comAudio(store, { start = 0, dur = 10, lane = null } = {}) {
  store.dispatch(act.addAudioClip({ url: `a${start}.mp3`, filename: 'a' + start, duration: dur }));
  const st = store.getState();
  const a = st.audio_clips[st.audio_clips.length - 1];
  const patch = { ...a, start, ...(lane != null ? { lane } : {}) };
  store.replaceState({ ...st, audio_clips: st.audio_clips.map(x => x.id === a.id ? patch : x) });
  return patch;
}

test('audio arrastado por cima de outro ENCOSTA (nao fica por cima)', () => {
  const store = base();
  comAudio(store, { start: 0, dur: 10, lane: 0 });
  const b = comAudio(store, { start: 20, dur: 5, lane: 0 });
  store.dispatch(act.moveAudio(b.id, 3));            // tenta 3..8, em cima do 1o
  const dep = store.getState().audio_clips.find(a => a.id === b.id);
  assert.equal(dep.start, 10, 'encostou no fim do vizinho');
});

test('audio: soltar em OUTRA faixa ocupada desce mais uma', () => {
  const store = base();
  comAudio(store, { start: 0, dur: 10, lane: 0 });
  comAudio(store, { start: 0, dur: 10, lane: 1 });
  const c = comAudio(store, { start: 30, dur: 5, lane: 2 });
  store.dispatch(act.moveItemTo('audio', c.id, 2, 1));  // mira a faixa 1, ocupada
  const dep = store.getState().audio_clips.find(a => a.id === c.id);
  assert.equal(dep.lane, 2, 'camada nova nasce ABAIXO no espaco do audio');
  assert.equal(dep.start, 2, 'e o tempo do drop e respeitado');
});

test('audio: arrasto diagonal pra faixa VAZIA pousa no tempo do drop', () => {
  const store = base();
  comAudio(store, { start: 0, dur: 10, lane: 0 });
  const b = comAudio(store, { start: 20, dur: 5, lane: 0 });
  store.dispatch(act.moveItemTo('audio', b.id, 2, 1));   // faixa 1 vazia
  const dep = store.getState().audio_clips.find(a => a.id === b.id);
  assert.equal(dep.lane, 1);
  assert.equal(dep.start, 2, 'nao foi repelido pelo vizinho da faixa velha');
});

test('audio: dois clipes nunca ficam sobrepostos na mesma faixa', () => {
  const store = base();
  comAudio(store, { start: 0, dur: 10, lane: 0 });
  const b = comAudio(store, { start: 20, dur: 5, lane: 0 });
  for (const alvo of [1, 3, 5, 7, 9, 0]) {
    store.dispatch(act.moveAudio(b.id, alvo));
    const st = store.getState();
    const mapa = audioLaneMap(st);
    const porLane = new Map();
    for (const a of st.audio_clips) {
      const l = mapa.get(a.id);
      const lista = porLane.get(l) || [];
      lista.push([a.start, a.start + (a.source_out - a.source_in)]);
      porLane.set(l, lista);
    }
    for (const [, lista] of porLane) {
      lista.sort((x, y) => x[0] - y[0]);
      for (let i = 1; i < lista.length; i++) {
        assert.ok(lista[i][0] >= lista[i - 1][1] - 1e-6,
          `sobreposicao ao tentar start=${alvo}: ${JSON.stringify(lista)}`);
      }
    }
  }
});

// ── nenhum caminho de CRIACAO pode sumir com o arquivo do usuario ──

test('imagem entra mesmo com todas as camadas ocupadas (anda no tempo)', () => {
  const store = base();
  for (let l = 1; l <= MAX_LANE; l++) comOverlay(store, { lane: l, start: 0, dur: 10 });
  const antes = store.getState().overlays.length;
  store.dispatch(act.addImageOverlay({ url: 'i.png', width: 10, height: 10 }, 0));
  const st = store.getState();
  assert.equal(st.overlays.length, antes + 1, 'a imagem NAO pode sumir em silencio');
  const img = st.overlays.find(o => o.kind === 'image');
  assert.ok(img.start >= 10, `entrou depois do vizinho (start=${img.start})`);
});

test('colar com tudo ocupado tambem entra, sem sobrepor', () => {
  const store = base();
  for (let l = 1; l <= MAX_LANE; l++) comOverlay(store, { lane: l, start: 0, dur: 10 });
  const modelo = store.getState().overlays[0];
  const antes = store.getState().overlays.length;
  store.dispatch(act.paste('overlay', { ...modelo }, 2));
  const st = store.getState();
  assert.equal(st.overlays.length, antes + 1);
  const novo = st.overlays[st.overlays.length - 1];
  const vizinhos = st.overlays.filter(o => o.id !== novo.id && (o.lane || 1) === (novo.lane || 1));
  for (const v of vizinhos) {
    const fimV = v.start + (v.source_out - v.source_in);
    const fimN = novo.start + (novo.source_out - novo.source_in);
    assert.ok(novo.start >= fimV - 1e-6 || fimN <= v.start + 1e-6, 'nao sobrepoe ninguem');
  }
});

test('a faixa principal NUNCA ganha campo lane', () => {
  const store = base();
  store.dispatch(act.splitClipAt(20));
  comTexto(store, { lane: 4 });
  const ov = comOverlay(store, { lane: 1, start: 0, dur: 5 });
  store.dispatch(act.setItemLane('overlay', ov.id, 3));
  store.dispatch(act.reorderLanes('overlay', 3, 4));
  for (const c of store.getState().clips) {
    assert.equal(c.lane, undefined, 'clip da faixa principal nao tem camada');
  }
});
