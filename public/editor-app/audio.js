/* ═══════════════════════════════════════════════════════════════════════════
   audio.js — Upload audio extra + preview audivel (Web Audio API)
   ═══════════════════════════════════════════════════════════════════════════
   Pipeline:
     1. User escolhe MP3/WAV/M4A
     2. Validacao (formato, tamanho ≤50MB, duracao via probe)
     3. Upload via /api/blue-editor?action=get-upload-url (signed URL)
     4. State.audio_extra = { url, filename, duration, size_bytes }
     5. Player: <audio> oculto sincronizado com video.currentTime + volume mix
   ═══════════════════════════════════════════════════════════════════════════ */

window.BEAudio = (function() {
  'use strict';

  const ACCEPTED_TYPES = ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/x-m4a'];
  const ACCEPTED_EXT = ['.mp3', '.wav', '.m4a', '.aac'];
  const MAX_SIZE = 50 * 1024 * 1024; // 50MB
  const MAX_DURATION = 600;

  let audioEl = null; // <audio> sincronizado com player
  let videoEl = null;
  let lastVideoTime = 0;

  function isValidType(file) {
    if (ACCEPTED_TYPES.includes(file.type)) return true;
    const lo = file.name.toLowerCase();
    return ACCEPTED_EXT.some(e => lo.endsWith(e));
  }

  function probeAudio(blobOrUrl) {
    return new Promise((resolve, reject) => {
      const a = document.createElement('audio');
      a.preload = 'metadata';
      const cleanup = () => { try { a.remove(); } catch(e){} };
      a.onloadedmetadata = () => {
        const d = a.duration || 0;
        cleanup();
        if (!isFinite(d) || d <= 0) return reject(new Error('Duração inválida'));
        resolve({ duration: d });
      };
      a.onerror = () => { cleanup(); reject(new Error('Audio invalido')); };
      a.src = blobOrUrl instanceof Blob ? URL.createObjectURL(blobOrUrl) : blobOrUrl;
    });
  }

  async function uploadAudio(file) {
    if (!file) return;
    if (!isValidType(file)) return alert('Formato não suportado. Use MP3, WAV ou M4A.');
    if (file.size > MAX_SIZE) return alert('Áudio muito grande. Limite: 50 MB.');
    let meta;
    try {
      meta = await probeAudio(file);
    } catch (e) {
      return alert('Erro ao ler áudio: ' + e.message);
    }
    if (meta.duration > MAX_DURATION) return alert('Áudio muito longo. Limite: 10 min.');

    // Pega signed URL
    const token = localStorage.getItem('bt_token');
    const ext = (file.name.match(/\.(\w+)$/)?.[1] || 'mp3').toLowerCase();
    let signed;
    try {
      const r = await fetch('/api/blue-editor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get-upload-url', token, ext }),
      });
      const d = await r.json();
      if (!r.ok || !d.upload_url) return alert('Falha ao iniciar upload: ' + (d.error || 'erro'));
      signed = d;
    } catch (e) { return alert('Rede: ' + e.message); }

    // Upload simples (audios sao pequenos, sem progress bar)
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', signed.upload_url);
        xhr.setRequestHeader('Content-Type', file.type || 'audio/mpeg');
        xhr.onload = () => xhr.status < 300 ? resolve() : reject(new Error('HTTP ' + xhr.status));
        xhr.onerror = () => reject(new Error('Erro de rede'));
        xhr.send(file);
      });
    } catch (e) { return alert('Upload: ' + e.message); }

    BEState.patch({
      audio_extra: {
        url: signed.public_url,
        path: signed.path,
        filename: file.name,
        duration: meta.duration,
        size_bytes: file.size,
      },
    });
    if (window.BEEditor) BEEditor.renderAudioPanel();
  }

  // Sincroniza <audio> com video.currentTime + aplica volumes do state
  function tick() {
    if (!audioEl || !videoEl) return;
    const s = BEState.get();
    if (!s.audio_extra || !s.audio_extra.url) {
      audioEl.pause();
      return;
    }
    // Carrega src se mudou
    if (audioEl.src !== s.audio_extra.url) {
      audioEl.src = s.audio_extra.url;
    }
    // Sync time
    if (Math.abs(audioEl.currentTime - videoEl.currentTime) > 0.2) {
      audioEl.currentTime = Math.min(videoEl.currentTime, audioEl.duration || videoEl.currentTime);
    }
    // Volumes
    const volV = s.volumes?.video ?? 1;
    const volA = s.volumes?.audio_extra ?? 1;
    videoEl.volume = Math.max(0, Math.min(1, volV));
    audioEl.volume = Math.max(0, Math.min(1, volA));
    // Play/pause segue video
    if (videoEl.paused && !audioEl.paused) audioEl.pause();
    if (!videoEl.paused && audioEl.paused) audioEl.play().catch(()=>{});
  }

  function init() {
    // Cria <audio> oculto pra preview audivel
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.preload = 'auto';
      audioEl.style.display = 'none';
      document.body.appendChild(audioEl);
    }
    // Bind videoEl quando disponivel
    const checkVideo = () => {
      videoEl = document.getElementById('previewVideo');
      if (!videoEl) setTimeout(checkVideo, 200);
    };
    checkVideo();
    setInterval(tick, 100);
    BEState.subscribe(() => {
      const s = BEState.get();
      if (s.audio_extra && s.audio_extra.url) {
        if (audioEl && audioEl.src !== s.audio_extra.url) {
          audioEl.src = s.audio_extra.url;
        }
      } else if (audioEl) {
        audioEl.pause();
        audioEl.removeAttribute('src');
      }
    });
  }

  return { init, uploadAudio };
})();
