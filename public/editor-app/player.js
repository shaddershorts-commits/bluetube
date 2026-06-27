/* ═══════════════════════════════════════════════════════════════════════════
   player.js — HTML5 video + transport + keyboard shortcuts
   ═══════════════════════════════════════════════════════════════════════════
   - <video playsinline> dentro do preview-frame (iOS-safe)
   - Botoes prev/play/next + display de tempo mm:ss.ff
   - Keyboard: Space (play/pause), Left/Right (seek 1s), Home (0), End (duration)
   - Sincroniza currentTime com state.trim pra "tocar trecho" (Fase 2)
   - Aspect strategy: vertical OK, horizontal/square aplica crop ou letterbox

   Em fases futuras adiciona:
   - Canvas overlay pra textos sincronizado (Fase 4)
   - Mixer Web Audio pra audio extra (Fase 5)
   ═══════════════════════════════════════════════════════════════════════════ */

window.BEPlayer = (function() {
  'use strict';

  let videoEl = null;
  let frameEl = null;
  let timeCurrentEl = null;
  let timeTotalEl = null;
  let keyboardBound = false;
  let lastState = null;
  let skipRangesEnabled = true; // pula regioes "cortadas" em tempo real

  // ─── Format mm:ss.ff (frames a 30fps) ──────────────────────────────────
  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const total = Math.max(0, t);
    const m = Math.floor(total / 60);
    const s = Math.floor(total - m * 60);
    const ff = Math.floor((total - Math.floor(total)) * 30);
    return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0') + '.' + String(ff).padStart(2,'0');
  }

  // ─── Cria estrutura do player no preview-frame ─────────────────────────
  function render() {
    frameEl = document.getElementById('previewFrame');
    timeCurrentEl = document.getElementById('timeCurrent');
    timeTotalEl = document.getElementById('timeTotal');
    if (!frameEl) return;

    frameEl.innerHTML = '';
    videoEl = document.createElement('video');
    videoEl.id = 'previewVideo';
    videoEl.playsInline = true;     // iOS — evita fullscreen forcado
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('webkit-playsinline', '');
    videoEl.crossOrigin = 'anonymous'; // permite probe de dimensoes via canvas futuro
    videoEl.preload = 'auto';
    videoEl.style.width = '100%';
    videoEl.style.height = '100%';
    videoEl.style.background = '#000';
    frameEl.appendChild(videoEl);

    // Aplica aspect strategy ao carregar source
    videoEl.addEventListener('loadedmetadata', applyAspectStrategy);
    videoEl.addEventListener('timeupdate', () => {
      onTimeUpdate();
      enforceSkipRanges(); // Pula automatico regioes cortadas
    });
    videoEl.addEventListener('seeking', enforceSkipRanges);
    videoEl.addEventListener('play', () => updatePlayBtn(true));
    videoEl.addEventListener('pause', () => updatePlayBtn(false));
    videoEl.addEventListener('ended', () => updatePlayBtn(false));
  }

  // ─── Skip ranges: pula regioes "fora dos clips ativos" em tempo real ────
  // Cortes = source preserva mas player pula. Sequencia logica:
  //   Source: [0────────────10────────────20────────────30]
  //   Clips ativos: [2, 8], [15, 25]
  //   Player toca 2-8, pula pra 15, toca 15-25, pausa.
  function enforceSkipRanges() {
    if (!skipRangesEnabled || !videoEl) return;
    const s = BEState.get();
    if (!s.video || !s.video.duration) return;
    const clips = BEState.getEffectiveClips().filter(c => c.active !== false);
    if (clips.length === 0) return;
    const t = videoEl.currentTime;
    // Verifica se t cai DENTRO de algum clip ativo
    for (const c of clips) {
      if (t >= c.source_in - 0.05 && t <= c.source_out + 0.05) return; // OK
    }
    // Fora de qualquer clip ativo — encontra proximo clip
    const sorted = [...clips].sort((a, b) => a.source_in - b.source_in);
    const next = sorted.find(c => c.source_in > t);
    if (next) {
      videoEl.currentTime = next.source_in;
    } else {
      // Passou do ultimo clip — pausa no inicio do primeiro
      videoEl.pause();
      videoEl.currentTime = sorted[0].source_in;
    }
  }

  // ─── Aspect: vertical = fit normal, horizontal/square = sera ajustado no export ─
  // Pra preview, mostramos o video como esta (object-fit: contain) com aviso visual
  // se nao for 9:16. Strategy real (crop/letterbox) sera aplicada no render Railway.
  function applyAspectStrategy() {
    if (!videoEl) return;
    const s = BEState.get();
    const aspect = s.video.aspect;
    // Default: contain (mostra video inteiro respeitando aspect ratio)
    videoEl.style.objectFit = 'contain';
    // TODO Fase 7: passar aspect_strategy pro Railway no export
    showAspectHintIfNeeded(aspect);
  }

  function showAspectHintIfNeeded(aspect) {
    if (!frameEl) return;
    const existing = frameEl.querySelector('.aspect-hint');
    if (existing) existing.remove();
    if (aspect === 'vertical') return;
    const hint = document.createElement('div');
    hint.className = 'aspect-hint';
    hint.textContent = aspect === 'horizontal'
      ? '📐 Vídeo horizontal · será ajustado pra 9:16 no export'
      : '📐 Vídeo quadrado · será ajustado pra 9:16 no export';
    frameEl.appendChild(hint);
  }

  // ─── Carrega video do state ────────────────────────────────────────────
  function loadFromState(s) {
    if (!videoEl) render();
    if (!s.video.url) return;
    if (videoEl.src !== s.video.url) {
      videoEl.src = s.video.url;
      videoEl.load();
    }
    if (timeTotalEl) timeTotalEl.textContent = fmt(s.video.duration);
    enableTransport(true);
  }

  function onTimeUpdate() {
    if (timeCurrentEl) timeCurrentEl.textContent = fmt(videoEl.currentTime || 0);
  }

  function updatePlayBtn(playing) {
    const playBtn = document.querySelector('.transport-btn[data-action="play"]');
    if (playBtn) playBtn.textContent = playing ? '⏸' : '⏵';
  }

  // ─── Transport controls ────────────────────────────────────────────────
  function enableTransport(enabled) {
    const controls = document.querySelector('.transport-controls');
    if (!controls) return;
    // Reconstrucao simples — substitui placeholders por botoes ativos
    controls.innerHTML = `
      <button class="transport-btn" data-action="prev" title="Início (Home)">⏮</button>
      <button class="transport-btn" data-action="play" title="Play/Pause (Espaço)">⏵</button>
      <button class="transport-btn" data-action="next" title="Fim (End)">⏭</button>
    `;
    controls.querySelectorAll('.transport-btn').forEach(b => {
      b.disabled = !enabled;
      b.addEventListener('click', () => {
        const act = b.dataset.action;
        if (act === 'play') togglePlay();
        else if (act === 'prev') seekTo(0);
        else if (act === 'next') seekTo(videoEl?.duration || 0);
      });
    });
    bindKeyboardOnce();
  }

  function togglePlay() {
    if (!videoEl) return;
    if (videoEl.paused) videoEl.play().catch(e => console.warn('[play]', e.message));
    else videoEl.pause();
  }

  function seekTo(t) {
    if (!videoEl || !isFinite(t)) return;
    videoEl.currentTime = Math.max(0, Math.min(videoEl.duration || t, t));
  }

  function seekBy(delta) {
    if (!videoEl) return;
    seekTo((videoEl.currentTime || 0) + delta);
  }

  // ─── Keyboard shortcuts ────────────────────────────────────────────────
  function bindKeyboardOnce() {
    if (keyboardBound) return;
    keyboardBound = true;
    document.addEventListener('keydown', e => {
      // Ignora se foco em input/textarea
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!videoEl || !videoEl.src) return;
      switch (e.key) {
        case ' ': e.preventDefault(); togglePlay(); break;
        case 'ArrowLeft': e.preventDefault(); seekBy(e.shiftKey ? -5 : -1); break;
        case 'ArrowRight': e.preventDefault(); seekBy(e.shiftKey ? 5 : 1); break;
        case 'Home': e.preventDefault(); seekTo(0); break;
        case 'End': e.preventDefault(); seekTo(videoEl.duration || 0); break;
      }
    });
  }

  // ─── Re-render quando state muda ───────────────────────────────────────
  function onStateChange(s) {
    lastState = s;
    if (s.video && s.video.url) loadFromState(s);
  }

  function init() {
    render();
    BEState.subscribe(onStateChange);
  }

  return { init, loadFromState, togglePlay, seekTo };
})();
