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
    { id:'clean',    icon:'🧹', label:'BlueClean',     href:'/blueClean' },
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
    if (!refresh) return false;
    try {
      const r = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh', refresh_token: refresh })
      });
      if (r.ok) {
        const d = await r.json();
        const t = d.session?.access_token || d.access_token;
        const rf = d.session?.refresh_token;
        if (t) { localStorage.setItem('bt_token', t); if (typeof TOKEN !== 'undefined') TOKEN = t; return true; }
        if (rf) localStorage.setItem('bt_refresh_token', rf);
      }
    } catch (e) {}
    // Refresh failed — try saved credentials
    return _btAutoRelogin();
  }

  async function _btAutoRelogin() {
    try {
      const saved = localStorage.getItem('bt_saved_cred');
      if (!saved) return false;
      const { e, p } = JSON.parse(atob(saved));
      if (!e || !p) return false;
      const r = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'signin', email: e, password: p })
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

  // Save credentials for auto re-login (called from login handlers)
  window._btSaveCredentials = function(email, password) {
    try { localStorage.setItem('bt_saved_cred', btoa(JSON.stringify({ e: email, p: password }))); } catch(e) {}
  };

  // Refresh immediately on page load
  _btRefreshToken();
  // Refresh every 15 minutes
  setInterval(_btRefreshToken, 15 * 60 * 1000);
})();
