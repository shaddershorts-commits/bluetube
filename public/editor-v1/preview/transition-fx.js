// editor-v1/preview/transition-fx.js
// A transição RODANDO no player — com os DOIS vídeos na tela (2026-07-29).
//
// A primeira versão desenhava uma camada por cima do vídeo. Dava pra ver um
// brilho, uma tarja — mas "Deslizar" não deslizava nada, porque a cena que
// entra nunca aparecia. O user pegou na hora: "fica parecendo mais um efeito
// por cima do vídeo".
//
// Agora o elemento de buffer (que já existia pro double-buffer) mostra a cena
// que ENTRA, no tempo certo dela, enquanto o ativo segue tocando a que sai. O
// CSS move e mistura os dois de verdade.
//
// FLUIDEZ: o JS escreve UMA variável por frame (--p, o progresso 0..1) e o CSS
// deriva transform/opacity/clip-path a partir dela. Quem anima é o compositor
// da GPU — nada é redesenhado na thread principal.

const CLAMP = (v) => Math.max(0, Math.min(1, v));

export function createTransitionFx(stageEl, store, player) {
  if (!stageEl) return { destroy() {}, tick() {}, tocar() {}, registrarCatalogo() {} };

  let mapa = new Map();          // id -> definição do catálogo
  let previa = null;             // prévia disparada pelo clique no card
  let ativoAgora = null;         // chave do efeito aplicado (evita mexer no DOM à toa)

  function registrarCatalogo(lista) {
    mapa = new Map(lista.map((x) => [x.id, x]));
  }

  /** Qual transição está acontecendo em t, e em que ponto dela. */
  function acharAtiva(state, t) {
    const itens = itensDaMain(state);
    for (const tr of state.transitions || []) {
      const saindo = itens[tr.between];
      const entrando = itens[tr.between + 1];
      if (!saindo || !entrando) continue;
      const dur = Math.max(0.1, Math.min(3, Number(tr.duration) || 0.5));
      const ini = saindo.tEnd - dur / 2;
      if (t >= ini && t <= ini + dur) {
        return { tr, entrando, prog: CLAMP((t - ini) / dur) };
      }
    }
    return null;
  }

  // evita importar selectors aqui: a shell passa a lista pronta no tick
  let itensCache = [];
  const itensDaMain = () => itensCache;

  function limpar() {
    if (!ativoAgora) return;
    ativoAgora = null;
    stageEl.classList.remove('be-em-transicao');
    stageEl.removeAttribute('data-fx');
    const b = player.getBufferEl?.();
    if (b) b.classList.remove('be-trans-entrando');
    const d = player.getDisplayEl?.();
    if (d) d.classList.remove('be-trans-saindo');
    player.liberarEntrada?.();
  }

  /**
   * Chamado a cada frame pela shell. `itens` = mainTrackItems(state).
   */
  function tick(t, itens, transicoes) {
    itensCache = itens || [];
    const state = store.getState();

    let def = null, prog = 0, entrando = null;

    if (previa) {
      const ini = previa.t - previa.dur / 2;
      if (t >= ini && t <= ini + previa.dur) {
        def = previa.def; prog = CLAMP((t - ini) / previa.dur);
        entrando = itensCache.find((x) => Math.abs(x.tStart - previa.t) < 0.001) || null;
      } else if (t > ini + previa.dur) previa = null;
    }

    if (!def) {
      const a = acharAtiva({ ...state, transitions: transicoes || [] }, t);
      if (a) {
        def = mapa.get(a.tr.type) || null;
        prog = a.prog;
        entrando = a.entrando;
      }
    }

    if (!def) { limpar(); return; }

    // a cena que ENTRA vai pro buffer, no tempo dela
    if (entrando) {
      const url = urlDoItem(state, entrando.clip);
      const src = entrando.clip.source_in || 0;
      if (url) player.prepararEntrada?.(url, src);
    }

    const chave = def.preview;
    if (chave !== ativoAgora) {
      ativoAgora = chave;
      stageEl.classList.add('be-em-transicao');
      stageEl.dataset.fx = chave;
      const b = player.getBufferEl?.();
      if (b) b.classList.add('be-trans-entrando');
      const d = player.getDisplayEl?.();
      if (d) d.classList.add('be-trans-saindo');
    }
    // uma escrita por frame — o CSS faz o resto
    stageEl.style.setProperty('--p', prog.toFixed(4));
  }

  function urlDoItem(state, clip) {
    if (clip.media_id != null) {
      return (state.media || []).find((m) => m.id === clip.media_id)?.url || null;
    }
    return state.video?.url || null;
  }

  /** Prévia avulsa (clique no card): não grava nada no projeto. */
  function tocar(def, tJuncao, dur) {
    previa = { def, t: tJuncao, dur };
    ativoAgora = null;
  }

  return {
    tick, tocar, registrarCatalogo,
    destroy() { limpar(); },
  };
}
