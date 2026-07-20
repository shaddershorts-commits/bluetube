// editor-v1/ui/timeline-controller.js
// Adapter DOM da timeline: UNICO dono dos pointer events do canvas.
// Converte eventos -> FSM pura -> executa effects. Nenhuma logica de negocio
// aqui: so traducao evento<->efeito.

import { computeLayout, zoomAt, zoomToFit, laneForY, METRICS } from '../timeline/layout.js';
import { hitTest } from '../timeline/hittest.js';
import { transition, idle, LONG_PRESS_MS } from '../timeline/interaction.js';
import { createRenderer, setImageRedraw } from '../timeline/render.js';
import { cutPoints, totalDuration } from '../core/selectors.js';
import { A } from '../core/actions.js';
import * as act from '../core/actions.js';
import * as clip from './clipboard.js';

export function createTimelineController({ canvas, store, player, onEditText, onOpenCompound }) {
  // width 0 = "ainda nao medido" -> zoomFit vira pendingFit ate o RO medir
  let vp = { pxPerSec: 40, scrollX: 0, width: 0, height: 200 };
  let fsm = idle();
  let snapIndicator = { active: false, t: null };
  let thumbs = null;
  let wave = null;
  let videoWave = null;
  let longPressTimer = 0;
  const pointers = new Map(); // pointerId -> {x,y}
  const renderer = createRenderer(canvas);
  setImageRedraw(() => draw()); // redesenha quando o thumbnail de imagem carrega

  // ── render pipeline ──
  function layoutNow() {
    return computeLayout(store.getState(), vp);
  }
  function ctxNow() {
    const state = store.getState();
    // teto de trim por clip: take extra e limitado pela PROPRIA midia
    const clipMaxOut = {};
    for (const c of state.clips || []) {
      if (c.media_id != null) {
        clipMaxOut[c.id] = (state.media || []).find(m => m.id === c.media_id)?.duration || Infinity;
      }
    }
    return {
      layout: layoutNow(),
      playhead: player.getTime(),
      cutPoints: cutPoints(state),
      snapEnabled: true,
      videoDuration: state.video?.duration || 0,
      clipMaxOut,
      // chaves da multi-selecao (pra detectar group drag)
      multiIds: new Set((state.multi_selected || []).map(x => x.type + ':' + x.id)),
    };
  }
  function draw() {
    renderer.draw({
      layout: layoutNow(),
      playhead: player.getTime(),
      fsm,
      snapIndicator,
      thumbs,
      wave,
      videoWave,
      dpr: Math.min(2, window.devicePixelRatio || 1),
    });
  }

  // ── effects executor ──
  function runEffects(effects) {
    for (const e of effects || []) {
      switch (e.do) {
        case 'dispatch': {
          let action = e.action;
          if (action.type === A.MOVE_CLIP) action = remapMove(action);
          store.dispatch(action);
          break;
        }
        case 'seek': player.seek(e.t); break;
        case 'select-clip': store.dispatch(act.selectClip(e.clipId)); break;
        case 'select-text': store.dispatch(act.selectText(e.textId)); break;
        case 'clear-selection': store.dispatch(act.selectClip(null)); break;
        case 'select-audio-clip': store.dispatch(act.selectAudioClip(e.audioId)); break;
        case 'select-overlay': store.dispatch(act.selectOverlay(e.overlayId)); break;
        case 'convert-to-overlay': {
          // altura do drop decide a lane (row existente ou nova acima do topo)
          const lane = e.y != null ? (laneForY(layoutNow(), e.y) ?? 1) : 1;
          store.dispatch(act.convertToOverlay(e.clipId, e.atT, lane));
          break;
        }
        case 'drop-lane': {
          const lane = laneForY(layoutNow(), e.y);
          if (lane == null) break; // soltou na main/audio: mantem a camada
          const st = store.getState();
          const atual = e.itemType === 'overlay'
            ? st.overlays.find(o => o.id === e.id)?.lane
            : st.texts.find(t => t.id === e.id)?.lane;
          if (atual !== lane) store.dispatch(act.setItemLane(e.itemType, e.id, lane));
          break;
        }
        case 'toggle-multi': store.dispatch(act.toggleMultiSelect(e.itemType, e.id)); break;
        case 'open-compound': onOpenCompound?.(e.compoundId); break;
        case 'zoom': vp = { ...vp, pxPerSec: e.pxPerSec, scrollX: clampScroll(e.scrollX, e.pxPerSec) }; draw(); break;
        case 'scroll': vp = { ...vp, scrollX: clampScroll(e.scrollX, vp.pxPerSec) }; draw(); break;
        case 'end-gesture': store.endGesture(); break;
        case 'abort-gesture': store.undo(); break;
        case 'set-cursor': canvas.style.cursor = e.cursor || 'default'; break;
        case 'show-snap': snapIndicator = { active: !!e.active, t: e.t ?? null }; draw(); break;
        case 'open-text-editor': onEditText?.(e.textId); break;
        case 'haptic': try { navigator.vibrate?.(30); } catch {} break;
        case 'autoscroll-edge': autoscroll(e.x); break;
        case 'clear-multi': store.dispatch(act.setMultiSelect([])); break;
        case 'marquee-live': case 'marquee-apply': {
          // seleciona tudo que INTERSECTA o retangulo (video/texto/audio/camada)
          store.dispatch(act.setMultiSelect(itemsInRect(layoutNow(), e.rect)));
          break;
        }
      }
    }
  }

  /** FSM entrega visIndex entre clips ATIVOS (sem o arrastado). Converte pro
   *  indice real do array state.clips. */
  function remapMove(action) {
    const state = store.getState();
    const dragged = state.clips.find(c => c.id === action.clipId);
    if (!dragged) return action;
    const activesExcl = state.clips.filter(c => c.active !== false && c.id !== action.clipId);
    const visIndex = Math.min(action.toIndex, activesExcl.length);
    let arrayIndex;
    if (visIndex >= activesExcl.length) {
      // depois do ultimo ativo
      const last = activesExcl[activesExcl.length - 1];
      arrayIndex = last ? state.clips.filter(c => c.id !== action.clipId).indexOf(last) + 1 : 0;
    } else {
      const target = activesExcl[visIndex];
      arrayIndex = state.clips.filter(c => c.id !== action.clipId).indexOf(target);
    }
    // reducer faz splice(from,1) + splice(to,0): to é indice no array pos-remocao
    return { ...action, toIndex: arrayIndex };
  }

  /** Itens do layout que intersectam o retangulo do marquee. */
  function itemsInRect(layout, r) {
    const hits = [];
    const inter = (b) => b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y;
    for (const c of layout.clips) if (inter(c)) hits.push({ type: 'clip', id: c.clipId });
    for (const t of layout.texts) if (inter(t)) hits.push({ type: 'text', id: t.textId });
    for (const a of layout.audioItems || []) if (inter(a)) hits.push({ type: 'audio', id: a.audioId });
    for (const o of layout.overlayItems || []) if (inter(o)) hits.push({ type: 'overlay', id: o.overlayId });
    return hits;
  }

  function autoscroll(x) {
    const EDGE = 40, SPEED = 14;
    if (x < EDGE) { vp = { ...vp, scrollX: clampScroll(vp.scrollX - SPEED, vp.pxPerSec) }; draw(); }
    else if (x > vp.width - EDGE) { vp = { ...vp, scrollX: clampScroll(vp.scrollX + SPEED, vp.pxPerSec) }; draw(); }
  }

  /** Scroll nunca deixa o conteudo 100% fora da tela: clamp entre -PAD_LEFT
   *  e (fim do conteudo - 20% da largura visivel). Ghosts contam no range. */
  function clampScroll(scrollX, pxPerSec) {
    const state = store.getState();
    const total = totalDuration(state);
    const inactive = (state.clips || []).filter(c => c.active === false)
      .reduce((a, c) => a + (c.source_out - c.source_in) + 0.5, 0);
    const contentEnd = (total + (inactive ? 1 + inactive : 0)) * pxPerSec;
    const maxScroll = Math.max(-METRICS.PAD_LEFT, contentEnd - vp.width * 0.2);
    return Math.min(maxScroll, Math.max(-METRICS.PAD_LEFT, scrollX));
  }

  // ── pointer events (unico listener) ──
  function evFrom(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, touch: e.pointerType === 'touch' };
  }

  function step(ev) {
    const r = transition(fsm, ev, ctxNow());
    fsm = r.next;
    runEffects(r.effects);
    draw();
  }

  // long-press em touch dispara contextmenu nativo -> cancelaria o gesto.
  // Botao DIREITO em clip de video: menu CapCut (Copiar/Cortar/Excluir/
  // Compor/Editar>Congelar,Reverso,Espelhar) — user 2026-07-20.
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const p = evFrom(e);
    const hit = hitTest(layoutNow(), p.x, p.y);
    if (hit.type === 'clip-body') {
      store.dispatch(act.selectClip(hit.clipId)); // menu age no clip clicado
      draw();
      showClipMenu(e.clientX, e.clientY, hit);
    } else if (hit.type === 'overlay-body') {
      store.dispatch(act.selectOverlay(hit.overlayId));
      draw();
      showOverlayMenu(e.clientX, e.clientY, hit);
    } else if (hit.type === 'audio-body') {
      store.dispatch(act.selectAudioClip(hit.audioId));
      draw();
      showAudioMenu(e.clientX, e.clientY, hit);
    }
  });

  // menu da CAMADA (overlay) — mesma editabilidade que o clip
  function showOverlayMenu(x, y, hit) {
    const st = store.getState();
    const ov = st.overlays.find(o => o.id === hit.overlayId);
    buildMenu(x, y, [
      { label: 'Copiar', hint: 'Ctrl C', fn: () => clip.copySel(store) },
      { label: 'Cortar', hint: 'Ctrl X', fn: () => clip.cutSel(store) },
      { label: 'Excluir', hint: '⌫', fn: () => store.dispatch(act.deleteOverlay(hit.overlayId)) },
      { sep: true },
      ...(ov?.kind === 'image' ? [
        { label: '↺ Resetar giro', fn: () => store.dispatch(act.setOverlayTransform(hit.overlayId, { rotation: 0 })) },
      ] : []),
      { label: 'Trazer pra frente', fn: () => bumpLane(hit.overlayId, +1) },
      { label: 'Mandar pra trás', fn: () => bumpLane(hit.overlayId, -1) },
    ]);
  }
  function bumpLane(id, dir) {
    const o = store.getState().overlays.find(x => x.id === id);
    if (o) store.dispatch(act.setItemLane('overlay', id, (o.lane || 1) + dir));
  }

  // menu do ÁUDIO
  function showAudioMenu(x, y, hit) {
    buildMenu(x, y, [
      { label: 'Copiar', hint: 'Ctrl C', fn: () => clip.copySel(store) },
      { label: 'Cortar', hint: 'Ctrl X', fn: () => clip.cutSel(store) },
      { label: 'Dividir no cursor', hint: 'Ctrl B', fn: () => store.dispatch(act.splitAudioAt(player.getTime())) },
      { label: 'Excluir', hint: '⌫', fn: () => store.dispatch(act.deleteAudioClip(hit.audioId)) },
    ]);
  }

  function showClipMenu(x, y, hit) {
    const atT = player.getTime();
    const items = [
      { label: 'Copiar', hint: 'Ctrl C', fn: () => clip.copySel(store) },
      { label: 'Cortar', hint: 'Ctrl X', fn: () => clip.cutSel(store) },
      { label: 'Copiar/colar atributos', sub: [
        { label: 'Copiar atributos', fn: () => clip.copyAttrs(store) },
        { label: 'Colar atributos', disabled: !clip.hasAttrs(), fn: () => clip.pasteAttrs(store) },
      ] },
      { label: 'Excluir', hint: '⌫', fn: () => store.dispatch(act.deleteClip(hit.clipId)) },
      { sep: true },
      { label: '⧉ Criar clipe composto', fn: () => store.dispatch(act.createCompound()) },
      ...(hit.compoundId ? [{ label: '⧉ Desfazer clipe composto', fn: () => store.dispatch(act.ungroupCompound(hit.compoundId)) }] : []),
      { label: 'Editar', sub: [
        { label: '❄ Congelar', fn: () => store.dispatch(act.freezeFrame(hit.clipId, atT)) },
        { label: '◀ Reverso', fn: () => toggleFx(hit.clipId, 'reversed') },
        { label: '⇄ Espelhar', fn: () => toggleFx(hit.clipId, 'mirrored') },
      ] },
    ];
    buildMenu(x, y, items);
  }

  function toggleFx(clipId, key) {
    const c = store.getState().clips.find(k => k.id === clipId);
    if (c) store.dispatch(act.setClipFx(clipId, { [key]: !c[key] }));
  }

  function buildMenu(x, y, items, parent) {
    if (!parent) document.getElementById('beCtxMenu')?.remove();
    const m = document.createElement('div');
    m.className = 'be-ctx-menu';
    if (!parent) m.id = 'beCtxMenu';
    m.style.cssText = 'position:fixed;z-index:1000;background:#0b1526;border:1px solid #1e3a5f;' +
      'border-radius:8px;padding:4px;box-shadow:0 10px 30px rgba(0,0,0,.6);min-width:190px;' +
      'font:13px Syne,system-ui,sans-serif';
    for (const it of items) {
      if (it.sep) {
        const s = document.createElement('div');
        s.style.cssText = 'height:1px;background:#1e3a5f;margin:4px 6px;';
        m.appendChild(s); continue;
      }
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:12px;justify-content:space-between;' +
        'padding:7px 10px;border-radius:6px;cursor:' + (it.disabled ? 'default' : 'pointer') +
        ';color:' + (it.disabled ? '#5b6b82' : '#dfe9ff') + ';';
      const left = document.createElement('span'); left.textContent = it.label; row.appendChild(left);
      const right = document.createElement('span');
      right.style.cssText = 'color:#5b7599;font-size:11px;';
      right.textContent = it.sub ? '›' : (it.hint || '');
      row.appendChild(right);
      let subMenu = null;
      if (!it.disabled) {
        row.onmouseenter = () => {
          row.style.background = 'rgba(0,170,255,.15)';
          m.querySelectorAll(':scope > .be-ctx-menu').forEach(el => el.remove());
          if (it.sub) {
            const r = row.getBoundingClientRect();
            subMenu = buildMenu(r.right - 4, r.top - 4, it.sub, m);
            m.appendChild(subMenu);
          }
        };
        row.onmouseleave = () => { row.style.background = ''; };
        if (it.fn) row.onclick = () => { it.fn(); closeMenu(); };
      }
      m.appendChild(row);
    }
    m.style.left = x + 'px'; m.style.top = y + 'px';
    if (!parent) {
      document.body.appendChild(m);
      // reposiciona se sair da tela
      requestAnimationFrame(() => {
        const r = m.getBoundingClientRect();
        if (r.right > innerWidth) m.style.left = (x - r.width) + 'px';
        if (r.bottom > innerHeight) m.style.top = Math.max(4, innerHeight - r.height - 4) + 'px';
      });
      setTimeout(() => {
        const close = (ev) => { if (!m.contains(ev.target)) closeMenu(); };
        window.addEventListener('pointerdown', close, true);
        m._close = () => window.removeEventListener('pointerdown', close, true);
      }, 0);
    }
    return m;
  }
  function closeMenu() {
    const m = document.getElementById('beCtxMenu');
    if (m) { m._close?.(); m.remove(); }
  }

  // deteccao de DUPLO-clique propria: e.detail no pointerdown e nao-confiavel
  // (varia entre browsers, as vezes fica 0). Rastreia tempo+posicao do down.
  let lastDownT = 0, lastDownX = -999, lastDownY = -999;
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const p = evFrom(e);
    pointers.set(e.pointerId, p);

    if (pointers.size === 2) {
      // segundo dedo -> pinch
      const [p1, p2] = [...pointers.values()];
      step({ kind: 'second-down', x: p.x, y: p.y, d: dist(p1, p2), cx: (p1.x + p2.x) / 2 });
      return;
    }
    const now = performance.now();
    const isDouble = (now - lastDownT < 350) && Math.hypot(p.x - lastDownX, p.y - lastDownY) < 12;
    lastDownT = now; lastDownX = p.x; lastDownY = p.y;
    const hit = hitTest(layoutNow(), p.x, p.y, { touch: p.touch });
    clearTimeout(longPressTimer);
    if (p.touch) {
      longPressTimer = setTimeout(() => step({ kind: 'longpress' }), LONG_PRESS_MS);
    }
    step({ kind: 'down', ...p, hit, button: e.button, detail: e.detail, double: isDouble, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey || e.metaKey });
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) {
      // hover: cursor affordance
      if (fsm.name === 'idle') {
        const p = evFrom(e);
        const hit = hitTest(layoutNow(), p.x, p.y);
        canvas.style.cursor =
          hit.type === 'trim-in' || hit.type === 'trim-out' ? 'ew-resize' :
          hit.type === 'clip-body' || hit.type === 'text-block' ? 'grab' :
          hit.type === 'ruler' ? 'col-resize' : 'default';
      }
      return;
    }
    const p = evFrom(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 2 && fsm.name === 'pinching') {
      const [p1, p2] = [...pointers.values()];
      step({ kind: 'pinch-move', d: dist(p1, p2), cx: (p1.x + p2.x) / 2 });
      return;
    }
    // movimento cancela long-press pendente se passou threshold
    step({ kind: 'move', ...p, shiftKey: e.shiftKey });
  });

  function release(e, kind) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    clearTimeout(longPressTimer);
    const p = evFrom(e);
    if (fsm.name === 'pinching' && pointers.size === 1) {
      const rest = [...pointers.values()][0];
      step({ kind: 'pinch-end', x: rest.x, y: rest.y });
      return;
    }
    step({ kind, ...p });
  }
  canvas.addEventListener('pointerup', (e) => release(e, 'up'));
  canvas.addEventListener('pointercancel', (e) => release(e, 'cancel'));

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = evFrom(e);
    step({ kind: 'wheel', ...p, deltaY: e.deltaY, deltaX: e.deltaX, ctrlKey: e.ctrlKey || e.metaKey });
  }, { passive: false });

  canvas.addEventListener('dblclick', (e) => {
    const p = evFrom(e);
    const hit = hitTest(layoutNow(), p.x, p.y);
    step({ kind: 'dblclick', ...p, hit });
  });

  // Esc global (quando canvas focado ou nao — gesto ativo deve abortar sempre)
  const escHandler = (e) => { if (e.key === 'Escape' && fsm.name !== 'idle') step({ kind: 'esc' }); };
  window.addEventListener('keydown', escHandler);

  // ── resize ──
  // pendingFit: zoomFit chamado antes do canvas ter medida real (parent era
  // display:none) fica pendente e executa na primeira medicao valida do RO.
  let pendingFit = false;
  function doFit() {
    const z = zoomToFit(store.getState(), vp.width);
    vp = { ...vp, ...z };
    draw();
  }
  const ro = new ResizeObserver((entries) => {
    const r = entries[0].contentRect;
    const widthChanged = Math.abs(r.width - vp.width) > 1;
    vp = { ...vp, width: r.width, height: r.height };
    if (pendingFit && r.width > 50) {
      pendingFit = false;
      doFit();
      return;
    }
    if (widthChanged) vp = { ...vp, scrollX: clampScroll(vp.scrollX, vp.pxPerSec) };
    draw();
  });
  ro.observe(canvas.parentElement || canvas);

  // ── subscriptions ──
  const unsubStore = store.subscribe(() => draw());
  const unsubPlayer = player.onUpdate(() => draw());

  draw();

  return {
    draw,
    getViewport: () => vp,
    getLayout: () => layoutNow(),  // E2E: coords reais (auto-altura muda posições)
    zoomFit() {
      if (vp.width < 50) { pendingFit = true; return; }
      doFit();
    },
    zoomBy(factor) {
      const z = zoomAt(vp, factor, vp.width / 2);
      vp = { ...vp, pxPerSec: z.pxPerSec, scrollX: clampScroll(z.scrollX, z.pxPerSec) };
      draw();
    },
    /** playhead sempre visivel (chamado no play) */
    followPlayhead() {
      const x = METRICS.PAD_LEFT + player.getTime() * vp.pxPerSec - vp.scrollX;
      if (x < 0 || x > vp.width - 60) {
        vp = { ...vp, scrollX: Math.max(-METRICS.PAD_LEFT, player.getTime() * vp.pxPerSec - vp.width * 0.3) };
        draw();
      }
    },
    setThumbs(t) { thumbs = t; draw(); },
    setWave(w) { wave = w; draw(); },
    setVideoWave(w) { videoWave = w; draw(); },
    getFsmName: () => fsm.name,
    destroy() {
      renderer.destroy();
      ro.disconnect();
      unsubStore(); unsubPlayer();
      window.removeEventListener('keydown', escHandler);
      clearTimeout(longPressTimer);
    },
  };
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
