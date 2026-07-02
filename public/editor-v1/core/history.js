// editor-v1/core/history.js
// Undo/redo por snapshot do documento. Middleware do store:
//   - so actions em UNDOABLE gravam snapshot
//   - actions com o mesmo gestureId coalescem (1 gesto = 1 undo step)
//   - stack limitado a MAX_UNDO
// Modulo puro (sem DOM).

import { UNDOABLE } from './actions.js';
import { MAX_UNDO } from './schema.js';

export function createHistory() {
  let past = [];        // snapshots ANTES de cada action undoable
  let future = [];
  let lastGestureId = null;

  return {
    /** Chamar ANTES do reduce. Grava snapshot se a action for undoable. */
    record(state, action) {
      if (!UNDOABLE[action.type]) return;
      // Coalescing: mesmo gesto (drag continuo) nao empilha de novo
      if (action.gestureId != null && action.gestureId === lastGestureId) return;
      lastGestureId = action.gestureId ?? null;
      past.push(state);
      if (past.length > MAX_UNDO) past.shift();
      future = [];
    },

    /** @returns {object|null} estado restaurado ou null se nada a desfazer */
    undo(currentState) {
      if (!past.length) return null;
      const prev = past.pop();
      future.push(currentState);
      lastGestureId = null;
      return prev;
    },

    /** @returns {object|null} */
    redo(currentState) {
      if (!future.length) return null;
      const next = future.pop();
      past.push(currentState);
      lastGestureId = null;
      return next;
    },

    canUndo() { return past.length > 0; },
    canRedo() { return future.length > 0; },
    clear() { past = []; future = []; lastGestureId = null; },
    /** Quebra coalescing manualmente (ex: fim de gesto). */
    endGesture() { lastGestureId = null; },
    size() { return { past: past.length, future: future.length }; },
  };
}
