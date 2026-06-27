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
      // Decide tela inicial baseado em ter video carregado
      const s = BEState.get();
      if (s.video && s.video.url) {
        // Projeto carregado: mostra editor montado
        this.showEditorMounted();
      } else {
        // Sem projeto: mostra tela de upload
        BEUpload.renderUploadScreen();
      }
      this.updateProjectName();
      this.updateFaseFlags();
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
          <button class="media-replace" id="mediaReplaceBtn" title="Trocar vídeo">↻</button>
        </div>
        <div class="media-status">
          <p>Fase 1 ativa: vídeo carregado. Pré-visualização funcional.</p>
          <p style="color:var(--text-3);font-size:12px;margin-top:6px">Próximas fases adicionam: timeline visual (Fase 2), cortes (Fase 3), texto (Fase 4), etc.</p>
        </div>
      `;
      const replaceBtn = document.getElementById('mediaReplaceBtn');
      if (replaceBtn) replaceBtn.addEventListener('click', () => {
        if (!confirm('Trocar de vídeo? O projeto atual será descartado.')) return;
        BEState.reset();
        BEUpload.renderUploadScreen();
        this.updateProjectName();
      });
    },
    updateProjectName() {
      const el = document.getElementById('projectName');
      if (el) el.textContent = BEState.get().nome_projeto || 'Projeto sem título';
    },
    updateFaseFlags() {
      const flagEl = document.querySelector('.header-flag');
      if (flagEl) flagEl.textContent = 'FASE 1 · player';
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
