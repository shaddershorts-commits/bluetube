// editor-v1/core/keyframes.js
// QUADROS-CHAVE de movimento (user 14/08: "a seta segue o cachorro").
//
// Modelo: overlay.kf = [{ t, x, y }] ordenado por t.
//   t = segundos DENTRO da janela da camada NA TIMELINE (0 = início da camada;
//       mover a camada no tempo carrega os quadros-chave junto, como no CapCut)
//   x/y = x_pct/y_pct (0..1, mesmo referencial do transform estático)
// Com >=1 quadro-chave, a POSIÇÃO da camada passa a ser esta curva (o
// x_pct/y_pct estático vira só o valor "sem kf"). Interpolação LINEAR entre
// vizinhos; antes do primeiro / depois do último, o valor é preso neles.
//
// Módulo puro: preview (pip.js), timeline e payload usam ESTAS funções — o
// render do Railway espelha a mesma reta por expressão em t (só números viajam).

export const MAX_KF = 100;      // teto de sanidade (expressão do ffmpeg finita)
export const KF_EPS = 0.05;     // mais perto que isso = o MESMO quadro-chave

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const c01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

/** Valida/ordena uma lista vinda de fora (projeto salvo). Nunca inventa nada:
 *  entrada inválida vira lista vazia; itens quebrados caem fora. */
export function normalizarKf(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((k) => k && num(k.t) && k.t >= 0 && num(k.x) && num(k.y))
    .slice(0, MAX_KF)
    .map((k) => ({ t: Math.round(k.t * 1000) / 1000, x: c01(k.x), y: c01(k.y) }))
    .sort((a, b) => a.t - b.t);
}

/** Posição {x,y} no instante tRel (segundos desde o início da camada).
 *  null = lista vazia (usar o transform estático). */
export function posNoTempo(kfs, tRel) {
  if (!Array.isArray(kfs) || !kfs.length) return null;
  if (tRel <= kfs[0].t) return { x: kfs[0].x, y: kfs[0].y };
  const last = kfs[kfs.length - 1];
  if (tRel >= last.t) return { x: last.x, y: last.y };
  for (let i = 1; i < kfs.length; i++) {
    if (tRel <= kfs[i].t) {
      const a = kfs[i - 1], b = kfs[i];
      const p = (tRel - a.t) / Math.max(1e-6, b.t - a.t);
      return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
    }
  }
  return { x: last.x, y: last.y };
}

/** Índice do quadro-chave "no" instante tRel (±KF_EPS), ou -1. */
export function kfIndexEm(kfs, tRel) {
  if (!Array.isArray(kfs)) return -1;
  let best = -1, bestD = KF_EPS;
  for (let i = 0; i < kfs.length; i++) {
    const d = Math.abs(kfs[i].t - tRel);
    if (d <= bestD) { best = i; bestD = d; }
  }
  return best;
}

/** Nova lista com um kf gravado em tRel (substitui o vizinho a <KF_EPS —
 *  arrastar parado no mesmo instante ATUALIZA em vez de acumular). */
export function upsertKf(kfs, tRel, x, y) {
  const t = Math.max(0, Math.round(tRel * 1000) / 1000);
  const out = (kfs || []).filter((k) => Math.abs(k.t - t) > KF_EPS);
  if (out.length >= MAX_KF) return kfs || [];
  out.push({ t, x: c01(x), y: c01(y) });
  out.sort((a, b) => a.t - b.t);
  return out;
}
