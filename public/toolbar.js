// toolbar.js — Barra de ferramentas compartilhada + persistência de estado

// Clean up stale Service Workers on non-blue pages.
// BUG CORRIGIDO: antes usava .includes('blue.html') que dava TRUE em qualquer
// página com 'blue.html' no nome (baixaBlue, blueVoice, blueEditor, blueScore),
// prendendo o SW nessas páginas indefinidamente.
if ('serviceWorker' in navigator) {
  const isBluePage = window.location.pathname === '/blue.html' ||
                     window.location.pathname === '/blue' ||
                     window.location.pathname.endsWith('/blue.html') ||
                     window.location.pathname.endsWith('/blue');
  navigator.serviceWorker.getRegistrations().then(regs => {
    let unregistered = false;
    regs.forEach(reg => {
      const url = reg.active?.scriptURL || '';
      if (url && !isBluePage && !url.includes('coi-serviceworker')) {
        reg.unregister();
        unregistered = true;
      }
    });
    // Se acabou de desregistrar um SW que estava controlando a página,
    // força UM reload pra servir HTML fresco da network (não via SW stale).
    // sessionStorage flag evita loop de reload.
    if (unregistered && navigator.serviceWorker.controller && !sessionStorage.getItem('_sw_cleared')) {
      sessionStorage.setItem('_sw_cleared', '1');
      setTimeout(() => location.reload(), 100);
    }
  });
}

(function(){
  // ── TOOLBAR ─────────────────────────────────────────────────────────────────
  const TOOLS = [
    { id:'roteiro',  icon:'📝', label:'Roteiro',       href:'/' },
    { id:'voice',    icon:'🎙️', label:'BlueVoice',     href:'/blueVoice' },
    { id:'score',    icon:'📊', label:'BlueScore',     href:'/blueScore' },
    { id:'lens',     icon:'🔍', label:'BlueLens',      href:'/blueLens' },
    { id:'virais',   icon:'🔥', label:'Virais',        href:'/virais' },
    { id:'baixa',    icon:'⬇️', label:'BaixaBlue',     href:'/baixaBlue' },
    { id:'editor',   icon:'✨', label:'BlueEditor',    href:'/blueEditor' },
    { id:'clean',    icon:'🧹', label:'BlueClean',      href:'/blueClean' },
    { id:'tendencias', icon:'🚀', label:'BlueTendências', href:'/bluetendencias' },
    { id:'blue',     icon:'🎬', label:'Blue',          href:'/blue' },
  ];

  const path = window.location.pathname;
  const PAGE_MAP = {
    '/':'roteiro', '/index.html':'roteiro', '/index':'roteiro',
    '/blueVoice.html':'voice', '/blueVoice':'voice',
    '/blueScore.html':'score', '/blueScore':'score',
    '/blueLens.html':'lens', '/blueLens':'lens',
    '/virais.html':'virais', '/virais':'virais',
    '/baixaBlue.html':'baixa', '/baixaBlue':'baixa',
    '/blueEditor.html':'editor', '/blueEditor':'editor',
    '/blueClean.html':'clean', '/blueClean':'clean',
    '/bluetendencias.html':'tendencias', '/bluetendencias':'tendencias',
    '/blue.html':'blue', '/blue':'blue',
  };
  const activeTool = PAGE_MAP[path] || '';

  // Don't show toolbar on blue.html (has its own nav)
  if (activeTool === 'blue') return;

  // Inject CSS
  const style = document.createElement('style');
  style.textContent = `
    .bt-toolbar{position:fixed;top:0;left:0;right:0;z-index:9999;height:40px;
      background:rgba(2,8,23,0.97);border-bottom:1px solid rgba(0,170,255,0.1);
      display:flex;align-items:center;overflow-x:auto;overflow-y:hidden;
      -webkit-overflow-scrolling:touch;scrollbar-width:none;padding:0 12px;gap:2px}
    .bt-toolbar::-webkit-scrollbar{display:none}
    .bt-toolbar a{display:flex;align-items:center;gap:5px;padding:6px 12px;
      text-decoration:none;font-family:'DM Mono','JetBrains Mono',monospace;
      font-size:11px;font-weight:500;color:rgba(150,190,230,0.5);white-space:nowrap;
      border-bottom:2px solid transparent;transition:all .2s;flex-shrink:0;
      border-radius:6px 6px 0 0;letter-spacing:-.2px}
    .bt-toolbar a:hover{color:rgba(200,225,255,0.8);background:rgba(0,170,255,0.04)}
    .bt-toolbar a.active{color:#00aaff;border-bottom-color:#00aaff;background:rgba(0,170,255,0.06);font-weight:600}
    .bt-toolbar .tb-icon{font-size:13px;line-height:1}
    .bt-toolbar .tb-saved{position:fixed;top:42px;right:12px;font-family:'DM Mono',monospace;
      font-size:10px;color:rgba(0,230,118,0.7);opacity:0;transition:opacity .3s;pointer-events:none;z-index:9999}
    .bt-toolbar .tb-saved.show{opacity:1}
    body{padding-top:40px !important}
    nav{top:40px !important}
    @media(max-width:640px){
      .bt-toolbar a{padding:6px 8px;font-size:10px;gap:3px}
      .bt-toolbar .tb-icon{font-size:11px}
    }
  `;
  document.head.appendChild(style);

  // Inject toolbar HTML
  const bar = document.createElement('div');
  bar.className = 'bt-toolbar';
  bar.innerHTML = TOOLS.map(t =>
    `<a href="${t.href}" class="${t.id===activeTool?'active':''}" title="${t.label}"><span class="tb-icon">${t.icon}</span>${t.label}</a>`
  ).join('') + '<div class="tb-saved" id="btSaved">✓ Salvo</div>';
  document.body.prepend(bar);

  // ── SAVE INDICATOR ──────────────────────────────────────────────────────────
  let _saveTimer = null;
  window._btShowSaved = function() {
    const el = document.getElementById('btSaved');
    if (!el) return;
    el.classList.add('show');
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => el.classList.remove('show'), 1500);
  };

  // ── STATE PERSISTENCE ───────────────────────────────────────────────────────
  const PREFIX = 'bt_state_';

  window._btSave = function(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
      window._btShowSaved();
    } catch(e) {}
  };

  window._btLoad = function(key) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch(e) { return null; }
  };

  // Auto-save any input/textarea/select on change
  function autoBindSave(selector, stateKey, skipIfPrefill) {
    const el = document.querySelector(selector);
    if (!el) return;
    // Skip restore if a prefill exists (e.g. coming from another page)
    if (skipIfPrefill && localStorage.getItem(skipIfPrefill)) {
      // Don't restore cache — let the prefill take priority
    } else {
      const saved = window._btLoad(stateKey);
      if (saved !== null && saved !== undefined) {
        el.value = saved;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    // Save on input/change
    const evt = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, () => window._btSave(stateKey, el.value));
  }

  // ── PAGE-SPECIFIC PERSISTENCE ───────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', () => {
    // index.html — Roteiro
    if (activeTool === 'roteiro') {
      autoBindSave('#urlInput', 'roteiro_url');
      autoBindSave('#langSelect', 'roteiro_lang');
    }

    // blueVoice.html
    if (activeTool === 'voice') {
      autoBindSave('#scriptText', 'voice_text', 'bt_prefill_script');
    }

    // blueScore.html
    if (activeTool === 'score') {
      autoBindSave('#channelInput', 'score_channel');
    }

    // blueLens.html
    if (activeTool === 'lens') {
      autoBindSave('#videoUrl', 'lens_url');
    }

    // baixaBlue.html
    if (activeTool === 'baixa') {
      autoBindSave('#urlInput', 'baixa_url');
    }
  });

  // Save generated results (called by each page after generating)
  window._btSaveResults = function(tool, data) {
    window._btSave(tool + '_results', data);
  };

  window._btLoadResults = function(tool) {
    return window._btLoad(tool + '_results');
  };

  // ── PERSISTENT SESSION — refresh on load + every 15min + auto re-login ────
  async function _btRefreshToken() {
    const refresh = localStorage.getItem('bt_refresh_token');
    if (!refresh) return _btAutoRelogin();
    try {
      // Endpoint dedicado: api/auth NAO tem action refresh (chamava e falhava
      // em silencio — token vencia com a aba aberta e conteudo Master "sumia").
      const r = await fetch('/api/session-refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refresh })
      });
      if (r.ok) {
        const d = await r.json();
        const t = d.session?.access_token || d.access_token;
        const rf = d.session?.refresh_token || d.refresh_token;
        // Supabase rotaciona o refresh_token: salvar SEMPRE o novo, senao a
        // proxima renovacao usa um token ja consumido e a sessao morre.
        if (rf) localStorage.setItem('bt_refresh_token', rf);
        if (t) { localStorage.setItem('bt_token', t); if (typeof TOKEN !== 'undefined') TOKEN = t; return true; }
      }
    } catch (e) {}
    // Refresh failed — try saved credentials
    return _btAutoRelogin();
  }
  window._btRefreshToken = _btRefreshToken;

  function _btDecodeCred(saved) {
    if (!saved) return null;
    // Formato novo (UTF-8 safe via encodeURIComponent)
    try { return JSON.parse(decodeURIComponent(atob(saved))); } catch(e) {}
    // Fallback: formato antigo (btoa direto)
    try { return JSON.parse(atob(saved)); } catch(e) { return null; }
  }

  async function _btAutoRelogin() {
    try {
      const cred = _btDecodeCred(localStorage.getItem('bt_saved_cred'));
      if (!cred || !cred.e || !cred.p) return false;
      const r = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'signin', email: cred.e, password: cred.p })
      });
      if (r.ok) {
        const d = await r.json();
        if (d.session?.access_token) {
          localStorage.setItem('bt_token', d.session.access_token);
          if (d.session?.refresh_token) localStorage.setItem('bt_refresh_token', d.session.refresh_token);
          if (typeof TOKEN !== 'undefined') TOKEN = d.session.access_token;
          return true;
        }
      }
    } catch (e) {}
    return false;
  }

  // Save credentials for auto re-login (UTF-8 safe via encodeURIComponent).
  window._btSaveCredentials = function(email, password) {
    if (!email || !password) return;
    try { localStorage.setItem('bt_saved_cred', btoa(encodeURIComponent(JSON.stringify({ e: email, p: password })))); } catch(e) {}
  };

  // Refresh immediately on page load
  _btRefreshToken();
  // Refresh every 15 minutes
  setInterval(_btRefreshToken, 15 * 60 * 1000);
})();

// ── AVISO DE ATUALIZAÇÃO (2026-07-28) ───────────────────────────────────────
// Quem está com a aba aberta quando sai um deploy fica com a versão velha em
// memória (e às vezes vê bug que já foi corrigido). Aqui a página compara o
// build servido com o que ela carregou; mudou, oferece recarregar. Nunca
// recarrega sozinho — o usuário decide (pode estar no meio de um roteiro).
(function avisoDeAtualizacao() {
  var MEU_BUILD = null;
  var INTERVALO = 5 * 60 * 1000; // 5 min

  function lerBuild() {
    return fetch('/api/build-version', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return d && d.build ? d.build : null; })
      .catch(function () { return null; });
  }

  function mostrarAviso() {
    if (document.getElementById('btUpdateToast')) return;
    var d = document.createElement('div');
    d.id = 'btUpdateToast';
    d.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:22px;z-index:99999;background:linear-gradient(135deg,#0a2240,#071a30);border:1px solid rgba(0,170,255,.45);border-radius:14px;padding:13px 16px;display:flex;align-items:center;gap:12px;box-shadow:0 14px 44px rgba(0,0,0,.55);font-family:system-ui,-apple-system,sans-serif;max-width:calc(100vw - 24px)';
    d.innerHTML = '<span style="font-size:20px">✨</span>' +
      '<div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:700;color:#e8f4ff">Nova versão disponível</div>' +
      '<div style="font-size:11px;color:rgba(200,225,255,.7);margin-top:2px">Atualize para pegar as novidades e correções</div></div>' +
      '<button id="btUpdateGo" style="flex-shrink:0;background:linear-gradient(135deg,#00aaff,#0077ff);color:#fff;border:none;border-radius:9px;padding:9px 15px;font-size:12.5px;font-weight:800;cursor:pointer">Atualizar</button>' +
      '<button id="btUpdateX" style="flex-shrink:0;background:none;border:none;color:rgba(200,225,255,.45);font-size:15px;cursor:pointer" aria-label="Depois">✕</button>';
    document.body.appendChild(d);
    document.getElementById('btUpdateGo').onclick = function () { location.reload(true); };
    document.getElementById('btUpdateX').onclick = function () {
      d.remove();
      // silencia por 1h — não vira insistência
      try { sessionStorage.setItem('bt_update_snooze', String(Date.now() + 3600000)); } catch (e) {}
    };
  }

  function checar() {
    try {
      var s = sessionStorage.getItem('bt_update_snooze');
      if (s && Date.now() < parseInt(s, 10)) return;
    } catch (e) {}
    lerBuild().then(function (b) {
      if (!b) return;
      if (!MEU_BUILD) { MEU_BUILD = b; return; }
      if (b !== MEU_BUILD) mostrarAviso();
    });
  }

  checar();
  setInterval(checar, INTERVALO);
  // volta pra aba depois de um tempo? confere na hora
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') checar();
  });
})();
