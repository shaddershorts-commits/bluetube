/* ═══════════════════════════════════════════════════════════════════════════
   thumbnails.js — Captura N frames do video como thumbs pra timeline
   ═══════════════════════════════════════════════════════════════════════════
   Estrategia:
     - Cria <video> oculto separado (NAO usa o player principal pra nao
       interferir na reproducao do user)
     - Faz seek pra N momentos e captura frame via drawImage(canvas)
     - Encoda como ImageBitmap (rapido pra desenhar 60fps)
     - Cacheia em array; timeline.js le BEThumbs.getThumbs() pra renderizar

   Performance:
     - Vai sendo populado progressivamente (cada thumb dispara render)
     - N = 30 por padrao (suficiente pra vídeos de até 10min)
     - Thumb height = 64px, largura proporcional ao aspect ratio do video
     - ImageBitmap em vez de toDataURL (10× mais rapido pra draw)

   Robustez:
     - Timeout 5s por seek (alguns codecs sao lentos)
     - Se um seek falhar, continua pros outros
     - Compatibility: cross-browser via crossOrigin='anonymous'
     - Cleanup quando video troca

   API publica:
     - BEThumbs.init() — bind subscribe state
     - BEThumbs.getThumbs() — retorna [{time, bitmap}, ...]
     - BEThumbs.getStatus() — 'pending' | 'loading' | 'ready' | 'unavailable'
   ═══════════════════════════════════════════════════════════════════════════ */

window.BEThumbs = (function() {
  'use strict';

  const THUMB_COUNT = 30;
  const THUMB_HEIGHT = 64;
  const SEEK_TIMEOUT_MS = 5000;

  let thumbs = [];            // [{ time: sec, bitmap: ImageBitmap, width, height }]
  let status = 'pending';
  let generating = false;
  let currentVideoUrl = null;
  let onReadyCallback = null;

  function setStatus(s, info) {
    status = s;
    console.log('[thumbnails]', s, info || '');
    if (onReadyCallback) {
      try { onReadyCallback({ status, thumbs }); } catch(e){}
    }
  }

  function getThumbs() { return thumbs; }
  function getStatus() { return status; }
  function onUpdate(cb) { onReadyCallback = cb; }

  // Cria offscreen video element pra extracao de frames.
  // Separado do player principal pra nao interferir na reproducao do user.
  function createOffscreenVideo(url) {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.crossOrigin = 'anonymous';
      v.preload = 'auto';
      v.style.position = 'fixed';
      v.style.left = '-9999px';
      v.style.opacity = '0';
      v.style.pointerEvents = 'none';
      v.src = url;
      const onError = (e) => {
        cleanup();
        reject(new Error('video load failed: ' + (e?.message || 'unknown')));
      };
      const cleanup = () => {
        v.removeEventListener('loadedmetadata', onMeta);
        v.removeEventListener('error', onError);
      };
      const onMeta = () => {
        cleanup();
        resolve(v);
      };
      v.addEventListener('loadedmetadata', onMeta);
      v.addEventListener('error', onError);
      document.body.appendChild(v);
      setTimeout(() => {
        if (!v.duration) { cleanup(); reject(new Error('metadata timeout')); }
      }, 8000);
    });
  }

  // Seek + wait pelo evento 'seeked'
  function seekAndWait(video, time) {
    return new Promise((resolve, reject) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        clearTimeout(tid);
        // Pequeno delay pra video render estabilizar (alguns codecs precisam)
        setTimeout(resolve, 30);
      };
      const onError = () => {
        cleanup();
        reject(new Error('seek error'));
      };
      const cleanup = () => {
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        clearTimeout(tid);
      };
      const tid = setTimeout(() => { cleanup(); reject(new Error('seek timeout')); }, SEEK_TIMEOUT_MS);
      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', onError);
      try {
        video.currentTime = Math.max(0, Math.min(video.duration - 0.05, time));
      } catch(e) {
        cleanup();
        reject(e);
      }
    });
  }

  // Captura 1 frame em ImageBitmap
  async function captureFrame(video) {
    const aspectRatio = (video.videoWidth || 9) / (video.videoHeight || 16);
    const thumbWidth = Math.max(20, Math.round(THUMB_HEIGHT * aspectRatio));
    const canvas = document.createElement('canvas');
    canvas.width = thumbWidth;
    canvas.height = THUMB_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas ctx fail');
    try {
      ctx.drawImage(video, 0, 0, thumbWidth, THUMB_HEIGHT);
    } catch (e) {
      // SecurityError em CORS apertado — log e re-throw
      throw new Error('drawImage failed: ' + e.message + ' (CORS?)');
    }
    // Cria ImageBitmap pra render fast
    if (window.createImageBitmap) {
      const bmp = await createImageBitmap(canvas);
      return { bitmap: bmp, width: thumbWidth, height: THUMB_HEIGHT };
    }
    // Fallback: retorna canvas como source de drawImage
    return { bitmap: canvas, width: thumbWidth, height: THUMB_HEIGHT };
  }

  // Gera N thumbnails pro video atual (uma vez)
  async function generate(url, duration) {
    if (generating || currentVideoUrl === url) return;
    generating = true;
    currentVideoUrl = url;
    thumbs = [];
    setStatus('loading');

    let video;
    try {
      video = await createOffscreenVideo(url);
    } catch (e) {
      setStatus('unavailable', 'video load: ' + e.message);
      generating = false;
      return;
    }

    const N = Math.min(THUMB_COUNT, Math.max(5, Math.floor(duration / 0.5)));
    let successes = 0;
    let failures = 0;

    for (let i = 0; i < N; i++) {
      if (currentVideoUrl !== url) break; // video trocou no meio
      // Distribui N pontos uniformemente entre [0.1, duration-0.1]
      // (pula primeiro e ultimo frame que podem ser pretos)
      const t = 0.1 + (duration - 0.2) * (i / (N - 1));
      try {
        await seekAndWait(video, t);
        const cap = await captureFrame(video);
        thumbs.push({ time: t, bitmap: cap.bitmap, width: cap.width, height: cap.height });
        successes++;
        // Dispara update pra timeline ja renderizar progressivamente
        if (onReadyCallback) {
          try { onReadyCallback({ status: 'loading', thumbs }); } catch(e){}
        }
      } catch (e) {
        failures++;
        if (failures > 5 && successes === 0) {
          // Muitas falhas seguidas sem sucesso — provavelmente CORS, aborta
          setStatus('unavailable', 'too many failures: ' + e.message);
          break;
        }
      }
    }

    try { video.remove(); } catch(e) {}
    if (successes > 0) {
      setStatus('ready', `${successes}/${N} thumbs`);
    } else if (failures > 0) {
      setStatus('unavailable', `${failures} falhas`);
    }
    generating = false;
  }

  // ─── Reset (quando trocar de video) ────────────────────────────────────
  function reset() {
    // Cleanup ImageBitmaps pra liberar memoria GPU
    thumbs.forEach(t => {
      try { if (t.bitmap && t.bitmap.close) t.bitmap.close(); } catch(e){}
    });
    thumbs = [];
    currentVideoUrl = null;
    status = 'pending';
  }

  // ─── State subscription ────────────────────────────────────────────────
  function onStateChange(s) {
    if (!s.video || !s.video.url || !s.video.duration) {
      reset();
      return;
    }
    if (currentVideoUrl !== s.video.url) {
      reset();
      // Delay pequeno pra evitar gerar 2× se state muda rapido em sequencia
      setTimeout(() => {
        if (currentVideoUrl === null) generate(s.video.url, s.video.duration);
      }, 200);
    }
  }

  function init() {
    BEState.subscribe(onStateChange);
    const s = BEState.get();
    if (s.video && s.video.url) onStateChange(s);
  }

  return { init, getThumbs, getStatus, onUpdate, reset };
})();
