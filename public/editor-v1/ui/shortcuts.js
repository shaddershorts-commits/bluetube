// editor-v1/ui/shortcuts.js
// Atalhos CapCut. Ignora quando o foco esta em input/textarea/contenteditable.

import * as act from '../core/actions.js';
import {
  segmentAt, timelineSegments, effectiveTexts, effectiveAudioClips, effectiveOverlays, audioTimelineDur,
} from '../core/selectors.js';
import { copySel, cutSel, pasteAt } from './clipboard.js';

/** Split CapCut: corta a FAIXA selecionada no cursor.
 *  Texto/audio/camada selecionado -> divide essa faixa; clip -> video;
 *  NADA selecionado -> corta TUDO que estiver sob o ponteiro (user 2026-07-20). */
export function splitSelectedAt(store, t) {
  const s = store.getState();
  if (s.selected_text_id != null) return store.dispatch(act.splitTextAt(s.selected_text_id, t));
  if (s.selected_audio_id != null) return store.dispatch(act.splitAudioAt(t));
  if (s.selected_overlay_id != null) return store.dispatch(act.splitOverlayAt(t));
  if (s.selected_clip_id != null) return store.dispatch(act.splitClipAt(t));
  return splitAllAt(store, t);
}

const EPS = 1e-3;
const spanAudio = (a) => a.source_out - a.source_in;

/** Corta TODAS as faixas sob o tempo t (video + textos + audios + camadas).
 *  Tudo com o mesmo gestureId => 1 undo desfaz o corte inteiro. */
export function splitAllAt(store, t) {
  const gestureId = 'splitall-' + Date.now();
  const s = store.getState();
  // compostos nao sao cortados aqui (dentro deles se edita com duplo clique)
  if (segmentAt(s, t) && !segmentAt(s, t).compoundId) {
    store.dispatch({ ...act.splitClipAt(t), gestureId });
  }
  for (const tx of s.texts.filter(x => x.active !== false &&
      t > x.start_sec + EPS && t < x.end_sec - EPS)) {
    store.dispatch({ ...act.splitTextAt(tx.id, t), gestureId });
  }
  // SPLIT_AUDIO/SPLIT_OVERLAY cortam 1 por dispatch: repete enquanto houver
  // faixa inteira sob o ponteiro (as metades novas nao batem mais no filtro)
  const nAud = s.audio_clips.filter(a => a.active !== false &&
    t > a.start + EPS && t < a.start + audioTimelineDur(a) - EPS).length;
  for (let i = 0; i < nAud; i++) store.dispatch({ ...act.splitAudioAt(t), gestureId });
  const nOv = s.overlays.filter(o => o.active !== false &&
    t > o.start + EPS && t < o.start + spanAudio(o) - EPS).length;
  for (let i = 0; i < nOv; i++) store.dispatch({ ...act.splitOverlayAt(t), gestureId });
  store.endGesture();
}

/** Intervalos [start,end] de TODAS as faixas (video/texto/audio/camada) em
 *  tempo virtual — base da navegacao com as setas ↑/↓. */
function trackSpans(state) {
  const spans = [];
  for (const s of timelineSegments(state)) spans.push({ start: s.tStart, end: s.tEnd });
  for (const x of effectiveTexts(state)) spans.push({ start: x.start_sec, end: x.end_sec });
  for (const a of effectiveAudioClips(state)) spans.push({ start: a.start, end: a.start + audioTimelineDur(a) });
  for (const o of effectiveOverlays(state)) spans.push({ start: o.start, end: o.start + spanAudio(o) });
  return spans;
}

export function attachShortcuts({ store, player, timeline }) {
  function isTyping() {
    const el = document.activeElement;
    if (!el) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
  }

  function onKey(e) {
    if (isTyping()) return;
    const t = player.getTime();
    const state = store.getState();
    const mod = e.ctrlKey || e.metaKey;

    // Undo/redo
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); store.undo(); return; }
    if ((mod && e.shiftKey && e.key.toLowerCase() === 'z') || (mod && e.key.toLowerCase() === 'y')) {
      e.preventDefault(); store.redo(); return;
    }
    // Split
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); splitSelectedAt(store, t); return; }
    // Importar midias (video/audio) — abre direto a janela de arquivos
    if (mod && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      document.getElementById('beFile')?.click();
      return;
    }
    // Separar audio do video (CapCut: Ctrl+Shift+S)
    if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      store.dispatch(act.detachAudio());
      return;
    }
    // Clipe composto (CapCut): Alt+G cria, Shift+Alt+G desfaz, Ctrl+A seleciona tudo
    if (e.altKey && !e.shiftKey && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      store.dispatch(act.createCompound());
      return;
    }
    if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      const st = store.getState();
      const sel = st.clips.find(c => c.id === st.selected_clip_id);
      if (sel?.compound_id) store.dispatch(act.ungroupCompound(sel.compound_id));
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); store.dispatch(act.selectAll()); return; }
    // Copiar / Recortar / Colar (Ctrl+C/X/V). ANTES ficava sem tratamento e o
    // Ctrl+V caía no 'v' (toggle) — "some + restaurar". Agora clipboard real.
    if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copySel(store); return; }
    if (mod && e.key.toLowerCase() === 'x') { e.preventDefault(); cutSel(store); return; }
    if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteAt(store, t); return; }
    // Zoom
    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); timeline.zoomBy(1.25); return; }
    if (mod && e.key === '-') { e.preventDefault(); timeline.zoomBy(1 / 1.25); return; }
    // qualquer outro atalho com Ctrl/Cmd NÃO deve cair nas teclas soltas abaixo
    // (senão Ctrl+V viraria toggle 'v', Ctrl+Q apagaria, etc)
    if (mod) return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        player.toggle();
        break;
      case 'q': case 'Q': {
        // CAMADA (overlay) selecionada: Q remove a parte ANTES do playhead
        // (funciona no vídeo arrastado pra criar camada — user 2026-07-20)
        const ov = state.overlays.find(o => o.id === state.selected_overlay_id);
        if (ov) {
          const dur = ov.source_out - ov.source_in;
          if (t > ov.start && t < ov.start + dur) store.dispatch(act.trimOverlay(ov.id, 'in', t));
          break;
        }
        // age SÓ no clip selecionado (ou o sob o playhead) — reducer garante.
        const segsQ = timelineSegments(state);
        const alvoQ = state.selected_clip_id != null
          ? segsQ.find(s => s.clip.id === state.selected_clip_id)
          : segmentAt(state, t);
        store.dispatch(act.deleteRangeLeft(t));
        if (alvoQ && t > alvoQ.tStart && t < alvoQ.tEnd) player.seek(alvoQ.tStart);
        break;
      }
      case 'w': case 'W': {
        const ov = state.overlays.find(o => o.id === state.selected_overlay_id);
        if (ov) {
          // remove a parte DEPOIS do playhead (source_out = ponto atual)
          const dur = ov.source_out - ov.source_in;
          if (t > ov.start && t < ov.start + dur) {
            store.dispatch(act.trimOverlay(ov.id, 'out', ov.source_in + (t - ov.start)));
          }
          break;
        }
        store.dispatch(act.deleteRangeRight(t));
        break;
      }
      case 'v': case 'V': {
        if (state.selected_clip_id != null) {
          store.dispatch(act.toggleClip(state.selected_clip_id));
        } else {
          const seg = segmentAt(state, t);
          if (seg) store.dispatch(act.toggleClip(seg.clip.id));
        }
        break;
      }
      case 'Delete': case 'Backspace': {
        // multi-selecao (Ctrl+A / marquee / ctrl+click): apaga TUDO selecionado
        if (state.multi_selected?.length) {
          store.dispatch(act.deleteMulti());
          break;
        }
        if (state.selected_text_id != null) {
          store.dispatch(act.deleteText(state.selected_text_id));
        } else if (state.selected_overlay_id != null) {
          store.dispatch(act.deleteOverlay(state.selected_overlay_id));
        } else if (state.selected_audio_id != null) {
          store.dispatch(act.deleteAudioClip(state.selected_audio_id));
        } else if (state.selected_clip_id != null) {
          store.dispatch(act.deleteClip(state.selected_clip_id));
        }
        break;
      }
      case 'ArrowLeft': e.preventDefault(); player.stepFrame(-1, e.shiftKey); break;
      case 'ArrowRight': e.preventDefault(); player.stepFrame(1, e.shiftKey); break;
      // ↑ = ponteiro pro INICIO da faixa mais proxima (qualquer track);
      // ↓ = pro FINAL. Apertar de novo continua andando pelas bordas.
      case 'ArrowUp': {
        e.preventDefault();
        const starts = trackSpans(state).map(sp => sp.start).filter(v => v < t - 1e-3);
        player.seek(starts.length ? Math.max(...starts) : 0);
        break;
      }
      case 'ArrowDown': {
        e.preventDefault();
        const ends = trackSpans(state).map(sp => sp.end).filter(v => v > t + 1e-3);
        player.seek(ends.length ? Math.min(...ends) : player.getDuration());
        break;
      }
      case 'Home': e.preventDefault(); player.seek(0); break;
      case 'End': e.preventDefault(); player.seek(player.getDuration()); break;
      case 'z': case 'Z':
        if (e.shiftKey) timeline.zoomFit();
        break;
      case 'Escape':
        if (state.multi_selected?.length) store.dispatch(act.setMultiSelect([]));
        break;
    }
  }

  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
