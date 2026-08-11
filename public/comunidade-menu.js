/* comunidade-menu.js — o menu ⋯ da Comunidade (2026-08-11)
 *
 * UM componente, três lugares: post do feed, comentário e página de perfil.
 *
 * ── POR QUE ARQUIVO PRÓPRIO ───────────────────────────────────────────────
 * O menu que existia vivia dentro do cardHtml() do comunidade.js, montado em
 * string com onclick inline, e tinha três defeitos que só apareciam de uso:
 *
 *   1) `this.nextElementSibling.classList.toggle('on')` abre, mas NADA fecha.
 *      Clicar em outro card abria o segundo com o primeiro ainda aberto, e
 *      clicar fora não fechava nenhum — ficavam abertos até a repintura.
 *   2) o dropdown era absoluto DENTRO do card: no último post do feed ele
 *      abria pra baixo e era cortado pela borda da lista.
 *   3) ele só existia pra AUTOR e MODERADOR. Quem visse algo errado não tinha
 *      o que fazer além de fechar a aba — não havia denunciar, nem copiar link.
 *
 * Um arquivo dedicado (padrão do comunidade-amigos.js) resolve os três de uma
 * vez e faz o mesmo menu servir a página de perfil, que não tinha nenhum.
 *
 * ── O QUE ELE DECIDE E O QUE ELE NÃO DECIDE ───────────────────────────────
 * Ele desenha as opções pelo que o servidor JÁ disse (meu? moderador? amigo?)
 * e executa DUAS por conta própria: copiar link (não sai do navegador) e
 * denunciar (endpoint próprio). Todo o resto — editar, apagar, fixar, banir,
 * desfazer amizade — é devolvido pra quem registrou o handler, porque essas
 * ações já existem e já são autorizadas de novo no servidor. Este arquivo não
 * autoriza nada: ele é uma tela.
 *
 * ── CSS NO ARRANQUE ───────────────────────────────────────────────────────
 * Injetado no load, nunca dentro da função que monta o menu — senão o ⋯ nasce
 * cru no feed e só fica bonito depois que alguém abre um menu (foi exatamente
 * o que aconteceu com a pílula "+ Amigo").
 */
(function () {
  'use strict';
  if (window.ComunidadeMenu) return;

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // Descritores dos itens, por chave. O botão no HTML carrega SÓ a chave —
  // enfiar o objeto inteiro num atributo seria escapar JSON dentro de HTML a
  // cada card, que é onde essas coisas quebram.
  var itens = {};
  var seq = 0;
  var aberto = null;          // chave do menu aberto (um por vez, sempre)
  var handlers = {};
  var lacos = false;

  var MOTIVOS = [
    { id: 'spam', txt: '📢 Spam ou propaganda' },
    { id: 'ofensa', txt: '💢 Ofensa ou ataque pessoal' },
    { id: 'improprio', txt: '🔞 Conteúdo impróprio' },
    { id: 'outro', txt: '❓ Outro motivo' },
  ];

  var CSS = ''
    + '.cmn-b{background:none;border:none;cursor:pointer;color:#5f7590;font-size:16px;line-height:1;'
    + 'padding:4px 8px;border-radius:9px;transition:all .15s;flex:0 0 auto}'
    + '.cmn-b:hover,.cmn-b.on{color:#fff;background:rgba(0,170,255,.12)}'
    // `fixed`, não `absolute`: o menu do último post do feed era cortado pela
    // borda da lista. Preso à tela, ele nunca é cortado por container nenhum.
    + '.cmn-dd{position:fixed;z-index:10050;min-width:196px;max-width:calc(100vw - 20px);'
    + 'background:#0b1729;border:1px solid rgba(0,170,255,.28);border-radius:14px;padding:5px;'
    + 'box-shadow:0 18px 50px rgba(0,0,0,.6)}'
    + '.cmn-dd button{display:flex;align-items:center;gap:9px;width:100%;text-align:left;background:none;'
    + 'border:none;cursor:pointer;border-radius:10px;padding:10px 11px;color:#c7d5ea;'
    + 'font-family:var(--cbt-sans,Inter,sans-serif);font-size:13px;line-height:1.3}'
    + '.cmn-dd button:hover{background:rgba(0,170,255,.1);color:#fff}'
    + '.cmn-dd button.perigo{color:#ff9b8f}'
    + '.cmn-dd button.perigo:hover{background:rgba(255,60,60,.16);color:#fff}'
    + '.cmn-tit{padding:8px 11px 6px;font-family:var(--font-mono,monospace);font-size:9.5px;'
    + 'letter-spacing:.1em;text-transform:uppercase;color:#5f7590;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.cmn-sep{height:1px;background:rgba(255,255,255,.07);margin:4px 6px}';

  function estilo() {
    if ($('cmnCSS')) return;
    var s = document.createElement('style');
    s.id = 'cmnCSS';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function avisar(msg, erro) {
    try {
      if (typeof window.toast === 'function') return window.toast(msg, erro ? 'erro' : '');
    } catch (e) {}
    try { console.log('[comunidade-menu]', msg); } catch (e) {}
  }

  // ── o botão ───────────────────────────────────────────────────────────────
  // `item` descreve o alvo E as permissões que o SERVIDOR já mandou. Nada aqui
  // é adivinhado pelo navegador.
  //   { tipo: 'post'|'comentario'|'perfil', id, nome, meu, mod, fixado, amigo, link }
  function botao(item) {
    if (!item || !item.tipo) return '';
    var chave = 'm' + (++seq);
    itens[chave] = item;
    // O feed é INFINITO: sem teto, este mapa cresce a cada rolagem numa aba que
    // ninguém recarrega. Os descritores antigos são de cards que já saíram da
    // tela — e o menu deles não abre mais de qualquer jeito.
    if (seq % 200 === 0) {
      var chaves = Object.keys(itens);
      for (var i = 0; i < chaves.length - 300; i++) {
        if (chaves[i] !== aberto) delete itens[chaves[i]];
      }
    }
    return '<button class="cmn-b" data-cmn="' + chave + '" aria-haspopup="true" aria-expanded="false"'
      + ' aria-label="Mais opções' + (item.nome ? ' de ' + esc(item.nome) : '') + '">⋯</button>';
  }

  function opcoes(item) {
    var o = [];
    var ehConteudo = item.tipo === 'post' || item.tipo === 'comentario';
    // Editar só existe pra post: o comentário nunca teve editor na tela, e
    // oferecer um botão que abre nada seria pior que não ter o botão.
    if (item.tipo === 'post' && (item.meu || item.mod)) o.push({ acao: 'editar', txt: '✏️ Editar' });
    if (ehConteudo && item.mod && item.podeFixar !== false) o.push({ acao: 'fixar', txt: item.fixado ? '📌 Desafixar' : '📌 Fixar' });
    // Copiar link existe pra TODO MUNDO — é a opção que faz o menu valer a pena
    // pra quem não é autor nem moderador, que é a maioria de quem lê o feed.
    if (item.link) o.push({ acao: 'copiar', txt: '🔗 Copiar link' });
    // Desfazer amizade NÃO entra aqui: o botão de amigo (comunidade-amigos.js)
    // já faz isso, com a confirmação e o texto dele. Duas portas pra mesma ação
    // destrutiva é como se clica na errada.
    if (!item.meu) o.push({ acao: 'denunciar', txt: '🚩 Denunciar', perigo: true });
    if (ehConteudo && (item.meu || item.mod)) o.push({ acao: 'apagar', txt: '🗑️ Apagar', perigo: true });
    // Banir depende de ter o uuid do autor em mãos. O feed de comentários não
    // devolve esse campo (a UI da Comunidade trabalha por display_name), então
    // ali o banir simplesmente não aparece — em vez de aparecer e falhar.
    if (!item.meu && item.mod && item.autorId) o.push({ acao: 'banir', txt: '🚫 Banir da Comunidade', perigo: true });
    return o;
  }

  function html(item, motivos) {
    if (motivos) {
      return '<div class="cmn-tit">denunciar por…</div>'
        + MOTIVOS.map(function (m) { return '<button data-cmn-motivo="' + m.id + '">' + m.txt + '</button>'; }).join('')
        + '<div class="cmn-sep"></div><button data-cmn-acao="voltar">← Voltar</button>';
    }
    var o = opcoes(item);
    if (!o.length) return '';
    return (item.nome ? '<div class="cmn-tit">' + esc(item.nome) + '</div>' : '')
      + o.map(function (x) {
        return '<button class="' + (x.perigo ? 'perigo' : '') + '" data-cmn-acao="' + x.acao + '">' + x.txt + '</button>';
      }).join('');
  }

  function fechar() {
    aberto = null;
    var d = $('cmnDD');
    if (d) d.remove();
    var abertos = document.querySelectorAll('.cmn-b.on');
    for (var i = 0; i < abertos.length; i++) {
      abertos[i].classList.remove('on');
      abertos[i].setAttribute('aria-expanded', 'false');
    }
  }

  function abrir(chave, botaoEl, motivos) {
    var item = itens[chave];
    if (!item) return;
    var corpo = html(item, motivos);
    if (!corpo) return;                  // menu sem nenhuma opção não abre vazio
    fechar();
    aberto = chave;
    botaoEl.classList.add('on');
    botaoEl.setAttribute('aria-expanded', 'true');
    var d = document.createElement('div');
    d.className = 'cmn-dd';
    d.id = 'cmnDD';
    d.setAttribute('role', 'menu');
    d.innerHTML = corpo;
    document.body.appendChild(d);
    posicionar(d, botaoEl);
    d.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      e.stopPropagation();
      var motivo = b.getAttribute('data-cmn-motivo');
      if (motivo) { fechar(); return denunciar(item, motivo); }
      var acao = b.getAttribute('data-cmn-acao');
      if (acao === 'voltar') return abrir(chave, botaoEl, false);
      if (acao === 'denunciar') return abrir(chave, botaoEl, true);
      fechar();
      if (acao === 'copiar') return copiar(item);
      var fn = handlers[acao];
      if (typeof fn === 'function') fn(item);
    });
  }

  // Preso à tela e SEMPRE dentro dela: no celular um menu de 196px aberto num
  // botão colado na direita sairia pela borda; e no último post do feed ele
  // abriria pra baixo, fora da vista.
  function posicionar(d, botaoEl) {
    try {
      var r = botaoEl.getBoundingClientRect();
      var larg = d.offsetWidth || 196;
      var alt = d.offsetHeight || 180;
      var x = Math.min(r.right - larg, window.innerWidth - larg - 8);
      d.style.left = Math.max(8, x) + 'px';
      d.style.top = (r.bottom + alt + 8 > window.innerHeight ? Math.max(8, r.top - alt - 6) : r.bottom + 6) + 'px';
    } catch (e) {}
  }

  // ── as duas ações que este arquivo executa sozinho ────────────────────────
  function copiar(item) {
    var url = item.link;
    try {
      if (url.charAt(0) === '/') url = window.location.origin + url;
    } catch (e) {}
    var pronto = function () { avisar('🔗 Link copiado.'); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(url).then(pronto).catch(function () { copiarNaMarra(url, pronto); });
      }
    } catch (e) {}
    copiarNaMarra(url, pronto);
  }

  // Safari antigo e página sem HTTPS não têm clipboard API. Sem esta reserva o
  // "Copiar link" seria um botão que não faz nada em silêncio.
  function copiarNaMarra(url, pronto) {
    try {
      var t = document.createElement('textarea');
      t.value = url;
      t.style.position = 'fixed';
      t.style.opacity = '0';
      document.body.appendChild(t);
      t.select();
      var ok = document.execCommand && document.execCommand('copy');
      t.remove();
      if (ok) return pronto();
    } catch (e) {}
    avisar('Não consegui copiar. O link é: ' + url, true);
  }

  function denunciar(item, motivo) {
    var t = '';
    try { t = localStorage.getItem('bt_token') || ''; } catch (e) {}
    fetch('/api/community?action=denunciar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'denunciar', token: t, tipo: item.tipo, alvo: item.id, motivo: motivo }),
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (d) {
        if (!d || !d.ok) return avisar((d && d.error) || 'Não deu pra enviar a denúncia agora.', true);
        // Denúncia repetida responde igual a denúncia nova, de propósito: dizer
        // "você já denunciou" transformaria o botão numa sonda.
        avisar('🚩 Denúncia enviada pra moderação. Obrigado por avisar.');
      })
      .catch(function () { avisar('Não consegui falar com o servidor agora.', true); });
  }

  // ── laços globais, ligados UMA vez ────────────────────────────────────────
  // Era isto que faltava no menu antigo: abrir tinha dono, fechar não tinha
  // ninguém.
  function ligar() {
    estilo();
    if (lacos) return;
    lacos = true;
    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-cmn]') : null;
      if (b) {
        e.preventDefault();
        e.stopPropagation();
        var chave = b.getAttribute('data-cmn');
        if (aberto === chave) return fechar();      // segundo toque fecha
        return abrir(chave, b, false);
      }
      if (aberto) {
        var d = $('cmnDD');
        if (!d || !d.contains(e.target)) fechar();
      }
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && aberto) { e.preventDefault(); fechar(); }
    });
    // Rolar com o menu aberto o deixaria flutuando longe do botão que o abriu —
    // ele é `fixed`, então não acompanha a página.
    window.addEventListener('scroll', function () { if (aberto) fechar(); }, true);
    window.addEventListener('resize', function () { if (aberto) fechar(); });
  }

  window.ComunidadeMenu = {
    botao: botao,
    ligar: ligar,
    fechar: fechar,
    // Quem monta a tela registra o que fazer com editar/apagar/fixar/banir/
    // desamigo. O que não for registrado simplesmente não aparece funcionando —
    // e é por isso que `opcoes()` só oferece o que aquele contexto sabe fazer.
    aoAcionar: function (mapa) {
      Object.keys(mapa || {}).forEach(function (k) { handlers[k] = mapa[k]; });
    },
    _interno: { opcoes: opcoes, html: html, itens: itens, MOTIVOS: MOTIVOS },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ligar);
  else ligar();
})();
