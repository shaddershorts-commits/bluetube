// editor-v1/timeline/waveform.js
// Analise de audio via Web Audio decode. Funciona pra arquivos de AUDIO e
// pro audio embutido em VIDEO (decodeAudioData extrai a trilha).
// Suporta slices por range de tempo (pra desenhar o trecho exato de cada
// clip na timeline, estilo CapCut). Falha (CORS/sem trilha) -> null, e a
// UI vive sem waveform.

const BUCKETS = 1600;

export function createWaveform(mediaUrl, onReady, opts = {}) {
  let peaks = null;       // Float32Array normalizado 0..1
  let mediaDur = 0;       // duracao real decodificada
  const bitmaps = new Map();
  let cancelled = false;
  const color = opts.color || 'rgba(34,197,94,.8)';

  async function analyze() {
    try {
      const resp = await fetch(mediaUrl, { mode: 'cors' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buf = await resp.arrayBuffer();
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      const audio = await ac.decodeAudioData(buf);
      mediaDur = audio.duration;
      const ch = audio.getChannelData(0);
      const out = new Float32Array(BUCKETS);
      const per = Math.floor(ch.length / BUCKETS) || 1;
      for (let i = 0; i < BUCKETS; i++) {
        let max = 0;
        const start = i * per;
        for (let j = 0; j < per; j += 16) {
          const v = Math.abs(ch[start + j] || 0);
          if (v > max) max = v;
        }
        out[i] = max;
      }
      const peak = Math.max(0.01, ...out);
      for (let i = 0; i < BUCKETS; i++) out[i] = out[i] / peak;
      if (!cancelled) { peaks = out; bitmaps.clear(); onReady?.(); }
      ac.close?.();
    } catch (e) {
      console.warn('[waveform] decode falhou (seguindo sem):', e.message);
    }
  }

  analyze();

  function drawSlice(t0, t1, w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(4, Math.round(w));
    c.height = Math.max(4, Math.round(h));
    const g = c.getContext('2d');
    g.fillStyle = color;
    const mid = c.height / 2;
    const b0 = (t0 / mediaDur) * BUCKETS;
    const b1 = (t1 / mediaDur) * BUCKETS;
    for (let x = 0; x < c.width; x++) {
      const bi = Math.floor(b0 + ((x + 0.5) / c.width) * (b1 - b0));
      const p = peaks[Math.min(BUCKETS - 1, Math.max(0, bi))] || 0;
      const bh = Math.max(1, p * (c.height - 2));
      g.fillRect(x, mid - bh / 2, 1, bh);
    }
    return c;
  }

  return {
    ready: () => !!peaks,
    duration: () => mediaDur,

    /** Bitmap do trecho [t0,t1] do MEDIA em (w x h). Cacheado. */
    getSlice(t0, t1, w, h) {
      if (!peaks || w < 4 || !(t1 > t0) || mediaDur <= 0) return null;
      const key = `${t0.toFixed(2)}_${t1.toFixed(2)}_${Math.round(w / 16)}_${Math.round(h)}`;
      if (bitmaps.has(key)) return bitmaps.get(key);
      const bmp = drawSlice(Math.max(0, t0), Math.min(mediaDur, t1), w, h);
      bitmaps.set(key, bmp);
      if (bitmaps.size > 300) bitmaps.clear();
      return bmp;
    },

    /** compat: bitmap do arquivo inteiro (track de audio extra) */
    getBitmap(w, h) {
      return this.getSlice(0, mediaDur || 1, w, h);
    },

    destroy() { cancelled = true; bitmaps.clear(); peaks = null; },
  };
}
