// editor-v1/core/idioma.js
// REGRAS DE IDIOMA DA LEGENDA — modulo puro.
//
// O Whisper ja devolvia o idioma detectado (api/blue-editor.js, campo
// `language`) e NINGUEM usava. O agrupamento de palavras em frases era cravado
// em alfabeto latino e errava feio fora dele:
//   - juntava tudo com ESPACO (japones/chines/tailandes nao usam espaco entre
//     palavras: a legenda saia toda picotada);
//   - cortava em 42 caracteres (medida de letra latina — ideograma ocupa o
//     dobro, entao 42 deles estouram o quadro);
//   - so reconhecia ".!?" como fim de frase, ignorando "。" "！" "؟" "।" e o
//     "¿...?" do espanhol;
//   - aplicava MAIUSCULAS em escrita que nao tem caixa (arabe, hebraico, CJK,
//     tailandes) — nao muda nada e so atrapalha.
//
// O agrupamento vive AQUI (e nao no endpoint) de proposito: no cliente ele e
// testavel sem rede e o usuario pode reagrupar ao trocar de modo sem pagar
// outra transcricao.

/** Normaliza o que o Whisper manda: ora nome em ingles ("portuguese"), ora
 *  codigo ISO ("pt", "pt-BR"). */
export function normalizarIdioma(bruto) {
  const s = String(bruto || '').trim().toLowerCase();
  if (!s) return '';
  const nomes = {
    portuguese: 'pt', english: 'en', spanish: 'es', french: 'fr', german: 'de',
    italian: 'it', dutch: 'nl', russian: 'ru', japanese: 'ja', chinese: 'zh',
    korean: 'ko', arabic: 'ar', hebrew: 'he', hindi: 'hi', thai: 'th',
    turkish: 'tr', polish: 'pl', indonesian: 'id', vietnamese: 'vi',
  };
  if (nomes[s]) return nomes[s];
  return s.split(/[-_]/)[0];
}

/** Escritas SEM espaco entre palavras. */
const SEM_ESPACO = new Set(['ja', 'zh', 'th', 'lo', 'my', 'km']);
/** Escritas SEM caixa alta/baixa (maiuscula nao existe). */
const SEM_CAIXA = new Set(['ja', 'zh', 'ko', 'ar', 'he', 'th', 'hi', 'ta', 'te', 'lo', 'my', 'km', 'bn']);
/** Escritas da direita pra esquerda. */
const RTL = new Set(['ar', 'he', 'fa', 'ur']);

export function separadorDePalavras(lang) {
  return SEM_ESPACO.has(normalizarIdioma(lang)) ? '' : ' ';
}
export function temCaixa(lang) {
  return !SEM_CAIXA.has(normalizarIdioma(lang));
}
export function ehRTL(lang) {
  return RTL.has(normalizarIdioma(lang));
}

// Faixas Unicode de escrita da direita pra esquerda (hebraico, arabe, siriaco,
// thaana + formas de apresentacao). Detectar pelo CONTEUDO cobre tambem o
// texto que o usuario digita na mao, nao so o que veio da transcricao.
const RANGE_RTL = /[֐-׿؀-ۿ܀-ݏހ-޿יִ-﷿ﹰ-﻿]/;
export function textoEhRTL(s) { return RANGE_RTL.test(String(s || '')); }

/** A escrita deste texto TEM maiuscula/minuscula? Sem depender de lista de
 *  idioma: se caixa alta e caixa baixa dao o mesmo resultado, nao ha caixa
 *  (vale pra CJK, arabe, hebraico, tailandes...). */
export function podeMudarCaixa(s) {
  const t = String(s || '');
  return t.toUpperCase() !== t.toLowerCase();
}

/** Quantos caracteres cabem numa linha de legenda. Ideograma ocupa ~2x a
 *  largura de uma letra latina, entao o limite cai pela metade. */
export function limiteDeCaracteres(lang) {
  const l = normalizarIdioma(lang);
  if (l === 'ja' || l === 'zh' || l === 'ko') return 20;
  if (l === 'th' || l === 'lo' || l === 'my' || l === 'km') return 28;
  return 42;
}

/** Fim de frase, por escrita. Inclui o ponto final do hindi (।), o interrogativo
 *  arabe (؟) e a pontuacao de largura dupla do CJK. */
export function fimDeFrase(lang) {
  const l = normalizarIdioma(lang);
  if (l === 'ja' || l === 'zh') return /[。．！？…]$/;
  if (l === 'ar' || l === 'fa' || l === 'ur') return /[.!?…؟]$/;
  if (l === 'hi' || l === 'bn') return /[।.!?…]$/;
  return /[.!?…]$/;
}

/** Primeira letra maiuscula — so onde a escrita TEM caixa. Nao mexe no resto
 *  da frase (nome proprio, sigla e o que o Whisper ja acertou ficam como estao). */
export function capitalizarFrase(texto, lang) {
  if (!temCaixa(lang)) return texto;
  const s = String(texto || '');
  const i = s.search(/\S/);
  if (i < 0) return s;
  // "iPhone", "eBay", "iOS": minuscula seguida de MAIUSCULA e grafia da marca —
  // capitalizar ali estragaria a palavra
  if (/[A-ZÀ-Þ]/.test(s[i + 1] || '')) return s;
  return s.slice(0, i) + s[i].toUpperCase() + s.slice(i + 1);
}

/** Agrupa palavras com timestamp em FRASES de legenda.
 *  Quebra em: pausa longa, fim de frase pontuado, ou estouro do limite de
 *  caracteres do idioma.
 *  @param words [{word,start,end}]
 *  @returns [{start,end,text}] */
export function agruparFrases(words, lang, opts = {}) {
  const sep = separadorDePalavras(lang);
  const limite = opts.limite || limiteDeCaracteres(lang);
  const pausa = opts.pausa ?? 0.6;
  const minDur = opts.minDur ?? 0.7;
  const terminador = fimDeFrase(lang);

  const frases = [];
  let cur = null;
  for (const w of words || []) {
    const palavra = String(w.word || '').trim();
    if (!palavra) continue;
    if (!cur) { cur = { start: w.start, end: w.end, text: palavra }; continue; }
    const juntas = cur.text + sep + palavra;
    if ((w.start - cur.end) > pausa || juntas.length > limite || terminador.test(cur.text)) {
      frases.push(cur);
      cur = { start: w.start, end: w.end, text: palavra };
    } else {
      cur.text = juntas;
      cur.end = w.end;
    }
  }
  if (cur) frases.push(cur);
  for (const f of frases) {
    f.text = capitalizarFrase(f.text, lang);
    if (f.end - f.start < minDur) f.end = f.start + minDur;
  }
  return frases;
}
