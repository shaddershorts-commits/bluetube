/* ═══════════════════════════════════════════════════════════════════════════
   BlueEditor V0 — entry point (Fase 0)
   Responsabilidades:
     1. Carrega feature flag do backend (EDITOR_V0_ENABLED)
     2. Valida auth + plano Master (gate visual)
     3. Inicializa app shell + status debug
   Fases futuras adicionam módulos separados (player, timeline, etc).
   ═══════════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  // ───────────────────────────────────────────────────────────────────────
  // Estado global mínimo (será expandido em fases futuras)
  // ───────────────────────────────────────────────────────────────────────
  const state = {
    flag: null,        // EDITOR_V0_ENABLED do servidor
    auth: null,        // { logged, email, plan }
    project: null,     // editor_jobs row (autosave) — Fase 1+
  };

  // Refs DOM
  const $ = (sel) => document.querySelector(sel);
  const refs = {
    gate: $('#gateOverlay'),
    gateMsg: $('#gateMsg'),
    gateActions: $('#gateActions'),
    app: $('#appRoot'),
    flagStatus: $('#flagStatus'),
    authStatus: $('#authStatus'),
    statusDevice: $('#statusDevice'),
    statusViewport: $('#statusViewport'),
    statusEnv: $('#statusEnv'),
    timelineCanvas: $('#timelineCanvas'),
  };

  // ───────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────
  function showGate(msg, actions) {
    refs.gateMsg.innerHTML = msg;
    refs.gateActions.innerHTML = '';
    (actions || []).forEach(a => {
      const el = document.createElement(a.href ? 'a' : 'button');
      el.className = a.kind || 'primary';
      el.textContent = a.label;
      if (a.href) el.href = a.href;
      if (a.onclick) el.addEventListener('click', a.onclick);
      refs.gateActions.appendChild(el);
    });
    refs.gate.hidden = false;
    refs.app.hidden = true;
  }

  function showApp() {
    refs.gate.hidden = true;
    refs.app.hidden = false;
  }

  function detectDevice() {
    const ua = navigator.userAgent;
    const isMobile = /Mobile|Android|iPhone|iPad/i.test(ua);
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const isAndroid = /Android/i.test(ua);
    const isMac = /Macintosh/i.test(ua);
    let label = 'desktop';
    if (isIOS) label = 'iOS';
    else if (isAndroid) label = 'Android';
    else if (isMobile) label = 'mobile';
    else if (isMac) label = 'macOS';
    else label = 'desktop';
    return { label, isMobile, isIOS, isAndroid };
  }

  function updateViewportStatus() {
    if (refs.statusViewport) {
      refs.statusViewport.textContent = `viewport: ${window.innerWidth}×${window.innerHeight}`;
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Auth (reusa padrão do BlueTube — bt_token no localStorage)
  // ───────────────────────────────────────────────────────────────────────
  async function loadAuth() {
    const token = localStorage.getItem('bt_token');
    if (!token) return { logged: false };
    try {
      // editor-espera.js já tem GET ?action=plano que valida token + retorna plano
      const r = await fetch('/api/editor-espera?action=plano&token=' + encodeURIComponent(token));
      if (!r.ok) return { logged: false };
      const d = await r.json();
      return {
        logged: d.plano !== 'guest',
        plan: d.plano || 'guest',
        nome: d.nome || null,
      };
    } catch (e) {
      console.warn('[editor] auth check falhou:', e.message);
      return { logged: false, error: e.message };
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Feature flag (lê env exposta via endpoint público — Fase 0 simples)
  // ───────────────────────────────────────────────────────────────────────
  async function loadFlag() {
    try {
      const r = await fetch('/api/editor-flag', { cache: 'no-store' });
      if (!r.ok) return { enabled: false, reason: 'flag_endpoint_missing' };
      const d = await r.json();
      return d;
    } catch (e) {
      return { enabled: false, reason: 'flag_fetch_failed' };
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Boot sequence
  // ───────────────────────────────────────────────────────────────────────
  async function boot() {
    const dev = detectDevice();
    if (refs.statusDevice) refs.statusDevice.textContent = `device: ${dev.label}`;
    if (refs.statusEnv) {
      const isPreview = location.hostname.includes('vercel.app');
      const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
      refs.statusEnv.textContent = `env: ${isLocal ? 'local' : isPreview ? 'preview' : 'prod'}`;
    }
    updateViewportStatus();
    window.addEventListener('resize', updateViewportStatus);

    // Carrega flag + auth em paralelo
    const [flag, auth] = await Promise.all([loadFlag(), loadAuth()]);
    state.flag = flag;
    state.auth = auth;

    if (refs.flagStatus) {
      refs.flagStatus.textContent = flag.enabled ? 'ON' : `OFF (${flag.reason || 'desligado'})`;
      refs.flagStatus.style.color = flag.enabled ? 'var(--ok)' : 'var(--text-3)';
    }
    if (refs.authStatus) {
      refs.authStatus.textContent = auth.logged ? `${auth.plan}` : 'deslogado';
      refs.authStatus.style.color = auth.logged && (auth.plan === 'master' || auth.plan === 'full') ? 'var(--ok)' : 'var(--text-3)';
    }

    // ── Gate logic ───────────────────────────────────────────────────────
    if (!flag.enabled) {
      showGate(
        `<strong>Em construção.</strong><br>` +
        `O BlueEditor está em desenvolvimento.<br><br>` +
        `<span style="font-size:12px;color:var(--text-3)">Motivo: <code>${flag.reason || 'flag desligada'}</code></span>`,
        [
          { label: '← Voltar pro BlueTube', kind: 'secondary', href: '/' },
        ]
      );
      return;
    }

    if (!auth.logged) {
      // Volta pro editor apos login. encodeURIComponent garante URL valida.
      const back = encodeURIComponent('/blueEditor-app');
      showGate(
        `<strong>Faça login pra acessar.</strong><br>` +
        `O BlueEditor está em fase de teste fechada.<br><br>` +
        `<span style="font-size:12px;color:var(--text-3)">Atenção: preview deploy tem login separado do site principal.</span>`,
        [
          { label: 'Entrar →', kind: 'primary', href: '/?login=1&redirect=' + back },
          { label: '← Voltar', kind: 'secondary', href: '/' },
        ]
      );
      return;
    }

    if (auth.plan !== 'master') {
      // FASE 0/teste: libera Full tambem (so eu testando, master eterno funciona)
      // FASE 11+ produto: trava em master only via feature flag separada
      const isTestEnv = location.hostname.includes('vercel.app') || location.hostname === 'localhost';
      if (!isTestEnv) {
        showGate(
          `<strong>Exclusivo Master.</strong><br>` +
          `O BlueEditor está disponível pra contas Master ativas.<br><br>` +
          `<span style="font-size:12px;color:var(--text-3)">Seu plano atual: <strong>${auth.plan}</strong></span>`,
          [
            { label: 'Fazer upgrade pro Master →', kind: 'gold', href: '/#plans' },
            { label: '← Voltar', kind: 'secondary', href: '/' },
          ]
        );
        return;
      }
      console.warn('[BlueEditor V0] plano ' + auth.plan + ' liberado em ambiente de teste (' + location.hostname + ')');
    }

    // ── Tudo certo: renderiza app ────────────────────────────────────────
    showApp();
    console.log('[BlueEditor V0] Fase 1 ativa', { flag, auth, device: dev });

    // Inicializa state + player + decide tela (upload ou editor montado)
    await BEEditor.init();
  }

  // ───────────────────────────────────────────────────────────────────────
  // Orquestrador (exposto pra modulos chamarem afterUploadComplete etc)
  // ───────────────────────────────────────────────────────────────────────
  window.BEEditor = {
    state: null,
    async init() {
      // Inicializa state (carrega do servidor ou cria novo)
      this.state = await BEState.init();
      // Inicializa player (subscreve state changes)
      BEPlayer.init();
      // Inicializa thumbnails generator (extrai frames do video)
      if (window.BEThumbs) BEThumbs.init();
      // Inicializa timeline (Fase 2): canvas + handles + waveform + thumbs
      BETimeline.init();
      // Subscribe pra atualizar trim info display
      BEState.subscribe(s => {
        this.updateTrimInfo(s);
      });
      // Bind botão tocar trecho
      const btnPlay = document.getElementById('btnPlayTrim');
      if (btnPlay) {
        btnPlay.addEventListener('click', () => BETimeline.playRange());
      }

      // Fase 3: bind botoes timeline toolbar (split, delete, undo, redo)
      this.bindTimelineToolbar();
      this.bindKeyboardShortcuts();

      // Subscribe history pra atualizar disabled state dos botoes
      if (window.BEHistory) {
        BEHistory.subscribe(st => this.updateHistoryButtons(st));
        this.updateHistoryButtons(BEHistory.getState());
      }
      // Subscribe state pra atualizar botoes split/delete
      BEState.subscribe(s => this.updateClipsButtons(s));
      // Decide tela inicial baseado em ter video carregado
      const s = BEState.get();
      if (s.video && s.video.url) {
        this.showEditorMounted();
      } else {
        BEUpload.renderUploadScreen();
      }
      this.updateProjectName();
      this.updateFaseFlags();
      this.updateTrimInfo(s);
    },
    updateTrimInfo(s) {
      const el = document.getElementById('trimInfo');
      const btn = document.getElementById('btnPlayTrim');
      if (!el) return;
      const v = s.video;
      const hasVideo = v && v.duration > 0;
      const trimIn = s.trim?.in || 0;
      const trimOut = s.trim?.out > 0 ? s.trim.out : (v?.duration || 0);
      const isTrimmed = hasVideo && (trimIn > 0.05 || trimOut < v.duration - 0.05);
      if (isTrimmed) {
        el.hidden = false;
        el.textContent = '✂ ' + fmtTimeMs(trimIn) + ' → ' + fmtTimeMs(trimOut) + ' (' + fmtTimeMs(trimOut - trimIn) + ')';
      } else {
        el.hidden = true;
      }
      if (btn) btn.disabled = !hasVideo;
    },
    afterUploadComplete() {
      // Apos upload terminar, decide painel a mostrar
      this.showEditorMounted();
      this.updateProjectName();
    },
    showEditorMounted() {
      const panel = document.getElementById('panelBody');
      if (!panel) return;
      const s = BEState.get();
      const v = s.video;
      panel.innerHTML = `
        <div class="media-info">
          <div class="media-thumb">
            <svg viewBox="0 0 24 24" width="32" height="32"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 9l5 3-5 3V9z" fill="currentColor"/></svg>
          </div>
          <div class="media-detail">
            <div class="media-name" title="${escapeHtml(v.filename || 'video.mp4')}">${escapeHtml(v.filename || 'video.mp4')}</div>
            <div class="media-meta">
              <span>${fmtTime(v.duration)}</span>
              <span class="sep">·</span>
              <span>${v.width}×${v.height}</span>
              <span class="sep">·</span>
              <span class="badge-${v.aspect}">${labelAspect(v.aspect)}</span>
            </div>
          </div>
          <div class="media-actions">
            <button class="media-action" id="mediaReplaceBtn" title="Trocar vídeo">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.4-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.4 6.4L3 16"/><path d="M3 21v-5h5"/></svg>
            </button>
            <button class="media-action media-action-danger" id="mediaDeleteBtn" title="Excluir vídeo">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>
        </div>
        <div class="media-status">
          <p>Fase 2 ativa: timeline + waveform + thumbnails.</p>
          <p style="color:var(--text-3);font-size:12px;margin-top:6px">Use os handles azuis pra cortar início/fim. Ctrl+Scroll = zoom timeline. Próximas fases: cortes múltiplos (Fase 3), texto (Fase 4), áudio extra (Fase 5).</p>
        </div>
      `;
      const replaceBtn = document.getElementById('mediaReplaceBtn');
      if (replaceBtn) replaceBtn.addEventListener('click', () => {
        if (!confirm('Trocar de vídeo? O projeto atual será descartado.')) return;
        this.discardCurrentProject();
      });
      const delBtn = document.getElementById('mediaDeleteBtn');
      if (delBtn) delBtn.addEventListener('click', () => {
        if (!confirm('Excluir vídeo e descartar projeto?')) return;
        this.discardCurrentProject();
      });
    },
    async discardCurrentProject() {
      // Apaga do servidor se ja tem ID
      const s = BEState.get();
      if (s.project_id) {
        try {
          const token = localStorage.getItem('bt_token');
          await fetch('/api/blue-editor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete-project', token, project_id: s.project_id }),
          });
        } catch(e) { console.warn('[delete-project]', e.message); }
      }
      // Limpa state + thumbs + waveform
      BEState.reset();
      if (window.BEThumbs) BEThumbs.reset();
      BEUpload.renderUploadScreen();
      this.updateProjectName();
      this.updateTrimInfo(BEState.get());
    },
    updateProjectName() {
      const el = document.getElementById('projectName');
      if (el) el.textContent = BEState.get().nome_projeto || 'Projeto sem título';
    },
    updateFaseFlags() {
      const flagEl = document.querySelector('.header-flag');
      if (flagEl) flagEl.textContent = 'FASE 3 · cortes';
    },
    // ─── Fase 3: timeline toolbar + clips ─────────────────────────────────
    bindTimelineToolbar() {
      const toolbar = document.querySelector('.timeline-toolbar .toolbar-left');
      if (!toolbar) return;
      const btns = toolbar.querySelectorAll('button');
      // [0]=+ (add) [1]=✂ (split) [2]=🗑 (delete) [3]=↶ (undo) [4]=↷ (redo)
      if (btns[1]) {
        btns[1].title = 'Cortar aqui (C)';
        btns[1].addEventListener('click', () => this.actionSplit());
      }
      if (btns[2]) {
        btns[2].title = 'Excluir clipe (Delete)';
        btns[2].addEventListener('click', () => this.actionDelete());
      }
      if (btns[3]) {
        btns[3].title = 'Desfazer (Ctrl+Z)';
        btns[3].addEventListener('click', () => BEHistory && BEHistory.undo());
      }
      if (btns[4]) {
        btns[4].title = 'Refazer (Ctrl+Y)';
        btns[4].addEventListener('click', () => BEHistory && BEHistory.redo());
      }
      // Cache pra updateClipsButtons / updateHistoryButtons
      this._tbBtns = btns;
    },
    bindKeyboardShortcuts() {
      // Shortcuts CapCut Desktop (compativeis pra migracao):
      //   Ctrl+B       Split clip (substituiu meu C)
      //   Q            Delete left of playhead
      //   W            Delete right of playhead
      //   V            Toggle clip active (skip no export)
      //   I / O        Set In/Out point (trim global)
      //   Space        Play/Pause
      //   J / K / L    Shuttle (J=seek-, K=stop, L=seek+/play)
      //   ← / →        Frame backward/forward (Shift = 10 frames)
      //   Home / End   Go to start/end
      //   ↑ / ↓        Previous/next cut point
      //   Ctrl + Z     Undo
      //   Ctrl+Shift+Z / Ctrl+Y   Redo
      //   Ctrl + +/-   Zoom in/out timeline
      //   Shift + Z    Zoom to fit
      //   Shift + X    Select clip at playhead
      //   Alt + X      Deselect
      //   Delete/Backspace  Delete selected clip
      document.addEventListener('keydown', e => {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        const s = BEState.get();
        if (!s.video || !s.video.url) return;
        const vid = document.getElementById('previewVideo');
        const now = vid ? vid.currentTime : 0;
        const dur = s.video.duration || 0;
        const ctrl = e.ctrlKey || e.metaKey;
        const k = e.key;
        const lower = k.length === 1 ? k.toLowerCase() : k;

        // ─── Undo / Redo ────────────────────────────────────────────────
        if (ctrl && lower === 'z' && !e.shiftKey) {
          e.preventDefault(); BEHistory && BEHistory.undo(); return;
        }
        if ((ctrl && e.shiftKey && lower === 'z') || (ctrl && lower === 'y')) {
          e.preventDefault(); BEHistory && BEHistory.redo(); return;
        }
        // ─── Ctrl + B = Split (CapCut) ─────────────────────────────────
        if (ctrl && lower === 'b') {
          e.preventDefault(); this.actionSplit(); return;
        }
        // ─── Ctrl + +/- = Zoom timeline ────────────────────────────────
        if (ctrl && (k === '+' || k === '=')) {
          e.preventDefault(); BETimeline && BETimeline.zoomBy && BETimeline.zoomBy(1.5); return;
        }
        if (ctrl && k === '-') {
          e.preventDefault(); BETimeline && BETimeline.zoomBy && BETimeline.zoomBy(1/1.5); return;
        }
        // ─── Shift + Z = Zoom to fit ──────────────────────────────────
        if (e.shiftKey && lower === 'z') {
          e.preventDefault(); BETimeline && BETimeline.zoomFit && BETimeline.zoomFit(); return;
        }
        // ─── Shift + X = select clip at playhead, Alt + X = deselect ──
        if (e.shiftKey && lower === 'x') {
          e.preventDefault();
          const clip = BEState.clipAtTime(now);
          if (clip && !clip.virtual) BEState.selectClip(clip.id);
          return;
        }
        if (e.altKey && lower === 'x') {
          e.preventDefault(); BEState.selectClip(null); return;
        }
        // ─── Q / W: ripple delete left/right ──────────────────────────
        if (lower === 'q' && !ctrl && !e.altKey) {
          e.preventDefault();
          if (!window.BEClips || !BEClips.deleteLeftFromPlayhead(now)) {
            this.flashStatus('Posicione o playhead dentro de um clipe');
          }
          return;
        }
        if (lower === 'w' && !ctrl && !e.altKey) {
          e.preventDefault();
          if (!window.BEClips || !BEClips.deleteRightFromPlayhead(now)) {
            this.flashStatus('Posicione o playhead dentro de um clipe');
          }
          return;
        }
        // ─── V: toggle clip active ────────────────────────────────────
        if (lower === 'v' && !ctrl && !e.altKey && !e.shiftKey) {
          e.preventDefault();
          const id = s.selected_clip_id || (BEState.clipAtTime(now) || {}).id;
          if (id && window.BEClips) BEClips.toggleClipActiveById(id);
          return;
        }
        // ─── I / O: set trim In/Out ───────────────────────────────────
        if (lower === 'i' && !ctrl && !e.altKey) {
          e.preventDefault();
          BEState.patch({ trim: { in: now, out: s.trim.out || dur } });
          return;
        }
        if (lower === 'o' && !ctrl && !e.altKey) {
          e.preventDefault();
          BEState.patch({ trim: { in: s.trim.in || 0, out: now } });
          return;
        }
        // ─── Space: play/pause ────────────────────────────────────────
        if (k === ' ' && !ctrl && !e.altKey) {
          e.preventDefault();
          if (vid) { vid.paused ? vid.play().catch(()=>{}) : vid.pause(); }
          return;
        }
        // ─── J / K / L: shuttle ──────────────────────────────────────
        if (lower === 'j' && !ctrl) {
          e.preventDefault();
          if (vid) { vid.pause(); vid.currentTime = Math.max(0, now - 2); }
          return;
        }
        if (lower === 'k' && !ctrl) {
          e.preventDefault();
          if (vid) vid.pause();
          return;
        }
        if (lower === 'l' && !ctrl) {
          e.preventDefault();
          if (vid) vid.play().catch(()=>{});
          return;
        }
        // ─── Frame nav (← / → e Shift+ pra 10 frames) ────────────────
        const FRAME = 1/30;
        if (k === 'ArrowLeft') {
          e.preventDefault();
          if (vid) vid.currentTime = Math.max(0, now - FRAME * (e.shiftKey ? 10 : 1));
          return;
        }
        if (k === 'ArrowRight') {
          e.preventDefault();
          if (vid) vid.currentTime = Math.min(dur, now + FRAME * (e.shiftKey ? 10 : 1));
          return;
        }
        // ─── ↑ / ↓: cut point navigation ─────────────────────────────
        if (k === 'ArrowUp') {
          e.preventDefault();
          const cuts = this.getCutPoints();
          const prev = cuts.filter(t => t < now - 0.05).pop();
          if (vid && prev !== undefined) vid.currentTime = prev;
          return;
        }
        if (k === 'ArrowDown') {
          e.preventDefault();
          const cuts = this.getCutPoints();
          const next = cuts.find(t => t > now + 0.05);
          if (vid && next !== undefined) vid.currentTime = next;
          return;
        }
        // ─── Home / End ──────────────────────────────────────────────
        if (k === 'Home') {
          e.preventDefault();
          if (vid) vid.currentTime = 0;
          return;
        }
        if (k === 'End') {
          e.preventDefault();
          if (vid) vid.currentTime = dur;
          return;
        }
        // ─── Delete: deletar clip selecionado ────────────────────────
        if (k === 'Delete' || k === 'Backspace') {
          if (s.selected_clip_id) {
            e.preventDefault(); this.actionDelete();
          }
          return;
        }
      });
    },
    getCutPoints() {
      // Retorna lista de tempos onde ha cortes (boundaries dos clips)
      const clips = BEState.getEffectiveClips();
      const pts = new Set([0]);
      clips.forEach(c => { pts.add(c.source_in); pts.add(c.source_out); });
      return Array.from(pts).sort((a, b) => a - b);
    },
    actionSplit() {
      const vid = document.getElementById('previewVideo');
      const t = vid ? vid.currentTime : 0;
      if (!window.BEClips || !BEClips.canSplitAt(t)) {
        this.flashStatus('Posicione o playhead dentro de um clipe pra cortar');
        return;
      }
      BEClips.splitAtPlayhead(t);
    },
    actionDelete() {
      if (!window.BEClips || !BEClips.canDeleteSelected()) {
        this.flashStatus('Selecione um clipe pra excluir (clique no canvas)');
        return;
      }
      BEClips.deleteSelected();
    },
    flashStatus(msg) {
      const el = document.getElementById('saveStatus');
      if (!el) return;
      const old = el.textContent;
      el.textContent = '⚠ ' + msg;
      el.style.color = 'var(--warn)';
      setTimeout(() => {
        el.textContent = '○ pronto';
        el.style.color = '';
      }, 2200);
    },
    updateHistoryButtons(st) {
      if (!this._tbBtns) return;
      if (this._tbBtns[3]) this._tbBtns[3].disabled = !st.canUndo;
      if (this._tbBtns[4]) this._tbBtns[4].disabled = !st.canRedo;
    },
    updateClipsButtons(s) {
      if (!this._tbBtns) return;
      const hasVideo = !!(s.video && s.video.url);
      const canSplit = hasVideo && window.BEClips;
      const canDelete = hasVideo && window.BEClips && BEClips.canDeleteSelected();
      if (this._tbBtns[1]) this._tbBtns[1].disabled = !canSplit;
      if (this._tbBtns[2]) this._tbBtns[2].disabled = !canDelete;
    },
  };

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function fmtTime(s) {
    s = Math.max(0, s|0);
    const m = (s/60)|0;
    const r = s - m*60;
    return String(m).padStart(2,'0') + ':' + String(r).padStart(2,'0');
  }
  function fmtTimeMs(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = Math.floor(t - m * 60);
    const ms = Math.floor((t - Math.floor(t)) * 100);
    return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0') + '.' + String(ms).padStart(2,'0');
  }
  function labelAspect(a) {
    if (a === 'vertical') return '9:16';
    if (a === 'horizontal') return '16:9';
    if (a === 'square') return '1:1';
    return '?';
  }

  // Boot quando DOM pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
