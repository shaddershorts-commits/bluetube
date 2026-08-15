// editor-v1/core/text-layout.js
// QUEBRA DE LINHA DO TEXTO — modulo puro (a medicao entra por parametro).
//
// Por que isto existe: o texto SAIA DO VIDEO (user 2026-07-29). Sao dois
// problemas diferentes nas duas pontas:
//   - no preview a caixa era cortada pelo overflow:hidden do container;
//   - no arquivo final o `drawtext` do ffmpeg NAO quebra linha nenhuma — uma
//     legenda longa vira UMA linha que atravessa o quadro inteiro.
//
// A decisao de onde quebrar e tomada UMA vez, aqui, e viaja pronta ate o
// render. Assim preview e arquivo nao podem discordar: nao ha dois algoritmos.
// (Foi o erro do xfade: efeito que so existia na tela.)

/** Largura util do quadro. 0.86 deixa margem de seguranca pra diferenca entre
 *  a fonte do navegador e o TTF que o ffmpeg usa. */
export const LARGURA_SEGURA = 0.86;
/** Teto de linhas: passou disso, a fonte encolhe em vez de virar um paredao. */
export const MAX_LINHAS = 4;

/** Quebra `texto` em linhas que cabem em `larguraMax`.
 *  @param medir (str) => largura em px
 *  Respeita quebras que o usuario digitou e parte palavra gigante que nao cabe
 *  sozinha (nome de arquivo, hashtag) — senao ela vazaria do quadro. */
export function quebrarLinhas(texto, medir, larguraMax) {
  const linhas = [];
  for (const paragrafo of String(texto ?? '').split('\n')) {
    if (paragrafo === '') { linhas.push(''); continue; }
    let atual = '';
    for (const palavra of paragrafo.split(/\s+/).filter(Boolean)) {
      const tentativa = atual ? atual + ' ' + palavra : palavra;
      if (medir(tentativa) <= larguraMax || !atual) {
        // palavra sozinha maior que a linha: parte no meio dela
        if (!atual && medir(palavra) > larguraMax) {
          let resto = palavra;
          while (medir(resto) > larguraMax && resto.length > 1) {
            let corte = resto.length - 1;
            while (corte > 1 && medir(resto.slice(0, corte)) > larguraMax) corte--;
            linhas.push(resto.slice(0, corte));
            resto = resto.slice(corte);
          }
          atual = resto;
          continue;
        }
        atual = tentativa;
      } else {
        linhas.push(atual);
        atual = palavra;
      }
    }
    linhas.push(atual);
  }
  return linhas.length ? linhas : [''];
}

/** Layout final de um bloco de texto dentro do quadro.
 *  Devolve as linhas E o tamanho de fonte ja ajustado — se o texto nao cabe em
 *  MAX_LINHAS, a fonte encolhe ate caber (teto de 45% de reducao).
 *  @param medirCom (linha, fontePx) => largura em px */
export function layoutTexto({ texto, fontePx, larguraQuadro, medirCom }) {
  const larguraMax = larguraQuadro * LARGURA_SEGURA;
  let fonte = fontePx;
  let linhas = quebrarLinhas(texto, (s) => medirCom(s, fonte), larguraMax);
  // encolhe ate caber em MAX_LINHAS, com PISO de 55% — legenda ilegivel e pior
  // que legenda alta. O piso e testado ANTES de aplicar: checar depois deixava
  // a fonte furar o limite em um passo.
  const piso = fontePx * 0.55;
  let guarda = 0;
  while (linhas.length > MAX_LINHAS && guarda++ < 12) {
    const prox = fonte * 0.9;
    if (prox < piso) break;
    fonte = prox;
    linhas = quebrarLinhas(texto, (s) => medirCom(s, fonte), larguraMax);
  }
  const larguraReal = linhas.reduce((m, l) => Math.max(m, medirCom(l, fonte)), 0);
  return { linhas, fontePx: fonte, larguraPx: larguraReal };
}

// ── medicao ─────────────────────────────────────────────────────────────────
// No navegador mede com canvas (exato). Em node (testes) cai numa estimativa
// proporcional — o que importa la e a REGRA, nao o pixel.
const _cv = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const _ctx = _cv ? _cv.getContext('2d') : null;
export function medir(str, fontePx, familia) {
  const s = String(str ?? '');
  if (!_ctx) return s.length * fontePx * 0.55;
  _ctx.font = `${fontePx}px ${familia}`;
  return _ctx.measureText(s).width;
}

export function familiaDaFonte(font) {
  if (font === 'Bebas Neue') return '"Bebas Neue", "Anton", sans-serif';
  if (font === 'Oswald') return '"Oswald", "Anton", sans-serif';
  return '"Anton", sans-serif';
}

/** Layout de UM texto do documento, em fracoes do quadro.
 *  A quebra depende so da RAZAO fonte/largura, entao dá o mesmo resultado em
 *  qualquer largura de referencia — e por isso que o preview (largura da tela)
 *  e o render (1080) concordam sem precisar combinar nada. */
export function layoutDoTexto(txt, tamanhoPct, larguraRef = 1080, alturaRef = 1920) {
  const familia = familiaDaFonte(txt.font);
  const base = tamanhoPct * larguraRef;
  const lay = layoutTexto({
    texto: txt.content, fontePx: base, larguraQuadro: larguraRef,
    medirCom: (s, f) => medir(s, f, familia),
  });
  const alturaBloco = lay.linhas.length * lay.fontePx * 1.12;
  const preso = prenderNoQuadro({
    xPct: txt.x_pct ?? 0.5, yPct: txt.y_pct ?? 0.35,
    larguraPx: lay.larguraPx, alturaPx: alturaBloco,
    larguraQuadro: larguraRef, alturaQuadro: alturaRef,
  });
  return {
    linhas: lay.linhas,
    fontePct: lay.fontePx / larguraRef,
    xPct: preso.xPct,
    yPct: preso.yPct,
  };
}

/** Prende o centro do bloco pra que ele NAO passe da borda do quadro.
 *  Recebe e devolve fracoes 0..1 (x_pct/y_pct do texto). */
export function prenderNoQuadro({ xPct, yPct, larguraPx, alturaPx, larguraQuadro, alturaQuadro }) {
  const meiaL = larguraQuadro > 0 ? (larguraPx / 2) / larguraQuadro : 0;
  const meiaA = alturaQuadro > 0 ? (alturaPx / 2) / alturaQuadro : 0;
  // margem minima igual a do texto (a sobra da LARGURA_SEGURA)
  const margem = (1 - LARGURA_SEGURA) / 2;
  const min = (m) => Math.min(0.5, m + margem);
  return {
    xPct: Math.min(1 - min(meiaL), Math.max(min(meiaL), xPct)),
    yPct: Math.min(1 - min(meiaA), Math.max(min(meiaA), yPct)),
  };
}
