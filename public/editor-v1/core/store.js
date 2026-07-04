// editor-v1/core/store.js
// Store minimalista com fluxo unidirecional:
//   dispatch(action) -> history.record -> reduce -> notify subscribers
// Subscribers recebem (state, action). Modulo puro (sem DOM).

import { reduce } from './reducers.js';
import { createInitialState } from './schema.js';
import { createHistory } from './history.js';

export function createStore(initial) {
  let state = initial || createInitialState();
  const subs = new Set();
  const history = createHistory();

  function notify(action) {
    for (const fn of subs) {
      try { fn(state, action); } catch (e) { console.error('[store] subscriber error:', e); }
    }
  }

  return {
    getState() { return state; },

    dispatch(action) {
      if (!action || !action.type) return state;
      const next = reduce(state, action);
      // history so grava quando a action MUDOU o estado — no-ops (ex:
      // detach repetido, trim sem delta) nao criam snapshots fantasmas
      if (next !== state) {
        history.record(state, action);
        state = next;
        notify(action);
      }
      return state;
    },

    undo() {
      const prev = history.undo(state);
      if (prev) { state = prev; notify({ type: '@undo' }); }
      return state;
    },

    redo() {
      const next = history.redo(state);
      if (next) { state = next; notify({ type: '@redo' }); }
      return state;
    },

    canUndo: () => history.canUndo(),
    canRedo: () => history.canRedo(),
    endGesture: () => history.endGesture(),
    clearHistory: () => history.clear(),

    /** Substitui o estado sem passar pelo reducer (load inicial). Limpa undo. */
    replaceState(next) {
      state = next;
      history.clear();
      notify({ type: '@replace' });
      return state;
    },

    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
