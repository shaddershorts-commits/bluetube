// editor-v1/core/caption-styles.js
// CATALOGO DE MODELOS DE LEGENDA — modulo puro (mesmo desenho do catalogo de
// transicoes, que o usuario ja aprovou: categorias, busca e favoritos).
//
// Antes os modelos moravam soltos dentro do shell.js, todos numa grade unica
// de 10, sem categoria e sem previa. O painel novo (pedido de 29/07, print do
// CapCut) pede categorias na lateral e previa so no hover — e pra isso os
// modelos precisam ser DADO, nao markup.
//
// `anim` e o que o usuario chamou de "modelos coordenados com a narracao":
// o modelo ja traz a animacao de entrada, entao escolher "Salto" na verdade
// escolhe estilo + movimento de uma vez.

export const CAT_LEGENDA = [
  { id: 'favoritos', nome: 'Favoritos' },
  { id: 'classicos', nome: 'Clássicos' },
  { id: 'impacto',   nome: 'Impacto' },
  { id: 'coloridos', nome: 'Coloridos' },
  { id: 'tarja',     nome: 'Tarja' },
  { id: 'narracao',  nome: 'Narração' },
];

/** colorMode:
 *   single    — uma cor pra tudo
 *   rotate    — a cor gira palavra a palavra (paleta)
 *   highlight — tarja colorida atras do texto  */
export const MODELOS_LEGENDA = [
  // ── Clássicos ─────────────────────────────────────────────────────────────
  { id: 'classico',  nome: 'Clássico', cat: 'classicos', font: 'Anton',      size: 'medium', colorMode: 'single', color: '#ffffff', anim: 'nenhuma' },
  { id: 'suave',     nome: 'Suave',    cat: 'classicos', font: 'Oswald',     size: 'medium', colorMode: 'single', color: '#ffffff', anim: 'fade' },
  { id: 'amarelo',   nome: 'Amarelo',  cat: 'classicos', font: 'Anton',      size: 'medium', colorMode: 'single', color: '#ffd32a', anim: 'nenhuma' },
  { id: 'lima',      nome: 'Lima',     cat: 'classicos', font: 'Bebas Neue', size: 'medium', colorMode: 'single', color: '#a3e635', anim: 'nenhuma' },
  { id: 'gelo',      nome: 'Gelo',     cat: 'classicos', font: 'Oswald',     size: 'medium', colorMode: 'single', color: '#bfe9ff', anim: 'fade' },

  // ── Impacto ───────────────────────────────────────────────────────────────
  { id: 'impacto',   nome: 'Impacto',  cat: 'impacto',   font: 'Bebas Neue', size: 'large',  colorMode: 'single', color: '#ffffff', anim: 'pop' },
  { id: 'gigante',   nome: 'Gigante',  cat: 'impacto',   font: 'Anton',      size: 'xlarge', colorMode: 'single', color: '#ffffff', anim: 'pop' },
  { id: 'alerta',    nome: 'Alerta',   cat: 'impacto',   font: 'Anton',      size: 'large',  colorMode: 'single', color: '#ff2d55', anim: 'pop' },
  { id: 'ouro',      nome: 'Ouro',     cat: 'impacto',   font: 'Bebas Neue', size: 'large',  colorMode: 'single', color: '#ffd32a', anim: 'subir' },

  // ── Coloridos (a cor gira a cada palavra) ────────────────────────────────
  { id: 'pop',       nome: 'Pop',      cat: 'coloridos', font: 'Anton', size: 'medium', colorMode: 'rotate', palette: ['#ffffff', '#ffd32a', '#4ade80', '#ff6b9d', '#38bdf8'], anim: 'pop' },
  { id: 'neon',      nome: 'Neon',     cat: 'coloridos', font: 'Anton', size: 'medium', colorMode: 'rotate', palette: ['#00e5ff', '#a3e635', '#ff4dff'], anim: 'pop' },
  { id: 'fogo',      nome: 'Fogo',     cat: 'coloridos', font: 'Anton', size: 'medium', colorMode: 'rotate', palette: ['#ffd32a', '#ff7a00', '#ff2d55'], anim: 'pop' },
  { id: 'oceano',    nome: 'Oceano',   cat: 'coloridos', font: 'Oswald', size: 'medium', colorMode: 'rotate', palette: ['#38bdf8', '#22d3ee', '#a5f3fc'], anim: 'fade' },
  { id: 'doce',      nome: 'Doce',     cat: 'coloridos', font: 'Anton', size: 'medium', colorMode: 'rotate', palette: ['#ff6b9d', '#c084fc', '#fda4af'], anim: 'subir' },

  // ── Tarja (fundo colorido atras do texto) ────────────────────────────────
  { id: 'caixaVerde',   nome: 'Verde',   cat: 'tarja', font: 'Anton', size: 'medium', colorMode: 'highlight', color: '#06210f', box: '#22c55e', anim: 'nenhuma' },
  { id: 'caixaRosa',    nome: 'Rosa',    cat: 'tarja', font: 'Anton', size: 'medium', colorMode: 'highlight', color: '#ffffff', box: '#ff2d78', anim: 'nenhuma' },
  { id: 'caixaAmarela', nome: 'Amarela', cat: 'tarja', font: 'Anton', size: 'medium', colorMode: 'highlight', color: '#1a1200', box: '#ffd32a', anim: 'nenhuma' },
  { id: 'caixaPreta',   nome: 'Preta',   cat: 'tarja', font: 'Oswald', size: 'medium', colorMode: 'highlight', color: '#ffffff', box: '#0b1526', anim: 'fade' },

  // ── Narração (modelos que ACOMPANHAM a fala palavra a palavra) ───────────
  { id: 'karaoke',   nome: 'Karaokê',  cat: 'narracao', font: 'Anton',      size: 'large',  colorMode: 'rotate', palette: ['#ffffff', '#ffd32a'], anim: 'pop',   dica: 'Cada palavra salta ao ser falada' },
  { id: 'sussurro',  nome: 'Sussurro', cat: 'narracao', font: 'Oswald',     size: 'medium', colorMode: 'single', color: '#ffffff', anim: 'fade',  dica: 'Entra e sai suave, acompanhando a voz' },
  { id: 'marcador',  nome: 'Marcador', cat: 'narracao', font: 'Anton',      size: 'medium', colorMode: 'highlight', color: '#0b1526', box: '#ffd32a', anim: 'pop', dica: 'Tarja que pisca na palavra falada' },
  { id: 'legendaTv', nome: 'TV',       cat: 'narracao', font: 'Oswald',     size: 'small',  colorMode: 'highlight', color: '#ffffff', box: '#000000', anim: 'nenhuma', dica: 'Discreta, no rodapé, como legenda de TV' },
];

export function modeloPorId(id) {
  return MODELOS_LEGENDA.find((m) => m.id === id) || MODELOS_LEGENDA[0];
}

const CHAVE_FAV = 'be_cap_favoritos';
export function lerFavoritosLegenda() {
  try { return new Set(JSON.parse(localStorage.getItem(CHAVE_FAV) || '[]')); }
  catch { return new Set(); }
}
export function alternarFavoritoLegenda(id) {
  const s = lerFavoritosLegenda();
  if (s.has(id)) s.delete(id); else s.add(id);
  try { localStorage.setItem(CHAVE_FAV, JSON.stringify([...s])); } catch {}
  return s;
}

export function daCategoriaLegenda(cat, favoritos) {
  if (cat === 'favoritos') return MODELOS_LEGENDA.filter((m) => favoritos?.has(m.id));
  return MODELOS_LEGENDA.filter((m) => m.cat === cat);
}

const semAcento = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

export function buscarLegenda(termo) {
  const q = semAcento(termo);
  if (!q) return null;
  return MODELOS_LEGENDA.filter((m) =>
    semAcento(m.nome).includes(q) || semAcento(m.dica).includes(q) || semAcento(m.cat).includes(q));
}

/** Estilo de UMA palavra/frase (indice i) segundo o modelo. A cor gira no
 *  modo rotate; a tarja acompanha no modo highlight. */
export function estiloDaPalavra(tpl, i) {
  const base = { font: tpl.font, size: tpl.size, anim: tpl.anim || 'nenhuma' };
  if (tpl.colorMode === 'rotate') {
    return { ...base, color: tpl.palette[i % tpl.palette.length], box: null };
  }
  if (tpl.colorMode === 'highlight') {
    return { ...base, color: tpl.color, box: tpl.box };
  }
  return { ...base, color: tpl.color, box: null };
}
