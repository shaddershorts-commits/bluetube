// editor-v1/core/sync-narracao.js
// O SOLVER da narração do "Criar com IA" (2026-08-13). Módulo PURO — zero
// DOM, zero rede — testado em node.
//
// O problema: a narração nova (traduzida) tem OUTRA duração por trecho; cada
// trecho tem uma ÂNCORA (o offset em que a fala original correspondente
// acontecia — é o que mantém a fala em cima do acontecimento do vídeo).
//
// O desenho V1 é o que o render de PRODUÇÃO suporta HOJE (medido em 13/08:
// áudio posicionado ✓; cortar/acelerar o vídeo por cena ainda não está em
// main): âncora + EMPURRA. Cada trecho começa na âncora dele, a menos que o
// anterior ainda esteja falando — aí espera o anterior acabar (+folga). Nada
// de sobreposição, nada de fala cortada. Quando o motor novo do editor chegar
// em produção (merge), o solver ganha o modo elástico (janela do vídeo estica
// via speed por cena) SEM mudar quem chama.
//
// Honestidade em números: devolve `atraso_max_s` (o quanto a pior fala ficou
// atrás do acontecimento) e `estouro_s` (quanto a narração passa do fim do
// vídeo) — o chamador AVISA em vez de cortar fala em silêncio.

export function montarLinhaDoTempo({ duracaoVideo, chunks, folga = 0.15 }) {
  const itens = [];
  let cursor = 0;
  let atrasoMax = 0;
  for (const c of (chunks || [])) {
    const dur = Math.max(0.05, Number(c.dur) || 0);
    const alvo = Math.max(0, (Number(c.offset_ms) || 0) / 1000);
    const start = Math.max(alvo, cursor);
    atrasoMax = Math.max(atrasoMax, start - alvo);
    itens.push({ start: r3(start), dur: r3(dur), alvo: r3(alvo), texto: String(c.texto || '') });
    cursor = start + dur + folga;
  }
  const fim = itens.length ? itens[itens.length - 1].start + itens[itens.length - 1].dur : 0;
  return {
    itens,
    fim: r3(fim),
    estouro_s: r3(Math.max(0, fim - (Number(duracaoVideo) || 0))),
    atraso_max_s: r3(atrasoMax),
  };
}

function r3(v) { return Math.round(v * 1000) / 1000; }
