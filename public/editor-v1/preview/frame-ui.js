// editor-v1/preview/frame-ui.js
// Marcador do VÍDEO no player: moldura com alças pra mover e escalar a cena
// dentro do quadro, como no CapCut (2026-07-29).
//
// Existe porque o marcador da MÁSCARA tomava conta do preview o tempo todo: o
// usuário saía da aba "Mascarar" e continuava editando a máscara sem querer,
// sem jeito de mexer no vídeo em si. Agora são dois modos que não se cruzam —
// quem decide é a sub-aba aberta (ver setModo, chamado pela shell).
//
// Guias (terços) aparecem só durante o gesto: enquadrar é mais fácil com
// referência, mas referência fixa polui o preview.

import * as act from '../core/actions.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function createFrameUI(stageEl, store, player) {
  if (!stageEl) return { destroy() {}, sync() {}, setAtivo() {} };

  const root = document.createElement('div');
  root.className = 'be-frameui';
  root.style.display = 'none';
  root.innerHTML =
    '<div class="be-frame-guias"></div>' +
    '<div class="be-frame-box" data-parte="corpo">' +
      '<span class="be-frame-h" data-parte="nw"></span>' +
      '<span class="be-frame-h" data-parte="ne"></span>' +
      '<span class="be-frame-h" data-parte="sw"></span>' +
      '<span class="be-frame-h" data-parte="se"></span>' +
    '</div>';
  stageEl.appendChild(root);
  const box = root.querySelector('.be-frame-box');
  const guias = root.querySelector('.be-frame-guias');

  let ativo = false;   // a shell liga/desliga conforme a sub-aba
  let gesto = null;

  // clip sob o playhead — é ele que a moldura representa
  function clipAtual() {
    const s = store.getState();
    if (s.selected_clip_id == null) return null;
    return s.clips.find((c) => c.id === s.selected_clip_id) || null;
  }

  function sync() {
    const clip = clipAtual();
    if (!ativo || !clip) { root.style.display = 'none'; return; }
    root.style.display = 'block';
    const r = stageEl.getBoundingClientRect();
    const esc = clip.scale ?? 1;
    const w = r.width * esc, h = r.height * esc;
    const cx = r.width / 2 + (clip.pos_x ?? 0) * r.width;
    const cy = r.height / 2 + (clip.pos_y ?? 0) * r.height;
    box.style.width = w + 'px';
    box.style.height = h + 'px';
    box.style.left = (cx - w / 2) + 'px';
    box.style.top = (cy - h / 2) + 'px';
  }

  function onDown(e) {
    const alvo = e.target.closest('[data-parte]');
    if (!ativo || !alvo) return;
    const clip = clipAtual();
    if (!clip) return;
    e.preventDefault(); e.stopPropagation();
    const r = stageEl.getBoundingClientRect();
    gesto = {
      parte: alvo.dataset.parte, x0: e.clientX, y0: e.clientY, r,
      clipId: clip.id,
      base: { scale: clip.scale ?? 1, pos_x: clip.pos_x ?? 0, pos_y: clip.pos_y ?? 0 },
      id: 'frame-' + clip.id + '-' + Date.now(),
    };
    guias.style.opacity = '1';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function onMove(e) {
    if (!gesto) return;
    const { parte, x0, y0, r, base, clipId, id } = gesto;
    const dx = (e.clientX - x0) / r.width;
    const dy = (e.clientY - y0) / r.height;
    let patch;
    if (parte === 'corpo') {
      patch = { pos_x: clamp(base.pos_x + dx, -1.5, 1.5), pos_y: clamp(base.pos_y + dy, -1.5, 1.5) };
    } else {
      // escala pelo canto: usa a diagonal, com sinal pelo canto agarrado
      const sinal = (parte.includes('e') ? 1 : -1) * dx + (parte.includes('s') ? 1 : -1) * dy;
      patch = { scale: clamp(base.scale + sinal, 0.1, 3) };
    }
    store.dispatch({ ...act.setClipTransform(clipId, patch), gestureId: id });
  }

  function onUp() {
    gesto = null;
    guias.style.opacity = '';
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  }

  root.addEventListener('pointerdown', onDown);
  const unsub = store.subscribe(sync);
  const offPlayer = player?.onUpdate ? player.onUpdate(sync) : null;
  const onResize = () => sync();
  window.addEventListener('resize', onResize);

  return {
    sync,
    /** a shell liga isto quando a sub-aba NÃO é "mascarar" */
    setAtivo(v) { ativo = !!v; sync(); },
    destroy() {
      unsub?.(); offPlayer?.();
      window.removeEventListener('resize', onResize);
      onUp();
      root.remove();
    },
  };
}
