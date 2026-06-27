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
      // Inicializa overlay de texto (Fase 4)
      if (window.BEText) BEText.init();
      // Inicializa áudio extra mixer (Fase 5)
      if (window.BEAudio) BEAudio.init();
      // Bind tabs do sidebar pra trocar painel
      this.bindSidebarTabs();
      // Subscribe pra atualizar trim info display
      BEState.subscribe(s => {
        this.updateTrimInfo(s);
      });
      // Bind botão tocar trecho
      const btnPlay = document.getElementById('btnPlayTrim');
      if (btnPlay) {
        btnPlay.addEventListener('click', () => BETimeline.playRange());
      }
      // Fase 8: bind botão Exportar
      const btnExp = document.querySelector('.btn-export');
      if (btnExp) {
        btnExp.disabled = false;
        btnExp.title = 'Exportar MP4 final';
        btnExp.addEventListener('click', () => this.openExportModal());
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
          <p>Use Ctrl+B pra cortar no playhead. Clique nos clips pra selecionar (borda dourada). Drag horizontal move o clip.</p>
          ${(s.clips && s.clips.length > 0) ? `
            <button class="btn-secondary" id="mediaResetClips" style="margin-top:10px;width:100%;padding:8px;font-size:12px">
              ↺ Resetar cortes (volta pro vídeo inteiro)
            </button>
            <p style="color:var(--text-3);font-size:11px;margin-top:6px">Você tem ${s.clips.length} clipe(s) cortado(s). Apertar acima descarta todos os cortes mantendo o vídeo.</p>
          ` : ''}
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
      const resetClipsBtn = document.getElementById('mediaResetClips');
      if (resetClipsBtn) resetClipsBtn.addEventListener('click', () => {
        if (!confirm('Descartar TODOS os cortes e voltar pro vídeo inteiro?')) return;
        // Reset clips + trim
        const st = BEState.get();
        BEState.replaceClips([]);
        BEState.patch({
          trim: { in: 0, out: st.video.duration || 0 },
          selected_clip_id: null,
        });
        if (window.BEHistory) BEHistory.clear();
        console.log('[BEEditor] cortes resetados — volta pro vídeo inteiro');
        this.showEditorMounted();
      });
    },
    async discardCurrentProject() {
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
      // Limpa TUDO: state, thumbs, history, undo/redo, sessionStorage
      BEState.reset();
      if (window.BEThumbs) BEThumbs.reset();
      if (window.BEHistory) BEHistory.clear();
      try { sessionStorage.removeItem('be_state_backup'); } catch(e) {}
      // Volta tab pra Media + render upload
      this.activeTab = 'media';
      document.querySelectorAll('.sidebar-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === 'media');
      });
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
      if (flagEl) flagEl.textContent = 'FASE 4-6 · texto, áudio, transições';
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
      const clips = BEState.getEffectiveClips();
      const pts = new Set([0]);
      clips.forEach(c => { pts.add(c.source_in); pts.add(c.source_out); });
      return Array.from(pts).sort((a, b) => a - b);
    },
    // ─── Fase 4: tabs do sidebar ──────────────────────────────────────────
    activeTab: 'media',
    _sidebarTabsBound: false,
    bindSidebarTabs() {
      // Listeners ficam no SIDEBAR (estatico), nao no painelBody (que e re-renderizado).
      // Idempotente — bind so 1 vez.
      if (this._sidebarTabsBound) return;
      const sidebar = document.querySelector('.editor-sidebar');
      if (!sidebar) return;
      sidebar.addEventListener('click', (e) => {
        const tab = e.target.closest('.sidebar-tab');
        if (!tab || tab.disabled) return;
        const t = tab.dataset.tab;
        if (!t) return;
        this.switchTab(t);
      });
      this._sidebarTabsBound = true;
    },
    switchTab(name) {
      this.activeTab = name;
      document.querySelectorAll('.sidebar-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === name);
      });
      const titleEl = document.getElementById('panelTitle');
      const labels = { media: 'Mídia', text: 'Texto', audio: 'Áudio', transitions: 'Transições', style: 'Estilo' };
      if (titleEl) titleEl.textContent = labels[name] || name;
      this.renderPanel(name);
      // Mobile: abre bottom sheet
      const isMobile = window.matchMedia('(max-width: 900px)').matches;
      const panel = document.querySelector('.editor-panel');
      if (panel && isMobile) panel.classList.add('open');
    },
    closeMobilePanel() {
      const panel = document.querySelector('.editor-panel');
      if (panel) panel.classList.remove('open');
    },
    renderPanel(name) {
      const s = BEState.get();
      const hasVideo = !!(s.video && s.video.url);
      if (!hasVideo) {
        BEUpload.renderUploadScreen();
        return;
      }
      if (name === 'media') this.showEditorMounted();
      else if (name === 'text') this.renderTextPanel();
      else if (name === 'audio') this.renderAudioPanel();
      else if (name === 'transitions') this.renderTransitionsPanel();
      else if (name === 'style') this.renderStylePanel();
    },
    renderTextPanel() {
      const panel = document.getElementById('panelBody');
      if (!panel) return;
      const s = BEState.get();
      const texts = s.texts || [];
      const selectedId = BEText && BEText.getSelectedTextId ? BEText.getSelectedTextId() : null;
      panel.innerHTML = `
        <button class="btn-add-item" id="btnAddText">+ Adicionar texto</button>
        <div class="text-list">
          ${texts.length === 0 ? '<div class="empty-list">Nenhum texto adicionado. Clica acima.</div>' :
            texts.map(t => `
              <div class="text-item ${selectedId === t.id ? 'selected' : ''}" data-id="${t.id}">
                <div class="text-item-content">
                  <div class="text-item-title">${escapeHtml(t.content || '(vazio)')}</div>
                  <div class="text-item-meta">${fmtTime(t.start_sec)} → ${fmtTime(t.end_sec)}</div>
                </div>
                <button class="text-item-edit" data-id="${t.id}" title="Editar">✎</button>
                <button class="text-item-delete" data-id="${t.id}" title="Excluir">🗑</button>
              </div>
            `).join('')
          }
        </div>
      `;
      const btnAdd = document.getElementById('btnAddText');
      if (btnAdd) btnAdd.addEventListener('click', () => this.openTextModal(null));
      panel.querySelectorAll('.text-item-edit').forEach(b => {
        b.addEventListener('click', () => this.openTextModal(parseInt(b.dataset.id, 10)));
      });
      panel.querySelectorAll('.text-item-delete').forEach(b => {
        b.addEventListener('click', () => {
          const id = parseInt(b.dataset.id, 10);
          if (!confirm('Excluir esse texto?')) return;
          const removed = BEState.deleteText(id);
          if (removed && window.BEHistory) {
            BEHistory.execute({
              label: 'remover texto',
              do() { /* ja aplicado */ },
              undo() { BEState.addText(removed); },
            });
          }
          this.renderTextPanel();
        });
      });
      panel.querySelectorAll('.text-item').forEach(it => {
        it.addEventListener('click', e => {
          if (e.target.closest('.text-item-edit') || e.target.closest('.text-item-delete')) return;
          const id = parseInt(it.dataset.id, 10);
          if (BEText) BEText.selectText(id);
          this.renderTextPanel();
        });
      });
    },
    openTextModal(id) {
      const isNew = id == null;
      const existing = !isNew ? (BEState.findText(id)?.text) : null;
      const vid = document.getElementById('previewVideo');
      const now = vid ? vid.currentTime : 0;
      const dur = BEState.get().video.duration || 30;
      const t = existing || {
        content: 'Olha isso',
        font: 'Anton',
        color: '#ffff00',
        size: 'large',
        x_pct: 0.5, y_pct: 0.5,
        start_sec: now,
        end_sec: Math.min(dur, now + 3),
      };
      const modal = document.createElement('div');
      modal.className = 'editor-modal-overlay';
      modal.innerHTML = `
        <div class="editor-modal">
          <div class="modal-header">
            <h3>${isNew ? '+ Adicionar texto' : '✎ Editar texto'}</h3>
            <button class="modal-close" id="textModalClose">✕</button>
          </div>
          <div class="modal-body">
            <label class="modal-field">
              <span>Conteúdo</span>
              <input type="text" id="txContent" maxlength="100" value="${escapeHtml(t.content)}" autocomplete="off">
            </label>
            <div class="modal-row">
              <label class="modal-field">
                <span>Fonte</span>
                <select id="txFont">
                  ${['Anton','Bebas Neue','Oswald','Inter'].map(f => `<option value="${f}" ${t.font===f?'selected':''}>${f}</option>`).join('')}
                </select>
              </label>
              <label class="modal-field">
                <span>Tamanho</span>
                <select id="txSize">
                  ${['small','medium','large','xlarge'].map(sz => `<option value="${sz}" ${t.size===sz?'selected':''}>${sz}</option>`).join('')}
                </select>
              </label>
            </div>
            <label class="modal-field">
              <span>Cor</span>
              <div class="color-grid">
                ${['#ffffff','#ffff00','#ff4444','#22c55e','#00aaff','#fbbf24','#a855f7','#000000'].map(c =>
                  `<button class="color-swatch ${t.color===c?'selected':''}" data-color="${c}" style="background:${c}"></button>`).join('')}
              </div>
            </label>
            <div class="modal-row">
              <label class="modal-field">
                <span>Aparece em (s)</span>
                <input type="number" id="txStart" step="0.1" min="0" max="${dur}" value="${t.start_sec.toFixed(2)}">
              </label>
              <label class="modal-field">
                <span>Some em (s)</span>
                <input type="number" id="txEnd" step="0.1" min="0" max="${dur}" value="${t.end_sec.toFixed(2)}">
              </label>
            </div>
            <div class="modal-hint">Arraste o texto direto no preview pra reposicionar.</div>
          </div>
          <div class="modal-actions">
            <button class="btn-secondary" id="textModalCancel">Cancelar</button>
            <button class="btn-primary" id="textModalSave">${isNew ? 'Adicionar' : 'Salvar'}</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      let chosenColor = t.color;
      modal.querySelectorAll('.color-swatch').forEach(b => {
        b.addEventListener('click', () => {
          chosenColor = b.dataset.color;
          modal.querySelectorAll('.color-swatch').forEach(x => x.classList.toggle('selected', x === b));
        });
      });
      const close = () => modal.remove();
      modal.querySelector('#textModalClose').addEventListener('click', close);
      modal.querySelector('#textModalCancel').addEventListener('click', close);
      modal.addEventListener('click', e => { if (e.target === modal) close(); });
      modal.querySelector('#textModalSave').addEventListener('click', () => {
        const content = modal.querySelector('#txContent').value.trim() || 'Texto';
        const font = modal.querySelector('#txFont').value;
        const size = modal.querySelector('#txSize').value;
        const start_sec = Math.max(0, Math.min(dur, parseFloat(modal.querySelector('#txStart').value) || 0));
        const end_sec = Math.max(start_sec + 0.1, Math.min(dur, parseFloat(modal.querySelector('#txEnd').value) || start_sec + 1));
        const props = { content, font, size, color: chosenColor, start_sec, end_sec };
        if (isNew) {
          const newId = BEState.addText({ ...props, x_pct: t.x_pct, y_pct: t.y_pct });
          if (window.BEHistory) {
            BEHistory.execute({
              label: 'adicionar texto',
              do() { /* ja aplicado */ },
              undo() { BEState.deleteText(newId); },
            });
          }
          if (BEText) BEText.selectText(newId);
        } else {
          const before = { ...existing };
          BEState.updateText(id, props);
          if (window.BEHistory) {
            BEHistory.execute({
              label: 'editar texto',
              do() { /* ja aplicado */ },
              undo() { BEState.updateText(id, { content: before.content, font: before.font, size: before.size, color: before.color, start_sec: before.start_sec, end_sec: before.end_sec }); },
            });
          }
        }
        close();
        this.renderTextPanel();
      });
      modal.querySelector('#txContent').focus();
    },
    onTextSelected(id) {
      // Notificacao do text.js quando user clica em texto no preview
      if (this.activeTab === 'text') this.renderTextPanel();
    },
    renderAudioPanel() {
      const panel = document.getElementById('panelBody');
      if (!panel) return;
      const s = BEState.get();
      const hasAudio = !!s.audio_extra;
      panel.innerHTML = `
        ${hasAudio ? `
          <div class="media-info">
            <div class="media-thumb">🎵</div>
            <div class="media-detail">
              <div class="media-name">${escapeHtml(s.audio_extra.filename || 'audio.mp3')}</div>
              <div class="media-meta">${fmtTime(s.audio_extra.duration)}</div>
            </div>
            <div class="media-actions">
              <button class="media-action media-action-danger" id="audioDeleteBtn" title="Remover">🗑</button>
            </div>
          </div>
        ` : `<button class="btn-add-item" id="btnAddAudio">+ Adicionar áudio (música/narração)</button>`}
        <div class="volume-section">
          <h4 class="vol-section-title">Volume</h4>
          <label class="vol-row">
            <span>🎬 Vídeo</span>
            <input type="range" id="volVideo" min="0" max="200" value="${Math.round((s.volumes?.video ?? 1) * 100)}">
            <span class="vol-val" id="volVideoVal">${Math.round((s.volumes?.video ?? 1) * 100)}%</span>
          </label>
          ${hasAudio ? `
          <label class="vol-row">
            <span>🎵 Áudio extra</span>
            <input type="range" id="volAudio" min="0" max="200" value="${Math.round((s.volumes?.audio_extra ?? 1) * 100)}">
            <span class="vol-val" id="volAudioVal">${Math.round((s.volumes?.audio_extra ?? 1) * 100)}%</span>
          </label>` : ''}
          <input type="file" id="audioFileInput" accept="audio/mpeg,audio/wav,audio/mp4,audio/x-m4a,.mp3,.wav,.m4a" hidden>
        </div>
      `;
      const btnAdd = document.getElementById('btnAddAudio');
      const fileInp = document.getElementById('audioFileInput');
      if (btnAdd && fileInp) {
        btnAdd.addEventListener('click', () => fileInp.click());
        fileInp.addEventListener('change', e => {
          const f = e.target.files?.[0];
          if (f && window.BEAudio) BEAudio.uploadAudio(f);
        });
      }
      const delBtn = document.getElementById('audioDeleteBtn');
      if (delBtn) delBtn.addEventListener('click', () => {
        if (!confirm('Remover áudio?')) return;
        BEState.patch({ audio_extra: null });
        this.renderAudioPanel();
      });
      const vV = document.getElementById('volVideo');
      const vA = document.getElementById('volAudio');
      if (vV) vV.addEventListener('input', e => {
        const v = parseInt(e.target.value, 10) / 100;
        BEState.patch({ volumes: { ...(s.volumes||{}), video: v } });
        document.getElementById('volVideoVal').textContent = e.target.value + '%';
      });
      if (vA) vA.addEventListener('input', e => {
        const v = parseInt(e.target.value, 10) / 100;
        BEState.patch({ volumes: { ...(s.volumes||{}), audio_extra: v } });
        document.getElementById('volAudioVal').textContent = e.target.value + '%';
      });
    },
    renderTransitionsPanel() {
      const panel = document.getElementById('panelBody');
      if (!panel) return;
      const s = BEState.get();
      const clips = BEState.getEffectiveClips();
      if (clips.length <= 1) {
        panel.innerHTML = `<div class="empty-list">Faça um corte (Ctrl+B) primeiro pra adicionar transição entre clipes.</div>`;
        return;
      }
      const trans = s.transitions || [];
      panel.innerHTML = `
        <div class="transitions-list">
          <div class="trans-help">Escolha o tipo de transição entre cada par de clipes.</div>
          ${clips.slice(0, -1).map((c, i) => {
            const t = trans.find(tr => tr.between === i) || { type: 'cut', duration: 0.5 };
            return `
              <div class="trans-row">
                <div class="trans-label">Clipe #${i+1} → Clipe #${i+2}</div>
                <select class="trans-type" data-between="${i}">
                  <option value="cut" ${t.type==='cut'?'selected':''}>Cut (sem transição)</option>
                  <option value="fade" ${t.type==='fade'?'selected':''}>Fade preto</option>
                  <option value="crossfade" ${t.type==='crossfade'?'selected':''}>Cross-fade</option>
                </select>
                <input type="number" class="trans-dur" data-between="${i}" min="0.2" max="2" step="0.1" value="${t.duration||0.5}" ${t.type==='cut'?'disabled':''}>
              </div>
            `;
          }).join('')}
        </div>
      `;
      panel.querySelectorAll('.trans-type').forEach(sel => {
        sel.addEventListener('change', e => this.updateTransition(parseInt(sel.dataset.between, 10), { type: e.target.value }));
      });
      panel.querySelectorAll('.trans-dur').forEach(inp => {
        inp.addEventListener('change', e => this.updateTransition(parseInt(inp.dataset.between, 10), { duration: parseFloat(e.target.value) }));
      });
    },
    updateTransition(between, props) {
      const s = BEState.get();
      const trans = [...(s.transitions || [])];
      const idx = trans.findIndex(t => t.between === between);
      if (idx >= 0) trans[idx] = { ...trans[idx], ...props };
      else trans.push({ between, type: 'cut', duration: 0.5, ...props });
      BEState.patch({ transitions: trans });
      // Re-render pra atualizar disabled
      this.renderTransitionsPanel();
    },
    renderStylePanel() {
      const panel = document.getElementById('panelBody');
      if (!panel) return;
      panel.innerHTML = `<div class="empty-list">Estilos prontos chegam em fases futuras. Por enquanto edita manualmente em Texto/Áudio.</div>`;
    },
    // ─── Fase 8: Export modal + polling ───────────────────────────────────
    _exportPolling: null,
    async openExportModal() {
      const s = BEState.get();
      if (!s.video || !s.video.url) return this.flashStatus('Sem vídeo carregado');
      if (!s.project_id) {
        // Força save pra ter project_id
        this.flashStatus('Salvando projeto…');
        await new Promise(r => setTimeout(r, 2500));
        if (!BEState.get().project_id) return this.flashStatus('Erro ao salvar — tenta de novo');
      }
      const modal = document.createElement('div');
      modal.className = 'editor-modal-overlay';
      modal.id = 'exportModal';
      modal.innerHTML = `
        <div class="editor-modal export-modal">
          <div class="modal-header">
            <h3>Exportar vídeo</h3>
            <button class="modal-close" id="expClose">✕</button>
          </div>
          <div class="modal-body">
            <div class="export-summary" id="expSummary">
              <div class="exp-meta">
                <div><strong>Clipes:</strong> <span id="expClips">—</span></div>
                <div><strong>Textos:</strong> <span id="expTexts">—</span></div>
                <div><strong>Duração:</strong> <span id="expDur">—</span></div>
                <div><strong>Resolução:</strong> 1080×1920 (9:16)</div>
              </div>
              <button class="btn-primary" id="expStart">Começar export</button>
            </div>
            <div class="export-progress" id="expProgress" hidden>
              <div class="exp-stage" id="expStage">Preparando…</div>
              <div class="exp-bar"><div class="exp-bar-fill" id="expBarFill"></div></div>
              <div class="exp-pct" id="expPct">0%</div>
              <button class="btn-secondary exp-cancel" id="expCancel">Cancelar</button>
            </div>
            <div class="export-result" id="expResult" hidden>
              <div class="exp-success">✓ Pronto!</div>
              <video id="expVideo" controls playsinline></video>
              <a class="btn-primary exp-download" id="expDownload" download="bluetube-export.mp4">⬇ Baixar MP4</a>
              <button class="btn-secondary" id="expNew">Fazer outro</button>
            </div>
            <div class="export-error" id="expError" hidden></div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      this.fillExportSummary();
      modal.querySelector('#expClose').addEventListener('click', () => this.closeExportModal());
      modal.querySelector('#expStart').addEventListener('click', () => this.startExport());
      modal.querySelector('#expCancel').addEventListener('click', () => this.cancelExport());
      modal.querySelector('#expNew').addEventListener('click', () => this.closeExportModal());
    },
    fillExportSummary() {
      const s = BEState.get();
      const clips = BEState.getEffectiveClips();
      const totalDur = clips.reduce((acc, c) => acc + (c.source_out - c.source_in), 0);
      document.getElementById('expClips').textContent = clips.length;
      document.getElementById('expTexts').textContent = (s.texts || []).filter(t => t.active !== false).length;
      document.getElementById('expDur').textContent = fmtTimeMs(totalDur);
    },
    closeExportModal() {
      if (this._exportPolling) { clearInterval(this._exportPolling); this._exportPolling = null; }
      document.getElementById('exportModal')?.remove();
    },
    async startExport() {
      const s = BEState.get();
      document.getElementById('expSummary').hidden = true;
      document.getElementById('expProgress').hidden = false;
      document.getElementById('expError').hidden = true;
      this.setExportProgress('Enviando pro render…', 5);
      const token = localStorage.getItem('bt_token');
      try {
        const r = await fetch('/api/blue-editor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'edit-v0', token, project_id: s.project_id, project_state: s }),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) {
          return this.showExportError(d.error || 'Erro ao iniciar export');
        }
        this.setExportProgress('Processando vídeo…', 10);
        this.startExportPolling();
      } catch (e) {
        this.showExportError('Erro de rede: ' + e.message);
      }
    },
    startExportPolling() {
      const s = BEState.get();
      const token = localStorage.getItem('bt_token');
      this._exportPolling = setInterval(async () => {
        try {
          const r = await fetch('/api/blue-editor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'status-v0', token, project_id: s.project_id }),
          });
          const d = await r.json();
          if (!r.ok) return;
          const stages = {
            queued: 'Na fila…',
            downloading: 'Baixando vídeo…',
            trimming: 'Cortando clipes…',
            concatenating: 'Juntando clipes…',
            audio: 'Processando áudio…',
            rendering: 'Renderizando vídeo final…',
            uploading: 'Enviando MP4…',
          };
          const stage = stages[d.status] || d.status || 'Processando…';
          if (d.status === 'done' && d.output_url) {
            clearInterval(this._exportPolling); this._exportPolling = null;
            this.setExportProgress('Pronto!', 100);
            setTimeout(() => this.showExportResult(d.output_url), 400);
            return;
          }
          if (d.status === 'error') {
            clearInterval(this._exportPolling); this._exportPolling = null;
            this.showExportError(d.erro || 'Erro no render');
            return;
          }
          this.setExportProgress(stage, d.progresso || 10);
        } catch (e) { /* ignora — re-tenta no próximo tick */ }
      }, 2500);
    },
    setExportProgress(stage, pct) {
      const stEl = document.getElementById('expStage');
      const pctEl = document.getElementById('expPct');
      const barEl = document.getElementById('expBarFill');
      if (stEl) stEl.textContent = stage;
      if (pctEl) pctEl.textContent = pct + '%';
      if (barEl) barEl.style.width = pct + '%';
    },
    async cancelExport() {
      if (this._exportPolling) { clearInterval(this._exportPolling); this._exportPolling = null; }
      const token = localStorage.getItem('bt_token');
      try {
        await fetch('/api/blue-editor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cancel-v0', token, project_id: BEState.get().project_id }),
        });
      } catch(e) {}
      this.closeExportModal();
    },
    showExportError(msg) {
      document.getElementById('expProgress').hidden = true;
      document.getElementById('expSummary').hidden = false;
      const errEl = document.getElementById('expError');
      errEl.hidden = false;
      errEl.textContent = '⚠ ' + msg;
    },
    showExportResult(url) {
      document.getElementById('expProgress').hidden = true;
      document.getElementById('expResult').hidden = false;
      document.getElementById('expVideo').src = url;
      document.getElementById('expDownload').href = url;
      // Tracking
      try {
        if (typeof fbq !== 'undefined') fbq('track', 'Lead', { content_name: 'editor_export' });
      } catch(e){}
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
