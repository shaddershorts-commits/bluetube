// editor-v1/preview/mask-ui.js
// Marcador da MÁSCARA no player: mostra onde ela está e deixa arrastar e
// redimensionar direto em cima do vídeo (2026-07-29).
//
// Antes só existiam sliders no painel — o usuário ajustava no escuro, número
// por número, sem ver a forma. Aqui o desenho é o controle.
//
// Convenções que casam com o resto do editor:
//   • o gesto inteiro vira UM passo de undo (gestureId por gesto)
//   • o círculo é CÍRCULO: um raio só, em pixels reais (o quadro é 9:16, então
//     largura e altura em % NÃO são a mesma coisa — foi a origem do "oval")
//   • enquanto arrasta, o preview segue o cursor; o commit é o próprio dispatch

import * as act from '../core/actions.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function createMaskUI(stageEl, store) {
  if (!stageEl) return { destroy() {}, sync() {} };

  const root = document.createElement('div');
  root.className = 'be-maskui';
  root.style.display = 'none';
  root.innerHTML =
    '<div class="be-mask-shape" data-parte="corpo">' +
      '<span class="be-mask-h" data-parte="nw"></span>' +
      '<span class="be-mask-h" data-parte="ne"></span>' +
      '<span class="be-mask-h" data-parte="sw"></span>' +
      '<span class="be-mask-h" data-parte="se"></span>' +
    '</div>';
  stageEl.appendChild(root);
  const shape = root.querySelector('.be-mask-shape');

  let gesto = null;

  function clipSelecionado() {
    const s = store.getState();
    if (s.selected_clip_id == null) return null;
    return s.clips.find((c) => c.id === s.selected_clip_id) || null;
  }

  function sync() {
    const clip = clipSelecionado();
    const m = clip?.mask;
    if (!m) { root.style.display = 'none'; return; }
    root.style.display = 'block';
    const box = stageEl.getBoundingClientRect();
    const circulo = m.shape === 'circle';
    // círculo: diâmetro em PIXELS a partir da largura — é o que o torna redondo
    const wpx = m.w_pct * box.width;
    const hpx = circulo ? wpx : m.h_pct * box.height;
    shape.style.width = wpx + 'px';
    shape.style.height = hpx + 'px';
    shape.style.left = (m.x_pct * box.width - wpx / 2) + 'px';
    shape.style.top = (m.y_pct * box.height - hpx / 2) + 'px';
    shape.style.borderRadius = circulo
      ? '50%'
      : (((m.radius || 0) / 100) * (Math.min(wpx, hpx) / 2)) + 'px';
    shape.dataset.forma = m.shape;
  }

  function onDown(e) {
    const alvo = e.target.closest('[data-parte]');
    if (!alvo) return;
    const clip = clipSelecionado();
    if (!clip?.mask) return;
    e.preventDefault(); e.stopPropagation();
    const box = stageEl.getBoundingClientRect();
    gesto = {
      parte: alvo.dataset.parte,
      x0: e.clientX, y0: e.clientY,
      m0: { ...clip.mask },
      box, clipId: clip.id,
      id: 'mask-' + clip.id + '-' + Math.round(e.clientX) + Math.round(e.clientY),
    };
    root.setPointerCapture?.(e.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function onMove(e) {
    if (!gesto) return;
    const { parte, x0, y0, m0, box, clipId, id } = gesto;
    const dx = (e.clientX - x0) / box.width;
    const dy = (e.clientY - y0) / box.height;
    let patch;
    if (parte === 'corpo') {
      patch = { x_pct: clamp(m0.x_pct + dx, 0, 1), y_pct: clamp(m0.y_pct + dy, 0, 1) };
    } else {
      // canto: cresce/encolhe a partir do CENTRO (previsível e simétrico —
      // ancorar no canto oposto faz a forma "fugir" do cursor no vídeo)
      const sinalX = parte.includes('e') ? 1 : -1;
      const sinalY = parte.includes('s') ? 1 : -1;
      const w = clamp(m0.w_pct + sinalX * dx * 2, 0.05, 1);
      patch = { w_pct: w };
      // no círculo a altura acompanha sozinha (um raio só)
      if (m0.shape !== 'circle') patch.h_pct = clamp(m0.h_pct + sinalY * dy * 2, 0.05, 1);
    }
    // gestureId igual durante o arraste inteiro = 1 passo de undo
    store.dispatch({ ...act.setClipMask(clipId, patch), gestureId: id });
  }

  function onUp() {
    gesto = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  }

  root.addEventListener('pointerdown', onDown);
  const unsub = store.subscribe(sync);
  const onResize = () => sync();
  window.addEventListener('resize', onResize);
  sync();

  return {
    sync,
    destroy() {
      unsub?.();
      window.removeEventListener('resize', onResize);
      onUp();
      root.remove();
    },
  };
}
