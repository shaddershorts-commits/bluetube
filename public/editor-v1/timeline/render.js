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

// cache de <img> das camadas de imagem (thumbnail na timeline). Só pra
// DISPLAY (canvas pode ficar "tainted" — nunca lemos os pixels de volta).
const _imgCache = new Map(); // url -> { img, loaded }
let _imgRedraw = null;
export function setImageRedraw(fn) { _imgRedraw = fn; }
function imageThumb(url) {
  if (!url) return null;
  let e = _imgCache.get(url);
  if (!e) {
    const img = new Image();
    e = { img, loaded: false };
    img.onload = () => { e.loaded = true; _imgRedraw?.(); };
    img.onerror = () => {};
    img.src = url;
    _imgCache.set(url, e);
  }
  return e.loaded ? e.img : null;
}

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

function paint(ctx, canvas, { layout, playhead, fsm, snapIndicator, thumbs, wave, videoWave, dpr }) {
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

  // ── rows de camada (fundos sutis; topo = frente no video) ──
  for (const r of layout.laneRows || []) {
    ctx.fillStyle = 'rgba(120,150,220,.05)';
    ctx.fillRect(0, r.y, W, r.h);
  }
  // rows de ÁUDIO (inclui lanes extras vazias criadas pelo menu — alvo de drop)
  for (const r of layout.audioLaneRows || []) {
    ctx.fillStyle = 'rgba(34,197,94,.04)';
    ctx.fillRect(0, r.y, W, r.h);
  }

  // ── clips ativos ──
  for (const c of layout.clips) {
    const isDragging = fsm?.name === 'dragging-clip' && fsm.clipId === c.clipId;
    const isTrimming = fsm?.name === 'trimming' && fsm.clipId === c.clipId;

    // Preview de trim (estilo CapCut): a borda arrastada segue o cursor.
    // Nada foi comitado no store ainda — só geometria visual deste frame.
    const isFrozenResize = fsm?.name === 'resizing-frozen' && fsm.clipId === c.clipId;
    let cx0 = c.x, cw = c.w, srcIn = c.sourceIn, srcOut = c.sourceOut;
    if (isTrimming) {
      const pps = layout.vp.pxPerSec;
      if (fsm.edge === 'in') {
        const delta = fsm.previewSource - fsm.sourceIn0; // >0 = encolhe pela esquerda
        cx0 = c.x + delta * pps;
        cw = c.w - delta * pps;
        srcIn = fsm.previewSource;
      } else {
        const delta = fsm.previewSource - fsm.sourceOut0;
        cw = c.w + delta * pps;
        srcOut = fsm.previewSource;
      }
    }
    if (isFrozenResize) {
      const pps = layout.vp.pxPerSec;
      if (fsm.edge === 'out') cw = fsm.previewDur * pps;
      else { cx0 = c.x + (c.w - fsm.previewDur * pps); cw = fsm.previewDur * pps; }
    }
    if (cx0 + cw < 0 || cx0 > W) continue;

    roundRect(ctx, cx0, c.y, cw, c.h, 6);
    ctx.fillStyle = c.selected ? COLORS.clipSelected : COLORS.clip;
    ctx.fill();

    // CapCut-style: thumbnails em cima + strip de waveform do audio DO VIDEO
    // embaixo. Cada clip usa a miniatura/waveform DA SUA fonte (principal OU
    // take importado) — lookup por c.mediaId (null = 'main').
    const th = thumbs?.get ? thumbs.get(c.mediaId) : thumbs;
    const vw = videoWave?.get ? videoWave.get(c.mediaId) : videoWave;
    const waveH = (layout.clipWaveform && vw?.ready?.()) ? 14 : 0;
    const thumbH = c.h - waveH;

    if (th) {
      const strip = th.getStrip(srcIn, srcOut, cw, thumbH);
      if (strip) {
        ctx.save();
        roundRect(ctx, cx0, c.y, cw, c.h, 6);
        ctx.clip();
        ctx.globalAlpha = isDragging ? 0.55 : 0.85;
        ctx.drawImage(strip, cx0, c.y, cw, thumbH);
        ctx.globalAlpha = 1;
        ctx.restore();
      }
    }
    if (waveH > 0) {
      const wbmp = vw.getSlice(srcIn, srcOut, cw, waveH);
      if (wbmp) {
        ctx.save();
        roundRect(ctx, cx0, c.y, cw, c.h, 6);
        ctx.clip();
        ctx.fillStyle = 'rgba(2, 20, 12, .85)';
        ctx.fillRect(cx0, c.y + thumbH, cw, waveH);
        ctx.drawImage(wbmp, cx0, c.y + thumbH, cw, waveH);
        ctx.restore();
      }
    }

    if (c.mediaId != null) {
      // take importado: tag do nome no topo (a miniatura já mostra os frames)
      ctx.save();
      roundRect(ctx, cx0, c.y, cw, c.h, 6);
      ctx.clip();
      ctx.fillStyle = 'rgba(10, 40, 30, .7)';
      ctx.fillRect(cx0, c.y, cw, 13);
      ctx.fillStyle = '#dff5ec';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillText('🎞 ' + (c.mediaName || 'take'), cx0 + 5, c.y + 3);
      ctx.restore();
    }
    if (c.frozen || c.reversed || c.mirrored) {
      // badges dos efeitos do menu Editar
      const badges = [];
      if (c.frozen) badges.push('❄ congelado');
      if (c.reversed) badges.push('◀ reverso');
      if (c.mirrored) badges.push('⇄ espelho');
      ctx.save();
      roundRect(ctx, cx0, c.y, cw, c.h, 6);
      ctx.clip();
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.fillRect(cx0, c.y + c.h - 13, cw, 13);
      ctx.fillStyle = '#cfe8ff';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillText(badges.join('  '), cx0 + 5, c.y + c.h - 11);
      ctx.restore();
    }
    if (c.isCompound) {
      // faixa de titulo do composto (CapCut)
      ctx.save();
      roundRect(ctx, cx0, c.y, cw, c.h, 6);
      ctx.clip();
      ctx.fillStyle = 'rgba(112, 72, 184, .55)';
      ctx.fillRect(cx0, c.y, cw, 14);
      ctx.fillStyle = '#fff';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillText('⧉ ' + (c.compoundName || 'Clipe composto') + ' (2x clique abre)', cx0 + 6, c.y + 3);
      ctx.restore();
    }
    roundRect(ctx, cx0, c.y, cw, c.h, 6);
    ctx.strokeStyle = c.multi ? COLORS.snap : (c.selected ? COLORS.clipSelectedBorder : COLORS.clipBorder);
    ctx.lineWidth = (c.selected || c.multi) ? 2 : 1;
    ctx.stroke();

    // trim handles do selecionado (compound nao trima no v1)
    if (c.selected && !c.isCompound) {
      drawHandle(ctx, cx0, c.y, c.h, 'left');
      drawHandle(ctx, cx0 + cw, c.y, c.h, 'right');
    }
    // duracao no canto (durante trim mostra a duracao do preview)
    if (cw > 48) {
      const dur = isTrimming ? (srcOut - srcIn) : (c.tEnd - c.tStart);
      ctx.fillStyle = 'rgba(232,244,255,.75)';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillText(`${dur.toFixed(1)}s`, cx0 + 6, c.y + c.h - 12);
    }
  }

  // ── FANTASMA da nova camada (arrastando clip pra cima pra criar overlay) ──
  if (fsm?.name === 'dragging-clip' && fsm.lifting && fsm.liftX != null) {
    const c = layout.clips.find(k => k.clipId === fsm.clipId);
    const gw = c ? c.w : 80;
    const gx = fsm.liftX - gw / 2;
    // encaixa na row de lane sob o cursor (ou logo acima do topo)
    const rows = layout.laneRows || [];
    let gy = fsm.liftY - (c ? c.h : 40) / 2;
    let laneLabel = 'nova camada';
    for (const r of rows) {
      if (fsm.liftY >= r.y - 6 && fsm.liftY <= r.y + r.h + 6) { gy = r.y; laneLabel = 'camada ' + r.lane; break; }
    }
    ctx.save();
    ctx.globalAlpha = 0.8;
    roundRect(ctx, gx, gy, gw, (c ? c.h : 40), 6);
    ctx.fillStyle = 'rgba(120, 90, 200, .5)';
    ctx.fill();
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = '#a97fee';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillText('⬆ ' + laneLabel, gx + 6, gy + 5);
    ctx.restore();
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
    if (t.selected || t.multi) {
      ctx.strokeStyle = t.multi ? COLORS.snap : COLORS.textBlockBorder;
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

  // ── camadas overlay (acima da principal — CapCut) ──
  for (const o of layout.overlayItems || []) {
    ctx.globalAlpha = o.hidden ? 0.35 : 1; // camada com olhinho fechado
    let ox = o.x, ow = o.w, sI = o.srcIn, sO = o.srcOut;
    if (fsm?.name === 'trimming-overlay' && fsm.overlayId === o.overlayId) {
      const pps = layout.vp.pxPerSec;
      if (fsm.edge === 'in') {
        const d = fsm.preview - fsm.tStart0;
        ox = o.x + d * pps; ow = o.w - d * pps; sI = fsm.srcIn0 + d;
      } else {
        const d = fsm.preview - fsm.tEnd0;
        ow = o.w + d * pps; sO = fsm.srcOut0 + d;
      }
    }
    if (fsm?.name === 'dragging-overlay' && fsm.overlayId === o.overlayId) {
      ox = o.x + (fsm.previewStart - o.tStart) * layout.vp.pxPerSec;
    }
    if (ox + ow < 0 || ox > W) continue;
    roundRect(ctx, ox, o.y, ow, o.h, 5);
    ctx.fillStyle = o.isImage ? '#2a3b63' : '#3b2a63';
    ctx.fill();
    if (o.isImage) {
      // camada de IMAGEM: thumbnail do PNG (cacheado por url)
      const bmp = imageThumb(o.imageUrl);
      if (bmp) {
        ctx.save(); roundRect(ctx, ox, o.y, ow, o.h, 5); ctx.clip();
        // desenha a imagem repetida/contida (mostra que é sticker)
        const iw = Math.min(ow, o.h * (bmp.width / bmp.height || 1));
        ctx.globalAlpha = 0.9; ctx.drawImage(bmp, ox + 2, o.y + 2, Math.max(8, iw - 4), o.h - 4);
        ctx.globalAlpha = 1; ctx.restore();
      }
    } else {
      const ovTh = thumbs?.get ? thumbs.get(o.mediaId) : thumbs;
      if (ovTh) {
        const strip = ovTh.getStrip(sI, sO, ow, o.h);
        if (strip) {
          ctx.save(); roundRect(ctx, ox, o.y, ow, o.h, 5); ctx.clip();
          ctx.globalAlpha = 0.8; ctx.drawImage(strip, ox, o.y, ow, o.h);
          ctx.globalAlpha = 1; ctx.restore();
        }
      }
    }
    roundRect(ctx, ox, o.y, ow, o.h, 5);
    ctx.strokeStyle = o.multi ? COLORS.snap : (o.selected ? '#a97fee' : 'rgba(169,127,238,.45)');
    ctx.lineWidth = (o.selected || o.multi) ? 2 : 1;
    ctx.stroke();
    if (o.selected) {
      drawHandle(ctx, ox, o.y, o.h, 'left');
      drawHandle(ctx, ox + ow, o.y, o.h, 'right');
    }
    if (ow > 50) {
      ctx.fillStyle = 'rgba(232,244,255,.8)';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillText((o.isImage ? '🖼 imagem ' : '⧉ camada ') + (o.lane || 1), ox + 6, o.y + 3);
    }
  }
  ctx.globalAlpha = 1;

  // ── clips de audio (cada um editavel; preview de gesto igual video) ──
  for (const a of layout.audioItems || []) {
    ctx.globalAlpha = a.hidden ? 0.35 : 1; // lane de áudio com olhinho fechado
    let ax = a.x, aw = a.w, srcI = a.srcIn, srcO = a.srcOut;
    if (fsm?.name === 'trimming-audio' && fsm.audioId === a.audioId) {
      const pps = layout.vp.pxPerSec;
      if (fsm.edge === 'in') {
        const d = fsm.preview - fsm.tStart0;
        ax = a.x + d * pps; aw = a.w - d * pps; srcI = fsm.srcIn0 + d;
      } else {
        const d = fsm.preview - fsm.tEnd0;
        aw = a.w + d * pps; srcO = fsm.srcOut0 + d;
      }
    }
    if (fsm?.name === 'dragging-audio' && fsm.audioId === a.audioId) {
      ax = a.x + (fsm.previewStart - a.tStart) * layout.vp.pxPerSec;
    }
    if (ax + aw < 0 || ax > W) continue;

    roundRect(ctx, ax, a.y, aw, a.h, 4);
    ctx.fillStyle = COLORS.audio;
    ctx.fill();
    ctx.strokeStyle = a.multi ? COLORS.snap : (a.selected ? '#22c55e' : COLORS.audioBorder);
    ctx.lineWidth = (a.selected || a.multi) ? 2 : 1;
    ctx.stroke();

    ctx.save();
    roundRect(ctx, ax, a.y, aw, a.h, 4);
    ctx.clip();
    const wf = a.kind === 'video' ? videoWave : wave?.get?.(a.url);
    if (wf?.ready?.()) {
      const bmp = wf.getSlice(srcI, srcO, aw, a.h);
      if (bmp) {
        ctx.globalAlpha = 0.85;
        // amplitude adaptativa ao volume (CapCut): baixar o volume encolhe as
        // ondas visualmente. O waveform é desenhado centralizado (mid = h/2),
        // então escalar a altura mantém a onda centrada. vol>1 = ondas maiores
        // (o clip() já corta o excesso). vol=0 (mudo) = nada.
        const vol = a.volume == null ? 1 : Math.max(0, Math.min(2, a.volume));
        if (vol === 1) {
          ctx.drawImage(bmp, ax, a.y, aw, a.h);
        } else if (vol > 0) {
          const dh = a.h * vol;
          ctx.drawImage(bmp, ax, a.y + (a.h - dh) / 2, aw, dh);
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    if (a.selected) {
      drawHandle(ctx, ax, a.y, a.h, 'left');
      drawHandle(ctx, ax + aw, a.y, a.h, 'right');
    }
    if (aw > 60) {
      // rótulo CONFINADO à própria faixa: nome longo (ex. ElevenLabs_...) não
      // pinta por cima dos clips vizinhos ao cortar (user 2026-07-23)
      ctx.save();
      ctx.beginPath();
      ctx.rect(ax + 2, a.y, Math.max(0, aw - 10), a.h);
      ctx.clip();
      ctx.fillStyle = 'rgba(232,244,255,.75)';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillText(a.label, ax + 6, a.y + 3);
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;

  // ── marquee (seletor retangular no vazio) ──
  if (fsm?.name === 'marquee') {
    const mx = Math.min(fsm.x0, fsm.x1), my = Math.min(fsm.y0, fsm.y1);
    const mw = Math.abs(fsm.x1 - fsm.x0), mh = Math.abs(fsm.y1 - fsm.y0);
    ctx.fillStyle = 'rgba(0,170,255,.12)';
    ctx.fillRect(mx, my, mw, mh);
    ctx.strokeStyle = 'rgba(0,170,255,.7)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(mx, my, mw, mh);
    ctx.setLineDash([]);
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
