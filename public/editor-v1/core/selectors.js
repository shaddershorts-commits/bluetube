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
  return effectiveClips(state).reduce((acc, c) => acc + (c.source_out - c.source_in), 0);
}

/** Segmentos da timeline: cada clip ativo com seu offset acumulado no tempo
 *  virtual. [{ clip, tStart, tEnd }] onde t* e tempo virtual. */
export function timelineSegments(state) {
  const segs = [];
  let t = 0;
  for (const clip of effectiveClips(state)) {
    const dur = clip.source_out - clip.source_in;
    segs.push({ clip, tStart: t, tEnd: t + dur });
    t += dur;
  }
  return segs;
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
  return (state.texts || []).filter(x =>
    x.active !== false && t >= x.start_sec - 1e-9 && t <= x.end_sec + 1e-9);
}

/** Payload de export — espelha exatamente o contrato edit-v0 do Vercel.
 *  A validacao do backend: clips efetivos ordenados por source_in, totalDur >= 0.5. */
export function exportPayload(state) {
  const clips = effectiveClips(state).map(c => ({
    source_in: round3(c.source_in),
    source_out: round3(c.source_out),
  }));
  return {
    version: 1,
    project_id: state.project_id,
    nome_projeto: state.nome_projeto,
    video: state.video,
    clips,
    texts: (state.texts || []).filter(t => t.active !== false).map(t => ({
      content: t.content,
      font: t.font,
      size: t.size,
      color: t.color,
      x_pct: round4(t.x_pct),
      y_pct: round4(t.y_pct),
      start_sec: round3(t.start_sec),
      end_sec: round3(t.end_sec),
    })),
    audio_extra: state.audio_extra,
    transitions: state.transitions || [],
    volumes: state.volumes,
    aspect_strategy: state.aspect_strategy,
  };
}

/** true se o estado esta pronto pra exportar (mesma regra do backend). */
export function canExport(state) {
  return !!(state.video?.url) && totalDuration(state) >= 0.5;
}

function round3(v) { return Math.round(v * 1000) / 1000; }
function round4(v) { return Math.round(v * 10000) / 10000; }
