// editor-v1/preview/overlay.js
// Overlay WYSIWYG de textos sobre o preview. Espelha EXATAMENTE o render do
// Railway: fontsize = TEXT_SIZE_PCT[size] * outputWidth, posicao centrada em
// (x_pct, y_pct). Drag com Pointer Events + setPointerCapture (FSM simples
// local: idle -> dragging; texto e 1 elemento DOM, nao canvas).

import { TEXT_SIZE_PCT } from '../core/schema.js';
import * as act from '../core/actions.js';
import { textsAt } from '../core/selectors.js';

export function createOverlay(container, store, player, onEditRequest) {
  let els = new Map(); // textId -> div
  let dragging = null; // { textId, pointerId, startX, startY, x0_pct, y0_pct, gestureId, moved }
  let gestureSeq = 1;

  container.style.position = 'absolute';
  container.style.inset = '0';
  container.style.overflow = 'hidden';
  // container NAO captura pointer — so os textos
  container.style.pointerEvents = 'none';

  function fontFamilyFor(font) {
    if (font === 'Bebas Neue') return '"Bebas Neue", "Anton", sans-serif';
    if (font === 'Oswald') return '"Oswald", "Anton", sans-serif';
    return '"Anton", sans-serif';
  }

  function render() {
    const state = store.getState();
    const t = player.getTime();
    const visible = textsAt(state, t);
    const box = container.getBoundingClientRect();
    if (box.width < 10) return;

    const seen = new Set();
    for (const txt of visible) {
      seen.add(txt.id);
      let el = els.get(txt.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'be-text-overlay';
        el.style.position = 'absolute';
        el.style.transform = 'translate(-50%, -50%)';
        el.style.whiteSpace = 'pre-wrap';
        el.style.textAlign = 'center';
        el.style.cursor = 'grab';
        el.style.userSelect = 'none';
        el.style.pointerEvents = 'auto';
        el.style.touchAction = 'none';
        el.style.maxWidth = '92%';
        el.style.lineHeight = '1.12';
        el.style.textShadow = '0 0 4px rgba(0,0,0,.9), 2px 2px 2px rgba(0,0,0,.8)';
        attachDrag(el, txt.id);
        container.appendChild(el);
        els.set(txt.id, el);
      }
      // WYSIWYG: fontsize proporcional a LARGURA do preview (Railway usa OUT_W)
      const fsPx = TEXT_SIZE_PCT[txt.size] * box.width;
      el.textContent = txt.content;
      el.style.left = (txt.x_pct * 100) + '%';
      el.style.top = (txt.y_pct * 100) + '%';
      el.style.fontFamily = fontFamilyFor(txt.font);
      el.style.fontSize = fsPx + 'px';
      el.style.color = txt.color;
      // traçado/borda da letra: espelha o borderw+bordercolor do drawtext.
      // Cor escolhível (txt.stroke), padrão preto. paint-order deixa o traçado
      // ATRÁS do preenchimento (não come a letra). box tira o traçado.
      const strokeW = Math.max(1, fsPx * 0.055);
      // tarja colorida atrás (CapCut) — espelha o box=1 do drawtext no export
      if (txt.box) {
        el.style.background = txt.box;
        el.style.padding = '0.04em 0.28em';
        el.style.borderRadius = '0.1em';
        el.style.textShadow = 'none';
        el.style.webkitTextStroke = '0';
      } else {
        el.style.background = 'transparent';
        el.style.padding = '0';
        el.style.borderRadius = '0';
        el.style.textShadow = 'none';
        el.style.webkitTextStroke = strokeW + 'px ' + (txt.stroke || '#000000');
        el.style.paintOrder = 'stroke fill';
      }
      // z compartilhado com as camadas de video (pip): lane maior = na frente.
      // Texto em lane menor que um overlay fica ATRAS do video dele (CapCut).
      el.style.zIndex = String(10 + (txt.lane || 4));
      el.style.outline = state.selected_text_id === txt.id ? '2px dashed rgba(169,127,238,.9)' : 'none';
      el.style.outlineOffset = '4px';
    }
    // remove os que sairam de cena
    for (const [id, el] of els) {
      if (!seen.has(id)) { el.remove(); els.delete(id); }
    }
  }

  function attachDrag(el, textId) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const state = store.getState();
      const txt = state.texts.find(x => x.id === textId);
      if (!txt) return;
      el.setPointerCapture(e.pointerId);
      dragging = {
        textId, pointerId: e.pointerId,
        startX: e.clientX, startY: e.clientY,
        x0: txt.x_pct, y0: txt.y_pct,
        gestureId: 'ov' + (gestureSeq++),
        moved: false,
      };
      el.style.cursor = 'grabbing';
      store.dispatch(act.selectText(textId));
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging || dragging.pointerId !== e.pointerId || dragging.textId !== textId) return;
      const box = container.getBoundingClientRect();
      const dx = (e.clientX - dragging.startX) / box.width;
      const dy = (e.clientY - dragging.startY) / box.height;
      if (!dragging.moved && Math.hypot(e.clientX - dragging.startX, e.clientY - dragging.startY) < 3) return;
      dragging.moved = true;
      const nx = dragging.x0 + dx, ny = dragging.y0 + dy;
      // "Aplicar a todas as legendas": arrastar UMA legenda reposiciona TODAS
      // (posição uniforme). Só vale pra legendas (caption) com a caixa marcada.
      const st = store.getState();
      const dragged = st.texts.find(x => x.id === textId);
      const applyAll = dragged?.caption && document.getElementById('beCapApplyAll')?.checked;
      const targets = applyAll ? st.texts.filter(x => x.caption).map(x => x.id) : [textId];
      for (const id of targets) {
        store.dispatch({ ...act.moveText(id, nx, ny), gestureId: dragging.gestureId });
      }
    });
    const finish = (e) => {
      if (!dragging || dragging.pointerId !== e.pointerId) return;
      const wasMoved = dragging.moved;
      dragging = null;
      el.style.cursor = 'grab';
      store.endGesture();
      if (!wasMoved && e.type === 'pointerup') {
        // clique simples: abre editor do texto
        onEditRequest?.(textId);
      }
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
  }

  const unsub = store.subscribe(render);
  const unsubPlayer = player.onUpdate(render);
  render();

  return {
    render,
    destroy() {
      unsub(); unsubPlayer();
      for (const [, el] of els) el.remove();
      els.clear();
    },
  };
}
