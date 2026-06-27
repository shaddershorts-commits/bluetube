/* ═══════════════════════════════════════════════════════════════════════════
   clips.js — Acoes de clip wrapadas em Commands undo/redo
   ═══════════════════════════════════════════════════════════════════════════
   Usa BEState (operacoes de mutacao) + BEHistory (registra reverter).

   API publica:
     BEClips.splitAtPlayhead(playerCurrentTime)
     BEClips.deleteSelected()
     BEClips.canSplitAt(t)
     BEClips.canDeleteSelected()
   ═══════════════════════════════════════════════════════════════════════════ */

window.BEClips = (function() {
  'use strict';

  function canSplitAt(t) {
    const s = BEState.get();
    if (!s.video || !s.video.duration) return false;
    const clip = BEState.clipAtTime(t);
    if (!clip) return false;
    // Pelo menos 0.1s de cada lado
    return (t - clip.source_in > 0.1) && (clip.source_out - t > 0.1);
  }

  function splitAtPlayhead(t) {
    if (!canSplitAt(t)) return false;
    // Snapshot do estado anterior pra undo
    const before = JSON.parse(JSON.stringify({
      clips: BEState.get().clips,
      next_clip_id: BEState.get().next_clip_id,
    }));
    let newIds = null;
    BEHistory.execute({
      label: 'cortar em ' + fmtTime(t),
      do() {
        const result = BEState.splitAtTime(t);
        if (result) newIds = result;
      },
      undo() {
        // Restaura clips exatos
        BEState.replaceClips(before.clips || []);
        // Restaura next_id (best-effort)
        const cur = BEState.get();
        cur.next_clip_id = before.next_clip_id;
      },
    });
    return !!newIds;
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

  function fmtTime(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = Math.floor(t - m * 60);
    return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
  }

  return { splitAtPlayhead, deleteSelected, canSplitAt, canDeleteSelected };
})();
