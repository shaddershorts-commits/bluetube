/* blublu-suporte.js — "Como usar?" da Comunidade (2026-08-06)
 *
 * Entrada acima da aba Dicas: título azul brilhante + o Blublu flutuando num
 * círculo ao lado. Clicou, abre um chat de SUPORTE de verdade — um Claude
 * respondendo com a personalidade dele, ensinando a usar o BlueTube.
 *
 * Arquivo próprio de propósito: não chama nenhuma função do comunidade.js,
 * só injeta o botão no lugar certo. Um bug aqui não derruba a comunidade.
 */
(function () {
  'use strict';

  var API = '/api/blublu-suporte';
  var historico = [];            // [{papel:'voce'|'blublu', texto}]
  var ocupado = false;
  var montado = false;

  // ── estilo ────────────────────────────────────────────────────────────────
  var CSS = ''
    + '.bsp-entrada{display:flex;align-items:center;gap:13px;margin:0 16px 10px;padding:13px 15px;border-radius:16px;cursor:pointer;'
    + 'background:linear-gradient(135deg,rgba(0,208,255,.14),rgba(0,140,255,.06));border:1px solid rgba(0,208,255,.4);'
    + 'box-shadow:0 0 26px rgba(0,208,255,.14),inset 0 1px 0 rgba(255,255,255,.07);transition:all .22s}'
    + '.bsp-entrada:hover{background:linear-gradient(135deg,rgba(0,208,255,.22),rgba(0,140,255,.1));'
    + 'box-shadow:0 0 38px rgba(0,208,255,.26),inset 0 1px 0 rgba(255,255,255,.1);transform:translateY(-1px)}'
    + '.bsp-circ{width:46px;height:46px;border-radius:50%;flex-shrink:0;position:relative;'
    + 'background:radial-gradient(circle at 50% 35%,rgba(0,208,255,.3),rgba(0,120,255,.08));'
    + 'border:1px solid rgba(0,208,255,.5);box-shadow:0 0 20px rgba(0,208,255,.3);'
    + 'display:flex;align-items:center;justify-content:center;overflow:hidden;animation:bspFlut 3.4s ease-in-out infinite}'
    + '.bsp-circ img{width:38px;height:38px;object-fit:contain;filter:drop-shadow(0 0 7px rgba(0,208,255,.65))}'
    + '@keyframes bspFlut{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}'
    + '@media (prefers-reduced-motion:reduce){.bsp-circ{animation:none}}'
    + '.bsp-txt{flex:1;min-width:0}'
    + '.bsp-tit{font-family:var(--font-display,Syne,sans-serif);font-weight:800;font-size:15px;color:#5fe3ff;'
    + 'text-shadow:0 0 14px rgba(0,208,255,.5);line-height:1.2}'
    + '.bsp-sub{font-family:var(--font-mono,monospace);font-size:11px;color:#8aa0bd;margin-top:3px}'
    + '.bsp-seta{color:#5fe3ff;font-size:19px;flex-shrink:0;opacity:.85}'

    // overlay
    + '.bsp-ov{position:fixed;inset:0;z-index:100000;background:rgba(2,8,23,.9);backdrop-filter:blur(14px);'
    + 'display:none;align-items:center;justify-content:center;padding:16px}'
    + '.bsp-ov.on{display:flex}'
    + '.bsp-box{width:100%;max-width:640px;height:min(82vh,720px);display:flex;flex-direction:column;'
    + 'background:linear-gradient(180deg,#0d1b30,#060d1a);border:1px solid rgba(0,208,255,.32);border-radius:20px;'
    + 'box-shadow:0 30px 90px rgba(0,0,0,.6),0 0 46px rgba(0,208,255,.12);overflow:hidden}'
    + '.bsp-head{display:flex;align-items:center;gap:12px;padding:15px 17px;border-bottom:1px solid rgba(255,255,255,.07);flex:0 0 auto}'
    + '.bsp-head img{width:40px;height:40px;border-radius:50%;background:rgba(0,208,255,.12);padding:3px;'
    + 'border:1px solid rgba(0,208,255,.4)}'
    + '.bsp-nome{font-family:var(--font-display,Syne,sans-serif);font-weight:800;font-size:15.5px;color:#eaf6ff}'
    + '.bsp-st{font-family:var(--font-mono,monospace);font-size:10.5px;color:#5fe3ff;margin-top:2px}'
    + '.bsp-x{margin-left:auto;background:none;border:none;color:#7d92b8;font-size:20px;cursor:pointer;padding:4px 8px}'
    + '.bsp-msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:11px}'
    + '.bsp-m{max-width:86%;padding:11px 14px;border-radius:14px;font-size:14px;line-height:1.62;white-space:pre-wrap;word-wrap:break-word}'
    + '.bsp-m.eu{align-self:flex-end;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;border-bottom-right-radius:5px}'
    + '.bsp-m.ele{align-self:flex-start;background:rgba(255,255,255,.055);color:#dceaff;border:1px solid rgba(255,255,255,.08);border-bottom-left-radius:5px}'
    + '.bsp-m.erro{align-self:flex-start;background:rgba(255,90,90,.1);color:#ffb3a7;border:1px solid rgba(255,90,90,.28)}'
    + '.bsp-m b{color:#fff}.bsp-m code{background:rgba(0,208,255,.14);padding:1px 6px;border-radius:5px;font-size:12.5px;color:#8ceaff}'
    + '.bsp-dig{align-self:flex-start;display:flex;gap:4px;padding:12px 15px}'
    + '.bsp-dig i{width:7px;height:7px;border-radius:50%;background:#5fe3ff;display:block;animation:bspP 1.3s infinite}'
    + '.bsp-dig i:nth-child(2){animation-delay:.18s}.bsp-dig i:nth-child(3){animation-delay:.36s}'
    + '@keyframes bspP{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-4px)}}'
    + '.bsp-sug{display:flex;flex-wrap:wrap;gap:7px;padding:0 16px 12px}'
    + '.bsp-sug button{background:rgba(0,208,255,.08);border:1px solid rgba(0,208,255,.3);color:#9fdcff;'
    + 'border-radius:100px;padding:7px 13px;font-size:12px;cursor:pointer;font-family:inherit;transition:all .18s}'
    + '.bsp-sug button:hover{background:rgba(0,208,255,.18);color:#fff}'
    + '.bsp-in{display:flex;gap:9px;padding:13px 16px;border-top:1px solid rgba(255,255,255,.07);flex:0 0 auto}'
    + '.bsp-in input{flex:1;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:12px;'
    + 'padding:13px 15px;color:#eaf6ff;font-size:14px;font-family:inherit;outline:none}'
    + '.bsp-in input:focus{border-color:rgba(0,208,255,.5)}'
    + '.bsp-in button{background:linear-gradient(135deg,#00aaff,#0077ff);border:none;border-radius:12px;'
    + 'width:50px;color:#fff;font-size:17px;cursor:pointer}'
    + '.bsp-in button:disabled{opacity:.45;cursor:default}'
    + '@media(max-width:560px){.bsp-box{height:92vh;max-width:100%}.bsp-ov{padding:0}.bsp-box{border-radius:0}}';

  function estilo() {
    if (document.getElementById('bspCSS')) return;
    var s = document.createElement('style');
    s.id = 'bspCSS';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  // markdown mínimo: **negrito**, `código` e listas numeradas já vêm quebradas
  function fmt(t) {
    return esc(t)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  var $ = function (id) { return document.getElementById(id); };

  function montarOverlay() {
    if (montado) return;
    montado = true;
    var ov = document.createElement('div');
    ov.className = 'bsp-ov';
    ov.id = 'bspOv';
    ov.onclick = function (e) { if (e.target === ov) fechar(); };
    ov.innerHTML =
      '<div class="bsp-box">' +
      '  <div class="bsp-head">' +
      '    <img src="/blublu-pointing.png" alt="Blublu" onerror="this.style.display=\'none\'"/>' +
      '    <div><div class="bsp-nome">Blublu</div><div class="bsp-st">te ensinando a usar o BlueTube</div></div>' +
      '    <button class="bsp-x" onclick="BluBluSuporte.fechar()" aria-label="Fechar">✕</button>' +
      '  </div>' +
      '  <div class="bsp-msgs" id="bspMsgs"></div>' +
      '  <div class="bsp-sug" id="bspSug"></div>' +
      '  <div class="bsp-in">' +
      '    <input id="bspIn" type="text" maxlength="1200" placeholder="Pergunta o que quiser sobre o BlueTube…" autocomplete="off"/>' +
      '    <button id="bspEnv" onclick="BluBluSuporte.enviar()" aria-label="Enviar">➤</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(ov);
    $('bspIn').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); }
    });
  }

  function addMsg(classe, texto) {
    var box = $('bspMsgs');
    if (!box) return null;
    var d = document.createElement('div');
    d.className = 'bsp-m ' + classe;
    d.innerHTML = fmt(texto);
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
    return d;
  }

  function digitando(ligar) {
    var box = $('bspMsgs');
    if (!box) return;
    var el = $('bspDig');
    if (ligar && !el) {
      el = document.createElement('div');
      el.className = 'bsp-dig';
      el.id = 'bspDig';
      el.innerHTML = '<i></i><i></i><i></i>';
      box.appendChild(el);
      box.scrollTop = box.scrollHeight;
    }
    if (!ligar && el) el.remove();
  }

  // Sugestões só pra quebrar a tela em branco — o que a pessoa digita depois
  // vai livre pro modelo. Somem no primeiro envio.
  var SUGESTOES = [
    'Como eu faço um roteiro do zero?',
    'Como acho vídeos virais do meu nicho?',
    'Como baixo um canal inteiro?',
    'O que é o BlueMetadata?',
  ];

  function pintarSugestoes() {
    var box = $('bspSug');
    if (!box) return;
    box.innerHTML = SUGESTOES.map(function (s) {
      return '<button type="button" data-q="' + esc(s) + '">' + esc(s) + '</button>';
    }).join('');
    box.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        $('bspIn').value = b.getAttribute('data-q');
        enviar();
      });
    });
  }

  async function enviar() {
    if (ocupado) return;
    var input = $('bspIn');
    var texto = (input.value || '').trim();
    if (!texto) return;

    var sug = $('bspSug');
    if (sug) sug.innerHTML = '';

    input.value = '';
    addMsg('eu', texto);
    historico.push({ papel: 'voce', texto: texto });

    ocupado = true;
    $('bspEnv').disabled = true;
    digitando(true);

    try {
      var token = localStorage.getItem('bt_token') || '';
      var r = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token, mensagem: texto, historico: historico.slice(0, -1) }),
      });
      var d = await r.json().catch(function () { return {}; });
      digitando(false);

      if (!r.ok || !d.resposta) {
        var msgs = {
          login_obrigatorio: 'Entra na sua conta pra falar comigo.',
          plano_necessario: 'O suporte aqui é pra assinante Full ou Master.',
          timeout: 'Demorei demais. Manda de novo?',
        };
        addMsg('erro', msgs[d.error] || d.detail || 'Deu ruim aqui. Tenta de novo em instantes.');
        return;
      }

      addMsg('ele', d.resposta);
      historico.push({ papel: 'blublu', texto: d.resposta });
      if (historico.length > 24) historico = historico.slice(-24);
    } catch (e) {
      digitando(false);
      addMsg('erro', 'Sem conexão aqui. Confere a internet e tenta de novo.');
    } finally {
      ocupado = false;
      var b = $('bspEnv');
      if (b) b.disabled = false;
      input.focus();
    }
  }

  // Traz a conversa salva do servidor. Fica no servidor (não no navegador) pra
  // a pessoa continuar de onde parou mesmo trocando de aparelho.
  async function carregarConversa() {
    if (historico.length) return;                 // já tem conversa nesta sessão
    try {
      var token = localStorage.getItem('bt_token') || '';
      if (!token) return;
      var r = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token, acao: 'historico', mensagem: '.' }),
      });
      var d = await r.json().catch(function () { return {}; });
      if (!d.ok || !d.conversa || !d.conversa.length) return false;

      var box = $('bspMsgs');
      if (box) box.innerHTML = '';
      d.conversa.forEach(function (m) {
        addMsg(m.papel === 'blublu' ? 'ele' : 'eu', m.texto);
        historico.push(m);
      });
      if (historico.length > 24) historico = historico.slice(-24);
      return true;
    } catch (e) { return false; }
  }

  function abrir() {
    estilo();
    montarOverlay();
    $('bspOv').classList.add('on');
    document.body.style.overflow = 'hidden';

    if (!historico.length) {
      var saudacao = addMsg('ele', 'Opa. Sou o Blublu — aqui eu te ensino a usar o BlueTube na prática.\n\nPergunta do jeito que vier: "como faço X", "pra que serve Y", "qual o caminho pra Z". Se travar em alguma tela, me diz onde que eu te tiro de lá.');
      pintarSugestoes();
      // se existir conversa salva, ela substitui a saudação
      carregarConversa().then(function (tinha) {
        if (tinha) { var s = $('bspSug'); if (s) s.innerHTML = ''; }
        else if (saudacao && !historico.length) { /* mantém a saudação */ }
      });
    }
    setTimeout(function () { var i = $('bspIn'); if (i) i.focus(); }, 120);
  }

  function fechar() {
    var ov = $('bspOv');
    if (ov) ov.classList.remove('on');
    document.body.style.overflow = '';
  }

  // ── injeta a entrada ACIMA da aba Dicas ───────────────────────────────────
  function entradaHTML() {
    return '<div class="bsp-entrada" id="bspEntrada" role="button" tabindex="0">' +
      '  <div class="bsp-circ"><img src="/blublu-pointing.png" alt="Blublu"/></div>' +
      '  <div class="bsp-txt">' +
      '    <div class="bsp-tit">Como usar?</div>' +
      '    <div class="bsp-sub">Pergunta pro Blublu — ele te ensina passo a passo</div>' +
      '  </div>' +
      '  <div class="bsp-seta">›</div>' +
      '</div>';
  }

  function injetar() {
    if (document.getElementById('bspEntrada')) return true;
    // ancora: a barra de abas (mobile/modal) ou a navegação lateral (desktop)
    var abas = document.getElementById('cbtTabs');
    var lateral = document.querySelector('.cbt-side .cbt-brand');
    var alvo = null, modo = '';
    if (abas && abas.offsetParent !== null) { alvo = abas; modo = 'antes'; }
    else if (lateral) { alvo = lateral; modo = 'depois'; }
    else if (abas) { alvo = abas; modo = 'antes'; }
    if (!alvo) return false;

    estilo();
    var wrap = document.createElement('div');
    wrap.innerHTML = entradaHTML();
    var el = wrap.firstElementChild;
    if (modo === 'antes') alvo.parentNode.insertBefore(el, alvo);
    else alvo.parentNode.insertBefore(el, alvo.nextSibling);

    el.addEventListener('click', abrir);
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); }
    });
    return true;
  }

  // A comunidade monta a tela por JS e pode montar depois da gente. Tenta
  // agora, e fica de olho até aparecer (com teto, pra não observar pra sempre).
  function ligar() {
    if (injetar()) return;
    var tentativas = 0;
    var obs = new MutationObserver(function () {
      if (injetar() || ++tentativas > 60) obs.disconnect();
    });
    try { obs.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    setTimeout(function () { try { obs.disconnect(); } catch (e) {} }, 30000);
  }

  window.BluBluSuporte = { abrir: abrir, fechar: fechar, enviar: enviar };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ligar);
  else ligar();
})();
