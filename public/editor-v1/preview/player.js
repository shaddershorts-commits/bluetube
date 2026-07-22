// editor-v1/preview/player.js
// Transporte com TEMPO VIRTUAL + mixer multi-audio + DOUBLE BUFFER de vídeo.
// - dois <video> empilhados: o ativo mostra a cena atual, o buffer PRÉ-CARREGA
//   a próxima fonte (take). Ao cruzar a fronteira entre fontes diferentes, faz
//   um swap instantâneo — sem a tela preta de load() (user 2026-07-20).
// - cada audio_clip ganha um Audio() próprio, agendado por start/source_in/out.

import { timelineToSource, totalDuration, playableDuration, segmentAt, timelineSegments, effectiveAudioClips, mediaUrlFor, clipSpeed, segSpeed, audioTimelineDur } from '../core/selectors.js';

// opts.primaryUrl(): url preferida do video PRINCIPAL. opts.bufferEl: 2º <video>.
export function createPlayer(videoEl, opts, store) {
  let virtualTime = 0;
  let playing = false;
  let rafId = 0;
  let lastTick = 0;
  const listeners = new Set();
  const pool = new Map(); // audio_clip.id -> { el, url }

  // double buffer: els[active] mostra, els[1-active] pré-carrega
  const els = [videoEl, opts?.bufferEl].filter(Boolean);
  let active = 0;
  const disp = () => els[active];
  const buf = () => (els.length > 1 ? els[1 - active] : null);

  function emit() { for (const fn of listeners) fn(); }
  function primaryUrl() { return opts?.primaryUrl?.() || store.getState().video?.url || null; }
  function urlForClip(state, clip) {
    return clip.media_id != null ? mediaUrlFor(state, clip) : primaryUrl();
  }
  function applyVisibility() {
    els.forEach((el, i) => el.classList.toggle('be-buffering', i !== active));
  }

  // cada elemento aplica seu próprio seek pendente quando a mídia carrega
  els.forEach((el) => {
    el.addEventListener('loadedmetadata', () => {
      if (el._pendingSeek == null) return;
      try { el.currentTime = el._pendingSeek; } catch {}
      el._pendingSeek = null;
      if (playing && el === disp()) el.play().catch(() => {});
    });
  });

  // tempo no arquivo pro instante virtual, considerando velocidade/reverso/frozen
  function srcForSeg(seg, tv) {
    const c = seg.clip;
    if (c.frozen) return c.freeze_src || 0;
    const off = (tv - seg.tStart) * segSpeed(seg);
    return c.reversed ? Math.max(c.source_in, c.source_out - off) : c.source_in + off;
  }

  function syncVideoToVirtual(seekVideo = true) {
    const state = store.getState();
    const tClamped = Math.min(virtualTime, Math.max(0, totalDuration(state) - 0.001));
    const seg = segmentAt(state, tClamped);
    const src = seg ? srcForSeg(seg, tClamped) : null;
    const d = disp();
    // Sem clip ativo (faixa excluída/gap): esconde (preto) até voltar conteúdo.
    d.style.visibility = src == null ? 'hidden' : '';
    if (src == null) return;
    d.playbackRate = segSpeed(seg);
    const url = urlForClip(state, seg.clip);
    const atual = d.currentSrc || d.src || '';
    if (url && atual !== url) {
      const b = buf();
      if (b && b.dataset.loadedUrl === url && b.readyState >= 2) {
        // SWAP instantâneo: o buffer já tem esse take decodificado
        active = 1 - active;
        applyVisibility();
        const nd = disp();
        nd._pendingSeek = null;
        nd._swapTo = null;
        nd.style.visibility = '';
        nd.muted = !!state.audio_detached;
        nd.volume = Math.min(1, state.volumes?.video ?? 1);
        nd.playbackRate = segSpeed(seg);
        try { nd.currentTime = src; } catch {}
        if (playing) nd.play().catch(() => {});
        buf().pause();
        buf().dataset.loadedUrl = '';
        return;
      }
      // SEM buffer pronto. DURANTE PLAYBACK: NUNCA faz load() no display (isso
      // apaga = "tela preta" entre takes) — garante o buffer carregando essa
      // fonte e marca a troca pendente; o tick segura o ÚLTIMO FRAME congelado
      // e troca quando o buffer decodifica. PAUSADO (scrub): não há tick pra
      // dirigir a troca, então load direto (pisca uma vez, aceitável no scrub).
      const bb = buf();
      if (bb && playing) {
        if (bb.dataset.loadedUrl !== url) {
          bb.dataset.loadedUrl = url;
          bb._pendingSeek = src;
          bb.muted = true;
          bb.src = url;
          bb.load();
        }
        d._swapTo = { url, src, t0: (typeof performance !== 'undefined' ? performance.now() : Date.now()) };
        return;
      }
      d._swapTo = null;
      d.src = url; d.load(); d._pendingSeek = src;
      return;
    }
    if (seekVideo && d._pendingSeek == null && Math.abs(d.currentTime - src) > 0.06) {
      d.currentTime = src;
    }
  }

  // próximo segmento CONTÍGUO na mesma fonte (o vídeo pode tocar direto pra
  // dentro dele, sem seek). Ex: um vídeo cortado em 2, ou os sub-clips de um
  // composto que vieram do mesmo arquivo.
  function nextContiguous(state, seg) {
    const segs = timelineSegments(state);
    const nx = segs.find(s => s.tStart >= seg.tEnd - 1e-6);
    if (!nx) return null;
    const c = seg.clip, n = nx.clip;
    if (n.frozen || n.reversed || c.frozen || c.reversed) return null;
    if (urlForClip(state, n) !== urlForClip(state, c)) return null;   // fonte diferente
    if (Math.abs(segSpeed(nx) - segSpeed(seg)) > 1e-3) return null;   // velocidade diferente
    if (Math.abs(n.source_in - c.source_out) > 0.12) return null;    // não colado no arquivo
    return nx;
  }

  // pré-carrega a PRÓXIMA fonte no buffer (só durante playback, só se a fonte
  // muda — clips do mesmo arquivo não precisam de swap)
  function preloadNext(state) {
    const b = buf();
    if (!b) return;
    const cur = segmentAt(state, virtualTime);
    if (!cur) return;
    const segs = timelineSegments(state);
    const idx = segs.indexOf(cur);
    const nx = idx >= 0 ? segs[idx + 1] : null;
    if (!nx || nx.clip.frozen || nx.clip.reversed) return;
    const nurl = urlForClip(state, nx.clip);
    const curUrl = urlForClip(state, cur.clip);
    if (!nurl || nurl === curUrl) return;        // mesma fonte: sem flash mesmo
    if (b.dataset.loadedUrl === nurl) return;    // já pré-carregado
    b.dataset.loadedUrl = nurl;
    b._pendingSeek = nx.clip.reversed ? nx.clip.source_out : nx.clip.source_in;
    b.muted = true;
    b.src = nurl;
    b.load();
  }

  function syncPool() {
    const state = store.getState();
    const clips = effectiveAudioClips(state);
    const seen = new Set();
    for (const a of clips) {
      seen.add(a.id);
      const url = a.kind === 'video' ? primaryUrl() : a.url;
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

  function syncAudios(t) {
    const state = store.getState();
    for (const a of effectiveAudioClips(state)) {
      const entry = pool.get(a.id);
      if (!entry) continue;
      const el = entry.el;
      const sp = clipSpeed(a);
      const dur = audioTimelineDur(a);
      const inside = t >= a.start - 0.02 && t < a.start + dur;
      el.volume = Math.min(1, a.volume ?? 1);
      el.playbackRate = sp;
      if (inside) {
        const local = a.source_in + (t - a.start) * sp;
        if (Math.abs(el.currentTime - local) > 0.25 * sp) {
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
    const total = playableDuration(state);
    const dt = lastTick ? (ts - lastTick) / 1000 : 0;
    lastTick = ts;
    const d = disp();

    // TROCA PENDENTE pra fonte nova (take seguinte): mantém o último frame no
    // lugar do preto e troca assim que o buffer decodifica — playback fluido.
    if (d._swapTo) {
      const bb = buf();
      const ready = bb && bb.dataset.loadedUrl === d._swapTo.url && bb.readyState >= 2;
      if (ready) {
        const tgt = d._swapTo.src;
        active = 1 - active;
        applyVisibility();
        const nd = disp();
        nd._swapTo = null; nd._pendingSeek = null; nd.style.visibility = '';
        nd.muted = !!state.audio_detached;
        nd.volume = Math.min(1, state.volumes?.video ?? 1);
        const s2 = segmentAt(state, virtualTime);
        nd.playbackRate = s2 ? segSpeed(s2) : 1;
        try { nd.currentTime = tgt; } catch {}
        if (playing) nd.play().catch(() => {});
        buf().pause();
        buf().dataset.loadedUrl = '';
      } else {
        const espera = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - (d._swapTo.t0 || 0);
        if (espera > 4000) {
          // buffer não veio em 4s (rede ruim): aceita o load (pisca uma vez, mas
          // não trava pra sempre)
          const u = d._swapTo.url, s = d._swapTo.src; d._swapTo = null;
          d.src = u; d.load(); d._pendingSeek = s;
        } else {
          // ainda decodificando: congela o último frame (sem preto) e espera
          if (!d.paused) d.pause();
        }
        rafId = requestAnimationFrame(tick);
        return;
      }
    }

    const seg = segmentAt(state, virtualTime);
    if (seg && d._pendingSeek != null) {
      // trocando de fonte (load em andamento): segura o relógio
      rafId = requestAnimationFrame(tick);
      return;
    }
    if (seg && (seg.clip.frozen || seg.clip.reversed)) {
      // congelado (1 frame) ou reverso (scrub pra trás): relógio por rAF
      if (!d.paused) d.pause();
      virtualTime += dt;
      if (virtualTime >= total) { pause(); virtualTime = total; emit(); return; }
      if (virtualTime >= seg.tEnd - 1e-3) virtualTime = seg.tEnd + 0.001;
      syncVideoToVirtual();
      syncAudios(virtualTime);
      emit();
      rafId = requestAnimationFrame(tick);
      return;
    }
    if (seg) {
      if (d.paused) d.play().catch(() => {});
      // garante que o elemento EM EXIBIÇÃO nunca fica mudo (o buffer é mutado
      // no preload; sem isso o áudio sumia às vezes após um swap — user #6)
      d.muted = !!state.audio_detached;
      d.volume = Math.min(1, state.volumes?.video ?? 1);
      d.playbackRate = segSpeed(seg);
      preloadNext(state); // aquece o buffer com a próxima fonte
      const vSrc = d.currentTime;
      if (vSrc >= seg.clip.source_in - 0.08 && vSrc <= seg.clip.source_out + 0.2) {
        virtualTime = seg.tStart + Math.max(0, vSrc - seg.clip.source_in) / segSpeed(seg);
        if (vSrc >= seg.clip.source_out - 0.03) {
          // fim do clip: se o próximo é CONTÍGUO na mesma fonte (split simples,
          // inclusive dentro do composto), DEIXA FLUIR — o <video> continua
          // tocando pra dentro do próximo, sem seek. Isso mata a tela preta e o
          // áudio repetindo a palavra (user 2026-07-20).
          if (!nextContiguous(state, seg)) {
            const nextT = seg.tEnd + 0.001;
            if (nextT >= total) { pause(); virtualTime = total; emit(); return; }
            virtualTime = nextT;
            syncVideoToVirtual();
          }
        }
      } else {
        syncVideoToVirtual();
      }
    } else {
      // gap sem video (só-audio / audio além do fim): <video> pausa
      if (!d.paused) d.pause();
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
    const total = playableDuration(state);
    if (total <= 0) return;
    if (virtualTime >= total - 0.01) virtualTime = 0;
    syncPool();
    syncVideoToVirtual();
    const d = disp();
    d.muted = !!state.audio_detached;
    d.volume = Math.min(1, state.volumes?.video ?? 1);
    playing = true;
    lastTick = 0;
    if (segmentAt(state, virtualTime)) d.play().catch(() => {});
    syncAudios(virtualTime);
    rafId = requestAnimationFrame(tick);
    emit();
  }

  function pause() {
    playing = false;
    cancelAnimationFrame(rafId);
    els.forEach((el) => el.pause());
    for (const [, entry] of pool) entry.el.pause();
    emit();
  }

  function seek(t) {
    const total = playableDuration(store.getState());
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
    const total = playableDuration(state);
    if (virtualTime > total) { virtualTime = total; emit(); }
    disp().muted = !!state.audio_detached;
    if (!playing) syncVideoToVirtual();
    syncPool();
  });

  return {
    play, pause, seek, stepFrame,
    toggle() { playing ? pause() : play(); },
    isPlaying: () => playing,
    getTime: () => virtualTime,
    getDuration: () => playableDuration(store.getState()),
    getSourceTime: () => timelineToSource(store.getState(), virtualTime),
    getDisplayEl: () => disp(),           // shell aplica transform no elemento ativo
    onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    destroy() {
      pause();
      for (const [, e] of pool) { e.el.pause(); e.el.removeAttribute('src'); }
      pool.clear();
      listeners.clear();
    },
  };
}
