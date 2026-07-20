// editor-v1/core/selectors.js
// Consultas derivadas do estado. UNICO lugar com o mapeamento tempo
// virtual (timeline) <-> tempo source (arquivo). Modulo puro.

/** Clips efetivos: ativos, na ordem do array (ordem visual da timeline).
 *  Espelha a logica do backend edit-v0 (filter active !== false). */
export function effectiveClips(state) {
  return (state.clips || []).filter(c => c.active !== false);
}

/** Duracao total do corte final (soma dos clips ativos). */
export function totalDuration(state) {
  return effectiveClips(state).reduce((acc, c) => acc + clipDuration(state, c), 0);
}

/** Duracao REPRODUZIVEL da timeline: video OU audio, o que terminar depois.
 *  Sem isso, projeto so-audio (ou com a faixa de video excluida) tinha
 *  duracao 0 e o play nunca andava (bug user 2026-07-20). */
export function playableDuration(state) {
  let total = totalDuration(state);
  for (const a of effectiveAudioClips(state)) {
    total = Math.max(total, a.start + (a.source_out - a.source_in));
  }
  return total;
}

/** Segmentos da timeline: cada clip ativo com seu offset acumulado no tempo
 *  virtual. [{ clip, tStart, tEnd }] onde t* e tempo virtual. */
export function timelineSegments(state) {
  // EXPANDIDO (player/export): compostos viram seus sub-clips reais
  const segs = [];
  let t = 0;
  for (const clip of effectiveClips(state)) {
    if (clip.compound_id) {
      const comp = (state.compounds || []).find(k => k.id === clip.compound_id);
      const t0 = t;
      for (const sub of (comp?.clips || []).filter(x => x.active !== false)) {
        const dur = sub.source_out - sub.source_in;
        segs.push({ clip: sub, tStart: t, tEnd: t + dur, compoundId: clip.compound_id });
        t += dur;
      }
      // composto pode ser MAIOR que o video interno (so-audio/texto):
      // o bloco ocupa a duracao total — o trecho sem video toca preto+audio
      t = t0 + compoundDuration(comp);
    } else {
      const dur = clip.source_out - clip.source_in;
      segs.push({ clip, tStart: t, tEnd: t + dur });
      t += dur;
    }
  }
  return segs;
}

/** Duracao INTERNA de um composto: video em sequencia OU o fim do ultimo
 *  audio/texto/camada — o que terminar depois. Compostos sem video (so
 *  audio, por ex.) existem desde 2026-07-20. */
export function compoundDuration(comp) {
  if (!comp) return 0;
  let total = (comp.clips || []).filter(x => x.active !== false)
    .reduce((a, x) => a + (x.source_out - x.source_in), 0);
  for (const a of (comp.audio_clips || []).filter(x => x.active !== false)) {
    total = Math.max(total, a.start + (a.source_out - a.source_in));
  }
  for (const x of (comp.texts || []).filter(x => x.active !== false)) {
    total = Math.max(total, x.end_sec);
  }
  for (const o of (comp.overlays || []).filter(x => x.active !== false)) {
    total = Math.max(total, o.start + (o.source_out - o.source_in));
  }
  return total;
}

/** Duracao de um clip da main (compound = duracao interna total). */
export function clipDuration(state, c) {
  if (c.compound_id) {
    return compoundDuration((state.compounds || []).find(k => k.id === c.compound_id));
  }
  return c.source_out - c.source_in;
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

/** Textos efetivos (soltos + dos compostos, offsets absolutos). */
export function effectiveTexts(state) {
  const out = (state.texts || []).filter(t => t.active !== false).map(t => ({ ...t }));
  const offs = compoundOffsets(state);
  for (const comp of (state.compounds || [])) {
    const off = offs.get(comp.id);
    if (off == null) continue;
    for (const t of (comp.texts || []).filter(x => x.active !== false)) {
      out.push({ ...t, id: 'c' + comp.id + '_' + t.id, start_sec: t.start_sec + off, end_sec: t.end_sec + off, _compound: true });
    }
  }
  return out;
}

/** Audios efetivos (soltos + dos compostos, offsets absolutos). */
export function effectiveAudioClips(state) {
  const out = (state.audio_clips || []).filter(a => a.active !== false).map(a => ({ ...a }));
  const offs = compoundOffsets(state);
  for (const comp of (state.compounds || [])) {
    const off = offs.get(comp.id);
    if (off == null) continue;
    for (const a of (comp.audio_clips || []).filter(x => x.active !== false)) {
      out.push({ ...a, id: 'c' + comp.id + '_' + a.id, start: a.start + off, _compound: true });
    }
  }
  return out;
}

/** Overlays efetivos (soltos + dos compostos, offsets absolutos). */
export function effectiveOverlays(state) {
  const out = (state.overlays || []).filter(o => o.active !== false).map(o => ({ ...o }));
  const offs = compoundOffsets(state);
  for (const comp of (state.compounds || [])) {
    const off = offs.get(comp.id);
    if (off == null) continue;
    for (const o of (comp.overlays || []).filter(x => x.active !== false)) {
      out.push({ ...o, id: 'c' + comp.id + '_' + o.id, start: o.start + off, _compound: true });
    }
  }
  return out;
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
      return seg.clip.source_in + (t - seg.tStart);
    }
  }
  return null;
}

/** tempo source -> tempo virtual. Retorna null se o instante nao esta em
 *  nenhum clip ativo. */
export function sourceToTimeline(state, s) {
  for (const seg of timelineSegments(state)) {
    if (s >= seg.clip.source_in - 1e-9 && s <= seg.clip.source_out + 1e-9) {
      return seg.tStart + (s - seg.clip.source_in);
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
  }));
  return {
    version: 1,
    project_id: state.project_id,
    nome_projeto: state.nome_projeto,
    video: state.video,
    clips,
    texts: effectiveTexts(state).map(t => ({
      content: t.content,
      font: t.font,
      size: t.size,
      color: t.color,
      x_pct: round4(t.x_pct),
      y_pct: round4(t.y_pct),
      start_sec: round3(t.start_sec),
      end_sec: round3(t.end_sec),
      lane: t.lane || 4, // ordem de composicao (CapCut: lane maior = frente)
    })),
    // clips de audio pro mixer do render (adelay/atrim no Railway)
    audio_clips: effectiveAudioClips(state).map(a => ({
      kind: a.kind,                 // 'video' usa o proprio source do video
      url: a.url || null,
      start: round3(a.start),
      source_in: round3(a.source_in),
      source_out: round3(a.source_out),
      volume: a.volume ?? 1,
    })),
    // camadas overlay (render: filter overlay + scale + enable window)
    overlays: effectiveOverlays(state).map(o => ({
      source_in: round3(o.source_in), source_out: round3(o.source_out),
      media_url: o.media_id != null ? mediaUrlFor(state, o) : null,
      start: round3(o.start),
      x_pct: round4(o.x_pct), y_pct: round4(o.y_pct),
      scale: Math.round(o.scale * 100) / 100,
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
