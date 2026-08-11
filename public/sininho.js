/* public/sininho.js — sininho de notificações no site (2026-08-06)
 * ==========================================================================
 * Nasceu pro BlueScore: a análise é feita à mão e demora, então o usuário
 * PRECISA de um lugar no site pra saber que ficou pronta. Antes disso o
 * sininho só existia dentro do app /blue.
 *
 * Lê a MESMA caixa do app (blue_notificacoes, via /api/blue-interact), então
 * o aviso aparece nos dois lugares e "marcar como lida" vale pros dois.
 *
 * Arquivo separado de propósito: o index.html já tem <script src> e um
 * <script> inline novo no meio dele seria engolido em silêncio.
 */
(function () {
  'use strict';

  var ALVO = '.nav-user-btn';      // o sino entra ANTES do botão de perfil
  var MAX_TENTATIVAS = 60;         // a nav é remontada; não observar pra sempre
  var _aberto = false;
  var _carregando = false;
  var _lista = [];
  var _ultimoId = null;   // pra saber o que é NOVO desde a última leitura
  var _primeira = true;   // na 1ª carga não toca: seria som pro histórico

  function token() { try { return localStorage.getItem('bt_token'); } catch (e) { return null; } }

  function esc(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function quando(iso) {
    if (!iso) return '';
    var min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return 'agora';
    if (min < 60) return min + ' min';
    if (min < 1440) return Math.floor(min / 60) + 'h';
    var d = Math.floor(min / 1440);
    return d === 1 ? 'ontem' : d + 'd';
  }

  // As chaves têm que bater com o `tipo` que o BACKEND grava em
  // blue_notificacoes — o que não estiver aqui cai no 🔔 genérico.
  var ICONES = {
    bluescore: '📊', mensagem: '💬', comentario: '💭',
    curtida: '❤️', seguidor: '👤', verificacao: '✓', assinatura: '⚡',
    amizade: '🤝', // pedido de amizade / pedido aceito na Comunidade
    denuncia: '🚩', // denúncia do menu ⋯ chegando pro moderador
  };

  function estilo() {
    if (document.getElementById('snStyle')) return;
    var s = document.createElement('style');
    s.id = 'snStyle';
    s.textContent = [
      '#snWrap{position:relative;display:inline-flex}',
      '#snBtn{position:relative;background:rgba(0,170,255,.06);border:1px solid rgba(0,170,255,.15);border-radius:9px;',
      'padding:7px 10px;font-size:14px;line-height:1;cursor:pointer;color:#e8f4ff;transition:border-color .2s}',
      '#snBtn:hover{border-color:rgba(0,170,255,.45)}',
      '#snBadge{position:absolute;top:-5px;right:-5px;min-width:16px;height:16px;padding:0 4px;border-radius:100px;',
      'background:linear-gradient(135deg,#ff4757,#ff6b81);color:#fff;font-family:var(--font-mono,monospace);font-size:9px;',
      'font-weight:700;display:none;align-items:center;justify-content:center;box-shadow:0 0 10px rgba(255,71,87,.5)}',
      '#snPanel{display:none;position:absolute;top:calc(100% + 8px);right:0;z-index:800;width:330px;max-width:calc(100vw - 24px);',
      'background:#0a1628;border:1px solid rgba(0,170,255,.25);border-radius:14px;box-shadow:0 20px 50px rgba(0,0,0,.6);overflow:hidden}',
      '#snPanel.on{display:block}',
      '.sn-topo{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(0,170,255,.1)}',
      '.sn-topo b{font-size:13px;color:#e8f4ff}',
      '.sn-corpo{max-height:340px;overflow-y:auto}',
      '.sn-item{display:flex;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(0,170,255,.06);cursor:default}',
      '.sn-item:last-child{border-bottom:none}',
      '.sn-item.link{cursor:pointer}.sn-item.link:hover{background:rgba(0,170,255,.05)}',
      '.sn-item.nova{background:rgba(0,170,255,.045)}',
      // viral absoluto: fundo e borda dourados, título em ouro
      '.sn-item.sn-ouro{background:linear-gradient(135deg,rgba(251,191,36,.12),rgba(251,191,36,.03));border-left:3px solid #fbbf24}',
      '.sn-item.sn-ouro .sn-ico{background:rgba(251,191,36,.16);border-color:rgba(251,191,36,.45)}',
      '.sn-item.sn-ouro .sn-tit{color:#fbbf24;font-weight:800}',
      '.sn-ico{width:28px;height:28px;border-radius:8px;background:rgba(0,170,255,.1);border:1px solid rgba(0,170,255,.18);',
      'display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0}',
      '.sn-txt{flex:1;min-width:0}',
      '.sn-tit{font-size:12.5px;font-weight:600;color:#e8f4ff;line-height:1.35}',
      '.sn-msg{font-size:11.5px;color:rgba(150,190,230,.72);line-height:1.45;margin-top:2px;word-break:break-word}',
      '.sn-quando{font-family:var(--font-mono,monospace);font-size:9.5px;color:rgba(150,190,230,.4);margin-top:3px}',
      '.sn-vazio{padding:26px 16px;text-align:center;font-size:12px;color:rgba(150,190,230,.45);line-height:1.6}',
    ].join('');
    document.head.appendChild(s);
  }

  function montar() {
    if (!token()) return false;
    if (document.getElementById('snWrap')) return true;
    var alvo = document.querySelector(ALVO);
    if (!alvo || !alvo.parentNode) return false;

    estilo();
    var wrap = document.createElement('div');
    wrap.id = 'snWrap';
    wrap.innerHTML =
      '<button id="snBtn" title="Notificações" aria-label="Notificações">🔔<span id="snBadge"></span></button>' +
      '<div id="snPanel" role="dialog" aria-label="Notificações">' +
        '<div class="sn-topo"><b>Notificações</b>' +
        '<button id="snLer" style="background:none;border:none;font-family:var(--font-mono,monospace);font-size:10.5px;color:rgba(150,190,230,.5);cursor:pointer">marcar lidas</button></div>' +
        '<div class="sn-corpo" id="snCorpo"><div class="sn-vazio">Carregando…</div></div>' +
      '</div>';
    alvo.parentNode.insertBefore(wrap, alvo);

    document.getElementById('snBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      alternar();
    });
    document.getElementById('snLer').addEventListener('click', function (e) {
      e.stopPropagation();
      marcarLidas();
    });
    // Os listeners de documento entram UMA vez. montar() roda de novo toda vez
    // que a nav é remontada — sem esta guarda, empilharia um por remontagem.
    if (!montar._globais) {
      montar._globais = true;
      document.addEventListener('click', function (e) {
        var w = document.getElementById('snWrap');
        if (_aberto && w && !w.contains(e.target)) fechar();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && _aberto) fechar();
      });
    }

    carregar();
    // Sem isto o sino só atualizava no F5 — e o som nunca tocaria com o site
    // aberto, que é justamente o pedido. 2 min, e SÓ com a aba visível: aba
    // em segundo plano não precisa de aviso nem de requisição.
    if (!montar._loop) {
      montar._loop = setInterval(function () { if (!document.hidden) carregar(); }, 120000);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) carregar(); });
    }
    return true;
  }

  function alternar() { _aberto ? fechar() : abrir(); }

  function abrir() {
    _aberto = true;
    var p = document.getElementById('snPanel');
    if (p) p.classList.add('on');
    carregar();
  }

  function fechar() {
    _aberto = false;
    var p = document.getElementById('snPanel');
    if (p) p.classList.remove('on');
  }

  async function carregar() {
    var tk = token();
    if (!tk || _carregando) return;
    _carregando = true;
    try {
      var r = await fetch('/api/blue-interact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'notificacoes', token: tk }),
      });
      if (!r.ok) throw new Error('http ' + r.status);
      var d = await r.json();
      _lista = d.notificacoes || [];
      // Som só pra aviso que CHEGOU agora. Na primeira carga da página o
      // histórico inteiro seria "novo" — tocar ali é barulho sem motivo.
      var topo = _lista[0] && _lista[0].id;
      if (!_primeira && topo && topo !== _ultimoId && !_lista[0].lida) {
        if (window.BTSom) window.BTSom.tocar();
      }
      if (topo) _ultimoId = topo;
      _primeira = false;
      pintar(d.unread || 0);
    } catch (e) {
      // sininho é conforto: falhou, some em silêncio em vez de poluir a nav
      var corpo = document.getElementById('snCorpo');
      if (corpo) corpo.innerHTML = '<div class="sn-vazio">Não consegui carregar agora.</div>';
    } finally {
      _carregando = false;
    }
  }

  function pintar(naoLidas) {
    var badge = document.getElementById('snBadge');
    if (badge) {
      badge.textContent = naoLidas > 99 ? '99+' : String(naoLidas);
      badge.style.display = naoLidas > 0 ? 'flex' : 'none';
    }
    var corpo = document.getElementById('snCorpo');
    if (!corpo) return;
    if (!_lista.length) {
      corpo.innerHTML = '<div class="sn-vazio">Nada por aqui ainda.<br>Avisos das suas análises e da sua conta aparecem aqui.</div>';
      return;
    }
    corpo.innerHTML = _lista.map(function (n) {
      var url = (n.dados && n.dados.url) || '';
      // 'ouro' = viral absoluto (300 mil em menos de 3h). O aviso tem que
      // gritar mais que os outros, senão some no meio da lista.
      var ouro = n.dados && n.dados.destaque === 'ouro';
      return '<div class="sn-item' + (url ? ' link' : '') + (n.lida ? '' : ' nova') +
        (ouro ? ' sn-ouro' : '') + '"' +
        (url ? ' data-url="' + esc(url) + '"' : '') + '>' +
        '<div class="sn-ico">' + (ouro ? '👑' : (ICONES[n.tipo] || '🔔')) + '</div>' +
        '<div class="sn-txt">' +
          '<div class="sn-tit">' + esc(n.titulo || 'Aviso') + '</div>' +
          (n.mensagem ? '<div class="sn-msg">' + esc(n.mensagem) + '</div>' : '') +
          '<div class="sn-quando">' + quando(n.created_at) + '</div>' +
        '</div></div>';
    }).join('');
    corpo.querySelectorAll('.sn-item.link').forEach(function (el) {
      el.addEventListener('click', function () {
        marcarLidas();
        var u = el.dataset.url;
        // Link de fora (o Short no YouTube) abre em aba nova — jogar a pessoa
        // pra fora do BlueTube pra ver um vídeo seria perder a sessão dela.
        if (/^https?:\/\//i.test(u)) window.open(u, '_blank', 'noopener');
        else window.location.href = u;
      });
    });
  }

  async function marcarLidas() {
    var tk = token();
    if (!tk) return;
    var badge = document.getElementById('snBadge');
    if (badge) badge.style.display = 'none';
    _lista.forEach(function (n) { n.lida = true; });
    try {
      await fetch('/api/blue-interact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'marcar-lidas', token: tk }),
      });
    } catch (e) {}
  }

  // A nav do index é remontada por innerHTML depois que o plano carrega, o que
  // apaga o sino. O observer reinstala — com teto, senão fica rodando à toa.
  function vigiar() {
    if (montar()) return;
    var tentativas = 0;
    var obs = new MutationObserver(function () {
      // Conta só as tentativas FRUSTRADAS. O index dispara centenas de
      // mutações; contar todas gastaria o teto antes de a nav existir.
      if (document.getElementById('snWrap')) { tentativas = 0; return; }
      if (++tentativas > MAX_TENTATIVAS) return obs.disconnect();
      montar();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', vigiar);
  } else {
    vigiar();
  }
})();
