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
      showGate(
        `<strong>Faça login pra acessar.</strong><br>` +
        `O BlueEditor está em fase de teste fechada.`,
        [
          { label: 'Entrar →', kind: 'primary', href: '/?login=1' },
          { label: '← Voltar', kind: 'secondary', href: '/' },
        ]
      );
      return;
    }

    if (auth.plan !== 'master') {
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

    // ── Tudo certo: renderiza app ────────────────────────────────────────
    showApp();
    console.log('[BlueEditor V0] Fase 0 ativa', { flag, auth, device: dev });
  }

  // Boot quando DOM pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
