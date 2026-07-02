// editor-v1/timeline/render.js
// Render declarativo do canvas: cada frame = clear + draw(state, layout,
// transport, fsm). Nunca mutacao incremental. Camadas pesadas (thumbnails,
// waveform) vem cacheadas dos modulos proprios como bitmaps.

import { METRICS, rulerTicks, timeToX } from './layout.js';

const COLORS = {
  bg: '#04101f',
  ruler: 'rgba(150,190,230,.45)',
  rulerMinor: 'rgba(150,190,230,.15)',
  clip: '#123c63',
  clipBorder: 'rgba(0,170,255,.35)',
  clipSelected: '#1a5c94',
  clipSelectedBorder: '#00aaff',
  ghost: 'rgba(90,110,140,.25)',
  ghostBorder: 'rgba(150,190,230,.25)',
  handle: '#00aaff',
  handleGrip: '#04101f',
  playhead: '#ff4757',
  snap: '#ffd32a',
  text: 'rgba(232,244,255,.9)',
  textBlock: '#7048b8',
  textBlockBorder: '#a97fee',
  audio: '#0d5c46',
  audioBorder: 'rgba(34,197,94,.5)',
};

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let raf = 0;
  let dirty = false;
  let lastArgs = null;

  function draw(args) {
    lastArgs = args;
    if (dirty) return;
    dirty = true;
    raf = requestAnimationFrame(() => {
      dirty = false;
      paint(ctx, canvas, lastArgs);
    });
  }

  function destroy() { cancelAnimationFrame(raf); }
  return { draw, destroy };
}

function paint(ctx, canvas, { layout, playhead, fsm, snapIndicator, thumbs, wave, dpr }) {
  const W = layout.vp.width, H = Math.max(layout.contentH, layout.vp.height);
  // resolucao fisica (retina)
  const scale = dpr || 1;
  if (canvas.width !== Math.round(W * scale) || canvas.height !== Math.round(H * scale)) {
    canvas.width = Math.round(W * scale);
    canvas.height = Math.round(H * scale);
  }
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  // ── regua ──
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.textBaseline = 'top';
  for (const tick of rulerTicks(layout)) {
    if (tick.x < -20 || tick.x > W + 20) continue;
    if (tick.major) {
      ctx.strokeStyle = COLORS.ruler;
      ctx.fillStyle = COLORS.ruler;
      line(ctx, tick.x, METRICS.RULER_H - 10, tick.x, METRICS.RULER_H);
      ctx.fillText(tick.label, tick.x + 3, 3);
    } else {
      ctx.strokeStyle = COLORS.rulerMinor;
      line(ctx, tick.x, METRICS.RULER_H - 5, tick.x, METRICS.RULER_H);
    }
  }

  // ── clips ativos ──
  for (const c of layout.clips) {
    if (c.x + c.w < 0 || c.x > W) continue;
    const isDragging = fsm?.name === 'dragging-clip' && fsm.clipId === c.clipId;
    roundRect(ctx, c.x, c.y, c.w, c.h, 6);
    ctx.fillStyle = c.selected ? COLORS.clipSelected : COLORS.clip;
    ctx.fill();

    // thumbnails (bitmap cacheado por clip)
    if (thumbs) {
      const strip = thumbs.getStrip(c.sourceIn, c.sourceOut, c.w, c.h);
      if (strip) {
        ctx.save();
        roundRect(ctx, c.x, c.y, c.w, c.h, 6);
        ctx.clip();
        ctx.globalAlpha = isDragging ? 0.55 : 0.85;
        ctx.drawImage(strip, c.x, c.y, c.w, c.h);
        ctx.globalAlpha = 1;
        ctx.restore();
      }
    }

    roundRect(ctx, c.x, c.y, c.w, c.h, 6);
    ctx.strokeStyle = c.selected ? COLORS.clipSelectedBorder : COLORS.clipBorder;
    ctx.lineWidth = c.selected ? 2 : 1;
    ctx.stroke();

    // trim handles do selecionado (CapCut-style: barras solidas nas pontas)
    if (c.selected) {
      drawHandle(ctx, c.x, c.y, c.h, 'left');
      drawHandle(ctx, c.x + c.w, c.y, c.h, 'right');
    }
    // duracao no canto
    if (c.w > 48) {
      ctx.fillStyle = 'rgba(232,244,255,.75)';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillText(`${(c.tEnd - c.tStart).toFixed(1)}s`, c.x + 6, c.y + c.h - 12);
    }
  }

  // ── ghosts (desativados) ──
  for (const g of layout.ghosts) {
    if (g.x + g.w < 0 || g.x > W) continue;
    roundRect(ctx, g.x, g.y, g.w, g.h, 6);
    ctx.fillStyle = COLORS.ghost;
    ctx.fill();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = COLORS.ghostBorder;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    if (g.w > 40) {
      ctx.fillStyle = 'rgba(232,244,255,.4)';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillText('↩ restaurar', g.x + 6, g.y + g.h / 2 - 4);
    }
  }

  // ── blocos de texto ──
  for (const t of layout.texts) {
    if (t.x + t.w < 0 || t.x > W) continue;
    roundRect(ctx, t.x, t.y, t.w, t.h, 4);
    ctx.fillStyle = COLORS.textBlock;
    ctx.fill();
    if (t.selected) {
      ctx.strokeStyle = COLORS.textBlockBorder;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (t.w > 30) {
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.font = '10px "Syne", sans-serif';
      const label = 'T ' + (t.content || '').slice(0, Math.max(1, Math.floor(t.w / 7)));
      ctx.fillText(label, t.x + 5, t.y + 7);
    }
  }

  // ── track de audio extra ──
  if (layout.audio) {
    const a = layout.audio;
    roundRect(ctx, a.x, a.y, a.w, a.h, 4);
    ctx.fillStyle = COLORS.audio;
    ctx.fill();
    ctx.strokeStyle = COLORS.audioBorder;
    ctx.lineWidth = 1;
    ctx.stroke();
    if (wave) {
      const bmp = wave.getBitmap(a.w, a.h);
      if (bmp) {
        ctx.save();
        roundRect(ctx, a.x, a.y, a.w, a.h, 4);
        ctx.clip();
        ctx.globalAlpha = 0.8;
        ctx.drawImage(bmp, a.x, a.y, a.w, a.h);
        ctx.globalAlpha = 1;
        ctx.restore();
      }
    }
    ctx.fillStyle = 'rgba(232,244,255,.7)';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillText('♪ áudio', a.x + 6, a.y + 5);
  }

  // ── linha de snap ──
  if (snapIndicator?.active && snapIndicator.t != null) {
    const x = timeToX(layout.vp, snapIndicator.t);
    ctx.strokeStyle = COLORS.snap;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    line(ctx, x, 0, x, H);
    ctx.setLineDash([]);
  }

  // ── playhead ──
  if (playhead != null) {
    const x = timeToX(layout.vp, playhead);
    ctx.strokeStyle = COLORS.playhead;
    ctx.lineWidth = 2;
    line(ctx, x, 0, x, H);
    // cabeca triangular
    ctx.fillStyle = COLORS.playhead;
    ctx.beginPath();
    ctx.moveTo(x - 6, 0);
    ctx.lineTo(x + 6, 0);
    ctx.lineTo(x, 9);
    ctx.closePath();
    ctx.fill();
  }
}

function drawHandle(ctx, x, y, h, side) {
  const w = METRICS.HANDLE_W;
  const rx = side === 'left' ? x - w / 2 : x - w / 2;
  roundRect(ctx, rx, y + 2, w, h - 4, 3);
  ctx.fillStyle = COLORS.handle;
  ctx.fill();
  // grip (2 tracinhos)
  ctx.strokeStyle = COLORS.handleGrip;
  ctx.lineWidth = 1.5;
  const cx = rx + w / 2;
  line(ctx, cx - 2, y + h * 0.35, cx - 2, y + h * 0.65);
  line(ctx, cx + 2, y + h * 0.35, cx + 2, y + h * 0.65);
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}
