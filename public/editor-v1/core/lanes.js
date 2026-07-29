// editor-v1/core/lanes.js
// REGRAS DE CAMADA (user 2026-07-29). Modulo PURO: sem DOM, sem canvas.
//
// Existe pra ser o unico lugar que decide "esse item pode ficar nessa camada?".
// Antes disso a decisao estava espalhada entre laneForY (geometria), o
// timeline-controller (3 handlers de drop) e os reducers — e ninguem validava
// nada: dava pra soltar video na faixa de texto e empilhar dois clipes no
// mesmo pedaco da mesma camada.
//
// As regras:
//   R1. faixa de TEXTO so aceita TEXTO (e faixa de VIDEO so aceita video)
//   R2. AUDIO vive num espaco proprio ABAIXO da faixa principal; camadas de
//       texto/video ficam ACIMA dela (isso e geometria do layout, aqui a gente
//       so garante que a lane resolvida nunca sai de 1..MAX_LANE)
//   R5. dois itens nao se sobrepoem no tempo dentro da mesma camada: primeiro
//       tenta REPELIR (encostar no vizinho); se o alvo e a camada em si, sobe
//       pra primeira camada ACIMA que aceite
//
// EXCECAO CONSCIENTE — LEGENDAS (caption:true) ficam FORA da regra de
// sobreposicao: sao geradas em lote (uma por palavra, ate ~300 de uma vez em
// SET_CAPTIONS) e aplicar R5 nelas cascatearia o projeto inteiro em camadas.
// Elas ainda DEFINEM o tipo da camada (camada com legenda e camada de texto,
// entao video nao entra nela).

import { MAX_LANE, TEXT_DEFAULT_LANE, OVERLAY_DEFAULT_LANE } from './schema.js';
import { overlayTimelineDur, audioTimelineDur, audioLaneMap } from './selectors.js';

const EPS = 1e-6;

/** Tipos de camada. 'misto' so aparece em projeto ANTIGO (salvo antes desta
 *  regra), onde texto e video dividiam a mesma lane — nesse caso a gente
 *  aceita os dois pra nao quebrar o projeto do usuario. */
export const CAMADA = { TEXTO: 'texto', VIDEO: 'video', LIVRE: 'livre', MISTO: 'misto' };

export function laneDeOverlay(o) { return o.lane || OVERLAY_DEFAULT_LANE; }
export function laneDeTexto(t) { return t.lane || TEXT_DEFAULT_LANE; }

/** Itens (texto + video) de uma camada, com o intervalo ja resolvido no tempo
 *  da timeline. `legenda` marca quem e isento da regra de sobreposicao. */
export function itensDaLane(state, lane) {
  const out = [];
  for (const o of state.overlays || []) {
    if (o.active === false || laneDeOverlay(o) !== lane) continue;
    const start = o.start || 0;
    out.push({ tipo: 'overlay', id: o.id, start, end: start + overlayTimelineDur(o), legenda: false });
  }
  for (const t of state.texts || []) {
    if (t.active === false || laneDeTexto(t) !== lane) continue;
    out.push({ tipo: 'text', id: t.id, start: t.start_sec, end: t.end_sec, legenda: t.caption === true });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Tipo da camada, deduzido do conteudo. */
export function laneKind(state, lane) {
  let temVideo = false, temTexto = false;
  for (const it of itensDaLane(state, lane)) {
    if (it.tipo === 'overlay') temVideo = true; else temTexto = true;
  }
  if (temVideo && temTexto) return CAMADA.MISTO;
  if (temVideo) return CAMADA.VIDEO;
  if (temTexto) return CAMADA.TEXTO;
  return CAMADA.LIVRE;
}

function tipoCompativel(kind, tipo) {
  if (kind === CAMADA.LIVRE || kind === CAMADA.MISTO) return true;
  return kind === CAMADA.VIDEO ? tipo === 'overlay' : tipo === 'text';
}

function sobrepoe(aIni, aFim, bIni, bFim) {
  // encostar NAO e sobrepor: fim exatamente no comeco do vizinho e valido
  return aIni < bFim - EPS && aFim > bIni + EPS;
}

/** A camada aceita esse item nesse intervalo? (tipo + sobreposicao) */
export function laneAceita(state, lane, { tipo, id, start, end, legenda = false }) {
  if (!Number.isInteger(lane) || lane < 1 || lane > MAX_LANE) return false;
  if (!tipoCompativel(laneKind(state, lane), tipo)) return false;
  if (legenda) return true;               // legenda nunca e barrada
  for (const it of itensDaLane(state, lane)) {
    if (it.legenda) continue;             // nem barra
    if (it.tipo === tipo && it.id === id) continue;   // ele mesmo
    if (sobrepoe(start, end, it.start, it.end)) return false;
  }
  return true;
}

/** Camada final pra um drop: a alvo se aceitar, senao a primeira ACIMA que
 *  aceite (R1 e R5 mandam criar camada nova em cima, nunca embaixo).
 *  Devolve null quando nao ha nenhuma camada possivel — o chamador deve
 *  RECUSAR o movimento em vez de sobrepor. */
export function laneDestino(state, { tipo, id, laneAlvo, start, end, legenda = false }) {
  const padrao = tipo === 'overlay' ? OVERLAY_DEFAULT_LANE : TEXT_DEFAULT_LANE;
  let alvo = Number.isFinite(laneAlvo) ? Math.round(laneAlvo) : padrao;
  alvo = Math.min(MAX_LANE, Math.max(1, alvo));
  for (let l = alvo; l <= MAX_LANE; l++) {
    if (laneAceita(state, l, { tipo, id, start, end, legenda })) return l;
  }
  return null;
}

/** Intervalos ocupados de uma camada (sem o proprio item, sem legendas),
 *  unidos quando se tocam. */
function ocupacao(state, lane, tipo, id) {
  const brutos = itensDaLane(state, lane)
    .filter(it => !it.legenda && !(it.tipo === tipo && it.id === id))
    .map(it => [it.start, it.end])
    .sort((a, b) => a[0] - b[0]);
  const uni = [];
  for (const [ini, fim] of brutos) {
    const ult = uni[uni.length - 1];
    if (ult && ini <= ult[1] + EPS) ult[1] = Math.max(ult[1], fim);
    else uni.push([ini, fim]);
  }
  return uni;
}

/** REPELIR: start mais proximo do desejado que NAO sobrepoe ninguem na camada.
 *  E o que da a sensacao de "os dois se repelem" no arrasto horizontal —
 *  o item encosta no vizinho em vez de entrar por cima dele. */
export function repelirStart(state, { tipo, id, lane, start, dur }) {
  const ocup = ocupacao(state, lane, tipo, id);
  if (!ocup.length) return Math.max(0, start);
  const desejado = Math.max(0, start);
  // ja cabe onde quer?
  if (!ocup.some(([ini, fim]) => sobrepoe(desejado, desejado + dur, ini, fim))) return desejado;

  // vaos livres: antes do primeiro, entre pares, depois do ultimo (infinito)
  const vaos = [];
  if (ocup[0][0] > 0) vaos.push([0, ocup[0][0]]);
  for (let i = 0; i < ocup.length - 1; i++) vaos.push([ocup[i][1], ocup[i + 1][0]]);
  vaos.push([ocup[ocup.length - 1][1], Infinity]);

  let melhor = null, menorDist = Infinity;
  for (const [ini, fim] of vaos) {
    if (fim - ini < dur - EPS) continue;          // nao cabe nesse vao
    // teto do vao: o item inteiro tem que caber DENTRO dele
    const teto = fim === Infinity ? Infinity : fim - dur;
    const cand = Math.min(Math.max(desejado, ini), teto);
    const dist = Math.abs(cand - desejado);
    if (dist < menorDist) { menorDist = dist; melhor = cand; }
  }
  return melhor == null ? desejado : Math.max(0, melhor);
}

/** Camadas em uso (com item ou reservadas como extras), de baixo pra cima. */
export function lanesEmUso(state) {
  const set = new Set();
  for (const o of state.overlays || []) if (o.active !== false) set.add(laneDeOverlay(o));
  for (const t of state.texts || []) if (t.active !== false) set.add(laneDeTexto(t));
  const max = set.size ? Math.max(...set) : 0;
  for (let i = 0; i < (state.extra_overlay_lanes || 0); i++) {
    const l = max + 1 + i;
    if (l <= MAX_LANE) set.add(l);
  }
  return [...set].sort((a, b) => a - b);
}

function lanesDeAudioEmUso(state) {
  const mapa = audioLaneMap(state);
  const set = new Set(mapa.values());
  const max = set.size ? Math.max(...set) : -1;
  for (let i = 0; i < (state.extra_audio_lanes || 0); i++) set.add(max + 1 + i);
  return [...set].sort((a, b) => a - b);
}

/** Move a camada `de` pra posicao da camada `para`, empurrando as do meio
 *  (insercao, igual arrastar item numa lista) e devolve o state novo.
 *  Usado pelo arrasto do OLHINHO no cabecalho da faixa (R4).
 *  Retorna o MESMO state quando nada muda (nao cria snapshot de undo fantasma). */
export function reordenarLanes(state, { kind, de, para }) {
  if (!Number.isInteger(de) || !Number.isInteger(para) || de === para) return state;
  const audio = kind === 'audio';
  const rows = audio ? lanesDeAudioEmUso(state) : lanesEmUso(state);
  const iDe = rows.indexOf(de);
  const iPara = rows.indexOf(para);
  if (iDe < 0 || iPara < 0) return state;

  // ordem nova das camadas: tira `de` do lugar e reinsere na posicao de `para`
  const ordem = rows.slice();
  ordem.splice(iDe, 1);
  ordem.splice(iPara, 0, de);
  // os MESMOS numeros de camada, redistribuidos na ordem nova
  const mapa = new Map();
  ordem.forEach((laneAntiga, i) => mapa.set(laneAntiga, rows[i]));
  const trocou = [...mapa].some(([a, b]) => a !== b);
  if (!trocou) return state;
  const novo = (l) => mapa.has(l) ? mapa.get(l) : l;

  if (audio) {
    const atual = audioLaneMap(state);
    return {
      ...state,
      audio_clips: (state.audio_clips || []).map(a => {
        const lane = atual.get(a.id);
        return lane == null ? a : { ...a, lane: novo(lane) };
      }),
      hidden_audio_lanes: (state.hidden_audio_lanes || []).map(novo),
    };
  }
  return {
    ...state,
    overlays: (state.overlays || []).map(o => ({ ...o, lane: novo(laneDeOverlay(o)) })),
    texts: (state.texts || []).map(t => ({ ...t, lane: novo(laneDeTexto(t)) })),
    hidden_overlay_lanes: (state.hidden_overlay_lanes || []).map(novo),
  };
}

/** Duracao na timeline de um item de camada (video/texto) — atalho pros
 *  chamadores que so tem o objeto cru. */
export function durDoItem(state, tipo, item) {
  if (tipo === 'overlay') return overlayTimelineDur(item);
  if (tipo === 'audio') return audioTimelineDur(item);
  return Math.max(0, item.end_sec - item.start_sec);
}
