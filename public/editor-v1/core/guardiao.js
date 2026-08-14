// editor-v1/core/guardiao.js
// AUTORREPARADOR (user 15/08: "o sistema identifica e já corrige").
//
// Honestidade de escopo: isto NÃO conserta bug desconhecido por mágica — ele
// detecta CLASSES de falha e aplica a escada de recuperação certa de cada uma:
//   1. RELÓGIO PARADO tocando (o "travou, não reproduziu mais"): watchdog
//      religa o playback — re-kick → seek+play → aviso honesto (nunca insiste
//      pra sempre: 3 tentativas e conta pro usuário).
//   2. ESTADO CORROMPIDO (NaN, janela invertida, referência órfã — vindo de
//      bug nosso, extensão do navegador ou projeto salvo antigo): sentinela
//      acha a violação com um validador de invariantes DURAS (zero falso
//      positivo em estado válido) e repara com o normalizeLoadedState — o
//      MESMO reparador que já protege o load, uma fonte de verdade só.
//   3. CHUVA DE ERROS (3+ em 30s): oferece recuperar a sessão — o snapshot de
//      sessão (autosave grava a cada edição) volta EXATAMENTE onde estava.
//
// Toda ação do guardião é VISÍVEL (toast "🩹 ...") e logada — reparo
// silencioso é como bug some da vista sem sumir do produto.

import { normalizeLoadedState } from './schema.js';

export const FLAG_RECUPERAR = 'be_v1_recuperar';

/** Invariantes DURAS do estado. Só reporta violação OBJETIVA — um estado
 *  válido devolve []. (O reparo usa o normalize; aqui é só o detector, e a
 *  separação é o que garante zero falso positivo em loop.) */
export function acharProblemas(state) {
  const probs = [];
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!state || typeof state !== 'object') return ['estado ausente'];
  for (const c of state.clips || []) {
    if (!c.frozen && (!num(c.source_in) || !num(c.source_out) || c.source_out <= c.source_in)) {
      probs.push(`cena ${c.id}: recorte inválido (${c.source_in}..${c.source_out})`);
    }
    if (c.speed !== undefined && (!num(c.speed) || c.speed <= 0)) probs.push(`cena ${c.id}: velocidade inválida`);
  }
  for (const a of state.audio_clips || []) {
    if (!num(a.source_in) || !num(a.source_out) || a.source_out <= a.source_in) probs.push(`áudio ${a.id}: recorte inválido`);
    if (!num(a.start) || a.start < 0) probs.push(`áudio ${a.id}: início inválido`);
  }
  for (const o of state.overlays || []) {
    if (!num(o.source_in) || !num(o.source_out) || o.source_out <= o.source_in) probs.push(`camada ${o.id}: recorte inválido`);
    if (!num(o.x_pct) || !num(o.y_pct) || !num(o.scale)) probs.push(`camada ${o.id}: posição/escala inválida`);
  }
  for (const t of state.texts || []) {
    if (!num(t.x_pct) || !num(t.y_pct)) probs.push(`texto ${t.id}: posição inválida`);
    if (!num(t.start_sec) || !num(t.end_sec)) probs.push(`texto ${t.id}: janela inválida`);
  }
  const ids = (arr) => new Set((arr || []).map((x) => x.id));
  if (state.selected_clip_id != null && !ids(state.clips).has(state.selected_clip_id)) probs.push('seleção de cena órfã');
  if (state.selected_audio_id != null && !ids(state.audio_clips).has(state.selected_audio_id)) probs.push('seleção de áudio órfã');
  if (state.selected_overlay_id != null && !ids(state.overlays).has(state.selected_overlay_id)) probs.push('seleção de camada órfã');
  if (state.selected_text_id != null && !ids(state.texts).has(state.selected_text_id)) probs.push('seleção de texto órfã');
  if (state.volumes && (!num(state.volumes.video) || !num(state.volumes.audio_extra))) probs.push('volumes inválidos');
  return probs;
}

/** Repara com o normalize (a régua canônica) e LIMPA seleções órfãs que o
 *  normalize preserva de propósito. Devolve { estado, problemas }. */
export function repararEstado(state) {
  const problemas = acharProblemas(state);
  if (!problemas.length) return { estado: state, problemas };
  const estado = normalizeLoadedState(JSON.parse(JSON.stringify(state)));
  const ids = (arr) => new Set((arr || []).map((x) => x.id));
  if (estado.selected_clip_id != null && !ids(estado.clips).has(estado.selected_clip_id)) estado.selected_clip_id = null;
  if (estado.selected_audio_id != null && !ids(estado.audio_clips).has(estado.selected_audio_id)) estado.selected_audio_id = null;
  if (estado.selected_overlay_id != null && !ids(estado.overlays).has(estado.selected_overlay_id)) estado.selected_overlay_id = null;
  if (estado.selected_text_id != null && !ids(estado.texts).has(estado.selected_text_id)) estado.selected_text_id = null;
  return { estado, problemas };
}

export function criarGuardiao({ store, player, toast }) {
  let strikes = 0;
  let ultimoT = -1;
  let desistiu = false;
  let reparosFeitos = 0;

  // ── 1. watchdog do relógio ────────────────────────────────────────────────
  function checarRelogio() {
    if (!player.isPlaying?.()) { strikes = 0; ultimoT = -1; return 'parado'; }
    const t = player.getTime();
    if (ultimoT >= 0 && Math.abs(t - ultimoT) < 0.02) {
      strikes++;
      if (desistiu) return 'desistiu';
      if (strikes === 1) {
        // re-kick suave: alguns stalls do elemento soltam só com pause/play
        try { player.pause(); player.play(); } catch {}
        console.warn('[guardião] relógio parado tocando — re-kick');
        return 'rekick';
      }
      if (strikes === 2) {
        try { player.pause(); player.seek(t); player.play(); } catch {}
        toast?.('🩹 A reprodução engasgou — reparei e segui.');
        console.warn('[guardião] stall persistiu — seek+play');
        return 'seekplay';
      }
      if (strikes >= 3) {
        desistiu = true;   // nunca insistir pra sempre (loop de recuperação)
        toast?.('⚠️ A reprodução travou de vez. Recarregue a página — seu projeto está salvo.', true);
        return 'desistiu';
      }
    } else if (ultimoT >= 0 && Math.abs(t - ultimoT) >= 0.02) {
      strikes = 0; desistiu = false;
    }
    ultimoT = t;
    return 'ok';
  }

  // ── 2. sentinela do estado ────────────────────────────────────────────────
  function checarEstado() {
    const st = store.getState();
    const probs = acharProblemas(st);
    if (!probs.length) return null;
    const { estado } = repararEstado(st);
    // replaceState: reparo NÃO entra na pilha de undo (não é edição do user)
    store.replaceState(estado);
    reparosFeitos++;
    console.warn('[guardião] estado reparado:', probs);
    toast?.(`🩹 Encontrei ${probs.length === 1 ? 'um dado corrompido' : probs.length + ' dados corrompidos'} no projeto e reparei. Nada foi perdido.`);
    return probs;
  }

  // ── 3. chuva de erros → recuperar a sessão ────────────────────────────────
  const errosRecentes = [];
  function registrarErro() {
    const agora = Date.now();
    errosRecentes.push(agora);
    while (errosRecentes.length && agora - errosRecentes[0] > 30000) errosRecentes.shift();
    if (errosRecentes.length >= 3) {
      errosRecentes.length = 0;
      oferecerRecuperacao();
    }
  }
  let ofereceu = false;
  function oferecerRecuperacao() {
    if (ofereceu) return;
    ofereceu = true;
    const barra = document.createElement('div');
    barra.id = 'beGuardiaoBarra';
    barra.innerHTML = `<span>⚠️ Muitos erros seguidos por aqui. Posso recarregar e te devolver EXATAMENTE onde você estava.</span>
      <button type="button" id="beGuardiaoRec">🩹 Recuperar sessão</button>
      <button type="button" id="beGuardiaoX" title="Continuar assim">✕</button>`;
    document.body.appendChild(barra);
    barra.querySelector('#beGuardiaoRec').addEventListener('click', () => {
      try { sessionStorage.setItem(FLAG_RECUPERAR, '1'); } catch {}
      location.reload();
    });
    barra.querySelector('#beGuardiaoX').addEventListener('click', () => { barra.remove(); ofereceu = false; });
  }
  const onErr = () => registrarErro();
  window.addEventListener('error', onErr);
  window.addEventListener('unhandledrejection', onErr);

  const timerRelogio = setInterval(checarRelogio, 900);
  const timerEstado = setInterval(checarEstado, 3000);

  return {
    // ganchos de teste/diagnóstico — a sonda usa; produção não precisa
    checarRelogio, checarEstado, registrarErro,
    stats: () => ({ strikes, reparosFeitos, desistiu }),
    destroy() {
      clearInterval(timerRelogio); clearInterval(timerEstado);
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onErr);
      document.getElementById('beGuardiaoBarra')?.remove();
    },
  };
}
