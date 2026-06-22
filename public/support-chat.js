// public/support-chat.js — Botão flutuante + popup de chat de suporte 1:1.
//
// Drop-in component: páginas incluem <script src="/support-chat.js" defer></script>
// e ele se auto-instala. Detecta se há outros elementos fixed bottom-right
// (Blublu feedback popup em index.html/blueEditor.html/bluetendencias.html) e
// se desloca pra esquerda automaticamente pra não sobrepor.
//
// Realtime via Supabase SDK (carregado lazy só quando popup abre). Zero polling.
// Badge "🔔 N" atualiza só na carga da página + após interações (não polling).

(function () {
  'use strict';
  if (window.__btSupportChatInit) return;
  window.__btSupportChatInit = true;

  // ── CONFIG ──────────────────────────────────────────────────────────────
  const TOKEN_KEY = 'bt_token';
  const SUPABASE_JS_CDN = 'https://esm.sh/@supabase/supabase-js@2.45.4?bundle';
  // Supabase URL + anon_key vêm do backend /api/support-chat?action=config (não hardcode).
  let SUPABASE_URL = null;
  let SUPABASE_ANON_KEY = null;

  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } }
  function isLogged() { return !!getToken(); }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  // ── STATE ───────────────────────────────────────────────────────────────
  let state = {
    open: false,
    thread: null,
    messages: [],
    unread: 0,
    sb: null,           // Supabase client
    realtimeCh: null,   // canal Realtime
    loading: false,
    sending: false,
  };

  // ── CSS ─────────────────────────────────────────────────────────────────
  const css = `
    #bt-support-btn {
      position: fixed; bottom: 24px; right: 24px;
      width: 56px; height: 56px; border-radius: 50%;
      background: linear-gradient(135deg, #00aaff, #0078ff);
      box-shadow: 0 8px 24px rgba(0,170,255,.4), 0 0 0 2px rgba(0,170,255,.2);
      border: none; cursor: pointer; z-index: 149;
      display: none; align-items: center; justify-content: center;
      transition: all .25s cubic-bezier(.2,.9,.2,1);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    #bt-support-btn:hover { transform: translateY(-2px) scale(1.06); box-shadow: 0 12px 32px rgba(0,170,255,.55); }
    #bt-support-btn.bt-open { display: flex; }
    #bt-support-btn svg { width: 26px; height: 26px; fill: #fff; }
    #bt-support-btn .bt-badge {
      position: absolute; top: -4px; right: -4px;
      min-width: 22px; height: 22px; padding: 0 6px; border-radius: 11px;
      background: #ef4444; color: #fff; font-size: 11px; font-weight: 800;
      display: none; align-items: center; justify-content: center;
      box-shadow: 0 2px 8px rgba(239,68,68,.5); line-height: 1;
    }
    #bt-support-btn.bt-has-unread .bt-badge { display: inline-flex; }
    #bt-support-btn .bt-tooltip {
      position: absolute; bottom: calc(100% + 10px); right: 0;
      background: rgba(2,8,23,.95); color: #fff;
      padding: 5px 10px; border-radius: 6px; font-size: 11px; white-space: nowrap;
      border: 1px solid rgba(0,170,255,.3); pointer-events: none;
      opacity: 0; transition: opacity .2s; font-weight: 500;
    }
    #bt-support-btn:hover .bt-tooltip { opacity: 1; }

    #bt-support-modal {
      position: fixed; bottom: 92px; right: 24px;
      width: 360px; max-width: calc(100vw - 32px);
      height: 520px; max-height: calc(100vh - 120px);
      background: #0a1729; border-radius: 16px;
      border: 1px solid rgba(0,170,255,.2);
      box-shadow: 0 24px 60px rgba(0,0,0,.6), 0 0 0 1px rgba(0,170,255,.08);
      display: none; flex-direction: column; z-index: 200;
      overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      animation: bt-slideup .25s cubic-bezier(.2,.9,.2,1);
    }
    @keyframes bt-slideup { 0% { opacity: 0; transform: translateY(20px); } 100% { opacity: 1; transform: translateY(0); } }
    #bt-support-modal.bt-open { display: flex; }

    .bt-header {
      padding: 14px 18px; display: flex; align-items: center; gap: 10px;
      background: linear-gradient(135deg, rgba(0,170,255,.12), rgba(124,58,237,.08));
      border-bottom: 1px solid rgba(0,170,255,.15);
    }
    .bt-header-avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: linear-gradient(135deg, #00aaff, #0078ff);
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; color: #fff;
    }
    .bt-header-info { flex: 1; min-width: 0; }
    .bt-header-title { font-size: 14px; font-weight: 700; color: #e8f4ff; }
    .bt-header-sub { font-size: 11px; color: rgba(232,244,255,.55); font-family: monospace; margin-top: 2px; }
    .bt-close-btn {
      background: none; border: none; color: rgba(232,244,255,.6);
      cursor: pointer; padding: 6px; font-size: 18px; line-height: 1;
      border-radius: 6px; transition: all .2s;
    }
    .bt-close-btn:hover { color: #fff; background: rgba(255,255,255,.08); }

    .bt-messages {
      flex: 1; overflow-y: auto; padding: 16px;
      display: flex; flex-direction: column; gap: 10px;
      background: #050a14;
    }
    .bt-msg { display: flex; flex-direction: column; max-width: 80%; }
    .bt-msg.bt-from-user { align-self: flex-end; }
    .bt-msg.bt-from-admin { align-self: flex-start; }
    .bt-msg-bubble {
      padding: 9px 13px; border-radius: 16px; font-size: 13px;
      line-height: 1.45; color: #fff; word-wrap: break-word; white-space: pre-wrap;
    }
    .bt-from-user .bt-msg-bubble {
      background: linear-gradient(135deg, #0078ff, #00aaff);
      border-bottom-right-radius: 4px;
    }
    .bt-from-admin .bt-msg-bubble {
      background: rgba(255,255,255,.06);
      border: 1px solid rgba(255,255,255,.1);
      border-bottom-left-radius: 4px;
    }
    .bt-msg-time { font-size: 10px; color: rgba(232,244,255,.4); margin-top: 4px; font-family: monospace; }
    .bt-from-user .bt-msg-time { text-align: right; }

    .bt-empty {
      flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 24px; text-align: center; gap: 14px;
    }
    .bt-empty-icon { font-size: 48px; opacity: .5; }
    .bt-empty-title { font-size: 15px; font-weight: 700; color: #e8f4ff; }
    .bt-empty-sub { font-size: 12px; color: rgba(232,244,255,.55); line-height: 1.5; max-width: 260px; }

    .bt-input-area {
      padding: 12px; border-top: 1px solid rgba(0,170,255,.12);
      background: #0a1729;
    }
    .bt-input-row { display: flex; gap: 8px; align-items: flex-end; }
    .bt-input {
      flex: 1; background: rgba(255,255,255,.05); border: 1px solid rgba(0,170,255,.2);
      border-radius: 10px; padding: 10px 12px; color: #fff; font-size: 13px;
      font-family: inherit; resize: none; min-height: 38px; max-height: 100px;
      outline: none; transition: border-color .15s;
    }
    .bt-input:focus { border-color: rgba(0,170,255,.6); }
    .bt-send-btn {
      width: 38px; height: 38px; border-radius: 50%; border: none;
      background: linear-gradient(135deg, #00aaff, #0078ff);
      color: #fff; cursor: pointer; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      transition: all .15s;
    }
    .bt-send-btn:hover:not(:disabled) { transform: scale(1.05); }
    .bt-send-btn:disabled { opacity: .4; cursor: not-allowed; }
    .bt-send-btn svg { width: 18px; height: 18px; fill: currentColor; }

    .bt-loading { text-align: center; padding: 24px; color: rgba(232,244,255,.55); font-size: 12px; }
  `;

  function injectStyles() {
    if (document.getElementById('bt-support-styles')) return;
    const s = document.createElement('style');
    s.id = 'bt-support-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ── DOM ─────────────────────────────────────────────────────────────────
  function buildDOM() {
    const btn = document.createElement('button');
    btn.id = 'bt-support-btn';
    btn.setAttribute('aria-label', 'Abrir suporte');
    btn.innerHTML = `
      <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 0 0-9.95 9h2a8 8 0 0 1 15.9 0h2A10 10 0 0 0 12 2zm-1 11v6h2v-6h-2zm0 7v2h2v-2h-2zM2 13a10 10 0 0 0 5.5 8.9V20a8.01 8.01 0 0 1-3.5-7H2zm15 7.9A10 10 0 0 0 22 13h-2a8.01 8.01 0 0 1-3.5 7v1.9z"/></svg>
      <span class="bt-badge">0</span>
      <span class="bt-tooltip">💬 Suporte</span>
    `;
    btn.addEventListener('click', toggleModal);
    document.body.appendChild(btn);

    const modal = document.createElement('div');
    modal.id = 'bt-support-modal';
    modal.innerHTML = `
      <div class="bt-header">
        <div class="bt-header-avatar">💬</div>
        <div class="bt-header-info">
          <div class="bt-header-title">Suporte BlueTube</div>
          <div class="bt-header-sub">Resposta em até 24h</div>
        </div>
        <button class="bt-close-btn" aria-label="Fechar">✕</button>
      </div>
      <div class="bt-messages" id="bt-msgs"></div>
      <div class="bt-input-area">
        <div class="bt-input-row">
          <textarea class="bt-input" id="bt-input" placeholder="Escreva sua mensagem…" rows="1"></textarea>
          <button class="bt-send-btn" id="bt-send" aria-label="Enviar">
            <svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('.bt-close-btn').addEventListener('click', closeModal);
    const input = modal.querySelector('#bt-input');
    const sendBtn = modal.querySelector('#bt-send');
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        sendMessage();
      }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(100, input.scrollHeight) + 'px';
    });
    sendBtn.addEventListener('click', sendMessage);
  }

  // Detecta se há outros elementos fixed bottom-right (Blublu) e desloca o botão pra esquerda
  function adjustPositionToAvoidConflict() {
    const btn = document.getElementById('bt-support-btn');
    const modal = document.getElementById('bt-support-modal');
    if (!btn) return;
    // Procura o popup do Blublu (index.html/blueEditor.html/bluetendencias.html)
    const blublu = document.querySelector('.blublu-container');
    if (blublu) {
      btn.style.right = '92px';
      modal.style.right = '24px';
    } else {
      btn.style.right = '24px';
      modal.style.right = '24px';
    }
  }

  // ── DATA LAYER ──────────────────────────────────────────────────────────
  async function api(path, options = {}) {
    const token = getToken();
    return fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        ...(options.headers || {}),
      },
    });
  }

  async function fetchUnreadCount() {
    if (!isLogged()) return 0;
    try {
      const r = await api('/api/support-chat?action=unread-count');
      if (!r.ok) return 0;
      const d = await r.json();
      return d.unread || 0;
    } catch (_) { return 0; }
  }

  async function loadThread() {
    state.loading = true;
    renderMessages();
    try {
      const r = await api('/api/support-chat?action=my-thread');
      const d = await r.json();
      if (d.ok) {
        state.thread = d.thread;
        state.messages = d.messages || [];
        state.unread = 0;
        updateBadge();
      }
    } catch (e) {
      console.warn('[support-chat] loadThread err:', e.message);
    } finally {
      state.loading = false;
      renderMessages();
    }
  }

  async function sendMessage() {
    const input = document.getElementById('bt-input');
    if (!input) return;
    const content = input.value.trim();
    if (!content || state.sending) return;
    state.sending = true;
    const sendBtn = document.getElementById('bt-send');
    if (sendBtn) sendBtn.disabled = true;
    try {
      const r = await api('/api/support-chat', {
        method: 'POST',
        body: JSON.stringify({ action: 'send', content }),
      });
      const d = await r.json();
      if (d.ok && d.message) {
        state.messages.push(d.message);
        if (!state.thread) state.thread = { id: d.thread_id };
        input.value = '';
        input.style.height = 'auto';
        renderMessages();
        // Após primeira mensagem da thread, sobe Realtime
        ensureRealtime();
      } else {
        alert('Erro: ' + (d.error || 'desconhecido'));
      }
    } catch (e) {
      alert('Erro de rede.');
      console.warn(e);
    } finally {
      state.sending = false;
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  // ── REALTIME (Supabase WebSocket) ───────────────────────────────────────
  async function fetchSupabaseConfig() {
    if (SUPABASE_URL && SUPABASE_ANON_KEY) return true;
    try {
      const r = await fetch('/api/support-chat?action=config', {
        headers: { 'Authorization': 'Bearer ' + getToken() },
      });
      if (!r.ok) return false;
      const d = await r.json();
      if (!d.ok || !d.supabase_url || !d.anon_key) return false;
      SUPABASE_URL = d.supabase_url;
      SUPABASE_ANON_KEY = d.anon_key;
      return true;
    } catch (_) { return false; }
  }

  async function loadSupabaseSDK() {
    if (state.sb) return state.sb;
    const cfgOk = await fetchSupabaseConfig();
    if (!cfgOk) return null;
    try {
      const mod = await import(SUPABASE_JS_CDN);
      const createClient = mod.createClient;
      state.sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { params: { eventsPerSecond: 5 } },
      });
      // Autentica o client com o JWT do user pra RLS funcionar nos channels
      const tok = getToken();
      if (tok && state.sb.auth?.setSession) {
        try { await state.sb.auth.setSession({ access_token: tok, refresh_token: tok }); }
        catch (_) {}
      }
      return state.sb;
    } catch (e) {
      console.warn('[support-chat] Supabase SDK load err:', e.message);
      return null;
    }
  }

  async function ensureRealtime() {
    if (state.realtimeCh) return;
    if (!state.thread?.id) return;
    const sb = await loadSupabaseSDK();
    if (!sb) return;
    try {
      state.realtimeCh = sb
        .channel('support-' + state.thread.id)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'support_messages', filter: 'thread_id=eq.' + state.thread.id },
          (payload) => {
            const m = payload.new;
            if (!m || m.sender !== 'admin') return; // só nos importa admin
            const exists = state.messages.some(x => x.id === m.id);
            if (!exists) {
              state.messages.push(m);
              renderMessages();
              if (state.open) {
                // popup aberto — marca como lido server-side
                api('/api/support-chat', { method: 'POST', body: JSON.stringify({ action: 'mark-read' }) }).catch(() => {});
              } else {
                state.unread += 1;
                updateBadge();
              }
            }
          }
        )
        .subscribe();
    } catch (e) {
      console.warn('[support-chat] subscribe err:', e.message);
    }
  }

  function teardownRealtime() {
    if (state.realtimeCh && state.sb) {
      try { state.sb.removeChannel(state.realtimeCh); } catch (_) {}
      state.realtimeCh = null;
    }
  }

  // ── RENDER ──────────────────────────────────────────────────────────────
  function renderMessages() {
    const box = document.getElementById('bt-msgs');
    if (!box) return;
    if (state.loading) {
      box.innerHTML = '<div class="bt-loading">Carregando…</div>';
      return;
    }
    if (!state.thread || state.messages.length === 0) {
      box.innerHTML = `
        <div class="bt-empty">
          <div class="bt-empty-icon">💬</div>
          <div class="bt-empty-title">Como podemos ajudar?</div>
          <div class="bt-empty-sub">Escreve sua mensagem que a equipe BlueTube responde em até 24h. Tu vai ver a resposta aqui e também por email.</div>
        </div>
      `;
      return;
    }
    box.innerHTML = state.messages.map(m => `
      <div class="bt-msg bt-from-${m.sender}">
        <div class="bt-msg-bubble">${escapeHtml(m.content)}</div>
        <div class="bt-msg-time">${fmtTime(m.created_at)}</div>
      </div>
    `).join('');
    box.scrollTop = box.scrollHeight;
  }

  function updateBadge() {
    const btn = document.getElementById('bt-support-btn');
    if (!btn) return;
    const badge = btn.querySelector('.bt-badge');
    if (state.unread > 0) {
      btn.classList.add('bt-has-unread');
      if (badge) badge.textContent = state.unread > 9 ? '9+' : String(state.unread);
    } else {
      btn.classList.remove('bt-has-unread');
    }
    syncFloatVisibility();
  }

  async function toggleModal() {
    if (state.open) { closeModal(); return; }
    openModal();
  }
  async function openModal() {
    const modal = document.getElementById('bt-support-modal');
    if (!modal) return;
    state.open = true;
    modal.classList.add('bt-open');
    hideFloatBtn(); // popup aberto não precisa de botão flutuante
    await loadThread();
    ensureRealtime();
    setTimeout(() => {
      const inp = document.getElementById('bt-input');
      if (inp) inp.focus();
    }, 100);
  }
  function closeModal() {
    const modal = document.getElementById('bt-support-modal');
    if (!modal) return;
    state.open = false;
    modal.classList.remove('bt-open');
    syncFloatVisibility(); // se ainda tem unread, reaparece o botão
  }

  // Mostra o botão flutuante. Por default só aparece quando há mensagens não
  // lidas (notificação visual). User pode forçar via window.btSupportChat.open().
  function showFloatBtn() {
    const btn = document.getElementById('bt-support-btn');
    if (btn) btn.classList.add('bt-open');
  }
  function hideFloatBtn() {
    const btn = document.getElementById('bt-support-btn');
    if (btn) btn.classList.remove('bt-open');
  }

  // ── API GLOBAL ──────────────────────────────────────────────────────────
  // Permite que outras partes do site (ex: modal de perfil "Falar com suporte"
  // em index.html) abram o chat sem o botão flutuante aparecer.
  window.btSupportChat = {
    open() {
      if (!isLogged()) {
        alert('Faça login pra falar com o suporte.');
        return;
      }
      // Garante que DOM está montado mesmo se init() ainda não rodou
      injectStyles();
      if (!document.getElementById('bt-support-modal')) buildDOM();
      adjustPositionToAvoidConflict();
      openModal();
    },
    close() { closeModal(); },
    getUnread() { return state.unread || 0; },
    isOpen() { return state.open; },
  };

  // ── INIT ────────────────────────────────────────────────────────────────
  async function init() {
    if (!isLogged()) return; // só pra logado
    injectStyles();
    buildDOM();
    adjustPositionToAvoidConflict();
    // Badge: 1 query no carregamento (sem polling)
    try {
      state.unread = await fetchUnreadCount();
      updateBadge();
      // Mostra botão flutuante SÓ quando há mensagens não lidas (notificação)
      if (state.unread > 0) {
        showFloatBtn();
        // Inicializa Realtime mesmo sem popup aberto pra capturar próximas msgs
        // (precisa thread carregado antes — chama once silencioso)
        loadThreadSilent();
      }
    } catch (_) {}
  }

  // Carrega thread sem abrir popup — usado pra subscribe Realtime em background
  // quando user tem mensagens não lidas no carregamento da página.
  async function loadThreadSilent() {
    try {
      const r = await api('/api/support-chat?action=my-thread');
      const d = await r.json();
      if (d.ok && d.thread) {
        state.thread = d.thread;
        state.messages = d.messages || [];
        // NÃO seta unread=0 aqui (user ainda não viu), só pra ter thread_id pro Realtime
        ensureRealtime();
      }
    } catch (_) {}
  }

  function syncFloatVisibility() {
    if (state.open) { hideFloatBtn(); return; }
    if (state.unread > 0) showFloatBtn();
    else hideFloatBtn();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
