// editor-v1/core/guardiao.js
// AUTORREPARADOR — v2 (15/08, depois do caso real do usuário).
//
// A v1 reparava com o normalizeLoadedState, que FILTRA itens fora da régua:
// um falso positivo qualquer virava PERDA DE CONTEÚDO (o "separei o áudio,
// juntei, apareceu que reparou e o áudio sumiu"). Reparo que remove conteúdo
// é pior que o erro que ele caça. Regras da v2, nesta ordem:
//   1. NUNCA REMOVER NADA — só corrigir campos no lugar (NaN → padrão,
//      janela invertida → clampa preservando o item, seleção órfã → null).
//      O reparador ASSERTA as contagens antes de aplicar: se qualquer lista
//      mudaria de tamanho, ele NÃO aplica e só loga.
//   2. SILÊNCIO TOTAL (pedido do usuário: "é pra trabalhar no background") —
//      zero toast, zero barra; tudo vai pro console com prefixo [guardião].
//   3. Itens desativados (active:false) não são julgados — lixeira lógica
//      tem forma própria e não toca preview nem export.
//
// Escadas: relógio parado tocando → re-kick → seek+play → desiste em
// silêncio (nunca loop); estado corrompido → reparo cirúrgico; chuva de
// erros → só registra no console (o snapshot de sessão já é gravado a cada
// edição; a recuperação via FLAG_RECUPERAR continua disponível no boot).

export const FLAG_RECUPERAR = 'be_v1_recuperar';

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const ativos = (arr) => (arr || []).filter((x) => x && x.active !== false);

/** Violações OBJETIVAS e CIRURGICAMENTE corrigíveis. Estado válido → []. */
export function acharProblemas(state) {
  const probs = [];
  if (!state || typeof state !== 'object') return ['estado ausente'];
  for (const c of ativos(state.clips)) {
    if (c.compound_id) continue;   // stub de composto tem forma própria
    if (!c.frozen && (!num(c.source_in) || !num(c.source_out) || c.source_out <= c.source_in)) {
      probs.push(`cena ${c.id}: recorte inválido`);
    }
    if (c.speed !== undefined && (!num(c.speed) || c.speed <= 0)) probs.push(`cena ${c.id}: velocidade inválida`);
  }
  for (const a of ativos(state.audio_clips)) {
    if (!num(a.source_in) || !num(a.source_out) || a.source_out <= a.source_in) probs.push(`áudio ${a.id}: recorte inválido`);
    if (!num(a.start) || a.start < 0) probs.push(`áudio ${a.id}: início inválido`);
  }
  for (const o of ativos(state.overlays)) {
    if (!num(o.source_in) || !num(o.source_out) || o.source_out <= o.source_in) probs.push(`camada ${o.id}: recorte inválido`);
    if (!num(o.x_pct) || !num(o.y_pct) || !num(o.scale)) probs.push(`camada ${o.id}: posição/escala inválida`);
  }
  for (const t of ativos(state.texts)) {
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

/** Reparo CIRÚRGICO: corrige campos no lugar, contagens intocadas.
 *  Devolve { estado, problemas } — estado === state quando não há o que fazer. */
export function repararEstado(state) {
  const problemas = acharProblemas(state);
  if (!problemas.length) return { estado: state, problemas };
  const e = JSON.parse(JSON.stringify(state));
  const fixNum = (obj, campo, padrao) => { if (!num(obj[campo])) obj[campo] = padrao; };
  for (const c of ativos(e.clips)) {
    if (c.compound_id) continue;
    if (!c.frozen) {
      fixNum(c, 'source_in', 0);
      if (!num(c.source_out) || c.source_out <= c.source_in) c.source_out = c.source_in + 0.1;
    }
    if (c.speed !== undefined && (!num(c.speed) || c.speed <= 0)) delete c.speed;
  }
  for (const a of ativos(e.audio_clips)) {
    fixNum(a, 'source_in', 0);
    if (!num(a.source_out) || a.source_out <= a.source_in) a.source_out = a.source_in + 0.1;
    if (!num(a.start) || a.start < 0) a.start = 0;
  }
  for (const o of ativos(e.overlays)) {
    fixNum(o, 'source_in', 0);
    if (!num(o.source_out) || o.source_out <= o.source_in) o.source_out = o.source_in + 0.1;
    fixNum(o, 'x_pct', 0.5); fixNum(o, 'y_pct', 0.5); fixNum(o, 'scale', 1);
  }
  for (const t of ativos(e.texts)) {
    fixNum(t, 'x_pct', 0.5); fixNum(t, 'y_pct', 0.5);
    fixNum(t, 'start_sec', 0);
    if (!num(t.end_sec)) t.end_sec = t.start_sec + 1;
  }
  const ids = (arr) => new Set((arr || []).map((x) => x.id));
  if (e.selected_clip_id != null && !ids(e.clips).has(e.selected_clip_id)) e.selected_clip_id = null;
  if (e.selected_audio_id != null && !ids(e.audio_clips).has(e.selected_audio_id)) e.selected_audio_id = null;
  if (e.selected_overlay_id != null && !ids(e.overlays).has(e.selected_overlay_id)) e.selected_overlay_id = null;
  if (e.selected_text_id != null && !ids(e.texts).has(e.selected_text_id)) e.selected_text_id = null;
  if (e.volumes) { fixNum(e.volumes, 'video', 1); fixNum(e.volumes, 'audio_extra', 1); }
  // ── ASSERT ANTI-PERDA: nenhuma lista pode mudar de tamanho, nunca ─────────
  for (const k of ['clips', 'audio_clips', 'overlays', 'texts', 'media', 'compounds']) {
    if ((e[k] || []).length !== (state[k] || []).length) {
      console.error(`[guardião] reparo ABORTADO: mexeria na contagem de ${k} — isso nunca pode acontecer`);
      return { estado: state, problemas: [] };
    }
  }
  return { estado: e, problemas };
}

export function criarGuardiao({ store, player }) {
  let strikes = 0;
  let ultimoT = -1;
  let desistiu = false;
  let reparosFeitos = 0;

  // ── 1. watchdog do relógio (silencioso) ───────────────────────────────────
  function checarRelogio() {
    if (!player.isPlaying?.()) { strikes = 0; ultimoT = -1; return 'parado'; }
    const t = player.getTime();
    if (ultimoT >= 0 && Math.abs(t - ultimoT) < 0.02) {
      strikes++;
      if (desistiu) return 'desistiu';
      if (strikes === 1) {
        try { player.pause(); player.play(); } catch {}
        console.warn('[guardião] relógio parado tocando — re-kick');
        return 'rekick';
      }
      if (strikes === 2) {
        try { player.pause(); player.seek(t); player.play(); } catch {}
        console.warn('[guardião] stall persistiu — seek+play');
        return 'seekplay';
      }
      if (strikes >= 3) {
        desistiu = true;   // nunca insistir pra sempre (loop de recuperação)
        console.error('[guardião] stall não recuperável — parei de insistir');
        return 'desistiu';
      }
    } else if (ultimoT >= 0 && Math.abs(t - ultimoT) >= 0.02) {
      strikes = 0; desistiu = false;
    }
    ultimoT = t;
    return 'ok';
  }

  // ── 2. sentinela do estado (cirúrgica e silenciosa) ───────────────────────
  function checarEstado() {
    const st = store.getState();
    const { estado, problemas } = repararEstado(st);
    if (!problemas.length) return null;
    store.replaceState(estado);   // fora do undo: reparo não é edição do user
    reparosFeitos++;
    console.warn('[guardião] estado reparado em silêncio:', problemas);
    return problemas;
  }

  // ── 3. chuva de erros: só registra (nada na tela — pedido do usuário) ────
  const errosRecentes = [];
  function registrarErro() {
    const agora = Date.now();
    errosRecentes.push(agora);
    while (errosRecentes.length && agora - errosRecentes[0] > 30000) errosRecentes.shift();
    if (errosRecentes.length >= 3) {
      console.error(`[guardião] ${errosRecentes.length} erros em 30s — snapshot de sessão está em dia (be_v1_state)`);
    }
  }
  const onErr = () => registrarErro();
  window.addEventListener('error', onErr);
  window.addEventListener('unhandledrejection', onErr);

  const timerRelogio = setInterval(checarRelogio, 900);
  const timerEstado = setInterval(checarEstado, 3000);

  return {
    checarRelogio, checarEstado, registrarErro,
    stats: () => ({ strikes, reparosFeitos, desistiu }),
    destroy() {
      clearInterval(timerRelogio); clearInterval(timerEstado);
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onErr);
    },
  };
}
