/* public/toast.js — o aviso curto que sobrevive ao modal fechar.
 * ---------------------------------------------------------------------------
 * POR QUE ESTE ARQUIVO EXISTE
 *
 * Quatro páginas chamavam toast() e só duas o definiam. Na index.html não
 * existia nem a função nem o CSS, e as 6 chamadas estavam DESPROTEGIDAS — cada
 * uma um ReferenceError. O pior deles, medido em 11/08:
 *
 *   deleteMyAccount()  →  a API apaga a conta  →  localStorage.clear()
 *                      →  toast('✅ Conta deletada. Redirecionando...')  ← ESTOURA
 *                      →  setTimeout(... location.href='/')  ← NUNCA RODA
 *
 * A conta era apagada de verdade e a pessoa não via nada: sem mensagem, sem
 * redirecionamento, numa tela ainda com cara de logada. Concluía que falhou.
 * O caminho de erro era igualmente mudo. É o fluxo de exclusão da LGPD.
 *
 * Então este arquivo não conserta uma linha: fecha a CLASSE. Ele se basta —
 * injeta o próprio CSS — porque exigir que cada página lembre de colar o
 * estilo é justamente como o buraco nasceu.
 *
 * NÃO SOBRESCREVE um toast que a página já tenha (bluetendencias.html e
 * comunidade.js têm o deles). Quem chegou primeiro manda.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  // A página já resolveu isso sozinha: não brigue com ela.
  if (typeof window.toast === 'function') return;

  var CSS = ''
    + '.bt-toast-pilha{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);'
    + 'z-index:9999;display:flex;flex-direction:column-reverse;align-items:center;'
    + 'gap:8px;pointer-events:none;max-width:min(92vw,520px)}'
    + '.bt-toast{background:rgba(10,22,40,.97);border:1px solid rgba(0,170,255,.3);'
    + 'border-radius:10px;padding:12px 20px;font-size:13px;line-height:1.45;'
    + 'color:var(--neon,#7dd3fc);box-shadow:0 8px 24px rgba(0,0,0,.45);'
    // Mensagem de erro carrega o texto da exceção e passa longe de caber numa
    // linha. O nowrap do CSS antigo cortaria justo o caso que mais importa.
    + 'text-align:center;word-break:break-word;overflow-wrap:anywhere;'
    + 'opacity:0;transform:translateY(10px);transition:opacity .22s ease,transform .22s ease}'
    + '.bt-toast.ok{opacity:1;transform:translateY(0)}'
    + '.bt-toast.ruim{border-color:rgba(248,113,113,.45);color:#fca5a5}'
    + '@media (prefers-reduced-motion:reduce){.bt-toast{transition:none}}';

  var pilha = null;

  function garantirCasa() {
    if (pilha && pilha.isConnected) return pilha;
    if (!document.getElementById('bt-toast-estilo')) {
      var st = document.createElement('style');
      st.id = 'bt-toast-estilo';
      st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    }
    pilha = document.createElement('div');
    pilha.className = 'bt-toast-pilha';
    // Leitor de tela anuncia sem roubar o foco de onde a pessoa está.
    pilha.setAttribute('role', 'status');
    pilha.setAttribute('aria-live', 'polite');
    (document.body || document.documentElement).appendChild(pilha);
    return pilha;
  }

  window.toast = function (mensagem, opcoes) {
    try {
      var txt = mensagem === null || mensagem === undefined ? '' : String(mensagem);
      if (!txt) return;
      var o = opcoes || {};
      var casa = garantirCasa();

      var el = document.createElement('div');
      el.className = 'bt-toast' + (o.erro || /^(erro|falha|✗|❌)/i.test(txt) ? ' ruim' : '');
      // textContent, nunca innerHTML: a mensagem carrega e.message e resposta
      // de API, que são texto de fora. HTML aqui seria porta de injeção.
      el.textContent = txt;
      casa.appendChild(el);

      // Dois quadros antes de animar: um só não basta se o elemento acabou de
      // entrar no documento — o navegador ainda não calculou o estado inicial
      // e a transição é pulada.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { el.classList.add('ok'); });
      });

      // Mensagem longa merece mais tempo de leitura que "Salvo!".
      var ms = typeof o.ms === 'number' ? o.ms : Math.min(7000, Math.max(2600, txt.length * 65));
      setTimeout(function () {
        el.classList.remove('ok');
        setTimeout(function () {
          if (el.parentNode) el.parentNode.removeChild(el);
          if (pilha && !pilha.childElementCount && pilha.parentNode) {
            pilha.parentNode.removeChild(pilha);
            pilha = null;
          }
        }, 260);
      }, ms);
    } catch (e) {
      // Um aviso que quebra a página é pior que aviso nenhum — e foi exatamente
      // assim que o ReferenceError impediu o redirecionamento da exclusão de
      // conta. Nada que acontece aqui dentro pode escapar pra quem chamou.
      try { console.warn('[toast]', e && e.message, '|', mensagem); } catch (_) {}
    }
  };
})();
