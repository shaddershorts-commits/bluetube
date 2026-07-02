// editor-v1/timeline/snap.js
// Snap magnetico: aproxima um tempo-alvo de pontos de interesse (fronteiras
// de clips, playhead, t=0) quando a distancia em PX (nao segundos) esta
// dentro do threshold. Modulo puro.

export const SNAP_THRESHOLD_PX = 8;

/**
 * @param {number} t tempo candidato (s)
 * @param {number[]} points pontos de snap em tempo (s)
 * @param {number} pxPerSec zoom atual
 * @param {number} [thresholdPx]
 * @returns {{t:number, snapped:boolean, point:number|null}}
 */
export function snapTime(t, points, pxPerSec, thresholdPx = SNAP_THRESHOLD_PX) {
  if (!pxPerSec || pxPerSec <= 0) return { t, snapped: false, point: null };
  const maxDist = thresholdPx / pxPerSec;
  let best = null, bestDist = Infinity;
  for (const p of points) {
    const d = Math.abs(p - t);
    if (d <= maxDist && d < bestDist) { best = p; bestDist = d; }
  }
  if (best == null) return { t, snapped: false, point: null };
  return { t: best, snapped: true, point: best };
}

/** Pontos de snap padrao pra trims/drag: fronteiras + playhead + zero. */
export function defaultSnapPoints(cutPts, playhead) {
  const pts = new Set(cutPts);
  pts.add(0);
  if (playhead != null) pts.add(playhead);
  return [...pts];
}
