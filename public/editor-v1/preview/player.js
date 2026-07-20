// editor-v1/preview/player.js
// Transporte com TEMPO VIRTUAL + mixer multi-audio.
// - <video> principal segue os clips ativos (pula trechos removidos)
// - cada audio_clip ganha um Audio() proprio (Audio decodifica a trilha de
//   audio de arquivos de VIDEO tambem), agendado por start/source_in/out

import { timelineToSource, totalDuration, segmentAt, effectiveAudioClips } from '../core/selectors.js';

export function createPlayer(videoEl, _audioElUnused, store) {
  let virtualTime = 0;
  let playing = false;
  let rafId = 0;
  let lastTick = 0;
  const listeners = new Set();
  const pool = new Map(); // audio_clip.id -> { el, url }

  function emit() { for (const fn of listeners) fn(); }

  function syncVideoToVirtual(seekVideo = true) {
    const state = store.getState();
    const src = timelineToSource(state, Math.min(virtualTime, Math.max(0, totalDuration(state) - 0.001)));
    // Sem clip de vídeo ativo neste instante (faixa excluída/vazia): o <video>
    // congelava no último frame decodificado — esconde (preto) até voltar a
    // haver conteúdo. Fix do "excluí a faixa mas a imagem continuou".
    videoEl.style.visibility = src == null ? 'hidden' : '';
    if (src != null && seekVideo && Math.abs(videoEl.currentTime - src) > 0.06) {
      videoEl.currentTime = src;
    }
  }

  /** cria/atualiza os Audio() do pool conforme audio_clips */
  function syncPool() {
    const state = store.getState();
    const clips = effectiveAudioClips(state);
    const seen = new Set();
    for (const a of clips) {
      seen.add(a.id);
      const url = a.kind === 'video' ? (videoEl.currentSrc || videoEl.src) : a.url;
      if (!url) continue;
      let entry = pool.get(a.id);
      if (!entry || entry.url !== url) {
        entry?.el.pause?.();
        const el = new Audio();
        el.preload = 'auto';
        el.src = url;
        entry = { el, url };
        pool.set(a.id, entry);
      }
    }
    for (const [id, entry] of pool) {
      if (!seen.has(id)) { entry.el.pause(); entry.el.removeAttribute('src'); pool.delete(id); }
    }
  }

  /** agenda cada audio clip pro tempo virtual t */
  function syncAudios(t) {
    const state = store.getState();
    for (const a of effectiveAudioClips(state)) {
      const entry = pool.get(a.id);
      if (!entry) continue;
      const el = entry.el;
      const dur = a.source_out - a.source_in;
      const inside = t >= a.start - 0.02 && t < a.start + dur;
      el.volume = Math.min(1, a.volume ?? 1);
      if (inside) {
        const local = a.source_in + (t - a.start);
        if (Math.abs(el.currentTime - local) > 0.25) {
          try { el.currentTime = local; } catch {}
        }
        if (playing && el.paused) el.play().catch(() => {});
        if (!playing && !el.paused) el.pause();
      } else if (!el.paused) {
        el.pause();
      }
    }
  }

  function tick(ts) {
    if (!playing) return;
    const state = store.getState();
    const total = totalDuration(state);
    const dt = lastTick ? (ts - lastTick) / 1000 : 0;
    lastTick = ts;

    const seg = segmentAt(state, virtualTime);
    if (seg) {
      const vSrc = videoEl.currentTime;
      if (vSrc >= seg.clip.source_in - 0.05 && vSrc <= seg.clip.source_out + 0.05) {
        virtualTime = seg.tStart + Math.max(0, vSrc - seg.clip.source_in);
        if (vSrc >= seg.clip.source_out - 0.03) {
          const nextT = seg.tEnd + 0.001;
          if (nextT >= total) { pause(); virtualTime = total; emit(); return; }
          virtualTime = nextT;
          syncVideoToVirtual();
        }
      } else {
        syncVideoToVirtual();
      }
    } else {
      virtualTime += dt;
      if (virtualTime >= total) { pause(); virtualTime = total; emit(); return; }
      syncVideoToVirtual();
    }
    syncAudios(virtualTime);
    emit();
    rafId = requestAnimationFrame(tick);
  }

  function play() {
    const state = store.getState();
    const total = totalDuration(state);
    if (total <= 0) return;
    if (virtualTime >= total - 0.01) virtualTime = 0;
    syncPool();
    syncVideoToVirtual();
    // video mudo quando o audio foi destacado (vive nos audio_clips agora)
    videoEl.muted = !!state.audio_detached;
    videoEl.volume = Math.min(1, state.volumes?.video ?? 1);
    playing = true;
    lastTick = 0;
    videoEl.play().catch(() => {});
    syncAudios(virtualTime);
    rafId = requestAnimationFrame(tick);
    emit();
  }

  function pause() {
    playing = false;
    cancelAnimationFrame(rafId);
    videoEl.pause();
    for (const [, entry] of pool) entry.el.pause();
    emit();
  }

  function seek(t) {
    const total = totalDuration(store.getState());
    virtualTime = Math.min(Math.max(0, t), total);
    syncVideoToVirtual();
    syncPool();
    syncAudios(virtualTime);
    emit();
  }

  function stepFrame(dir, big = false) {
    const fps = 30;
    seek(virtualTime + (dir * (big ? 10 : 1)) / fps);
  }

  store.subscribe(() => {
    const state = store.getState();
    const total = totalDuration(state);
    if (virtualTime > total) { virtualTime = total; emit(); }
    videoEl.muted = !!state.audio_detached;
    if (!playing) syncVideoToVirtual();
    syncPool();
  });

  return {
    play, pause, seek, stepFrame,
    toggle() { playing ? pause() : play(); },
    isPlaying: () => playing,
    getTime: () => virtualTime,
    getDuration: () => totalDuration(store.getState()),
    getSourceTime: () => timelineToSource(store.getState(), virtualTime),
    onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    destroy() {
      pause();
      for (const [, e] of pool) { e.el.pause(); e.el.removeAttribute('src'); }
      pool.clear();
      listeners.clear();
    },
  };
}
