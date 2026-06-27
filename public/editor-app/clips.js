/* ═══════════════════════════════════════════════════════════════════════════
   clips.js — Acoes de clip wrapadas em Commands undo/redo (CapCut-style)
   ═══════════════════════════════════════════════════════════════════════════
   API:
     BEClips.splitAtPlayhead(t)         — Ctrl+B
     BEClips.deleteSelected()           — Backspace/Delete
     BEClips.deleteLeftFromPlayhead(t)  — Q
     BEClips.deleteRightFromPlayhead(t) — W
     BEClips.toggleClipActiveById(id)   — V
     BEClips.moveClipBy(id, deltaSec)   — drag horizontal
     BEClips.canSplitAt(t)
     BEClips.canDeleteSelected()
   ═══════════════════════════════════════════════════════════════════════════ */

window.BEClips = (function() {
  'use strict';

  function fmtTime(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = Math.floor(t - m * 60);
    return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
  }

  function canSplitAt(t) {
    const s = BEState.get();
    if (!s.video || !s.video.duration) return false;
    const clip = BEState.clipAtTime(t);
    if (!clip) return false;
    return (t - clip.source_in > 0.1) && (clip.source_out - t > 0.1);
  }

  function splitAtPlayhead(t) {
    if (!canSplitAt(t)) return false;
    const before = JSON.parse(JSON.stringify({
      clips: BEState.get().clips,
      next_clip_id: BEState.get().next_clip_id,
    }));
    BEHistory.execute({
      label: 'cortar em ' + fmtTime(t),
      do() { BEState.splitAtTime(t); },
      undo() {
        BEState.replaceClips(before.clips || []);
        BEState.get().next_clip_id = before.next_clip_id;
      },
    });
    return true;
  }

  function canDeleteSelected() {
    const s = BEState.get();
    if (!s.selected_clip_id) return false;
    if (!s.clips || s.clips.length <= 1) return false;
    return s.clips.some(c => c.id === s.selected_clip_id);
  }

  function deleteSelected() {
    if (!canDeleteSelected()) return false;
    const s = BEState.get();
    const id = s.selected_clip_id;
    const idx = s.clips.findIndex(c => c.id === id);
    if (idx < 0) return false;
    const removed = s.clips[idx];
    BEHistory.execute({
      label: 'remover clipe',
      do() { BEState.deleteClip(id); },
      undo() { BEState.insertClip(removed, idx); },
    });
    return true;
  }

  // Q: deleta o pedaco do playhead pra ESQUERDA do clip atual
  function deleteLeftFromPlayhead(t) {
    const clip = BEState.clipAtTime(t);
    if (!clip || clip.virtual) return false;
    if (t <= clip.source_in + 0.05 || t >= clip.source_out - 0.05) return false;
    const before = { source_in: clip.source_in, source_out: clip.source_out };
    const id = clip.id;
    BEHistory.execute({
      label: 'apagar esquerda (Q)',
      do() { BEState.deleteLeftFromPlayhead(t); },
      undo() { BEState.updateClip(id, before); },
    });
    return true;
  }

  // W: deleta o pedaco do playhead pra DIREITA do clip atual
  function deleteRightFromPlayhead(t) {
    const clip = BEState.clipAtTime(t);
    if (!clip || clip.virtual) return false;
    if (t >= clip.source_out - 0.05 || t <= clip.source_in + 0.05) return false;
    const before = { source_in: clip.source_in, source_out: clip.source_out };
    const id = clip.id;
    BEHistory.execute({
      label: 'apagar direita (W)',
      do() { BEState.deleteRightFromPlayhead(t); },
      undo() { BEState.updateClip(id, before); },
    });
    return true;
  }

  // V: toggle active (clip pulado no export, mas continua na timeline)
  function toggleClipActiveById(id) {
    if (!id) return false;
    const found = BEState.findClip(id);
    if (!found) return false;
    const wasActive = found.clip.active !== false;
    BEHistory.execute({
      label: wasActive ? 'desativar clipe' : 'ativar clipe',
      do() { BEState.toggleClipActive(id); },
      undo() { BEState.toggleClipActive(id); },
    });
    return true;
  }

  // Drag: move um clip preservando duracao (debounced — usuario solta = 1 Command)
  // Aqui o argumento e o delta TOTAL (final - inicial) pra ser undoable num bloco
  function moveClipBy(id, delta) {
    if (Math.abs(delta) < 0.01) return false;
    BEHistory.execute({
      label: 'mover clipe',
      do() { BEState.moveClip(id, delta); },
      undo() { BEState.moveClip(id, -delta); },
    });
    return true;
  }

  return {
    splitAtPlayhead, deleteSelected,
    deleteLeftFromPlayhead, deleteRightFromPlayhead,
    toggleClipActiveById, moveClipBy,
    canSplitAt, canDeleteSelected,
  };
})();
