// editor-v1/preview/transition-fx.js
// A transição RODANDO no player — com os DOIS vídeos na tela (2026-07-29,
// reescrito 2026-08-07).
//
// A primeira versão desenhava uma camada por cima do vídeo. Dava pra ver um
// brilho, uma tarja — mas "Deslizar" não deslizava nada, porque a cena que
// entra nunca aparecia. O user pegou na hora: "fica parecendo mais um efeito
// por cima do vídeo".
//
// A segunda versão punha os dois vídeos na tela, mas amarrava as classes CSS
// aos ELEMENTOS enquanto o double-buffer trocava os papéis deles no meio do
// efeito (swap na fronteira). Resultado: a cena que saía sumia de estalo, a
// que entrava era recarregada por cima da antiga e as classes vazavam pros
// efeitos seguintes — a "tela preta + imagem duplicada" do user (2026-08-07).
//
// AGORA A DIVISÃO É ESTRITA:
//   - o PLAYER é dono da mecânica: segura a fronteira até o fim do efeito
//     (prepararTransicao/transRoles), toca a entrada com material emprestado
//     e faz o swap UMA vez, no fim (espelho exato do xfade do render);
//   - este módulo é dono do VISUAL: pergunta os papéis ao player a cada
//     frame, aplica as classes no elemento CERTO e escreve --p no palco.
//
// FLUIDEZ: o JS escreve UMA variável por frame (--p, o progresso 0..1) e o CSS
// deriva transform/opacity/clip-path a partir dela. Quem anima é o compositor
// da GPU — nada é redesenhado na thread principal.

const CLAMP = (v) => Math.max(0, Math.min(1, v));

export function createTransitionFx(stageEl, store, player) {
  if (!stageEl) {
    return { destroy() {}, tick() {}, tocar() {}, registrarCatalogo() {}, rolesAtuais() { return null; } };
  }

  let mapa = new Map();          // id -> definição do catálogo
  let previa = null;             // prévia disparada pelo clique no card
  let ativoAgora = null;         // chave do efeito aplicado (evita mexer no DOM à toa)
  let rolesAgora = null;         // { elSai, elEntra, jun } enquanto o efeito roda

  function registrarCatalogo(lista) {
    mapa = new Map(lista.map((x) => [x.id, x]));
  }

  /** Qual transição está acontecendo em t, e em que ponto dela. */
  function acharAtiva(itens, transicoes, t) {
    for (const tr of transicoes || []) {
      const saindo = itens[tr.between];
      const entrando = itens[tr.between + 1];
      if (!saindo || !entrando) continue;
      const dur = Math.max(0.1, Math.min(3, Number(tr.duration) || 0.5));
      const jun = saindo.tEnd;
      const ini = jun - dur / 2;
      if (t >= ini && t <= ini + dur) {
        return { def: mapa.get(tr.type) || null, prog: CLAMP((t - ini) / dur), jun, dur };
      }
    }
    return null;
  }

  /** Tira TODO vestígio de transição dos DOIS elementos do double-buffer.
   *  Remover "do elemento que tinha tal papel" era exatamente o vazamento
   *  que duplicava a imagem — aqui é terra arrasada, idempotente. */
  function elementos() {
    return [player.getDisplayEl?.(), player.getBufferEl?.()].filter(Boolean);
  }

  function limpar() {
    if (!ativoAgora && !rolesAgora) return;
    ativoAgora = null;
    rolesAgora = null;
    stageEl.classList.remove('be-em-transicao');
    stageEl.removeAttribute('data-fx');
    stageEl.style.removeProperty('--p');
    for (const el of elementos()) {
      el.classList.remove('be-trans-entrando', 'be-trans-saindo', 'be-trans-pronta');
    }
    // efeito sumiu com o player ainda segurando a fronteira (ex.: user removeu
    // a transição no meio dela): devolve o playback ao caminho normal. No fim
    // natural o player já concluiu sozinho — vira no-op.
    if (player.transRoles?.()) player.abortarTransicao?.();
  }

  /**
   * Chamado a cada frame pela shell. `itens` = mainTrackItems(state).
   */
  function tick(t, itens, transicoes) {
    let ativa = null;

    if (previa) {
      const ini = previa.t - previa.dur / 2;
      if (t >= ini && t <= ini + previa.dur) {
        ativa = { def: previa.def, prog: CLAMP((t - ini) / previa.dur), jun: previa.t, dur: previa.dur };
      } else if (t > ini + previa.dur) previa = null;
    }

    if (!ativa) ativa = acharAtiva(itens, transicoes, t);
    if (!ativa || !ativa.def) { limpar(); return; }

    // papéis vêm do PLAYER: tocando = hold da fronteira; pausado = display
    // mostra o lado sob a agulha e o buffer compõe o outro lado
    let roles = null;
    if (player.isPlaying?.()) {
      roles = player.transRoles?.();
      if (!roles) {
        const ok = player.prepararTransicao?.({ jun: ativa.jun, dur: ativa.dur });
        roles = ok ? player.transRoles?.() : null;
      }
      // ENTRADA TARDIA (seek pra dentro da janela já tocando): não dá mais
      // pra segurar a fronteira, mas dá pra compor com o OUTRO lado num frame
      // parado — um fade a partir do congelado é honesto; sumir o efeito não
      if (!roles) roles = player.prepararLadoPausado?.({ t, jun: ativa.jun });
    } else {
      roles = player.prepararLadoPausado?.({ t, jun: ativa.jun });
    }
    if (roles) roles = { sai: roles.sai, entra: roles.entra, jun: ativa.jun };
    if (!roles || !roles.sai || !roles.entra) { limpar(); return; }

    // classes SEMPRE reconciliadas com os papéis do frame (os papéis podem
    // trocar num scrub pausado que cruza a emenda)
    const chave = ativa.def.preview;
    const mudou = chave !== ativoAgora ||
      rolesAgora?.elSai !== roles.sai || rolesAgora?.elEntra !== roles.entra;
    if (mudou) {
      ativoAgora = chave;
      rolesAgora = { elSai: roles.sai, elEntra: roles.entra, jun: roles.jun };
      stageEl.classList.add('be-em-transicao');
      stageEl.dataset.fx = chave;
      for (const el of elementos()) {
        el.classList.toggle('be-trans-saindo', el === roles.sai);
        el.classList.toggle('be-trans-entrando', el === roles.entra);
        if (el !== roles.entra) el.classList.remove('be-trans-pronta');
      }
    }
    // a entrada só APARECE quando tem frame decodificado — antes disso o
    // elemento visível-sem-frame pintava PRETO por cima da cena que sai
    roles.entra.classList.toggle('be-trans-pronta', roles.entra.readyState >= 2);

    // uma escrita por frame — o CSS faz o resto
    stageEl.style.setProperty('--p', ativa.prog.toFixed(4));
  }

  /** Prévia avulsa (clique no card): não grava nada no projeto. */
  function tocar(def, tJuncao, dur) {
    previa = { def, t: tJuncao, dur };
    ativoAgora = null;
  }

  /** Shell usa pra aplicar o visual da cena (transform/máscara) no elemento
   *  certo enquanto o efeito roda. */
  function rolesAtuais() {
    return rolesAgora;
  }

  return {
    tick, tocar, registrarCatalogo, rolesAtuais,
    destroy() { limpar(); },
  };
}
