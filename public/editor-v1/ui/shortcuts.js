// editor-v1/ui/shortcuts.js
// Atalhos CapCut. Ignora quando o foco esta em input/textarea/contenteditable.

import * as act from '../core/actions.js';
import { segmentAt } from '../core/selectors.js';

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
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); store.dispatch(act.splitClipAt(t)); return; }
    // Zoom
    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); timeline.zoomBy(1.25); return; }
    if (mod && e.key === '-') { e.preventDefault(); timeline.zoomBy(1 / 1.25); return; }

    switch (e.key) {
      case ' ':
        e.preventDefault();
        player.toggle();
        break;
      case 'q': case 'Q':
        store.dispatch(act.deleteRangeLeft(t));
        player.seek(0.001);
        break;
      case 'w': case 'W':
        store.dispatch(act.deleteRangeRight(t));
        break;
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
        if (state.selected_text_id != null) {
          store.dispatch(act.deleteText(state.selected_text_id));
        } else if (state.selected_clip_id != null) {
          store.dispatch(act.deleteClip(state.selected_clip_id));
        }
        break;
      }
      case 'ArrowLeft': e.preventDefault(); player.stepFrame(-1, e.shiftKey); break;
      case 'ArrowRight': e.preventDefault(); player.stepFrame(1, e.shiftKey); break;
      case 'Home': e.preventDefault(); player.seek(0); break;
      case 'End': e.preventDefault(); player.seek(player.getDuration()); break;
      case 'z': case 'Z':
        if (e.shiftKey) timeline.zoomFit();
        break;
    }
  }

  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
