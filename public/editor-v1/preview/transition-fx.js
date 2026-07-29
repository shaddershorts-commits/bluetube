// editor-v1/preview/transition-fx.js
// O efeito da transição RODANDO no player (2026-07-29).
//
// FLUIDEZ é o requisito aqui. Duas decisões cuidam disso:
//
// 1. Nada é desenhado por JavaScript quadro a quadro. O efeito é uma camada
//    com transform/opacity/clip-path/filter, propriedades que o compositor da
//    GPU anima sozinho. O JS só escreve o PROGRESSO (0..1) numa custom
//    property; o resto acontece fora da thread principal.
// 2. O progresso vem do relógio do player, não de um timer próprio — assim a
//    transição acompanha play, pause, scrub e velocidade sem dessincronizar.
//
// O que se vê aqui é aproximação do xfade do ffmpeg. Não é o mesmo pixel, mas
// é o mesmo GESTO — e cada efeito só existe aqui porque existe lá.

const CLAMP = (v) => Math.max(0, Math.min(1, v));

export function createTransitionFx(stageEl, store, player) {
  if (!stageEl) return { destroy() {}, tick() {}, tocar() {} };

  const camada = document.createElement('div');
  camada.className = 'be-trans-fx';
  camada.style.display = 'none';
  stageEl.appendChild(camada);

  let previa = null;   // { def, t, dur } — prévia disparada pelo clique no card

  /** Transição ativa no instante t, olhando o projeto. */
  function ativaEm(t, itens, transicoes) {
    for (const tr of transicoes || []) {
      const it = itens[tr.between];
      if (!it) continue;
      const dur = Math.max(0.1, Math.min(3, Number(tr.duration) || 0.5));
      const ini = it.tEnd - dur / 2;
      if (t >= ini && t <= ini + dur) {
        return { tr, progresso: CLAMP((t - ini) / dur) };
      }
    }
    return null;
  }

  /**
   * Chamado pelo player a cada frame. Mantém o custo baixo: só toca no DOM
   * quando o efeito ATIVO muda ou o progresso anda de verdade.
   */
  let ultimo = '';
  function tick(t, itens, transicoes) {
    let def = null, progresso = 0;

    if (previa) {
      const ini = previa.t - previa.dur / 2;
      if (t >= ini && t <= ini + previa.dur) {
        def = previa.def;
        progresso = CLAMP((t - ini) / previa.dur);
      } else if (t > ini + previa.dur) {
        previa = null;   // acabou
      }
    }

    if (!def) {
      const a = ativaEm(t, itens, transicoes);
      if (a) {
        def = { preview: a.tr.preview || previewDe(a.tr), nome: a.tr.type, intensity: a.tr.intensity };
        progresso = a.progresso;
      }
    }

    const chave = def ? def.preview + ':' + (def.intensity ?? 50) : '';
    if (chave !== ultimo) {
      ultimo = chave;
      camada.className = 'be-trans-fx' + (def ? ' be-fxp-' + def.preview : '');
      camada.style.display = def ? 'block' : 'none';
    }
    if (def) {
      // uma escrita só por frame; o CSS deriva tudo daqui
      camada.style.setProperty('--p', progresso.toFixed(4));
      camada.style.setProperty('--forca', ((def.intensity ?? 50) / 100).toFixed(3));
    }
  }

  // o estado guarda o id do catálogo; o tipo de prévia mora no catálogo
  let mapaPreview = null;
  function previewDe(tr) {
    if (!mapaPreview) return 'cross';
    return mapaPreview.get(tr.type) || 'cross';
  }
  function registrarCatalogo(lista) {
    mapaPreview = new Map(lista.map((x) => [x.id, x.preview]));
  }

  /** Prévia avulsa (clique no card): não mexe no projeto. */
  function tocar(def, tJuncao, dur) {
    previa = { def: { preview: def.preview, nome: def.nome, intensity: 50 }, t: tJuncao, dur };
    ultimo = '';
  }

  return {
    tick, tocar, registrarCatalogo,
    destroy() { camada.remove(); },
  };
}
