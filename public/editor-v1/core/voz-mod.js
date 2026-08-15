// editor-v1/core/voz-mod.js
// ÁUDIO DA CENA estilo CapCut (user 15/08): catálogo do Modificador de voz e
// do Preencher canal. REGRA DE SEMPRE: só entra aqui o que tem par REAL no
// ffmpeg do render — o motor espelha estas contas (railway server.js,
// filtrosDaCenaAudio). Módulo puro: sem DOM, sem fetch.

// Modificador de voz. `pitch` = fator do asetrate (o render usa
// asetrate*f + aresample + atempo=1/f — mesma conta do worklet do preview).
export const VOZES = [
  { id: null,       nome: 'Normal',   icone: '🎙', pitch: 1 },
  { id: 'grave',    nome: 'Grave',    icone: '🐻', pitch: 0.8 },
  { id: 'agudo',    nome: 'Agudo',    icone: '🐭', pitch: 1.3 },
  { id: 'helio',    nome: 'Hélio',    icone: '🎈', pitch: 1.5 },
  { id: 'eco',      nome: 'Eco',      icone: '🏔', pitch: 1 },
  { id: 'telefone', nome: 'Telefone', icone: '📞', pitch: 1 },
];
export const VOZ_POR_ID = new Map(VOZES.filter(v => v.id).map(v => [v.id, v]));
export const vozValida = (v) => (VOZ_POR_ID.has(v) ? v : null);

export const CANAIS = [
  { id: 'both', nome: 'Ambos' },
  { id: 'esq',  nome: 'Esquerdo' },
  { id: 'dir',  nome: 'Direito' },
];
export const canalValido = (c) => (c === 'esq' || c === 'dir' ? c : 'both');

// régua do volume por cena (dB, como o CapCut mostra)
export const VOL_DB_MIN = -60;
export const VOL_DB_MAX = 10;
export const FADE_MAX = 5;           // segundos, por lado
export const dbParaLinear = (db) => Math.pow(10, (Number(db) || 0) / 20);

/** Fator 0..1 do fade num instante da cena (tLocal/durCena em segundos da
 *  régua). Preview (el.volume) e render (afade) usam a MESMA conta. */
export function fatorFade(tLocal, durCena, fadeIn, fadeOut) {
  let f = 1;
  const fi = Math.min(Number(fadeIn) || 0, durCena / 2);
  const fo = Math.min(Number(fadeOut) || 0, durCena / 2);
  if (fi > 0 && tLocal < fi) f *= Math.max(0, tLocal / fi);
  if (fo > 0 && tLocal > durCena - fo) f *= Math.max(0, (durCena - tLocal) / fo);
  return Math.min(1, Math.max(0, f));
}
