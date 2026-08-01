/* oferta-cupom.js — cupom de AFILIADO pré-aplicado no checkout (2026-08-02)
 *
 * Escopo: só afiliado. O link do afiliado (?ref=CODIGO) já ativa o cupom de
 * 50% dele — quem clica não precisa digitar código nenhum no checkout.
 * Links com ?cupom=CODIGO explícito também funcionam.
 *
 * NÃO existe cupom padrão pra visitante sem link, NÃO reescreve preço na tela:
 * a página continua mostrando o preço de tabela. O desconto aparece no
 * checkout da Stripe (ou no valor do Pix).
 *
 * Arquivo separado (defer) de propósito: zero linha nova no <script> inline
 * do index.html, onde vive o pixel (regra da casa).
 */
(function () {
  'use strict';

  // Afiliados com cupom próprio: o link normal deles já ativa o desconto,
  // então links antigos já distribuídos passam a valer sem retrabalho.
  var REF_CUPONS = {
    'luizgui238bae5': 'Stubbe50',  // Luiz  — luiz.gui2@hotmail.com
    'invectga7e70ad': 'Daniel50'   // Daniel — invectgames@gmail.com
  };

  // 1. captura o cupom do link e persiste (sobrevive ao login/OTP no meio)
  var cupomNovo = null;
  try {
    var p = new URLSearchParams(window.location.search);
    var c = (p.get('cupom') || p.get('coupon') || '').trim();
    var ref = (p.get('ref') || '').trim();
    if (!c && ref && REF_CUPONS[ref]) c = REF_CUPONS[ref];
    if (c && /^[A-Za-z0-9_-]{3,40}$/.test(c)) {
      localStorage.setItem('bt_cupom', c);
      cupomNovo = c;
      // limpa só o cupom da URL (o ?ref= FICA — a atribuição do afiliado precisa dele)
      p.delete('cupom'); p.delete('coupon');
      var q = p.toString();
      history.replaceState(null, '', window.location.pathname + (q ? '?' + q : '') + window.location.hash);
    }
  } catch (e) {}

  // 2. injeta nos checkouts — interceptação cirúrgica do fetch
  var fetchOriginal = window.fetch;
  window.fetch = function (input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var ehCheckout = url.indexOf('/api/create-checkout') !== -1 || url.indexOf('/api/asaas-create-pix') !== -1;
      var cup = localStorage.getItem('bt_cupom');
      if (ehCheckout && cup && init && typeof init.body === 'string') {
        var body = JSON.parse(init.body);
        if (!body.cupom && !body.activation_offer) {   // ativação tem desconto próprio, não empilha
          body.cupom = cup;
          init = Object.assign({}, init, { body: JSON.stringify(body) });
        }
      }
    } catch (e) { /* qualquer falha: checkout segue normal, sem cupom */ }
    return fetchOriginal.call(this, input, init);
  };

  // 3. chip discreto pra quem CHEGOU por link com cupom saber que ele existe.
  // Não promete percentual: quem decide o desconto é a Stripe, no checkout.
  if (cupomNovo) {
    try {
      var chip = document.createElement('div');
      chip.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:99999;background:linear-gradient(135deg,#92400e,#fbbf24);color:#fff;font:600 13px/1.4 system-ui,sans-serif;padding:10px 18px;border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.35);display:flex;align-items:center;gap:8px;max-width:92vw';
      chip.innerHTML = '🎟️ Cupom <strong>' + cupomNovo.replace(/[<>&"]/g, '') + '</strong> será aplicado no checkout' +
        '<span style="cursor:pointer;opacity:.8;margin-left:4px;font-size:15px" onclick="this.parentNode.remove()">✕</span>';
      var addChip = function () { document.body && document.body.appendChild(chip); };
      if (document.body) addChip(); else document.addEventListener('DOMContentLoaded', addChip);
    } catch (e) {}
  }
})();
