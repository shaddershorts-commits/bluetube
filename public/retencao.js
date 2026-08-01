/* retencao.js — oferta de retenção REAL no cancelamento (2026-08-02)
 *
 * Substitui o passo 2 do modal de cancelamento: o antigo oferecia "R$10 no
 * próximo mês" e o botão era um STUB (alert sem aplicar nada). Agora:
 *   - Full e Master: 50% DE DESCONTO PERMANENTE na assinatura atual
 *   - Master: destaque dourado (é a retenção que mais importa)
 *   - vídeo do Blublu (mesmo da Oferta de Ativação) fazendo o "espera aí"
 *   - aceitar chama /api/retencao-50, que aplica o cupom forever na Stripe
 *
 * Arquivo separado + defer, sobrescrevendo funções do inline — mesma regra
 * do blublu-roteiro.js: NADA entra no <script> inline onde vive o pixel.
 * Se este arquivo falhar, o fluxo antigo continua (com o stub, mas continua).
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var PRECOS = { // exibição BRL (24/25 pagantes); a confirmação usa o valor REAL da Stripe
    master: { de: 'R$ 89,99', por: 'R$ 44,99' },
    full: { de: 'R$ 29,99', por: 'R$ 14,99' },
  };

  function montarOferta() {
    var step2 = $('cancelStep2');
    if (!step2) return false;
    var plano = (localStorage.getItem('bt_plan') || '').toLowerCase();
    if (plano !== 'master' && plano !== 'full') return false;   // segue o fluxo antigo
    var ehMaster = plano === 'master';
    var p = PRECOS[plano];
    var cor = ehMaster ? '#fbbf24' : 'var(--neon, #00aaff)';
    var grad = ehMaster ? 'linear-gradient(135deg,#fbbf24,#f59e0b)' : 'linear-gradient(135deg,var(--blue-500,#1a6bff),var(--neon,#00aaff))';

    step2.innerHTML =
      '<video id="retVideo" preload="none" playsinline ' +
      ' style="width:100%;max-height:220px;border-radius:14px;background:#000;border:1px solid ' + (ehMaster ? 'rgba(251,191,36,.35)' : 'rgba(0,170,255,.3)') + ';margin-bottom:14px"' +
      ' onerror="this.style.display=\'none\'">' +
      '  <source src="/blublu-ultima-chance.mp4" type="video/mp4"/>' +
      '</video>' +
      '<div style="font-size:17px;font-weight:800;margin-bottom:6px">Espera — isso aqui muda a conta.</div>' +
      '<div style="font-family:var(--font-mono,monospace);font-size:12.5px;color:var(--text-secondary,#9db8d8);margin-bottom:16px;line-height:1.6">' +
      (ehMaster
        ? 'Antes de você ir: <strong style="color:#fbbf24">50% de desconto PERMANENTE</strong> no seu Master. Não é um mês — é <strong style="color:#fbbf24">pra sempre</strong>, em toda mensalidade.'
        : 'Antes de você ir: <strong style="color:' + cor + '">50% de desconto permanente</strong> no seu plano — pra sempre, em toda mensalidade.') +
      '</div>' +
      '<div style="background:' + (ehMaster ? 'rgba(251,191,36,.07)' : 'rgba(0,170,255,.06)') + ';border:1px solid ' + (ehMaster ? 'rgba(251,191,36,.35)' : 'rgba(0,170,255,.2)') + ';border-radius:12px;padding:18px;margin-bottom:18px">' +
      '  <div style="font-family:var(--font-mono,monospace);font-size:12px;color:var(--text-dim,#6b87a8);text-decoration:line-through">' + p.de + '/mês</div>' +
      '  <div style="font-size:32px;font-weight:900;color:' + cor + '">' + p.por + '<span style="font-size:14px;font-weight:700">/mês</span></div>' +
      '  <div style="font-family:var(--font-mono,monospace);font-size:11px;color:' + cor + ';font-weight:700;letter-spacing:.04em;margin-top:4px">PARA SEMPRE · sem pegadinha · cancela quando quiser</div>' +
      '</div>' +
      '<div id="retErro" style="display:none;font-family:var(--font-mono,monospace);font-size:12px;color:#ff7a5a;margin-bottom:12px"></div>' +
      '<div style="display:flex;gap:10px">' +
      '  <button id="retAceitar" onclick="acceptDiscount()" style="flex:1.4;background:' + grad + ';border:none;border-radius:10px;padding:14px;font-family:var(--font-display,sans-serif);font-size:13px;font-weight:800;color:' + (ehMaster ? '#0a1020' : '#fff') + ';cursor:pointer">' + (ehMaster ? '👑 Ficar pagando metade' : '💙 Ficar pagando metade') + '</button>' +
      '  <button onclick="finalCancel()" style="flex:1;background:rgba(255,80,80,0.08);border:1px solid rgba(255,80,80,0.25);border-radius:10px;padding:14px;font-family:var(--font-mono,monospace);font-size:12px;color:#ff7a5a;cursor:pointer">Cancelar mesmo assim</button>' +
      '</div>';

    // o vídeo toca a partir do clique em "Confirmar cancelamento" (gesto real)
    var v = $('retVideo');
    if (v) { try { v.play().catch(function () {}); } catch (e) {} }
    return true;
  }

  // ── sobrescreve o passo 2: monta a oferta nova; sem plano pago, fluxo velho
  var confirmAntigo = window.confirmCancelStep2;
  window.confirmCancelStep2 = function () {
    if (typeof confirmAntigo === 'function') confirmAntigo();   // faz o show/hide dos steps
    montarOferta();                                             // e a gente troca o conteúdo
  };

  // ── aceitar = aplicar DE VERDADE na Stripe (o antigo era alert de mentira)
  window.acceptDiscount = async function () {
    var btn = $('retAceitar');
    var erro = $('retErro');
    if (btn) { btn.disabled = true; btn.textContent = 'Aplicando…'; }
    if (erro) erro.style.display = 'none';
    try {
      var r = await fetch('/api/retencao-50', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + (localStorage.getItem('bt_token') || ''),
        },
      });
      var d = await r.json().catch(function () { return {}; });
      if (r.ok && d.ok) {
        var valor = (d.moeda === 'BRL' && d.valor_novo)
          ? 'R$ ' + Number(d.valor_novo).toFixed(2).replace('.', ',')
          : (d.valor_novo ? d.valor_novo + ' ' + (d.moeda || '') : 'metade do valor');
        var step2 = $('cancelStep2');
        if (step2) {
          step2.innerHTML =
            '<div style="font-size:48px;margin-bottom:14px">🎉</div>' +
            '<div style="font-size:17px;font-weight:800;margin-bottom:8px">Fechado — 50% pra sempre.</div>' +
            '<div style="font-family:var(--font-mono,monospace);font-size:13px;color:var(--text-secondary,#9db8d8);line-height:1.7">' +
            (d.ja_tinha
              ? 'Você já tinha esse desconto ativo — segue valendo.'
              : 'Sua assinatura continua ativa e a partir da <strong>próxima fatura</strong> você paga <strong style="color:var(--neon,#00aaff)">' + valor + '/mês</strong>. Sem prazo, sem volta ao preço cheio.') +
            '</div>' +
            '<button onclick="closeCancelModal()" style="margin-top:20px;background:rgba(0,170,255,0.07);border:1px solid rgba(0,170,255,0.2);border-radius:10px;padding:12px 24px;font-family:var(--font-mono,monospace);font-size:12px;color:var(--text-secondary,#9db8d8);cursor:pointer">Voltar pro BlueTube 💙</button>';
        }
      } else {
        if (erro) {
          erro.textContent = d.error || 'Não consegui aplicar agora. Tenta de novo.';
          erro.style.display = 'block';
        }
        if (btn) { btn.disabled = false; btn.textContent = 'Tentar de novo'; }
      }
    } catch (e) {
      if (erro) { erro.textContent = 'Falha de conexão — tenta de novo.'; erro.style.display = 'block'; }
      if (btn) { btn.disabled = false; btn.textContent = 'Tentar de novo'; }
    }
  };
})();
