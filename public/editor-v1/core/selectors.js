// editor-v1/core/selectors.js
// Consultas derivadas do estado. UNICO lugar com o mapeamento tempo
// virtual (timeline) <-> tempo source (arquivo). Modulo puro.

import { TEXT_SIZE_PCT, FORMATO_PADRAO } from './schema.js';
import { chromaParaRender } from './fundo.js';
import { layoutDoTexto } from './text-layout.js';
// módulo puro (sem DOM), apesar de morar em preview/: é lá que a correção de
// cor é definida, e o payload precisa dos MESMOS números que desenham a tela
import { paramsRender } from '../preview/color-grade.js';

/** Clips efetivos: ativos, na ordem do array (ordem visual da timeline).
 *  Espelha a logica do backend edit-v0 (filter active !== false). */
export function effectiveClips(state) {
  return (state.clips || []).filter(c => c.active !== false);
}

/** Duracao total do corte final (soma dos clips ativos). */
export function totalDuration(state) {
  return effectiveClips(state).reduce((acc, c) => acc + clipDuration(state, c), 0);
}

// ── VELOCIDADE (user 2026-07-20): faixa acelerada/desacelerada ocupa menos/
// mais tempo na timeline. speed=2 => metade da duracao; speed=0.5 => dobro.
// Missing = 1.0 (retrocompat). Toda conversao tempo virtual<->arquivo passa
// por aqui, entao velocidade fica consistente em player/render/export.
export const clipSpeed = (c) => (c && c.speed > 0 ? c.speed : 1);
/** duracao NA TIMELINE de um clip de video (span do arquivo / velocidade).
 *  Cena CONGELADA (Congelar): duracao livre (freeze_dur), independe do arquivo. */
export const clipTimelineDur = (c) =>
  c.frozen ? (c.freeze_dur || 3) : (c.source_out - c.source_in) / clipSpeed(c);
/** duracao NA TIMELINE de um clip de audio */
export const audioTimelineDur = (a) => (a.source_out - a.source_in) / clipSpeed(a);
/** duracao NA TIMELINE de uma camada (overlay) — respeita a velocidade dela */
export const overlayTimelineDur = (o) => (o.source_out - o.source_in) / clipSpeed(o);

/** Duracao REPRODUZIVEL da timeline: video OU audio, o que terminar depois.
 *  Sem isso, projeto so-audio (ou com a faixa de video excluida) tinha
 *  duracao 0 e o play nunca andava (bug user 2026-07-20). */
export function playableDuration(state) {
  // extensão REAL da timeline: main + áudios + CAMADAS (vídeo/texto). A agulha
  // e o playback vão até onde QUALQUER faixa termina (user 2026-07-22: camada
  // além da principal reproduzia mas a agulha não clicava lá).
  let total = totalDuration(state);
  for (const a of effectiveAudioClips(state)) {
    total = Math.max(total, a.start + audioTimelineDur(a));
  }
  for (const o of effectiveOverlays(state)) {
    total = Math.max(total, o.start + overlayTimelineDur(o));
  }
  for (const t of effectiveTexts(state)) {
    total = Math.max(total, t.end_sec || 0);
  }
  return total;
}

/** Segmentos da timeline: cada clip ativo com seu offset acumulado no tempo
 *  virtual. [{ clip, tStart, tEnd }] onde t* e tempo virtual. */
export function timelineSegments(state) {
  // EXPANDIDO (player/export): compostos viram seus sub-clips reais.
  // seg.effSpeed = velocidade EFETIVA (velocidade do sub × velocidade do
  // composto) — acelerar o composto acelera tudo dentro (user 2026-07-20).
  const segs = [];
  let t = 0;
  for (const clip of effectiveClips(state)) {
    if (clip.compound_id) {
      const comp = (state.compounds || []).find(k => k.id === clip.compound_id);
      const cs = clipSpeed(clip);                     // velocidade do BLOCO composto
      const t0 = t;
      for (const sub of (comp?.clips || []).filter(x => x.active !== false)) {
        const dur = clipTimelineDur(sub) / cs;
        segs.push({ clip: sub, tStart: t, tEnd: t + dur, compoundId: clip.compound_id, effSpeed: clipSpeed(sub) * cs });
        t += dur;
      }
      // composto pode ser MAIOR que o video interno (so-audio/texto)
      t = t0 + compoundDuration(comp) / cs;
    } else {
      const dur = clipTimelineDur(clip);
      segs.push({ clip, tStart: t, tEnd: t + dur, effSpeed: clipSpeed(clip) });
      t += dur;
    }
  }
  return segs;
}

/** DONO CANÔNICO de uma propriedade da cena.
 *
 *  Máscara, Retoque e Aprimorar áudio podem ser aplicados na cena OU no BLOCO
 *  COMPOSTO que a contém. O composto vive em `state.clips` como um stub
 *  {id, compound_id}, e as cenas de dentro vivem em `compounds[].clips` — dois
 *  mapeamentos paralelos. Sem um resolvedor único, quem lê pelo sub-clipe
 *  (exportPayload, preview) NUNCA enxergava o que foi aplicado no bloco: era a
 *  raiz de "máscara em clipe composto não funciona" (user 2026-07-29).
 *
 *  Regra: o valor DA CENA vence; na falta dele, herda o do bloco. Assim
 *  aplicar no composto vale pra tudo dentro, e ajustar uma cena específica
 *  continua sobrescrevendo.
 */
export function propriedadeDaCena(state, seg, campo) {
  const doSub = seg?.clip?.[campo];
  if (doSub !== undefined && doSub !== null) return doSub;
  if (seg?.compoundId == null) return undefined;
  const stub = (state.clips || []).find(c => c.compound_id === seg.compoundId);
  return stub ? stub[campo] : undefined;
}

/** velocidade efetiva de um seg (composto multiplica a velocidade interna). */
export const segSpeed = (seg) => seg.effSpeed || clipSpeed(seg.clip);

/** Duracao INTERNA de um composto: video em sequencia OU o fim do ultimo
 *  audio/texto/camada — o que terminar depois. Compostos sem video (so
 *  audio, por ex.) existem desde 2026-07-20. */
export function compoundDuration(comp) {
  if (!comp) return 0;
  let total = (comp.clips || []).filter(x => x.active !== false)
    .reduce((a, x) => a + clipTimelineDur(x), 0);
  for (const a of (comp.audio_clips || []).filter(x => x.active !== false)) {
    total = Math.max(total, a.start + audioTimelineDur(a));
  }
  for (const x of (comp.texts || []).filter(x => x.active !== false)) {
    total = Math.max(total, x.end_sec);
  }
  for (const o of (comp.overlays || []).filter(x => x.active !== false)) {
    total = Math.max(total, o.start + overlayTimelineDur(o));
  }
  return total;
}

/** Duracao de um clip da main (compound = duracao interna / velocidade dele). */
export function clipDuration(state, c) {
  if (c.compound_id) {
    const comp = (state.compounds || []).find(k => k.id === c.compound_id);
    return compoundDuration(comp) / clipSpeed(c);
  }
  return clipTimelineDur(c);
}

/** Itens da MAIN track pro layout/render: compound = 1 bloco. */
export function mainTrackItems(state) {
  const items = [];
  let t = 0;
  for (const clip of effectiveClips(state)) {
    const dur = clipDuration(state, clip);
    items.push({ clip, tStart: t, tEnd: t + dur, isCompound: !!clip.compound_id });
    t += dur;
  }
  return items;
}

/** Offset virtual (tStart) de cada compound na timeline. */
export function compoundOffsets(state) {
  const map = new Map();
  for (const it of mainTrackItems(state)) {
    if (it.isCompound) map.set(it.clip.compound_id, it.tStart);
  }
  return map;
}

/** velocidade do BLOCO composto (pra acelerar o conteudo interno junto). */
export function compoundSpeedOf(state, compId) {
  const c = (state.clips || []).find(k => k.compound_id === compId);
  return c ? clipSpeed(c) : 1;
}

/** Lane RESOLVIDA de cada audio_clip solto (Map id → laneIndex). Fonte única
 *  usada pelo layout (posição da row) e pelo olhinho (esconder lane): lane
 *  explícita (arrasto vertical) vence; sem lane = empacota na primeira row
 *  livre (comportamento CapCut de sempre). */
export function audioLaneMap(state) {
  const map = new Map();
  const laneEnds = []; // laneIndex -> fim do último clip na lane
  const ativos = (state.audio_clips || []).filter(a => a.active !== false)
    .slice().sort((a, b) => a.start - b.start);
  for (const a of ativos) {
    const end = a.start + audioTimelineDur(a);
    let lane;
    if (Number.isInteger(a.lane) && a.lane >= 0) {
      lane = a.lane;
    } else {
      lane = laneEnds.findIndex(le => a.start >= (le ?? -Infinity) - 1e-6);
      if (lane < 0) lane = laneEnds.length;
    }
    laneEnds[lane] = Math.max(laneEnds[lane] ?? -Infinity, end);
    map.set(a.id, lane);
  }
  return map;
}

/** Textos efetivos (soltos + dos compostos, offsets absolutos + velocidade).
 *  Lanes escondidas (olhinho) ficam FORA — preview e export. */
export function effectiveTexts(state) {
  const hid = state.hidden_overlay_lanes || [];
  const out = (state.texts || []).filter(t => t.active !== false && !hid.includes(t.lane || 4)).map(t => ({ ...t }));
  const offs = compoundOffsets(state);
  for (const comp of (state.compounds || [])) {
    const off = offs.get(comp.id);
    if (off == null) continue;
    const cs = compoundSpeedOf(state, comp.id);
    for (const t of (comp.texts || []).filter(x => x.active !== false)) {
      out.push({ ...t, id: 'c' + comp.id + '_' + t.id, start_sec: off + t.start_sec / cs, end_sec: off + t.end_sec / cs, _compound: true });
    }
  }
  return out;
}

/** Audios efetivos (soltos + dos compostos, offsets + velocidade do bloco).
 *  Lane de áudio escondida (olhinho) = mudo/fora, como se não estivesse na
 *  timeline (preview e export). */
export function effectiveAudioClips(state) {
  const hidA = state.hidden_audio_lanes || [];
  const laneOf = hidA.length ? audioLaneMap(state) : null;
  const out = (state.audio_clips || [])
    .filter(a => a.active !== false && !(laneOf && hidA.includes(laneOf.get(a.id))))
    .map(a => ({ ...a }));
  const offs = compoundOffsets(state);
  for (const comp of (state.compounds || [])) {
    const off = offs.get(comp.id);
    if (off == null) continue;
    const cs = compoundSpeedOf(state, comp.id);
    // "Aprimorar áudio" aplicado NO COMPOSTO vale pro áudio de dentro dele:
    // pro usuário o composto é UMA faixa, e o áudio dela é este. O stub do
    // composto guarda as flags (é o que a UI consegue selecionar).
    const stub = (state.clips || []).find(c => c.compound_id === comp.id) || {};
    const fxDoComposto = {
      ...(stub.fx_ruido ? { fx_ruido: true } : {}),
      ...(stub.fx_voz ? { fx_voz: true, fx_voz_int: stub.fx_voz_int } : {}),
      ...(stub.fx_norm ? { fx_norm: true } : {}),
    };
    for (const a of (comp.audio_clips || []).filter(x => x.active !== false)) {
      // velocidade do composto acelera o audio interno junto (user 2026-07-20)
      out.push({ ...a, ...fxDoComposto, id: 'c' + comp.id + '_' + a.id, start: off + a.start / cs, speed: clipSpeed(a) * cs, _compound: true });
    }
  }
  return out;
}

/** Esta CENA tem som? (user 2026-08-07: "a opção deve aparecer em vídeos que
 *  tenham áudio"). Serve pro menu de botão direito não oferecer "Aprimorar
 *  áudio" onde não há o que aprimorar — botão que não faz nada é pior que
 *  botão ausente. */
export function cenaTemAudio(state, clip) {
  if (!clip) return false;
  if (clip.compound_id != null) return compoundTemAudio(state, clip.compound_id);
  if (clip.muted === true) return false;      // "Remover áudio desta cena"
  if (clip.media_id != null) return true;     // take importado traz a trilha dele
  return !state.audio_detached;               // principal: só se o som ainda está nele
}

/** O composto tem áudio próprio (interno) OU vídeo com áudio embutido?
 *  A timeline usa isto pra MOSTRAR que o bloco composto tem som — o usuário
 *  reportou (2026-07-29) que "o composto não consta que tem áudio, e por isso
 *  o editor acha que não dá pra usar os efeitos". */
export function compoundTemAudio(state, compoundId) {
  const comp = (state.compounds || []).find(k => k.id === compoundId);
  if (!comp) return false;
  if ((comp.audio_clips || []).some(a => a.active !== false)) return true;
  // vídeo interno com áudio embutido (não removido cena a cena)
  return (comp.clips || []).some(c => c.active !== false && !c.muted);
}

/** Overlays efetivos (soltos + dos compostos, offsets absolutos).
 *  Lanes escondidas (olhinho) ficam FORA — preview e export. */
export function effectiveOverlays(state) {
  const hid = state.hidden_overlay_lanes || [];
  const out = (state.overlays || []).filter(o => o.active !== false && !hid.includes(o.lane || 1)).map(o => ({ ...o }));
  const offs = compoundOffsets(state);
  for (const comp of (state.compounds || [])) {
    const off = offs.get(comp.id);
    if (off == null) continue;
    const cs = compoundSpeedOf(state, comp.id);
    for (const o of (comp.overlays || []).filter(x => x.active !== false)) {
      out.push({ ...o, id: 'c' + comp.id + '_' + o.id, start: off + o.start / cs, _compound: true });
    }
  }
  return out;
}

/** Plano de transcricao pra legendas automaticas: escolhe a fonte de audio
 *  REAL do projeto e devolve { url, segments:[{tStart,fileIn,fileOut,speed}] }
 *  onde tStart e tempo VIRTUAL e fileIn/fileOut sao tempos DENTRO do arquivo.
 *
 *  `speed` NAO e enfeite: com o clipe em 2x, 1s de arquivo passa em 0,5s de
 *  timeline. Sem ele a legenda ficava com o dobro do atraso a cada segundo de
 *  fala (teste do user 2026-08-05). Quem usa o plano e caption-sync.js.
 *  Prioridade (user 2026-07-20):
 *   1) audio proprio do editor (kind 'extra') — a narracao gravada por ele
 *   2) audio do video, SE nao foi separado/removido
 *   3) audio do video ja separado (kind 'video'), se ainda existe
 *   null = nao ha voz pra transcrever (nunca gera "legenda fantasma"). */
/** TODOS os candidatos a fonte de legenda, na ordem de prioridade "cega"
 *  (quem gera pode re-ranquear MEDINDO voz — ver escolherFonteComVoz na
 *  shell). Cada item: { url, segments, rotulo, origem }.
 *
 *  Nasceu do bug real de 15/08 ("só legendou um efeito"): a regra antiga
 *  "extra vence o vídeo" foi pensada pra locução, mas efeito de biblioteca
 *  também é 'extra' — e roubava a vez da fala. Agora:
 *   - som de BIBLIOTECA (origem:'biblioteca') vai pro FIM da fila, sempre;
 *   - nome que cheira a voz (🎙 voz do Demucs, locução, narração) vai pra
 *     FRENTE; o resto fica no meio, e o VAD decide por cima de tudo. */
export function captionAudioPlanos(state) {
  const audios = effectiveAudioClips(state);
  const extras = audios.filter(a => a.kind !== 'video' && a.url);
  const detachedVid = audios.filter(a => a.kind === 'video');

  const planosDe = (list, urlOf, rotuloDe, origem) => {
    const byUrl = new Map();
    for (const a of list) {
      const url = urlOf(a);
      if (!url) continue;
      if (!byUrl.has(url)) byUrl.set(url, { segs: [], nome: a.filename || 'áudio' });
      byUrl.get(url).segs.push({
        tStart: a.start, fileIn: a.source_in, fileOut: a.source_out,
        speed: clipSpeed(a),
      });
    }
    return [...byUrl.entries()]
      .map(([url, x]) => ({ url, segments: x.segs, rotulo: rotuloDe(x.nome), origem }))
      .sort((p, q) => cobertura(q) - cobertura(p));
  };
  const cobertura = (p) => p.segments.reduce((s, x) => s + (x.fileOut - x.fileIn), 0);
  const cheiraAVoz = (a) => /voz|vocal|locu|narr|grava|voice|speech|🎙/i.test(a.filename || '');

  const biblio = extras.filter(a => a.origem === 'biblioteca');
  const proprios = extras.filter(a => a.origem !== 'biblioteca');
  const comVoz = proprios.filter(cheiraAVoz);
  const outros = proprios.filter(a => !cheiraAVoz(a));

  const out = [];
  out.push(...planosDe(comVoz, a => a.url, n => n, 'voz'));
  out.push(...planosDe(outros, a => a.url, n => n, 'importado'));
  if (!state.audio_detached && state.video?.url) {
    const segs = timelineSegments(state)
      .filter(s => s.clip.media_id == null)  // takes tem audio proprio, fora do escopo
      .map(s => ({
        tStart: s.tStart, fileIn: s.clip.source_in, fileOut: s.clip.source_out,
        speed: s.effSpeed || 1,
      }));
    if (segs.length) out.push({ url: state.video.url, segments: segs, rotulo: 'áudio do vídeo', origem: 'video' });
  }
  if (detachedVid.length && state.video?.url) {
    out.push(...planosDe(detachedVid, () => state.video.url, () => 'áudio do vídeo (separado)', 'video'));
  }
  out.push(...planosDe(biblio, a => a.url, n => n + ' (biblioteca)', 'biblioteca'));
  return out;
}

export function captionAudioPlan(state) {
  const planos = captionAudioPlanos(state);
  if (!planos.length) return null;
  // LEI DA ÂNCORA: se já existem legendas presas numa fonte (src_url), essa
  // fonte É o plano — o ressincronizar (caption-sync) mapeia os tempos DELA;
  // trocar de fonte no meio quebraria toda legenda já gerada.
  const ancorada = (state.texts || []).find(t => t.caption === true && t.src_url);
  if (ancorada) {
    const p = planos.find(x => x.url === ancorada.src_url);
    if (p) return p;
  }
  return planos[0];
}

/** URL da midia de um clip/overlay: media_id -> pool; sem media_id -> video
 *  principal. null se nao resolver (pool corrompido). */
export function mediaUrlFor(state, item) {
  if (item?.media_id != null) {
    return (state.media || []).find(m => m.id === item.media_id)?.url || null;
  }
  return state.video?.url || null;
}

/** tempo virtual -> tempo no arquivo source. Retorna null se fora do range. */
export function timelineToSource(state, t) {
  for (const seg of timelineSegments(state)) {
    if (t >= seg.tStart && t < seg.tEnd + 1e-9) {
      const c = seg.clip;
      if (c.frozen) return c.freeze_src || 0;         // cena congelada = 1 frame
      const off = (t - seg.tStart) * segSpeed(seg);
      // Reverso: a timeline anda pra frente, o arquivo anda pra TRÁS
      return c.reversed ? Math.max(c.source_in, c.source_out - off)
                        : c.source_in + off;
    }
  }
  return null;
}

/** tempo source -> tempo virtual. Retorna null se o instante nao esta em
 *  nenhum clip ativo. */
export function sourceToTimeline(state, s) {
  for (const seg of timelineSegments(state)) {
    if (s >= seg.clip.source_in - 1e-9 && s <= seg.clip.source_out + 1e-9) {
      return seg.tStart + (s - seg.clip.source_in) / segSpeed(seg);
    }
  }
  return null;
}

/** Segmento (e clip) sob um tempo virtual. */
export function segmentAt(state, t) {
  return timelineSegments(state).find(seg => t >= seg.tStart && t < seg.tEnd + 1e-9) || null;
}

/** Proximo ponto de corte (fronteira de clip) apos t, ou null. */
export function nextCutPoint(state, t) {
  const pts = cutPoints(state);
  for (const p of pts) if (p > t + 1e-6) return p;
  return null;
}

/** Ponto de corte anterior a t, ou null. */
export function prevCutPoint(state, t) {
  const pts = cutPoints(state);
  for (let i = pts.length - 1; i >= 0; i--) if (pts[i] < t - 1e-6) return pts[i];
  return null;
}

/** Todas as fronteiras de clips em tempo virtual (inclui 0 e total). */
export function cutPoints(state) {
  const segs = timelineSegments(state);
  const pts = [0];
  for (const seg of segs) pts.push(seg.tEnd);
  return pts;
}

/** Textos visiveis num tempo virtual. */
export function textsAt(state, t) {
  return effectiveTexts(state).filter(x =>
    t >= x.start_sec - 1e-9 && t <= x.end_sec + 1e-9);
}

/** Como a cena SENTA no quadro 9:16 do projeto (2026-08-07).
 *
 *  Vídeo horizontal importado entrava esmagado no `cover` global — o certo,
 *  combinado com o user: entra NO TAMANHO REAL (inteiro, com barras), o
 *  preview segue vertical e ele ajusta escala/posição por cima.
 *
 *  A regra é DERIVADA (nada novo no estado): proporção da mídia difere do
 *  quadro além de 5% → 'contain'. Preview e export usam ESTA mesma função —
 *  é o que garante WYSIWYG. Devolve null = segue o padrão do projeto. */
/** Formato EFETIVO do projeto: {id, w, h, ar}. 'original' deriva das
 *  dimensões da mídia principal na hora (vídeo trocado = formato acompanha);
 *  os demais já viajam resolvidos no estado. Preview, fitDaCena e export usam
 *  ESTA função — um só ponto de verdade pra proporção. */
export function formatoDoProjeto(state) {
  const f = state.formato || FORMATO_PADRAO;
  if (f.id === 'original') {
    const v = state.video;
    const ok = v && v.width > 0 && v.height > 0;
    const w = ok ? Math.round(v.width / 2) * 2 : FORMATO_PADRAO.w;
    const h = ok ? Math.round(v.height / 2) * 2 : FORMATO_PADRAO.h;
    return { id: 'original', w, h, ar: w / h };
  }
  return { id: f.id, w: f.w, h: f.h, ar: f.w / f.h };
}

export function fitDaCena(state, seg) {
  if (!seg) return null;
  const c = seg.clip;
  const m = c.media_id != null
    ? (state.media || []).find(x => x.id === c.media_id)
    : state.video;
  if (!m || !(m.width > 0) || !(m.height > 0)) return null;
  const arM = m.width / m.height;
  const arP = formatoDoProjeto(state).ar;   // o quadro do PROJETO (9:16, 16:9…)
  return Math.abs(arM - arP) / arP > 0.05 ? 'contain' : null;
}

/** CAIXA da camada no palco, em FRAÇÃO do quadro do projeto (user 14/08:
 *  "o formato muda quando movo pra outra camada — todas têm o mesmo formato").
 *
 *  A caixa tem a proporção da MÍDIA da camada (contain no quadro) × escala:
 *  subir uma cena pra camada NÃO pode reenquadrá-la — com escala 1 ela fica
 *  IGUAL à faixa principal (mesma régua do fitDaCena). Preview (pip) e export
 *  (box_w_pct/box_h_pct no payload) usam ESTA função — WYSIWYG de uma fonte só.
 *  Imagem: largura = escala, altura segue a proporção do arquivo (h null).
 *  Mídia sem dimensões conhecidas: caixa na proporção do quadro (regra antiga). */
export function caixaDaCamada(state, o) {
  const s = o.scale ?? 0.5;
  if (o.kind === 'image') return { w: s, h: null };
  const m = o.media_id != null
    ? (state.media || []).find(x => x.id === o.media_id)
    : state.video;
  if (!m || !(m.width > 0) || !(m.height > 0)) return { w: s, h: s };
  const arM = m.width / m.height;
  const arP = formatoDoProjeto(state).ar;
  if (arM >= arP) return { w: s, h: s * (arP / arM) };   // mais larga: trava na largura
  return { w: s * (arM / arP), h: s };                   // mais alta: trava na altura
}

/** `transitions[].between` conta junções de ITENS da main track (composto = 1
 *  bloco), mas o export ACHATA compostos em sub-clips — no render a junção é
 *  entre clips achatados. Sem o remap, qualquer composto antes da emenda
 *  empurrava a transição pro lugar errado no arquivo (achado 2026-08-07). */
export function remapTransicoes(state) {
  const trans = state.transitions || [];
  if (!trans.length) return [];
  const items = mainTrackItems(state);
  const segs = timelineSegments(state);
  // quantos clips ACHATADOS cada item ocupa no payload
  const porItem = items.map(it => it.isCompound
    ? segs.filter(s => s.compoundId === it.clip.compound_id).length
    : 1);
  const out = [];
  for (const t of trans) {
    const k = t.between;
    if (k == null || k < 0 || k >= items.length - 1) continue;
    let flat = 0;
    for (let i = 0; i <= k; i++) flat += porItem[i];
    if (flat < 1) continue;   // item vazio (composto sem sub ativo) não tem emenda
    out.push({ ...t, between: flat - 1 });
  }
  return out;
}

/** Payload de export — espelha exatamente o contrato edit-v0 do Vercel.
 *  A validacao do backend: clips efetivos ordenados por source_in, totalDur >= 0.5. */
export function exportPayload(state) {
  // compostos sao ACHATADOS no export (timelineSegments ja expande)
  const clips = timelineSegments(state).map(seg => {
    // ⚠️ HERANÇA DO BLOCO COMPOSTO: máscara, Retoque e Aprimorar áudio podem
    // ter sido aplicados NO COMPOSTO. Ler direto de seg.clip (o sub-clipe)
    // ignorava tudo isso — era a raiz de "máscara em clipe composto não vai".
    const dono = (campo) => propriedadeDaCena(state, seg, campo);
    const mask = dono('mask');
    const grade = dono('grade');
    return {
    source_in: round3(seg.clip.source_in),
    source_out: round3(seg.clip.source_out),
    // multi-take: Railway baixa cada fonte distinta (null = video principal)
    media_url: seg.clip.media_id != null ? mediaUrlFor(state, seg.clip) : null,
    // aba Vídeo > Básico (escala/opacidade da cena) — Railway aplica no render
    scale: Math.round((dono('scale') ?? 1) * 100) / 100,
    opacity: Math.round((dono('opacity') ?? 1) * 100) / 100,
    // POSIÇÃO da cena no quadro: o preview move o vídeo (translate) e o payload
    // não levava — mover no editor não movia nada no arquivo exportado
    pos_x: Math.round((dono('pos_x') ?? 0) * 1000) / 1000,
    pos_y: Math.round((dono('pos_y') ?? 0) * 1000) / 1000,
    speed: Math.round(segSpeed(seg) * 1000) / 1000, // velocidade EFETIVA (composto multiplica)
    // menu Editar: congelar / reverso / espelhar (Railway aplica no render)
    ...(seg.clip.frozen ? { frozen: true, freeze_src: round3(seg.clip.freeze_src || 0), freeze_dur: round3(clipTimelineDur(seg.clip)) } : {}),
    ...(dono('reversed') ? { reversed: true } : {}),
    // animações da cena — o render aplica com filtros em t (fade/scale/crop)
    ...(seg.clip.anim_in ? { anim_in: seg.clip.anim_in } : {}),
    ...(seg.clip.anim_out ? { anim_out: seg.clip.anim_out } : {}),
    ...(seg.clip.anim_loop ? { anim_loop: seg.clip.anim_loop } : {}),
    // duração escolhida no slider (render usa o MESMO número do preview)
    ...(seg.clip.anim_in ? { anim_in_dur: round3(seg.clip.anim_in_dur ?? 0.5) } : {}),
    ...(seg.clip.anim_out ? { anim_out_dur: round3(seg.clip.anim_out_dur ?? 0.5) } : {}),
    ...(seg.clip.anim_loop && seg.clip.anim_loop_dur ? { anim_loop_dur: round3(seg.clip.anim_loop_dur) } : {}),
    ...(dono('mirrored') ? { mirrored: true } : {}),
    ...(dono('muted') ? { muted: true } : {}),          // áudio removido da cena
    // áudio da CENA estilo CapCut (15/08): o render aplica na extração do
    // áudio deste clipe (volume=dB, afade em tempo da régua, pan, voz)
    ...(dono('volume_db') ? { volume_db: dono('volume_db') } : {}),
    ...(dono('fade_in') ? { fade_in: dono('fade_in') } : {}),
    ...(dono('fade_out') ? { fade_out: dono('fade_out') } : {}),
    ...(dono('canal') ? { canal: dono('canal') } : {}),
    ...(dono('voz_mod') ? { voz_mod: dono('voz_mod') } : {}),
    // REMOVER FUNDO (15/08): números PRONTOS pro chromakey (core/fundo.js) —
    // o render não re-deriva nada; máscara/vídeo-duplo viajam por URL
    ...(dono('bg') ? { bg: bgParaPayload(dono('bg')) } : {}),
    // mídia com proporção diferente do quadro entra INTEIRA (tamanho real,
    // barras) — mesma regra do preview (fitDaCena) = WYSIWYG
    ...(fitDaCena(state, seg) === 'contain' ? { fit: 'contain' } : {}),
    // Aprimorar áudio da CENA (áudio embutido no vídeo) — o render aplica na
    // extração do áudio deste clipe
    ...(dono('fx_ruido') ? { fx_ruido: true } : {}),
    ...(dono('fx_voz') ? { fx_voz: true, fx_voz_int: Math.round(dono('fx_voz_int') ?? 75) } : {}),
    ...(dono('fx_norm') ? { fx_norm: true } : {}),
    ...(mask ? { mask } : {}),                           // máscara (Railway aplica)
    // CORREÇÃO DE COR: o payload NÃO levava o grade — os 15 controles do
    // Retoque morriam no preview e o arquivo saía sem nenhum deles. Vai o
    // estado cru (pra reabrir o projeto) e os números prontos pro render.
    ...(grade ? { grade } : {}),
    ...(grade && paramsRender(grade) ? { grade_render: paramsRender(grade) } : {}),
    };
  });
  return {
    version: 1,
    project_id: state.project_id,
    nome_projeto: state.nome_projeto,
    video: state.video,
    clips,
    texts: effectiveTexts(state).map(t => {
      // quebra de linha + posicao presa no quadro decididas AQUI e enviadas
      // prontas: o drawtext do ffmpeg nao quebra linha sozinho, entao sem isto
      // a legenda sai do quadro no arquivo final (bug 2026-07-29)
      // no quadro DO PROJETO: o prender-na-borda depende da proporção (16:9
      // tem menos altura relativa que 9:16); a quebra de linha é invariante
      const fpTxt = formatoDoProjeto(state);
      const lay = layoutDoTexto(t, TEXT_SIZE_PCT[t.size], fpTxt.w, fpTxt.h);
      return {
      content: t.content,
      lines: lay.linhas,          // o render desenha ESTAS linhas
      font_pct: round4(lay.fontePct), // fonte final (encolhe se virou paredao)
      font: t.font,
      size: t.size,
      color: t.color,
      ...(t.anim && t.anim !== 'nenhuma' ? { anim: t.anim } : {}), // entrada/saida
      ...(t.box ? { box: t.box } : {}), // tarja colorida atrás (estilo CapCut)
      ...(t.stroke ? { stroke: t.stroke } : {}), // traçado/borda da letra
      x_pct: round4(lay.xPct),
      y_pct: round4(lay.yPct),
      start_sec: round3(t.start_sec),
      end_sec: round3(t.end_sec),
      lane: t.lane || 4, // ordem de composicao (CapCut: lane maior = frente)
      };
    }),
    // clips de audio pro mixer do render (adelay/atrim no Railway)
    audio_clips: effectiveAudioClips(state).map(a => ({
      kind: a.kind,                 // 'video' usa o proprio source do video
      url: a.url || null,
      start: round3(a.start),
      source_in: round3(a.source_in),
      source_out: round3(a.source_out),
      volume: a.volume ?? 1,
      speed: Math.round(clipSpeed(a) * 1000) / 1000, // atempo no Railway
      // Aprimorar áudio (aplicado na cadeia do render)
      ...(a.fx_ruido ? { fx_ruido: true } : {}),
      ...(a.fx_voz ? { fx_voz: true, fx_voz_int: Math.round(a.fx_voz_int ?? 75) } : {}),
      ...(a.fx_norm ? { fx_norm: true } : {}),
    })),
    // camadas overlay (render: filter overlay + scale + enable window)
    overlays: effectiveOverlays(state).map(o => {
      const cx = caixaDaCamada(state, o);
      return {
      source_in: round3(o.source_in), source_out: round3(o.source_out),
      // imagem PNG (sticker/seta/círculo com transparência) vs camada de vídeo
      ...(o.kind === 'image' ? { kind: 'image', image_url: o.url } : {}),
      media_url: o.media_id != null ? mediaUrlFor(state, o) : null,
      start: round3(o.start),
      x_pct: round4(o.x_pct), y_pct: round4(o.y_pct),
      scale: Math.round(o.scale * 100) / 100,
      // CAIXA na proporção da MÍDIA (user 14/08): o render dimensiona por
      // estes números — a mesma caixa que o preview desenha (caixaDaCamada)
      box_w_pct: round4(cx.w),
      ...(cx.h != null ? { box_h_pct: round4(cx.h) } : {}),
      speed: Math.round(clipSpeed(o) * 1000) / 1000,
      ...(o.rotation ? { rotation: Math.round(o.rotation) } : {}),
      // som embutido da camada (user 14/08): o render mixa o áudio da camada,
      // a menos que o user o tenha removido — muted viaja explícito
      ...(o.muted ? { muted: true } : {}),
      ...(o.anim_in ? { anim_in: o.anim_in } : {}),
      ...(o.anim_out ? { anim_out: o.anim_out } : {}),
      ...(o.anim_loop ? { anim_loop: o.anim_loop } : {}),
      ...(o.anim_in ? { anim_in_dur: round3(o.anim_in_dur ?? 0.5) } : {}),
      ...(o.anim_out ? { anim_out_dur: round3(o.anim_out_dur ?? 0.5) } : {}),
      ...(o.anim_loop && o.anim_loop_dur ? { anim_loop_dur: round3(o.anim_loop_dur) } : {}),
      // quadros-chave de movimento (user 14/08): o render traça a MESMA reta
      // por expressão em t — ver keyframes.js (t relativo ao início da camada)
      ...(Array.isArray(o.kf) && o.kf.length
        ? { kf: o.kf.map(k => ({ t: round3(k.t), x: round4(k.x), y: round4(k.y) })) } : {}),
      // fundo removido na CAMADA: transparência REAL sobre o que está atrás
      ...(o.bg ? { bg: bgParaPayload(o.bg) } : {}),
      lane: o.lane || 1, // ordem de composicao
      };
    }),
    transitions: remapTransicoes(state),
    // com audio destacado o video renderiza MUDO (audio vem dos clips)
    volumes: state.audio_detached ? { ...state.volumes, video: 0 } : state.volumes,
    aspect_strategy: state.aspect_strategy,
    audio_detached: !!state.audio_detached,
  };
}

/** true se o estado esta pronto pra exportar (mesma regra do backend). */
export function canExport(state) {
  return !!(state.video?.url) && totalDuration(state) >= 0.5;
}

function round3(v) { return Math.round(v * 1000) / 1000; }
function round4(v) { return Math.round(v * 10000) / 10000; }

/** bg da cena no formato do RENDER: chroma vira números prontos
 *  (similarity/blend/despill), os outros modos viajam por URL. */
function bgParaPayload(bg) {
  if (!bg) return null;
  if (bg.modo === 'chroma') {
    return { modo: 'chroma', cor: bg.cor, ...chromaParaRender(bg) };
  }
  if (bg.modo === 'custom') return { modo: 'custom', mask_url: bg.mask_url };
  return {
    modo: 'auto', dupla_url: bg.dupla_url, src_in: round3(bg.src_in), src_out: round3(bg.src_out),
    ...(bg.dupla_dur > 0 ? { dupla_dur: round3(bg.dupla_dur) } : {}),
  };
}
