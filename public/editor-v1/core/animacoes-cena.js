// editor-v1/core/animacoes-cena.js
// Animações da CENA (aba Animação — user 14/08): Entrada, Saída e Combinação.
//
// REGRA QUE MANDA (a mesma das transições, e desta vez com a lição aprendida):
// TODA animação daqui tem par REAL no ffmpeg (filtroDaAnimacao) e NASCE com
// teste individual de pixel no preview E no render — catálogo pequeno e
// provado antes de crescer. Clique aplica na cena selecionada na hora:
// entrada anima o comecinho, saída o fim, combinação dura a cena inteira.
//
// O preview aproxima com transform/opacity (GPU); o render usa fade e
// scale(eval=frame)/crop com expressões em t — nada aqui é só-preview.

export const ANIM_CATEGORIAS = [
  { id: 'in', nome: 'Entrada' },
  { id: 'out', nome: 'Saída' },
  { id: 'loop', nome: 'Combinação' },
];

// camada:false = só na cena principal (zoom/pulso exigem escala por frame,
// sem par confiável na composição do overlay — melhor 6 perfeitas que 9 com
// 3 quebradas no arquivo, a régua do próprio user)
export const ANIMACOES_CENA = [
  // ── Entrada ──────────────────────────────────────────────────────────────
  { id: 'fade_in', nome: 'Fade-in', slot: 'in', dur: 0.5, icone: '◐' },
  { id: 'zoom_in', nome: 'Aproximar', slot: 'in', dur: 0.5, icone: '🔍', camada: false },
  { id: 'subir', nome: 'Surgir de baixo', slot: 'in', dur: 0.5, icone: '⬆' },
  { id: 'vindo_direita', nome: 'Chegar da direita', slot: 'in', dur: 0.5, icone: '⬅' },
  // ── Saída ────────────────────────────────────────────────────────────────
  { id: 'fade_out', nome: 'Fade-out', slot: 'out', dur: 0.5, icone: '◑' },
  { id: 'zoom_out', nome: 'Afastar', slot: 'out', dur: 0.5, icone: '🔎', camada: false },
  { id: 'descer', nome: 'Sair por baixo', slot: 'out', dur: 0.5, icone: '⬇' },
  // ── Combinação (a cena inteira) ──────────────────────────────────────────
  { id: 'pulsar', nome: 'Pulsar', slot: 'loop', dur: 0, icone: '💓', camada: false },
  { id: 'balanco', nome: 'Balanço', slot: 'loop', dur: 0, icone: '🌊' },
];

export const ANIM_POR_ID = new Map(ANIMACOES_CENA.map((a) => [a.id, a]));

// régua do slider "Duração" (user 14/08, igual CapCut): 0.1s a 5s — mas nunca
// mais que metade da cena (entrada e saída não podem se atropelar)
export const ANIM_DUR_MIN = 0.1;
export const ANIM_DUR_MAX = 5;
export function duracaoDaAnimacao(durEscolhida, durCena) {
  const alvo = Number(durEscolhida) > 0 ? Number(durEscolhida) : 0.5;
  return Math.max(ANIM_DUR_MIN, Math.min(alvo, ANIM_DUR_MAX, durCena / 2));
}

/** Fator 0..1 da animação num instante da cena (0 = totalmente "fora").
 *  tLocal/durCena em segundos DA CENA (régua). durEscolhida = slider (user
 *  14/08); ausente = 0.5s de sempre. Devolve null = sem animação. */
export function progressoDaAnimacao(anim, slot, tLocal, durCena, durEscolhida) {
  if (!anim) return null;
  const dur = duracaoDaAnimacao(durEscolhida ?? anim.dur, durCena);
  if (slot === 'in') return Math.max(0, Math.min(1, tLocal / dur));
  if (slot === 'out') return Math.max(0, Math.min(1, (durCena - tLocal) / dur));
  return null; // loop não tem progresso — é contínuo (previewDoLoop)
}

/** transform/opacity do PREVIEW pra um progresso p (entrada e saída usam a
 *  MESMA tabela — a saída roda o progresso ao contrário por construção). */
export function previewDaAnimacao(animId, p) {
  const q = 1 - p; // quanto falta pra assentar
  switch (animId) {
    case 'fade_in': case 'fade_out': return { opacity: p };
    case 'zoom_in': return { transform: `scale(${(1 + 0.2 * q).toFixed(4)})` };
    case 'zoom_out': return { transform: `scale(${(1 + 0.2 * q).toFixed(4)})` };
    case 'subir': return { transform: `translateY(${(q * 100).toFixed(2)}%)` };
    case 'vindo_direita': return { transform: `translateX(${(q * 100).toFixed(2)}%)` };
    case 'descer': return { transform: `translateY(${(q * 100).toFixed(2)}%)` };
    default: return null;
  }
}

/** transform do PREVIEW pras combinações (t = relógio contínuo em segundos).
 *  periodo = slider "Duração" (user 14/08): 1 ciclo completo dura isso.
 *  Ausente = os períodos de sempre (pulsar 1.6s, balanço 2.2s). */
export function previewDoLoop(animId, t, periodo) {
  const per = (p) => (Number(periodo) > 0 ? Number(periodo) : p);
  switch (animId) {
    case 'pulsar': return { transform: `scale(${(1.05 + 0.04 * Math.sin((2 * Math.PI * t) / per(1.6))).toFixed(4)})` };
    case 'balanco': return { transform: `scale(1.06) translateX(${(2.2 * Math.sin((2 * Math.PI * t) / per(2.2))).toFixed(2)}%)` };
    default: return null;
  }
}
