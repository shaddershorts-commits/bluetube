// editor-v1/timeline/thumbnails.js
// Extrai frames do <video> em background e monta strips cacheados por clip.
// Falha silenciosa (CORS/decoder) -> retorna null e a timeline vive sem thumbs.

const THUMB_W = 64, THUMB_H = 56;

export function createThumbnails(src, duration, onReady) {
  const frames = new Map(); // sec(int) -> canvas
  const strips = new Map(); // cacheKey -> canvas
  let cancelled = false;
  // aceita URL direto (multi-take) OU um <video> (compat). Cada fonte de midia
  // tem sua propria instancia, entao o take mostra os frames DELE.
  const url = typeof src === 'string' ? src : (src?.currentSrc || src?.src);

  async function extract() {
    if (!url || !duration) return;
    // 1 frame a cada ~2s, max 60 frames
    const step = Math.max(2, duration / 60);
    const grabber = document.createElement('video');
    grabber.crossOrigin = 'anonymous';
    grabber.muted = true;
    grabber.preload = 'auto';
    grabber.src = url;
    try {
      await once(grabber, 'loadedmetadata', 15000);
      for (let t = 0.1; t < duration && !cancelled; t += step) {
        grabber.currentTime = t;
        await once(grabber, 'seeked', 8000);
        const c = document.createElement('canvas');
        c.width = THUMB_W; c.height = THUMB_H;
        const g = c.getContext('2d');
        const vw = grabber.videoWidth || 1, vh = grabber.videoHeight || 1;
        const s = Math.max(THUMB_W / vw, THUMB_H / vh);
        g.drawImage(grabber, (THUMB_W - vw * s) / 2, (THUMB_H - vh * s) / 2, vw * s, vh * s);
        frames.set(Math.round(t), c);
        strips.clear();
        if (onReady) onReady();
      }
    } catch (e) {
      console.warn('[thumbs] extracao falhou (seguindo sem):', e.message);
    } finally {
      grabber.removeAttribute('src');
      grabber.load?.();
    }
  }

  extract();

  return {
    /** Strip do trecho [sIn, sOut] com largura w. Cacheado. */
    getStrip(sIn, sOut, w, h) {
      if (!frames.size || w < 8) return null;
      const key = `${Math.round(sIn)}_${Math.round(sOut)}_${Math.round(w / 32)}`;
      if (strips.has(key)) return strips.get(key);
      const c = document.createElement('canvas');
      c.width = Math.max(8, Math.round(w));
      c.height = h;
      const g = c.getContext('2d');
      const n = Math.max(1, Math.ceil(w / THUMB_W));
      for (let i = 0; i < n; i++) {
        const t = sIn + ((i + 0.5) / n) * (sOut - sIn);
        const f = nearestFrame(frames, t);
        if (f) g.drawImage(f, i * THUMB_W, 0, THUMB_W, h);
      }
      strips.set(key, c);
      if (strips.size > 200) strips.clear(); // bound de memoria
      return c;
    },
    destroy() { cancelled = true; frames.clear(); strips.clear(); },
  };
}

function nearestFrame(frames, t) {
  if (!frames.size) return null;
  let best = null, bd = Infinity;
  for (const [sec, c] of frames) {
    const d = Math.abs(sec - t);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

function once(el, evt, timeoutMs) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { cleanup(); reject(new Error(evt + ' timeout')); }, timeoutMs);
    const ok = () => { cleanup(); resolve(); };
    const err = () => { cleanup(); reject(new Error(evt + ' error')); };
    function cleanup() {
      clearTimeout(to);
      el.removeEventListener(evt, ok);
      el.removeEventListener('error', err);
    }
    el.addEventListener(evt, ok, { once: true });
    el.addEventListener('error', err, { once: true });
  });
}
