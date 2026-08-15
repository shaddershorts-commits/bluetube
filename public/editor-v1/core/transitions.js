// editor-v1/core/transitions.js
// Catálogo de transições (2026-07-29).
//
// REGRA QUE MANDA AQUI: toda transição desta lista tem um `xfade` REAL do
// ffmpeg. O preview é uma aproximação do que o render vai fazer — nunca um
// efeito bonito que o arquivo final não teria. Transição sem par no ffmpeg não
// entra no catálogo.
//
// `preview` descreve como aproximar no navegador. São efeitos compostos por
// opacity/transform/filter — tudo que a GPU compõe sozinha, sem repintar a
// cada frame. Por isso a prévia roda lisa mesmo em máquina fraca.
//
// `intensidade` (0..100) modula o efeito: o ffmpeg não tem esse parâmetro
// por transição, então ela vira DURAÇÃO efetiva + força do preview. Deixar
// explícito evita prometer um controle que o render não honra.

export const CATEGORIAS = [
  { id: 'favoritos', nome: 'Favoritos' },
  { id: 'basico', nome: 'Básico' },
  { id: 'deslizar', nome: 'Deslizar' },
  { id: 'luz', nome: 'Luz' },
  { id: 'desfocar', nome: 'Desfocar' },
  { id: 'falha', nome: 'Falha' },
  { id: 'camera', nome: 'Câmera' },
  { id: 'mascarar', nome: 'Mascarar' },
];

export const TRANSICOES = [
  // ── Básico ───────────────────────────────────────────────────────────────
  { id: 'dissolver', nome: 'Dissolver', cat: 'basico', xfade: 'fade', preview: 'cross' },
  { id: 'esmaecer_preto', nome: 'Esmaecer preto', cat: 'basico', xfade: 'fadeblack', preview: 'flash', cor: '#000' },
  { id: 'esmaecer_branco', nome: 'Esmaecer branco', cat: 'basico', xfade: 'fadewhite', preview: 'flash', cor: '#fff' },
  { id: 'dissolver_granulado', nome: 'Dissolver granulado', cat: 'basico', xfade: 'dissolve', preview: 'cross' },

  // ── Deslizar ─────────────────────────────────────────────────────────────
  { id: 'deslizar_baixo', nome: 'Deslizar baixo', cat: 'deslizar', xfade: 'slidedown', preview: 'slide', eixo: 'y', sinal: 1 },
  { id: 'deslizar_cima', nome: 'Deslizar cima', cat: 'deslizar', xfade: 'slideup', preview: 'slide', eixo: 'y', sinal: -1 },
  { id: 'deslizar_esq', nome: 'Deslizar esquerda', cat: 'deslizar', xfade: 'slideleft', preview: 'slide', eixo: 'x', sinal: -1 },
  { id: 'desvanecer_baixo', nome: 'Desvanecer baixo', cat: 'deslizar', xfade: 'smoothdown', preview: 'wipe', eixo: 'y', sinal: 1, suave: true },
  { id: 'varrer_baixo', nome: 'Varredura baixo', cat: 'deslizar', xfade: 'wipedown', preview: 'wipe', eixo: 'y', sinal: 1 },

  // ── Luz ──────────────────────────────────────────────────────────────────
  { id: 'flash_sol', nome: 'Flash do sol', cat: 'luz', xfade: 'fadewhite', preview: 'flash', cor: '#fff', forte: true },
  { id: 'varredura_clarao', nome: 'Varredura clarão', cat: 'luz', xfade: 'radial', preview: 'radial' },

  // ── Desfocar ─────────────────────────────────────────────────────────────
  { id: 'desfoque', nome: 'Desfoque', cat: 'desfocar', xfade: 'hblur', preview: 'blur' },
  { id: 'suave_esq', nome: 'Suave esquerda', cat: 'desfocar', xfade: 'smoothleft', preview: 'wipe', eixo: 'x', sinal: -1, suave: true },

  // ── Falha ────────────────────────────────────────────────────────────────
  { id: 'falha_tv', nome: 'Falha de TV', cat: 'falha', xfade: 'hlslice', preview: 'glitch' },
  { id: 'pixelizar', nome: 'Pixelizar', cat: 'falha', xfade: 'pixelize', preview: 'pixel' },

  // ── Câmera ───────────────────────────────────────────────────────────────
  { id: 'zoom_choque', nome: 'Zoom de choque', cat: 'camera', xfade: 'zoomin', preview: 'zoom' },
  { id: 'agitacao_x', nome: 'Agitação X', cat: 'camera', xfade: 'hrwind', preview: 'shake' },

  // ── Mascarar ─────────────────────────────────────────────────────────────
  { id: 'circulo', nome: 'Círculo', cat: 'mascarar', xfade: 'circlecrop', preview: 'circulo' },
  { id: 'abrir_circulo', nome: 'Abrir círculo', cat: 'mascarar', xfade: 'circleopen', preview: 'circulo', abrir: true },
];

export const POR_ID = new Map(TRANSICOES.map((t) => [t.id, t]));

/** Lista de xfade aceitos — o reducer valida contra isto. */
export const XFADE_VALIDOS = new Set(TRANSICOES.map((t) => t.xfade));

export function transicaoPorId(id) {
  return POR_ID.get(id) || null;
}

/** Duração efetiva em segundos, já com a intensidade aplicada. */
export function duracaoEfetiva(tr) {
  const base = Number(tr?.duration) || 0.5;
  return Math.max(0.1, Math.min(3, base));
}

// ── FAVORITOS ───────────────────────────────────────────────────────────────
// Ficam no navegador, não no projeto: é preferência de quem edita, não parte do
// vídeo. Assim a estrelinha acompanha o usuário entre projetos.
const CHAVE_FAV = 'be_transicoes_favoritas';

export function lerFavoritos() {
  try { return new Set(JSON.parse(localStorage.getItem(CHAVE_FAV) || '[]')); }
  catch { return new Set(); }
}

export function alternarFavorito(id) {
  const s = lerFavoritos();
  if (s.has(id)) s.delete(id); else s.add(id);
  try { localStorage.setItem(CHAVE_FAV, JSON.stringify([...s])); } catch {}
  return s;
}

/** Transições de uma categoria (favoritos lê do navegador). */
export function daCategoria(cat, favoritos) {
  if (cat === 'favoritos') return TRANSICOES.filter((t) => favoritos?.has(t.id));
  return TRANSICOES.filter((t) => t.cat === cat);
}

export function buscar(termo) {
  const q = String(termo || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  if (!q) return null;
  return TRANSICOES.filter((t) =>
    t.nome.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(q));
}
