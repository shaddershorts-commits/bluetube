/* ═══════════════════════════════════════════════════════════════════════════
   history.js — Undo/Redo via Command Pattern
   ═══════════════════════════════════════════════════════════════════════════
   Cada acao (trim, split, delete, addText, etc) cria um Command com:
     - do(): aplica a acao
     - undo(): reverte
     - label: descricao curta pra status
   Stack de undos + stack de redos. Limit 100 acoes (anti runaway memory).

   Uso:
     BEHistory.execute({ label: 'split', do(){...}, undo(){...} });
     BEHistory.undo();  // Ctrl+Z
     BEHistory.redo();  // Ctrl+Shift+Z ou Ctrl+Y
   ═══════════════════════════════════════════════════════════════════════════ */

window.BEHistory = (function() {
  'use strict';

  const MAX_HISTORY = 100;
  const undoStack = [];
  const redoStack = [];
  const listeners = new Set();

  function emit() {
    listeners.forEach(fn => { try { fn({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0, undoLabel: lastLabel(undoStack), redoLabel: lastLabel(redoStack) }); } catch(e){} });
  }
  function lastLabel(stack) {
    return stack.length > 0 ? stack[stack.length - 1].label : null;
  }

  // execute: aplica acao + adiciona ao undo stack + limpa redo stack
  function execute(cmd) {
    if (!cmd || typeof cmd.do !== 'function' || typeof cmd.undo !== 'function') {
      console.warn('[BEHistory] comando invalido', cmd);
      return;
    }
    cmd.do();
    undoStack.push(cmd);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0; // nova acao invalida redo
    emit();
  }

  function undo() {
    if (undoStack.length === 0) return false;
    const cmd = undoStack.pop();
    try { cmd.undo(); } catch(e) { console.error('[undo failed]', e); }
    redoStack.push(cmd);
    emit();
    return true;
  }

  function redo() {
    if (redoStack.length === 0) return false;
    const cmd = redoStack.pop();
    try { cmd.do(); } catch(e) { console.error('[redo failed]', e); }
    undoStack.push(cmd);
    emit();
    return true;
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function clear() {
    undoStack.length = 0;
    redoStack.length = 0;
    emit();
  }

  function getState() {
    return { canUndo: undoStack.length > 0, canRedo: redoStack.length > 0, undoLabel: lastLabel(undoStack), redoLabel: lastLabel(redoStack), undoSize: undoStack.length, redoSize: redoStack.length };
  }

  return { execute, undo, redo, subscribe, clear, getState };
})();
