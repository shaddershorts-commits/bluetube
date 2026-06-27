/* ═══════════════════════════════════════════════════════════════════════════
   timeline.js — Canvas timeline visual + handles trim + waveform + playhead
   ═══════════════════════════════════════════════════════════════════════════
   Camadas (de baixo pra cima):
     1. Background
     2. Régua de tempo (mm:ss.ff)
     3. Faixa de vídeo (clipe colorido) com waveform sobreposta
     4. Região fora do trim escurecida
     5. Handles de trim (in/out) touch-friendly
     6. Playhead (linha vertical sincronizada com video.currentTime)

   Input:
     - Mouse: down/move/up em handles, click na ruler/track pra seek
     - Touch: touchstart/move/end equivalentes (handles 48×48 px touch area)
     - Wheel: zoom (Ctrl+scroll) ou pan (scroll horizontal)

   Coord system:
     - canvasW pixels representam (durationSec / zoomFactor) segundos
     - panOffsetSec desloca o início visível
     - secToPx(t) = (t - panOffsetSec) / pxPerSec
     - pxToSec(x) = panOffsetSec + x * pxPerSec

   Sincroniza com state via BEState.subscribe e BEState.patch.
   ═══════════════════════════════════════════════════════════════════════════ */

window.BETimeline = (function() {
  'use strict';

  // ─── Constantes visuais ────────────────────────────────────────────────
  const RULER_H = 20;
  const TRACK_PAD_TOP = 28;
  const TRACK_H = 64;
  const HANDLE_W = 14;
  const HANDLE_TOUCH = 44;       // area de toque (>= Apple HIG 44px)
  const PLAYHEAD_W = 2;
  const FRAME_RATE = 30;         // frames/seg pra snap

  // ─── Cores (puxa CSS vars) ──────────────────────────────────────────────
  function getCss(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch(e) { return fallback; }
  }
  const COLORS = {
    bg: '#050810',
    ruler: 'rgba(150,190,230,0.55)',
    rulerMajor: 'rgba(232,244,255,0.78)',
    tickLine: 'rgba(0,170,255,0.15)',
    track: 'rgba(0,170,255,0.20)',
    trackBorder: 'rgba(0,170,255,0.45)',
    waveform: 'rgba(0,170,255,0.55)',
    waveformOutside: 'rgba(100,116,139,0.35)',
    outsideOverlay: 'rgba(2,8,23,0.65)',
    handle: '#00aaff',
    handleBorder: '#fff',
    playhead: '#fbbf24',
    playheadGlow: 'rgba(251,191,36,0.4)',
  };

  // ─── Estado interno ─────────────────────────────────────────────────────
  let canvas = null;
  let ctx = null;
  let dpr = 1;
  let canvasW = 0;
  let canvasH = 0;

  let duration = 0;
  let zoom = 1;            // 1 = todo o vídeo cabe na tela
  let panSec = 0;          // offset esquerdo em segundos
  let videoEl = null;

  let waveformData = null; // Float32Array com mins/maxes downsampled (por px)
  let waveformBuckets = 0; // qtos buckets foram calculados (= canvasW)
  let waveformGenerating = false;

  let dragging = null;     // {kind: 'in'|'out'|'playhead'|'pan', startX, startVal}
  let rafId = null;

  // ─── Helpers de coordenada ─────────────────────────────────────────────
  function visibleDuration() {
    return duration / zoom;
  }
  function pxPerSec() {
    return canvasW / visibleDuration();
  }
  function secToPx(t) {
    return (t - panSec) * pxPerSec();
  }
  function pxToSec(x) {
    return panSec + x / pxPerSec();
  }
  function clampPan() {
    const maxPan = Math.max(0, duration - visibleDuration());
    if (panSec < 0) panSec = 0;
    if (panSec > maxPan) panSec = maxPan;
  }

  // Snap pra frame mais próximo (Shift desativa)
  function snap(t, evt) {
    if (evt && (evt.shiftKey)) return t;
    return Math.round(t * FRAME_RATE) / FRAME_RATE;
  }

  // ─── Setup canvas + responsivo ────────────────────────────────────────
  function setupCanvas() {
    canvas = document.getElementById('timelineCanvas');
    if (!canvas) return false;
    ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return false;
    resize();
    if (window.ResizeObserver) {
      new ResizeObserver(() => { resize(); requestRender(); }).observe(canvas.parentElement);
    } else {
      window.addEventListener('resize', () => { resize(); requestRender(); });
    }
    return true;
  }

  function resize() {
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    dpr = Math.max(1, window.devicePixelRatio || 1);
    canvasW = Math.max(1, Math.floor(r.width));
    canvasH = Math.max(1, Math.floor(r.height));
    canvas.width = canvasW * dpr;
    canvas.height = canvasH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    clampPan();
    // Invalida waveform pra re-gerar no novo width
    if (waveformData && waveformBuckets !== canvasW) {
      waveformData = null;
      maybeGenerateWaveform();
    }
  }

  // ─── Render principal ──────────────────────────────────────────────────
  function requestRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      render();
    });
  }

  function render() {
    if (!ctx) return;
    // Hide empty placeholder
    const empty = document.querySelector('.timeline-empty');
    if (empty) empty.style.display = duration > 0 ? 'none' : '';
    if (duration <= 0) return;

    // Background
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, canvasW, canvasH);

    drawRuler();
    drawTrack();
    drawWaveform();
    drawTrimOverlay();
    drawHandles();
    drawPlayhead();
  }

  // ─── Ruler ─────────────────────────────────────────────────────────────
  function drawRuler() {
    const stepSec = chooseRulerStep();
    const startT = Math.floor(panSec / stepSec) * stepSec;
    const endT = panSec + visibleDuration();
    ctx.save();
    ctx.fillStyle = COLORS.ruler;
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textBaseline = 'top';

    for (let t = startT; t <= endT; t += stepSec) {
      const x = secToPx(t);
      if (x < -50 || x > canvasW + 50) continue;
      const isMajor = Math.abs(t / stepSec - Math.round(t / stepSec)) < 0.001 && Math.round(t / stepSec) % 5 === 0;
      ctx.fillStyle = isMajor ? COLORS.rulerMajor : COLORS.ruler;
      // Tick
      ctx.fillRect(Math.round(x), 0, 1, isMajor ? 8 : 5);
      // Label
      if (isMajor) {
        ctx.fillText(fmtTime(t), Math.round(x) + 4, 8);
      }
    }
    // Linha base
    ctx.fillStyle = COLORS.tickLine;
    ctx.fillRect(0, RULER_H - 1, canvasW, 1);
    ctx.restore();
  }

  function chooseRulerStep() {
    // Tenta steps em segundos baseado na escala atual
    const visible = visibleDuration();
    const candidates = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600];
    // Queremos ~10 ticks visíveis
    const target = visible / 10;
    for (const c of candidates) {
      if (c >= target) return c;
    }
    return candidates[candidates.length - 1];
  }

  function fmtTime(t) {
    if (t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = Math.floor(t - m * 60);
    if (m === 0 && t < 10) {
      const ms = Math.floor((t - Math.floor(t)) * 10);
      return s + (ms ? '.' + ms : '') + 's';
    }
    return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
  }

  // ─── Track (faixa do vídeo) ────────────────────────────────────────────
  function drawTrack() {
    const x0 = secToPx(0);
    const x1 = secToPx(duration);
    const w = Math.max(2, x1 - x0);
    ctx.fillStyle = COLORS.track;
    ctx.fillRect(x0, TRACK_PAD_TOP, w, TRACK_H);
    ctx.strokeStyle = COLORS.trackBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, TRACK_PAD_TOP + 0.5, w - 1, TRACK_H - 1);
  }

  // ─── Waveform (Web Audio decodificou em maybeGenerateWaveform) ─────────
  function drawWaveform() {
    if (!waveformData || !waveformData.length) return;
    const midY = TRACK_PAD_TOP + TRACK_H / 2;
    const ampH = (TRACK_H / 2) - 6;
    const s = BEState.get();
    const trimIn = s.trim.in;
    const trimOut = s.trim.out > 0 ? s.trim.out : duration;
    for (let i = 0; i < waveformData.length; i += 2) {
      const bucketIdx = i / 2;
      const sec = (bucketIdx / waveformBuckets) * duration;
      const x = secToPx(sec);
      if (x < -1 || x > canvasW + 1) continue;
      const min = waveformData[i];
      const max = waveformData[i + 1];
      const inTrim = sec >= trimIn && sec <= trimOut;
      ctx.fillStyle = inTrim ? COLORS.waveform : COLORS.waveformOutside;
      const yTop = midY - max * ampH;
      const yBot = midY - min * ampH;
      ctx.fillRect(Math.round(x), yTop, 1, Math.max(1, yBot - yTop));
    }
  }

  // ─── Trim overlay (escurece fora do trim) ─────────────────────────────
  function drawTrimOverlay() {
    const s = BEState.get();
    const trimIn = s.trim.in;
    const trimOut = s.trim.out > 0 ? s.trim.out : duration;
    ctx.fillStyle = COLORS.outsideOverlay;
    // Esquerda (0 → trim_in)
    if (trimIn > 0) {
      const x1 = secToPx(0);
      const x2 = secToPx(trimIn);
      if (x2 > x1) ctx.fillRect(x1, TRACK_PAD_TOP, x2 - x1, TRACK_H);
    }
    // Direita (trim_out → duration)
    if (trimOut < duration) {
      const x1 = secToPx(trimOut);
      const x2 = secToPx(duration);
      if (x2 > x1) ctx.fillRect(x1, TRACK_PAD_TOP, x2 - x1, TRACK_H);
    }
  }

  // ─── Handles ───────────────────────────────────────────────────────────
  function drawHandles() {
    const s = BEState.get();
    const trimIn = s.trim.in;
    const trimOut = s.trim.out > 0 ? s.trim.out : duration;
    drawHandle(trimIn, 'in');
    drawHandle(trimOut, 'out');
  }

  function drawHandle(t, kind) {
    const x = secToPx(t);
    if (x < -HANDLE_W || x > canvasW + HANDLE_W) return;
    ctx.save();
    // Barra vertical
    ctx.fillStyle = COLORS.handle;
    ctx.fillRect(x - HANDLE_W / 2, TRACK_PAD_TOP - 6, HANDLE_W, TRACK_H + 12);
    // Borda branca pra contraste
    ctx.strokeStyle = COLORS.handleBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - HANDLE_W / 2 + 0.5, TRACK_PAD_TOP - 5.5, HANDLE_W - 1, TRACK_H + 11);
    // Marcador (linha tripla no centro)
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    for (let dx = -2; dx <= 2; dx += 2) {
      ctx.beginPath();
      ctx.moveTo(x + dx, TRACK_PAD_TOP + TRACK_H / 2 - 6);
      ctx.lineTo(x + dx, TRACK_PAD_TOP + TRACK_H / 2 + 6);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ─── Playhead ──────────────────────────────────────────────────────────
  function drawPlayhead() {
    if (!videoEl) return;
    const t = videoEl.currentTime || 0;
    const x = secToPx(t);
    if (x < -2 || x > canvasW + 2) return;
    ctx.save();
    // Glow
    ctx.fillStyle = COLORS.playheadGlow;
    ctx.fillRect(x - 3, 0, 6, canvasH);
    // Linha
    ctx.fillStyle = COLORS.playhead;
    ctx.fillRect(x - PLAYHEAD_W / 2, 0, PLAYHEAD_W, canvasH);
    // Cabecinha triangular
    ctx.beginPath();
    ctx.moveTo(x - 6, 0);
    ctx.lineTo(x + 6, 0);
    ctx.lineTo(x, 8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // ─── Hit testing pra handles ──────────────────────────────────────────
  function hitTestHandle(x, y) {
    if (y < TRACK_PAD_TOP - 6 - HANDLE_TOUCH/2 || y > TRACK_PAD_TOP + TRACK_H + 6 + HANDLE_TOUCH/2) return null;
    const s = BEState.get();
    const trimIn = s.trim.in;
    const trimOut = s.trim.out > 0 ? s.trim.out : duration;
    const xIn = secToPx(trimIn);
    const xOut = secToPx(trimOut);
    if (Math.abs(x - xIn) <= HANDLE_TOUCH/2) return 'in';
    if (Math.abs(x - xOut) <= HANDLE_TOUCH/2) return 'out';
    return null;
  }

  // ─── Input handlers ────────────────────────────────────────────────────
  function bindInput() {
    if (!canvas) return;

    canvas.addEventListener('mousedown', e => onPointerDown(e.clientX, e.clientY, e));
    canvas.addEventListener('mousemove', e => onPointerMove(e.clientX, e.clientY, e));
    window.addEventListener('mouseup', () => onPointerUp());

    canvas.addEventListener('touchstart', e => {
      const t = e.touches[0];
      onPointerDown(t.clientX, t.clientY, e);
    }, { passive: false });
    canvas.addEventListener('touchmove', e => {
      const t = e.touches[0];
      onPointerMove(t.clientX, t.clientY, e);
    }, { passive: false });
    canvas.addEventListener('touchend', () => onPointerUp());
    canvas.addEventListener('touchcancel', () => onPointerUp());

    // Wheel: Ctrl+scroll zooma, scroll horizontal paneia
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (e.ctrlKey || e.metaKey) {
        const factor = e.deltaY < 0 ? 1.2 : 1/1.2;
        zoomAt(x, factor);
      } else {
        panSec += (e.deltaX || e.deltaY) / pxPerSec();
        clampPan();
        requestRender();
      }
    }, { passive: false });

    // Cursor style hover
    canvas.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = hitTestHandle(x, y);
      canvas.style.cursor = hit ? 'ew-resize' : (y < RULER_H ? 'pointer' : 'default');
    });
  }

  function onPointerDown(clientX, clientY, evt) {
    if (!canvas || !duration) return;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const handle = hitTestHandle(x, y);
    if (handle) {
      evt.preventDefault && evt.preventDefault();
      dragging = { kind: handle, lastClientX: clientX };
      return;
    }

    // Clique na ruler → seek
    if (y < RULER_H + TRACK_PAD_TOP + TRACK_H) {
      const t = snap(pxToSec(x), evt);
      if (videoEl) videoEl.currentTime = Math.max(0, Math.min(duration, t));
      dragging = { kind: 'playhead', lastClientX: clientX };
      requestRender();
    }
  }

  function onPointerMove(clientX, clientY, evt) {
    if (!dragging || !canvas) return;
    evt.preventDefault && evt.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const t = snap(pxToSec(x), evt);
    const s = BEState.get();
    if (dragging.kind === 'in') {
      const newIn = Math.max(0, Math.min((s.trim.out > 0 ? s.trim.out : duration) - 0.1, t));
      BEState.patch({ trim: { in: newIn, out: s.trim.out } });
    } else if (dragging.kind === 'out') {
      const newOut = Math.max(s.trim.in + 0.1, Math.min(duration, t));
      BEState.patch({ trim: { in: s.trim.in, out: newOut } });
    } else if (dragging.kind === 'playhead') {
      if (videoEl) videoEl.currentTime = Math.max(0, Math.min(duration, t));
    }
    requestRender();
  }

  function onPointerUp() {
    dragging = null;
  }

  function zoomAt(x, factor) {
    const tBefore = pxToSec(x);
    zoom = Math.max(1, Math.min(50, zoom * factor));
    const tAfter = pxToSec(x);
    panSec += (tBefore - tAfter);
    clampPan();
    requestRender();
    const lbl = document.getElementById('tlZoomLabel');
    if (lbl) lbl.textContent = Math.round(zoom * 100) + '%';
  }

  // ─── Waveform via Web Audio API ────────────────────────────────────────
  // Decodifica audio do MP4, downsample pra N buckets onde N = canvasW.
  // Cada bucket guarda (min, max) — 2 floats. Total waveformData.length = N*2.
  async function maybeGenerateWaveform() {
    if (waveformGenerating || waveformData || !videoEl || !videoEl.src) return;
    const s = BEState.get();
    if (!s.video || !s.video.url) return;
    waveformGenerating = true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctxAudio = new AC();
      const resp = await fetch(s.video.url, { credentials: 'omit' });
      if (!resp.ok) throw new Error('fetch failed');
      const buf = await resp.arrayBuffer();
      const audio = await ctxAudio.decodeAudioData(buf);
      const data = audio.getChannelData(0); // 1º canal
      const buckets = Math.max(100, canvasW);
      const samplesPerBucket = Math.max(1, Math.floor(data.length / buckets));
      const out = new Float32Array(buckets * 2);
      let max = 0;
      for (let i = 0; i < buckets; i++) {
        const start = i * samplesPerBucket;
        const end = Math.min(data.length, start + samplesPerBucket);
        let mn = 0, mx = 0;
        for (let j = start; j < end; j++) {
          const v = data[j];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        out[i*2] = mn;
        out[i*2 + 1] = mx;
        if (-mn > max) max = -mn;
        if (mx > max) max = mx;
      }
      // Normaliza pra usar toda altura disponivel
      if (max > 0 && max < 1) {
        const scale = 0.95 / max;
        for (let i = 0; i < out.length; i++) out[i] *= scale;
      }
      waveformData = out;
      waveformBuckets = buckets;
      try { ctxAudio.close(); } catch(e) {}
      requestRender();
    } catch (e) {
      console.warn('[timeline waveform]', e.message);
    } finally {
      waveformGenerating = false;
    }
  }

  // ─── Zoom buttons da toolbar ──────────────────────────────────────────
  function bindZoomToolbar() {
    const left = document.querySelector('.toolbar-right');
    if (!left) return;
    const btns = left.querySelectorAll('button');
    if (btns.length >= 2) {
      btns[0].disabled = false;
      btns[0].title = 'Zoom out';
      btns[1].disabled = false;
      btns[1].title = 'Zoom in';
      btns[0].addEventListener('click', () => zoomAt(canvasW/2, 1/1.5));
      btns[1].addEventListener('click', () => zoomAt(canvasW/2, 1.5));
    }
  }

  // ─── Sync com player ──────────────────────────────────────────────────
  function bindVideoSync() {
    const vid = document.getElementById('previewVideo');
    if (!vid) return;
    videoEl = vid;
    // Anima playhead em 30fps (suficiente; já temos rAF)
    let lastTime = -1;
    function tick() {
      if (videoEl && videoEl.currentTime !== lastTime) {
        lastTime = videoEl.currentTime;
        requestRender();
      }
      rafSync = requestAnimationFrame(tick);
    }
    let rafSync = requestAnimationFrame(tick);
  }

  // ─── State subscription ────────────────────────────────────────────────
  function onStateChange(s) {
    if (s.video && s.video.duration && s.video.duration !== duration) {
      duration = s.video.duration;
      panSec = 0;
      zoom = 1;
      waveformData = null;
      const lbl = document.getElementById('tlZoomLabel');
      if (lbl) lbl.textContent = '100%';
      // Tenta gerar waveform após o video element estar pronto
      setTimeout(() => {
        if (!videoEl) bindVideoSync();
        maybeGenerateWaveform();
      }, 300);
    }
    requestRender();
  }

  // ─── Init ──────────────────────────────────────────────────────────────
  function init() {
    if (!setupCanvas()) return;
    bindInput();
    bindZoomToolbar();
    BEState.subscribe(onStateChange);
    // Caso já tenha video no init (recuperação de projeto)
    const s = BEState.get();
    if (s.video && s.video.duration) {
      onStateChange(s);
    }
  }

  function playRange() {
    if (!videoEl) return;
    const s = BEState.get();
    const inT = s.trim.in;
    const outT = s.trim.out > 0 ? s.trim.out : duration;
    videoEl.currentTime = inT;
    videoEl.play().catch(()=>{});
    const stopAt = outT;
    const watcher = setInterval(() => {
      if (!videoEl || videoEl.paused) { clearInterval(watcher); return; }
      if (videoEl.currentTime >= stopAt - 0.05) {
        videoEl.pause();
        clearInterval(watcher);
      }
    }, 30);
  }

  return { init, playRange };
})();
