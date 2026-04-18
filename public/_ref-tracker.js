// _ref-tracker.js — Rastreamento de afiliados do Programa Pioneiros.
// Captura ?ref=XXX da URL e persiste em localStorage + cookie (30 dias) pra
// sobreviver a navegacao entre paginas. Carregado em todas as paginas publicas.
//
// Uso:
//   <script src="/_ref-tracker.js" defer></script>
//
// API exposta:
//   window.getRefAfiliado()  -> string | null (ref valido, ou null se expirou)
//   window.clearRefAfiliado()  -> remove o ref persistido
//
// Backend ja processa:
//   - signup envia ref_code e grava em profiles.ref_code
//   - create-checkout passa ref -> stripe metadata
//   - webhook registra em pioneiros_indicacoes
(function () {
  var KEY = 'bt_ref';
  // TTL de 60 dias — alinhado com Hotmart/ClickBank e com afiliado.html
  // (rollback: voltar pra 30 se quiser encurtar a janela)
  var TTL_DAYS = 60;
  var TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

  function setCookie(v) {
    try {
      var exp = new Date(Date.now() + TTL_MS).toUTCString();
      document.cookie = KEY + '=' + encodeURIComponent(v) + ';expires=' + exp + ';path=/;SameSite=Lax';
    } catch (e) {}
  }
  function getCookie() {
    try {
      var m = document.cookie.match(/(?:^|;\s*)bt_ref=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }
  function setLS(ref) {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        ref: ref,
        origem_url: window.location.href,
        salvo_em: Date.now(),
        expira_em: Date.now() + TTL_MS,
      }));
    } catch (e) {}
  }
  function getLS() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      // Backwards-compat: codigo antigo gravava a string pura
      if (raw.charAt(0) !== '{') return raw;
      var d = JSON.parse(raw);
      if (d && d.expira_em && d.expira_em > Date.now()) return d.ref;
      // Expirou — limpa
      localStorage.removeItem(KEY);
      return null;
    } catch (e) {
      try { return sessionStorage.getItem(KEY); } catch (_) { return null; }
    }
  }

  function salvar(ref) {
    if (!ref || typeof ref !== 'string') return;
    // Aceita apenas formato do link_ref gerado pelo backend: letras/numeros/hifen
    if (!/^[a-zA-Z0-9_-]{4,64}$/.test(ref)) return;
    setLS(ref);
    setCookie(ref);
    try { sessionStorage.setItem(KEY, ref); } catch (e) {}
    // Log so uma vez por sessao pra nao poluir
    try {
      if (!sessionStorage.getItem('bt_ref_logged')) {
        sessionStorage.setItem('bt_ref_logged', '1');
        console.log('[Afiliado] Ref salvo:', ref);
      }
    } catch (e) {}
  }

  function capturarDaURL() {
    try {
      var p = new URLSearchParams(window.location.search);
      var ref = p.get('ref');
      if (ref) salvar(ref);
    } catch (e) {}
  }

  window.getRefAfiliado = function () {
    return getLS() || getCookie() || (function(){ try { return sessionStorage.getItem(KEY); } catch(e){ return null; } })();
  };
  window.clearRefAfiliado = function () {
    try { localStorage.removeItem(KEY); } catch (e) {}
    try { sessionStorage.removeItem(KEY); } catch (e) {}
    try { document.cookie = KEY + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/'; } catch (e) {}
  };

  capturarDaURL();
})();
