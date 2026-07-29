// editor-v1/core/selectors.js
// Consultas derivadas do estado. UNICO lugar com o mapeamento tempo
// virtual (timeline) <-> tempo source (arquivo). Modulo puro.

import { TEXT_SIZE_PCT } from './schema.js';
import { layoutDoTexto } from './text-layout.js';

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
    for (const a of (comp.audio_clips || []).filter(x => x.active !== false)) {
      // velocidade do composto acelera o audio interno junto (user 2026-07-20)
      out.push({ ...a, id: 'c' + comp.id + '_' + a.id, start: off + a.start / cs, speed: clipSpeed(a) * cs, _compound: true });
    }
  }
  return out;
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
 *  REAL do projeto e devolve { url, segments:[{tStart,fileIn,fileOut}] } onde
 *  tStart e tempo VIRTUAL e fileIn/fileOut sao tempos DENTRO do arquivo (url).
 *  Prioridade (user 2026-07-20):
 *   1) audio proprio do editor (kind 'extra') — a narracao gravada por ele
 *   2) audio do video, SE nao foi separado/removido
 *   3) audio do video ja separado (kind 'video'), se ainda existe
 *   null = nao ha voz pra transcrever (nunca gera "legenda fantasma"). */
export function captionAudioPlan(state) {
  const audios = effectiveAudioClips(state);
  const extras = audios.filter(a => a.kind !== 'video' && a.url);
  const detachedVid = audios.filter(a => a.kind === 'video');

  const planFor = (list, urlOf) => {
    const byUrl = new Map();
    for (const a of list) {
      const url = urlOf(a);
      if (!url) continue;
      if (!byUrl.has(url)) byUrl.set(url, []);
      byUrl.get(url).push({ tStart: a.start, fileIn: a.source_in, fileOut: a.source_out });
    }
    let best = null, bestCov = -1;
    for (const [url, segments] of byUrl) {
      const cov = segments.reduce((s, x) => s + (x.fileOut - x.fileIn), 0);
      if (cov > bestCov) { bestCov = cov; best = { url, segments }; }
    }
    return best;
  };

  // 1) narracao propria do editor tem prioridade
  if (extras.length) return planFor(extras, a => a.url);
  // 2) audio do video principal (nao separado) — segmentos = clips do principal
  if (!state.audio_detached && state.video?.url) {
    const segs = timelineSegments(state)
      .filter(s => s.clip.media_id == null)  // takes tem audio proprio, fora do escopo
      .map(s => ({ tStart: s.tStart, fileIn: s.clip.source_in, fileOut: s.clip.source_out }));
    return segs.length ? { url: state.video.url, segments: segs } : null;
  }
  // 3) audio do video ja separado mas ainda presente
  if (detachedVid.length && state.video?.url) return planFor(detachedVid, () => state.video.url);
  return null;
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

/** Payload de export — espelha exatamente o contrato edit-v0 do Vercel.
 *  A validacao do backend: clips efetivos ordenados por source_in, totalDur >= 0.5. */
export function exportPayload(state) {
  // compostos sao ACHATADOS no export (timelineSegments ja expande)
  const clips = timelineSegments(state).map(seg => ({
    source_in: round3(seg.clip.source_in),
    source_out: round3(seg.clip.source_out),
    // multi-take: Railway baixa cada fonte distinta (null = video principal)
    media_url: seg.clip.media_id != null ? mediaUrlFor(state, seg.clip) : null,
    // aba Vídeo > Básico (escala/opacidade da cena) — Railway aplica no render
    scale: Math.round((seg.clip.scale ?? 1) * 100) / 100,
    opacity: Math.round((seg.clip.opacity ?? 1) * 100) / 100,
    speed: Math.round(clipSpeed(seg.clip) * 1000) / 1000, // aba Velocidade
    // menu Editar: congelar / reverso / espelhar (Railway aplica no render)
    ...(seg.clip.frozen ? { frozen: true, freeze_src: round3(seg.clip.freeze_src || 0), freeze_dur: round3(clipTimelineDur(seg.clip)) } : {}),
    ...(seg.clip.reversed ? { reversed: true } : {}),
    ...(seg.clip.mirrored ? { mirrored: true } : {}),
    ...(seg.clip.muted ? { muted: true } : {}),          // áudio removido da cena
    ...(seg.clip.mask ? { mask: seg.clip.mask } : {}),    // máscara (Railway aplica)
  }));
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
      const lay = layoutDoTexto(t, TEXT_SIZE_PCT[t.size]);
      return {
      content: t.content,
      lines: lay.linhas,          // o render desenha ESTAS linhas
      font_pct: round4(lay.fontePct), // fonte final (encolhe se virou paredao)
      font: t.font,
      size: t.size,
      color: t.color,
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
    })),
    // camadas overlay (render: filter overlay + scale + enable window)
    overlays: effectiveOverlays(state).map(o => ({
      source_in: round3(o.source_in), source_out: round3(o.source_out),
      // imagem PNG (sticker/seta/círculo com transparência) vs camada de vídeo
      ...(o.kind === 'image' ? { kind: 'image', image_url: o.url } : {}),
      media_url: o.media_id != null ? mediaUrlFor(state, o) : null,
      start: round3(o.start),
      x_pct: round4(o.x_pct), y_pct: round4(o.y_pct),
      scale: Math.round(o.scale * 100) / 100,
      speed: Math.round(clipSpeed(o) * 1000) / 1000,
      ...(o.rotation ? { rotation: Math.round(o.rotation) } : {}),
      lane: o.lane || 1, // ordem de composicao
    })),
    transitions: state.transitions || [],
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
