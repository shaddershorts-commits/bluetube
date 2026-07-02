// editor-v1/timeline/waveform.js
// Waveform do audio extra via Web Audio decode. Bitmap cacheado por largura.
// Falha (CORS etc) -> null, track renderiza flat.

export function createWaveform(audioUrl, onReady) {
  let peaks = null; // Float32Array normalizado 0..1
  const bitmaps = new Map();
  let cancelled = false;

  async function analyze() {
    try {
      const resp = await fetch(audioUrl, { mode: 'cors' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buf = await resp.arrayBuffer();
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      const audio = await ac.decodeAudioData(buf);
      const ch = audio.getChannelData(0);
      const BUCKETS = 600;
      const out = new Float32Array(BUCKETS);
      const per = Math.floor(ch.length / BUCKETS) || 1;
      for (let i = 0; i < BUCKETS; i++) {
        let max = 0;
        const start = i * per;
        for (let j = 0; j < per; j += 16) { // sample a cada 16 pra performance
          const v = Math.abs(ch[start + j] || 0);
          if (v > max) max = v;
        }
        out[i] = max;
      }
      // normaliza
      const peak = Math.max(0.01, ...out);
      for (let i = 0; i < BUCKETS; i++) out[i] = out[i] / peak;
      if (!cancelled) { peaks = out; bitmaps.clear(); onReady?.(); }
      ac.close?.();
    } catch (e) {
      console.warn('[waveform] decode falhou (seguindo flat):', e.message);
    }
  }

  analyze();

  return {
    getBitmap(w, h) {
      if (!peaks || w < 8) return null;
      const key = Math.round(w / 16);
      if (bitmaps.has(key)) return bitmaps.get(key);
      const c = document.createElement('canvas');
      c.width = Math.max(8, Math.round(w));
      c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = 'rgba(34,197,94,.75)';
      const mid = h / 2;
      const n = c.width;
      for (let x = 0; x < n; x++) {
        const p = peaks[Math.floor((x / n) * peaks.length)] || 0;
        const bh = Math.max(1, p * (h - 6));
        g.fillRect(x, mid - bh / 2, 1, bh);
      }
      bitmaps.set(key, c);
      if (bitmaps.size > 40) bitmaps.clear();
      return c;
    },
    destroy() { cancelled = true; bitmaps.clear(); peaks = null; },
  };
}
