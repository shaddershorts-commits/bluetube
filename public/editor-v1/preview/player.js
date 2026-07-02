// editor-v1/preview/player.js
// Transporte com TEMPO VIRTUAL: o player expoe currentTime/duration no tempo
// da timeline (clips ativos concatenados) e mapeia pro <video> via selectors.
// Pula automaticamente trechos removidos durante o playback.

import { timelineToSource, sourceToTimeline, totalDuration, segmentAt, timelineSegments } from '../core/selectors.js';

export function createPlayer(videoEl, audioEl, store) {
  let virtualTime = 0;        // fonte de verdade do playhead (tempo virtual)
  let playing = false;
  let rafId = 0;
  let lastTick = 0;
  const listeners = new Set();

  function emit() { for (const fn of listeners) fn(); }

  function syncVideoToVirtual(seekVideo = true) {
    const state = store.getState();
    const src = timelineToSource(state, Math.min(virtualTime, Math.max(0, totalDuration(state) - 0.001)));
    if (src != null && seekVideo && Math.abs(videoEl.currentTime - src) > 0.06) {
      videoEl.currentTime = src;
    }
  }

  function syncAudio() {
    if (!audioEl || !audioEl.src) return;
    const state = store.getState();
    const vol = state.volumes?.audio_extra ?? 1;
    audioEl.volume = Math.min(1, vol); // volume >1 so no export
    if (Math.abs(audioEl.currentTime - virtualTime) > 0.25) {
      try { audioEl.currentTime = Math.min(virtualTime, audioEl.duration || virtualTime); } catch {}
    }
  }

  function tick(ts) {
    if (!playing) return;
    const state = store.getState();
    const total = totalDuration(state);
    const dt = lastTick ? (ts - lastTick) / 1000 : 0;
    lastTick = ts;

    // Avanco baseado no video real (mais preciso) quando dentro de um segmento
    const seg = segmentAt(state, virtualTime);
    if (seg) {
      const vSrc = videoEl.currentTime;
      // dentro do mesmo segmento? tempo virtual = tStart + (vSrc - source_in)
      if (vSrc >= seg.clip.source_in - 0.05 && vSrc <= seg.clip.source_out + 0.05) {
        virtualTime = seg.tStart + Math.max(0, vSrc - seg.clip.source_in);
        // passou do fim do segmento -> pula pro proximo
        if (vSrc >= seg.clip.source_out - 0.03) {
          const nextT = seg.tEnd + 0.001;
          if (nextT >= total) { pause(); virtualTime = total; emit(); return; }
          virtualTime = nextT;
          syncVideoToVirtual();
        }
      } else {
        // video dessincronizado (seek externo?) -> força
        syncVideoToVirtual();
      }
    } else {
      virtualTime += dt;
      if (virtualTime >= total) { pause(); virtualTime = total; emit(); return; }
      syncVideoToVirtual();
    }
    syncAudio();
    emit();
    rafId = requestAnimationFrame(tick);
  }

  function play() {
    const state = store.getState();
    const total = totalDuration(state);
    if (total <= 0) return;
    if (virtualTime >= total - 0.01) virtualTime = 0;
    syncVideoToVirtual();
    const vol = state.volumes?.video ?? 1;
    videoEl.volume = Math.min(1, vol);
    playing = true;
    lastTick = 0;
    videoEl.play().catch(() => {});
    if (audioEl?.src) { syncAudio(); audioEl.play().catch(() => {}); }
    rafId = requestAnimationFrame(tick);
    emit();
  }

  function pause() {
    playing = false;
    cancelAnimationFrame(rafId);
    videoEl.pause();
    audioEl?.pause?.();
    emit();
  }

  function seek(t) {
    const total = totalDuration(store.getState());
    virtualTime = Math.min(Math.max(0, t), total);
    syncVideoToVirtual();
    syncAudio();
    emit();
  }

  function stepFrame(dir, big = false) {
    const fps = 30;
    seek(virtualTime + (dir * (big ? 10 : 1)) / fps);
  }

  // Se o documento mudar (split/delete/trim), garante que o playhead continua valido
  store.subscribe(() => {
    const total = totalDuration(store.getState());
    if (virtualTime > total) { virtualTime = total; emit(); }
    if (!playing) syncVideoToVirtual();
  });

  return {
    play, pause, seek, stepFrame,
    toggle() { playing ? pause() : play(); },
    isPlaying: () => playing,
    getTime: () => virtualTime,
    getDuration: () => totalDuration(store.getState()),
    /** tempo source atual do <video> mapeado, pra overlay/texto */
    getSourceTime: () => timelineToSource(store.getState(), virtualTime),
    onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    destroy() { pause(); listeners.clear(); },
  };
}
