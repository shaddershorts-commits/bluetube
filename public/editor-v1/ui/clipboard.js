// editor-v1/ui/clipboard.js
// Clipboard interno compartilhado (Ctrl+C/X/V + menu botão direito).
// Copiar = guarda cópia; Colar = cria NOVA faixa (nunca mexe no original).

import * as act from '../core/actions.js';

let clip = null;      // { kind, data }
let attrs = null;     // atributos (escala/opacidade/velocidade/fx) pra "colar atributos"

const findById = (arr, id) => (arr || []).find(x => x.id === id);

/** Copia a faixa selecionada. Retorna o kind ou null. */
export function copySel(store) {
  const s = store.getState();
  if (s.selected_clip_id != null) { const c = findById(s.clips, s.selected_clip_id); if (c) { clip = { kind: 'clip', data: { ...c } }; return 'clip'; } }
  else if (s.selected_audio_id != null) { const a = findById(s.audio_clips, s.selected_audio_id); if (a) { clip = { kind: 'audio', data: { ...a } }; return 'audio'; } }
  else if (s.selected_text_id != null) { const x = findById(s.texts, s.selected_text_id); if (x) { clip = { kind: 'text', data: { ...x } }; return 'text'; } }
  else if (s.selected_overlay_id != null) { const o = findById(s.overlays, s.selected_overlay_id); if (o) { clip = { kind: 'overlay', data: { ...o } }; return 'overlay'; } }
  return null;
}

export function deleteSel(store) {
  const s = store.getState();
  if (s.selected_clip_id != null) store.dispatch(act.deleteClip(s.selected_clip_id));
  else if (s.selected_audio_id != null) store.dispatch(act.deleteAudioClip(s.selected_audio_id));
  else if (s.selected_text_id != null) store.dispatch(act.deleteText(s.selected_text_id));
  else if (s.selected_overlay_id != null) store.dispatch(act.deleteOverlay(s.selected_overlay_id));
}

/** Recortar = copiar + remover (some da timeline). */
export function cutSel(store) {
  const k = copySel(store);
  if (k) deleteSel(store);
  return k;
}

/** Cola no tempo atT (playhead). */
export function pasteAt(store, atT) {
  if (!clip) return false;
  store.dispatch(act.paste(clip.kind, clip.data, atT));
  return true;
}

export function hasClipboard() { return !!clip; }

// ── copiar/colar ATRIBUTOS (escala, opacidade, velocidade, fx) ──
export function copyAttrs(store) {
  const s = store.getState();
  const c = findById(s.clips, s.selected_clip_id);
  if (!c) return false;
  attrs = {
    scale: c.scale ?? 1, opacity: c.opacity ?? 1, speed: c.speed ?? 1,
    reversed: !!c.reversed, mirrored: !!c.mirrored,
  };
  return true;
}
export function pasteAttrs(store) {
  const s = store.getState();
  const c = findById(s.clips, s.selected_clip_id);
  if (!c || !attrs) return false;
  store.dispatch(act.setClipTransform(c.id, { scale: attrs.scale, opacity: attrs.opacity }));
  store.dispatch(act.setSpeed('clip', c.id, attrs.speed));
  store.dispatch(act.setClipFx(c.id, { reversed: attrs.reversed, mirrored: attrs.mirrored }));
  return true;
}
export function hasAttrs() { return !!attrs; }
