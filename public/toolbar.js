// toolbar.js — Barra de ferramentas compartilhada + persistência de estado
(function(){
  // ── TOOLBAR ─────────────────────────────────────────────────────────────────
  const TOOLS = [
    { id:'roteiro',  icon:'📝', label:'Roteiro',     href:'/' },
    { id:'voice',    icon:'🎙️', label:'BlueVoice',   href:'/blueVoice.html' },
    { id:'score',    icon:'📊', label:'BlueScore',   href:'/blueScore.html' },
    { id:'lens',     icon:'🔍', label:'BlueLens',    href:'/blueLens.html' },
    { id:'virais',   icon:'🔥', label:'Virais',      href:'/virais.html' },
    { id:'baixa',    icon:'⬇️', label:'BaixaBlue',   href:'/baixaBlue.html' },
    { id:'editor',   icon:'✨', label:'BlueEditor',  href:'/blueEditor.html' },
    { id:'blue',     icon:'🎬', label:'Blue',        href:'/blue.html' },
  ];

  // Detect current page
  const path = window.location.pathname;
  const PAGE_MAP = {
    '/':'roteiro', '/index.html':'roteiro',
    '/blueVoice.html':'voice', '/blueScore.html':'score',
    '/blueLens.html':'lens', '/virais.html':'virais',
    '/baixaBlue.html':'baixa', '/blueEditor.html':'editor',
    '/blue.html':'blue',
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
})();
