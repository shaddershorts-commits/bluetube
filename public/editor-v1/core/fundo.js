// editor-v1/core/fundo.js
// REMOVER PLANO DE FUNDO da cena (user 15/08, paridade CapCut). Módulo puro.
//
// Três modos, todos com par REAL no render:
//   chroma — chromakey do ffmpeg (cor + intensidade/suavizar/limpar);
//            o preview GL usa a MESMA conta (distância UV) → WYSIWYG.
//   custom — máscara PINTADA pelo usuário (PNG branco = remover), enviada
//            ao storage; render faz alphamerge invertido.
//   auto   — segmentação de PESSOA no navegador (MediaPipe) gera um vídeo
//            DUPLO [cor | máscara] lado a lado; render recorta e compõe.
// A cena removida compõe sobre PRETO (faixa principal não tem "atrás").

export const BG_MODOS = ['chroma', 'custom', 'auto'];

const c0100 = (v, d) => Math.min(100, Math.max(0, Number.isFinite(Number(v)) ? Number(v) : d));

/** Valida/normaliza o bg vindo de fora (action ou projeto salvo). null = sem. */
export function validarBg(bg) {
  if (!bg || !BG_MODOS.includes(bg.modo)) return null;
  if (bg.modo === 'chroma') {
    const cor = /^#[0-9a-fA-F]{6}$/.test(bg.cor || '') ? bg.cor.toLowerCase() : '#00d000';
    return {
      modo: 'chroma', cor,
      intensidade: c0100(bg.intensidade, 20),
      suavizar: c0100(bg.suavizar, 20),
      limpar: c0100(bg.limpar, 0),
    };
  }
  if (bg.modo === 'custom') {
    if (typeof bg.mask_url !== 'string' || !bg.mask_url) return null;
    return { modo: 'custom', mask_url: bg.mask_url };
  }
  // auto
  if (typeof bg.dupla_url !== 'string' || !bg.dupla_url) return null;
  const sIn = Math.max(0, Number(bg.src_in) || 0);
  const sOut = Number(bg.src_out) > sIn ? Number(bg.src_out) : sIn + 0.1;
  return { modo: 'auto', dupla_url: bg.dupla_url, src_in: sIn, src_out: sOut };
}

/** Números PRONTOS pro chromakey do ffmpeg — o preview GL e o render usam
 *  ESTA conta (só números cruzam pro motor). */
export function chromaParaRender(bg) {
  const sim = 0.05 + (c0100(bg?.intensidade, 20) / 100) * 0.35;   // 0.05..0.40
  const blend = (c0100(bg?.suavizar, 20) / 100) * 0.3;            // 0..0.30
  const despill = c0100(bg?.limpar, 0) / 100;                     // 0..1
  return {
    similarity: Math.round(sim * 1000) / 1000,
    blend: Math.round(blend * 1000) / 1000,
    despill: Math.round(despill * 100) / 100,
  };
}

/** RGB→UV (BT.601) — a régua de distância do chromakey; o shader do preview
 *  replica exatamente esta conversão. r/g/b em 0..1; devolve u/v em -0.5..0.5. */
export function rgbParaUv(r, g, b) {
  return {
    u: -0.14713 * r - 0.28886 * g + 0.436 * b,
    v: 0.615 * r - 0.51499 * g - 0.10001 * b,
  };
}
