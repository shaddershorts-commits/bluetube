// editor-v1/preview/color-grade.js
// Correção de cor da cena — o que o painel "Retoque" edita (2026-07-29).
//
// A aba existia como placeholder ("em breve"). Aqui ela passa a MEXER NA
// IMAGEM de verdade, com filtro SVG aplicado ao elemento de vídeo.
//
// Por que SVG e não só `filter: brightness()` do CSS: brilho/contraste do CSS
// resolvem pouco. Temperatura, matiz seletivo, realce de altas/baixas e
// preto/branco pedem matriz de cor e transferência por canal — feColorMatrix e
// feComponentTransfer fazem isso no navegador, sem canvas e sem custo de CPU
// por frame (o compositor da GPU cuida).
//
// TODOS os valores são -100..100, com 0 = neutro (mesma convenção do CapCut).
//
// ⚠️ Isto é PREVIEW. O render final (Railway/ffmpeg) precisa dos filtros
// equivalentes (eq, curves, unsharp, vignette) pra sair igual no arquivo —
// enquanto isso não existir, o export ignora estes ajustes.

export const CAMPOS_COR = [
  { id: 'temp', rotulo: 'Temp', grupo: 'Cor', trilha: 'temp' },
  { id: 'matiz', rotulo: 'Matiz', grupo: 'Cor', trilha: 'matiz' },
  { id: 'saturacao', rotulo: 'Saturação', grupo: 'Cor', trilha: 'sat' },
  { id: 'exposicao', rotulo: 'Exposição', grupo: 'Claridade' },
  { id: 'contraste', rotulo: 'Contraste', grupo: 'Claridade' },
  { id: 'destacar', rotulo: 'Destacar', grupo: 'Claridade' },
  { id: 'sombra', rotulo: 'Sombra', grupo: 'Claridade' },
  { id: 'brancos', rotulo: 'Brancos', grupo: 'Claridade' },
  { id: 'pretos', rotulo: 'Pretos', grupo: 'Claridade' },
  { id: 'brilho', rotulo: 'Brilho', grupo: 'Claridade' },
  { id: 'nitidez', rotulo: 'Aumentar a nitidez', grupo: 'Efeitos', min: 0 },
  { id: 'fade', rotulo: 'Fade', grupo: 'Efeitos', min: 0 },
  { id: 'vinheta', rotulo: 'Vinheta', grupo: 'Efeitos', min: 0 },
];

export const NEUTRO = CAMPOS_COR.reduce((o, c) => (o[c.id] = 0, o), {});

/** Tem algum ajuste diferente de zero? */
export function temAjuste(g) {
  if (!g) return false;
  return CAMPOS_COR.some((c) => Math.abs(Number(g[c.id]) || 0) > 0.001);
}

const n = (v) => (Number(v) || 0) / 100;   // -100..100 -> -1..1

/**
 * Monta o <filter> SVG da cena. Devolve null quando tudo está neutro — assim o
 * vídeo fica sem filtro nenhum e não paga nada.
 */
export function svgDoGrade(g, id) {
  if (!temAjuste(g)) return null;

  const partes = [];

  // 1) TEMPERATURA e MATIZ — matriz de cor.
  //    temp > 0 esquenta (mais vermelho, menos azul); < 0 esfria.
  const t = n(g.temp) * 0.35;
  if (t) {
    partes.push(`<feColorMatrix type="matrix" values="
      ${1 + t} 0 0 0 0
      0 1 0 0 0
      0 0 ${1 - t} 0 0
      0 0 0 1 0"/>`);
  }
  // matiz: rotação de tom (o próprio primitivo do SVG)
  const matiz = n(g.matiz) * 60;
  if (matiz) partes.push(`<feColorMatrix type="hueRotate" values="${matiz.toFixed(2)}"/>`);

  // 2) SATURAÇÃO
  const sat = 1 + n(g.saturacao);
  if (Math.abs(sat - 1) > 0.001) partes.push(`<feColorMatrix type="saturate" values="${sat.toFixed(3)}"/>`);

  // 3) CLARIDADE — transferência por canal.
  //    Uma curva só, montada com todos os controles, evita empilhar filtro em
  //    cima de filtro (cada passe custa e arredonda o resultado).
  const exposicao = n(g.exposicao);
  const contraste = n(g.contraste);
  const brilho = n(g.brilho);
  const destacar = n(g.destacar);
  const sombra = n(g.sombra);
  const brancos = n(g.brancos);
  const pretos = n(g.pretos);
  const fade = Math.max(0, n(g.fade));

  if (exposicao || contraste || brilho || destacar || sombra || brancos || pretos || fade) {
    const N = 16;
    const tabela = [];
    for (let i = 0; i <= N; i++) {
      let v = i / N;
      // exposição e brilho: deslocamento (exposição pesa mais nos médios)
      v += exposicao * 0.5 * (1 - Math.abs(v - 0.5)) + brilho * 0.35;
      // contraste em torno do meio
      v = 0.5 + (v - 0.5) * (1 + contraste * 0.8);
      // altas e baixas: peso por região
      const pesoAlto = Math.max(0, (v - 0.5) * 2);
      const pesoBaixo = Math.max(0, (0.5 - v) * 2);
      v += destacar * 0.35 * pesoAlto + sombra * 0.35 * pesoBaixo;
      // brancos/pretos: puxam os extremos
      v += brancos * 0.3 * Math.pow(v, 2) - pretos * 0.3 * Math.pow(1 - v, 2);
      // fade: levanta o preto e baixa o branco (look "lavado")
      if (fade) v = v * (1 - fade * 0.35) + fade * 0.22;
      tabela.push(Math.max(0, Math.min(1, v)).toFixed(4));
    }
    const t2 = tabela.join(' ');
    partes.push(
      `<feComponentTransfer>` +
      `<feFuncR type="table" tableValues="${t2}"/>` +
      `<feFuncG type="table" tableValues="${t2}"/>` +
      `<feFuncB type="table" tableValues="${t2}"/>` +
      `</feComponentTransfer>`
    );
  }

  // 4) NITIDEZ — convolução (realce de borda). Só acima de zero.
  const nit = Math.max(0, n(g.nitidez));
  if (nit > 0.01) {
    const k = nit * 1.6;
    const centro = (1 + 4 * k).toFixed(3);
    partes.push(
      `<feConvolveMatrix order="3" preserveAlpha="true" divisor="1" ` +
      `kernelMatrix="0 ${(-k).toFixed(3)} 0 ${(-k).toFixed(3)} ${centro} ${(-k).toFixed(3)} 0 ${(-k).toFixed(3)} 0"/>`
    );
  }

  if (!partes.length) return null;
  return `<filter id="${id}" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">${partes.join('')}</filter>`;
}

/** A vinheta é sombra por cima, não filtro de cor — sai como CSS. */
export function vinhetaCss(g) {
  const v = Math.max(0, n(g?.vinheta));
  if (v < 0.01) return '';
  const inicio = (72 - v * 34).toFixed(0);
  return `radial-gradient(ellipse at center, transparent ${inicio}%, rgba(0,0,0,${(v * 0.85).toFixed(2)}) 100%)`;
}
