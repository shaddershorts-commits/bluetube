// editor-v1/services/upload.js
// Upload direto pro Supabase Storage via signed URL + probe de metadata.

import { api } from './api.js';

export const MAX_VIDEO_MB = 500;
export const MAX_AUDIO_MB = 50;
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
const AUDIO_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/aac'];

/**
 * @param {File} file
 * @param {'video'|'audio'} kind
 * @param {(pct:number)=>void} onProgress
 * @returns {Promise<{url,path,filename,duration,width,height,size_bytes}>}
 */
export async function uploadMedia(file, kind, onProgress) {
  validate(file, kind);
  const ext = (file.name.split('.').pop() || (kind === 'video' ? 'mp4' : 'mp3')).toLowerCase();
  const { upload_url, public_url, path } = await api.getUploadUrl(ext);

  await putWithProgress(upload_url, file, onProgress);

  const meta = kind === 'video' ? await probeVideo(file) : await probeAudio(file);
  return {
    url: public_url,
    path,
    filename: file.name,
    size_bytes: file.size,
    ...meta,
  };
}

function validate(file, kind) {
  const maxMB = kind === 'video' ? MAX_VIDEO_MB : MAX_AUDIO_MB;
  if (file.size > maxMB * 1024 * 1024) {
    throw new Error(`Arquivo muito grande (máx ${maxMB}MB)`);
  }
  const types = kind === 'video' ? VIDEO_TYPES : AUDIO_TYPES;
  const extOk = kind === 'video'
    ? /\.(mp4|mov|webm)$/i.test(file.name)
    : /\.(mp3|wav|m4a|aac)$/i.test(file.name);
  if (!types.includes(file.type) && !extOk) {
    throw new Error(kind === 'video' ? 'Formato inválido. Use MP4, MOV ou WebM.' : 'Formato inválido. Use MP3, WAV ou M4A.');
  }
}

function putWithProgress(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload falhou (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload falhou (rede)'));
    xhr.ontimeout = () => reject(new Error('Upload timeout'));
    xhr.timeout = 15 * 60 * 1000;
    xhr.send(file);
  });
}

/** Le duration/width/height localmente (object URL — sem esperar CDN). */
export function probeVideo(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    const url = URL.createObjectURL(file);
    const to = setTimeout(() => { cleanup(); reject(new Error('Não consegui ler o vídeo')); }, 20000);
    function cleanup() { clearTimeout(to); URL.revokeObjectURL(url); }
    function finish() {
      const meta = { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
      cleanup();
      if (!meta.duration || !isFinite(meta.duration)) reject(new Error('Duração inválida'));
      else resolve(meta);
    }
    v.onloadedmetadata = () => {
      if (!isFinite(v.duration) || v.duration === 0) {
        // WebM de MediaRecorder (e alguns MOV) reportam Infinity ate um seek
        // alem do fim forcar o calculo real (bug conhecido do Chromium).
        v.ondurationchange = () => { if (isFinite(v.duration) && v.duration > 0) finish(); };
        v.currentTime = 1e7;
        setTimeout(() => { if (isFinite(v.duration) && v.duration > 0) finish(); }, 3000);
      } else {
        finish();
      }
    };
    v.onerror = () => { cleanup(); reject(new Error('Formato de vídeo não suportado pelo navegador')); };
    v.src = url;
  });
}

export function probeAudio(file) {
  return new Promise((resolve, reject) => {
    const a = document.createElement('audio');
    a.preload = 'metadata';
    const url = URL.createObjectURL(file);
    const to = setTimeout(() => { cleanup(); reject(new Error('Não consegui ler o áudio')); }, 15000);
    function cleanup() { clearTimeout(to); URL.revokeObjectURL(url); }
    a.onloadedmetadata = () => {
      const meta = { duration: a.duration };
      cleanup();
      if (!meta.duration || !isFinite(meta.duration)) reject(new Error('Duração inválida'));
      else resolve(meta);
    };
    a.onerror = () => { cleanup(); reject(new Error('Formato de áudio não suportado')); };
    a.src = url;
  });
}
