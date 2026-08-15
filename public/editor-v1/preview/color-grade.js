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
  { id: 'brilho_efeito', rotulo: 'Brilho', grupo: 'Efeitos', min: 0 },
  { id: 'particulas', rotulo: 'Partículas', grupo: 'Efeitos', min: 0 },
  { id: 'fade', rotulo: 'Fade', grupo: 'Efeitos', min: 0 },
  { id: 'vinheta', rotulo: 'Vinheta', grupo: 'Efeitos', min: 0 },
];

// ── As 3 abas que faltavam no print do CapCut (2026-07-29) ──────────────────
// Todas usam CHAVES PLANAS de -100..100 (ex: hsl_vermelho_s) de propósito: o
// reducer já valida e limita qualquer campo numérico do grade, então as abas
// novas entram sem mexer no schema nem migrar projeto salvo.

/** HSL por FAIXA DE COR: mexer só nos vermelhos, só nos azuis, etc.
 *  `mascara` = combinação linear de RGB que isola a faixa (o feColorMatrix do
 *  SVG só sabe fazer combinação linear — é o que dá pra "selecionar" uma cor). */
export const FAIXAS_HSL = [
  { id: 'vermelho', rotulo: 'Vermelhos', ff: 'r', mascara: [1, -0.5, -0.5] },
  { id: 'amarelo',  rotulo: 'Amarelos',  ff: 'y', mascara: [0.5, 0.5, -1] },
  { id: 'verde',    rotulo: 'Verdes',    ff: 'g', mascara: [-0.5, 1, -0.5] },
  { id: 'ciano',    rotulo: 'Cianos',    ff: 'c', mascara: [-1, 0.5, 0.5] },
  { id: 'azul',     rotulo: 'Azuis',     ff: 'b', mascara: [-0.5, -0.5, 1] },
  { id: 'magenta',  rotulo: 'Magentas',  ff: 'm', mascara: [0.5, -1, 0.5] },
];
export const EIXOS_HSL = [
  { id: 'h', rotulo: 'Matiz' },
  { id: 's', rotulo: 'Saturação' },
  { id: 'l', rotulo: 'Luminância' },
];

/** CURVAS: curva tonal por canal. 3 âncoras (sombras/médios/altas) — é uma
 *  curva de verdade, e cada âncora vira ponto de controle no `curves` do
 *  ffmpeg, então o arquivo sai igual. */
export const CANAIS_CURVA = [
  { id: 'rgb', rotulo: 'RGB' }, { id: 'r', rotulo: 'R' },
  { id: 'g', rotulo: 'G' }, { id: 'b', rotulo: 'B' },
];
export const ANCORAS_CURVA = [
  { id: 'sombras', rotulo: 'Sombras' },
  { id: 'medios', rotulo: 'Médios' },
  { id: 'altas', rotulo: 'Altas' },
];

/** RODA DE CORES: desloca a cor por faixa TONAL (o colorbalance do ffmpeg é
 *  exatamente isto: rs/gs/bs, rm/gm/bm, rh/gh/bh). */
export const FAIXAS_RODA = [
  { id: 'sombras', rotulo: 'Sombras', ff: 's' },
  { id: 'medios', rotulo: 'Médios', ff: 'm' },
  { id: 'altas', rotulo: 'Altas', ff: 'h' },
];
export const CANAIS_RODA = [
  { id: 'r', rotulo: 'R' }, { id: 'g', rotulo: 'G' }, { id: 'b', rotulo: 'B' },
];

export const CHAVES_HSL = FAIXAS_HSL.flatMap(f => EIXOS_HSL.map(e => `hsl_${f.id}_${e.id}`));
export const CHAVES_CURVA = CANAIS_CURVA.flatMap(c => ANCORAS_CURVA.map(a => `cur_${c.id}_${a.id}`));
export const CHAVES_RODA = FAIXAS_RODA.flatMap(f => CANAIS_RODA.map(c => `roda_${f.id}_${c.id}`));
export const TODAS_CHAVES = [...CAMPOS_COR.map(c => c.id), ...CHAVES_HSL, ...CHAVES_CURVA, ...CHAVES_RODA];

export const NEUTRO = TODAS_CHAVES.reduce((o, k) => (o[k] = 0, o), {});

/** Tem algum ajuste diferente de zero? */
export function temAjuste(g) {
  if (!g) return false;
  return TODAS_CHAVES.some((k) => Math.abs(Number(g[k]) || 0) > 0.001);
}

/** Pesos das 3 zonas tonais num nível v (0..1). Somam ~1 e são a MESMA régua
 *  usada no preview e no cálculo dos pontos que vão pro ffmpeg. */
export function pesosTonais(v) {
  return {
    sombras: Math.max(0, 1 - 2 * v),
    medios: 1 - Math.abs(2 * v - 1),
    altas: Math.max(0, 2 * v - 1),
  };
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

  // 3b) CURVAS + RODA DE CORES — as duas mexem no MESMO lugar: quanto cada
  //     canal sobe/desce em cada zona tonal. Por isso viram UMA tabela por
  //     canal (empilhar dois filtros arredondaria duas vezes).
  const tabelaCanal = (canal) => {
    const N = 16, saida = [];
    let mexeu = false;
    for (let i = 0; i <= N; i++) {
      const v = i / N;
      const w = pesosTonais(v);
      let d = 0;
      for (const a of ANCORAS_CURVA) {
        const geral = n(g[`cur_rgb_${a.id}`]);
        const doCanal = n(g[`cur_${canal}_${a.id}`]);
        const daRoda = n(g[`roda_${a.id}_${canal}`]);
        const soma = geral + doCanal + daRoda;
        if (soma) { d += soma * 0.4 * w[a.id]; mexeu = true; }
      }
      saida.push(Math.max(0, Math.min(1, v + d)).toFixed(4));
    }
    return mexeu ? saida.join(' ') : null;
  };
  const tR = tabelaCanal('r'), tG = tabelaCanal('g'), tB = tabelaCanal('b');
  if (tR || tG || tB) {
    const id2 = (t) => t || Array.from({ length: 17 }, (_, i) => (i / 16).toFixed(4)).join(' ');
    partes.push(
      `<feComponentTransfer>` +
      `<feFuncR type="table" tableValues="${id2(tR)}"/>` +
      `<feFuncG type="table" tableValues="${id2(tG)}"/>` +
      `<feFuncB type="table" tableValues="${id2(tB)}"/>` +
      `</feComponentTransfer>`
    );
  }

  // 3c) HSL POR FAIXA DE COR — o SVG não tem "selecionar cor", então a faixa
  //     vira uma MÁSCARA: combinação linear de RGB no alfa (feColorMatrix só
  //     faz linear), o ajuste é aplicado numa cópia e composto só onde a
  //     máscara acende. Uma passada por faixa MEXIDA (as zeradas não custam).
  FAIXAS_HSL.forEach((f, iF) => {
    const h = n(g[`hsl_${f.id}_h`]), s = n(g[`hsl_${f.id}_s`]), l = n(g[`hsl_${f.id}_l`]);
    if (!h && !s && !l) return;
    const [mr, mg, mb] = f.mascara;
    const mask = `m${iF}`, ajust = `a${iF}`, corte = `c${iF}`;
    // máscara no ALFA: quanto o pixel pertence à faixa (negativo vira 0)
    partes.push(
      `<feColorMatrix type="matrix" in="SourceGraphic" result="${mask}" values="` +
      `0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${mr} ${mg} ${mb} 0 0"/>`
    );
    // cópia ajustada (matiz gira, saturação e luminância escalam)
    let cadeia = `<feColorMatrix type="hueRotate" in="SourceGraphic" values="${(h * 60).toFixed(2)}" result="${ajust}h"/>`;
    cadeia += `<feColorMatrix type="saturate" in="${ajust}h" values="${Math.max(0, 1 + s).toFixed(3)}" result="${ajust}s"/>`;
    cadeia += `<feComponentTransfer in="${ajust}s" result="${ajust}">` +
      `<feFuncR type="linear" slope="${(1 + l * 0.6).toFixed(3)}"/>` +
      `<feFuncG type="linear" slope="${(1 + l * 0.6).toFixed(3)}"/>` +
      `<feFuncB type="linear" slope="${(1 + l * 0.6).toFixed(3)}"/>` +
      `</feComponentTransfer>`;
    partes.push(cadeia);
    // recorta o ajuste pela máscara e assenta por cima do que veio antes
    partes.push(`<feComposite in="${ajust}" in2="${mask}" operator="in" result="${corte}"/>`);
    partes.push(`<feComposite in="${corte}" in2="SourceGraphic" operator="over"/>`);
  });

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

  // 5) BRILHO (Efeitos) — é o "glow" do CapCut, diferente do Brilho de
  //    Claridade: em vez de clarear tudo, espalha luz a partir das ALTAS.
  //    Borra uma cópia, corta as sombras dela e soma por cima.
  const glow = Math.max(0, n(g.brilho_efeito));
  if (glow > 0.01) {
    partes.push(
      `<feColorMatrix type="matrix" result="fonte" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0"/>` +
      // isola as altas: joga o preto pra baixo e mantém o topo
      `<feComponentTransfer in="fonte" result="altas">` +
      `<feFuncR type="linear" slope="${(1 + glow).toFixed(2)}" intercept="-0.45"/>` +
      `<feFuncG type="linear" slope="${(1 + glow).toFixed(2)}" intercept="-0.45"/>` +
      `<feFuncB type="linear" slope="${(1 + glow).toFixed(2)}" intercept="-0.45"/>` +
      `</feComponentTransfer>` +
      `<feGaussianBlur in="altas" stdDeviation="${(glow * 9).toFixed(1)}" result="brilho"/>` +
      `<feComposite in="brilho" in2="fonte" operator="arithmetic" k1="0" k2="${(glow * 0.9).toFixed(2)}" k3="1" k4="0"/>`
    );
  }

  // 6) PARTÍCULAS — grão/poeira luminosa. Ruído do próprio SVG, recortado nas
  //    altas pra virar poeira em vez de chuvisco uniforme, somado por cima.
  const part = Math.max(0, n(g.particulas));
  if (part > 0.01) {
    partes.push(
      `<feTurbulence type="fractalNoise" baseFrequency="${(0.7 + part * 0.5).toFixed(2)}" numOctaves="2" seed="7" result="ruido"/>` +
      `<feColorMatrix in="ruido" type="matrix" result="poeira" values="` +
      `0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  ${(part * 1.6).toFixed(2)} 0 0 0 ${(-part * 0.55).toFixed(2)}"/>` +
      `<feComposite in="poeira" in2="SourceGraphic" operator="atop" result="poeiraCortada"/>` +
      `<feBlend mode="screen" in2="poeiraCortada"/>`
    );
  }

  if (!partes.length) return null;
  return `<filter id="${id}" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">${partes.join('')}</filter>`;
}

/** Nível de saída de um canal para um nível de entrada v (0..1), somando
 *  Claridade (Básico) + Curvas + Roda. É a MESMA conta que monta a tabela do
 *  preview — por isso o arquivo sai igual ao que se vê. */
export function nivelDoCanal(g, canal, v) {
  const w = pesosTonais(v);
  let x = v;
  // Claridade (aba Básico): vale pros três canais
  const exposicao = n(g.exposicao), contraste = n(g.contraste), brilho = n(g.brilho);
  const destacar = n(g.destacar), sombra = n(g.sombra);
  const brancos = n(g.brancos), pretos = n(g.pretos), fade = Math.max(0, n(g.fade));
  x += exposicao * 0.5 * (1 - Math.abs(x - 0.5)) + brilho * 0.35;
  x = 0.5 + (x - 0.5) * (1 + contraste * 0.8);
  x += destacar * 0.35 * Math.max(0, (x - 0.5) * 2) + sombra * 0.35 * Math.max(0, (0.5 - x) * 2);
  x += brancos * 0.3 * Math.pow(x, 2) - pretos * 0.3 * Math.pow(1 - x, 2);
  if (fade) x = x * (1 - fade * 0.35) + fade * 0.22;
  // Curvas + Roda: por zona tonal, por canal
  for (const a of ANCORAS_CURVA) {
    const soma = n(g[`cur_rgb_${a.id}`]) + n(g[`cur_${canal}_${a.id}`]) + n(g[`roda_${a.id}_${canal}`]);
    if (soma) x += soma * 0.4 * w[a.id];
  }
  return Math.max(0, Math.min(1, x));
}

/** Pontos de controle da curva de um canal, prontos pro filtro `curves` do
 *  ffmpeg. Só NÚMEROS atravessam pro render — mandar string de filtro pronta
 *  seria injeção de comando no servidor. */
export function pontosCurva(g, canal, qtd = 6) {
  const pts = [];
  for (let i = 0; i < qtd; i++) {
    const x = i / (qtd - 1);
    pts.push([Number(x.toFixed(4)), Number(nivelDoCanal(g, canal, x).toFixed(4))]);
  }
  return pts;
}

const ehIdentidade = (pts) => pts.every(([x, y]) => Math.abs(x - y) < 0.002);

/** Tudo que o RENDER precisa saber do grade, em números. O servidor monta os
 *  filtros a partir disto (e valida de novo do lado dele). */
export function paramsRender(g) {
  if (!temAjuste(g)) return null;
  const p = {};
  const curvas = {};
  for (const c of ['r', 'g', 'b']) {
    const pts = pontosCurva(g, c);
    if (!ehIdentidade(pts)) curvas[c] = pts;
  }
  if (Object.keys(curvas).length) p.curvas = curvas;

  if (n(g.temp)) p.temp = Number(n(g.temp).toFixed(4));
  if (n(g.matiz)) p.matiz = Number((n(g.matiz) * 60).toFixed(2));
  if (n(g.saturacao)) p.saturacao = Number((1 + n(g.saturacao)).toFixed(4));
  if (n(g.nitidez) > 0.01) p.nitidez = Number(n(g.nitidez).toFixed(4));
  if (n(g.vinheta) > 0.01) p.vinheta = Number(n(g.vinheta).toFixed(4));
  if (n(g.particulas) > 0.01) p.grao = Number(n(g.particulas).toFixed(4));
  if (n(g.brilho_efeito) > 0.01) p.glow = Number(n(g.brilho_efeito).toFixed(4));

  const hsl = [];
  for (const f of FAIXAS_HSL) {
    const h = n(g[`hsl_${f.id}_h`]), s = n(g[`hsl_${f.id}_s`]), l = n(g[`hsl_${f.id}_l`]);
    if (h || s || l) {
      hsl.push({ faixa: f.ff,
        h: Number((h * 180).toFixed(2)), s: Number(s.toFixed(4)), l: Number(l.toFixed(4)) });
    }
  }
  if (hsl.length) p.hsl = hsl;
  return Object.keys(p).length ? p : null;
}

/** A vinheta é sombra por cima, não filtro de cor — sai como CSS. */
export function vinhetaCss(g) {
  const v = Math.max(0, n(g?.vinheta));
  if (v < 0.01) return '';
  const inicio = (72 - v * 34).toFixed(0);
  return `radial-gradient(ellipse at center, transparent ${inicio}%, rgba(0,0,0,${(v * 0.85).toFixed(2)}) 100%)`;
}
