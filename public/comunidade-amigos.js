/* public/comunidade-amigos.js — AMIZADES da Comunidade (2026-08-11)
 * ===========================================================================
 * Arquivo dedicado de propósito: um <script> inline novo dentro do
 * comunidade.html seria engolido em silêncio pelo <script src> vizinho.
 * Aqui só vive a camada de amizade — o comunidade.js só chama dois pontos:
 *   • ComunidadeAmigos.botao(post)  → pílula de estado no cabeçalho do card
 *   • ComunidadeAmigos.abrir()      → painel Amigos / Recebidos / Enviados
 * Se este arquivo não carregar, o feed continua funcionando sem o botão.
 *
 * PORTÃO: o painel e o botão só existem quando ComunidadeBT.me() responde —
 * e ele só responde quando o backend liberou (Full/Master ou moderador). O
 * portão de verdade é o do servidor (api/community.js); este é o espelho.
 *
 * SEGURANÇA DE HTML: tudo que vem de outro usuário (nome, avatar) passa por
 * esc() antes de virar markup, e nenhuma ação usa onclick inline com dado de
 * usuário dentro — os cliques vão por delegação lendo data-attributes.
 */
(function () {
  'use strict';
  if (window.ComunidadeAmigos) return;

  // `erro` existe separado de `dados` de propósito: sem ele, falha de rede e
  // lista vazia eram o MESMO estado (dados=null), e o painel dizia
  // "Carregando…" pra sempre em vez de admitir que quebrou.
  var S = { aberto: false, carregando: false, dados: null, erro: null, aba: 'amigos', estados: {} };

  function BT() { return window.ComunidadeBT || null; }
  function me() { try { return BT() && BT().me(); } catch (e) { return null; } }
  function liberado() { var m = me(); return !!(m && (m.paying || m.is_moderator)); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(m) { try { BT().toast(m); } catch (e) { /* silencioso */ } }
  function api(action, opts) { return BT().call(action, opts || {}); }

  function inicial(n) { return (String(n || '?').trim().charAt(0) || '?').toUpperCase(); }
  function hue(n) { var h = 0, s = String(n || ''); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }

  // Avatar no padrão visual da Comunidade (anel por plano, selo 👑/⚡)
  function avatar(u) {
    var anel = u.mod ? ' mod' : u.plan === 'master' ? ' pmaster' : u.plan === 'full' ? ' pfull' : '';
    var selo = u.mod ? '' : u.plan === 'master' ? '<span class="cbt-pbdg">👑</span>' : u.plan === 'full' ? '<span class="cbt-pbdg">⚡</span>' : '';
    var core = u.avatar
      ? '<div class="cbt-av' + anel + '"><img src="' + esc(u.avatar) + '" alt=""></div>'
      : '<div class="cbt-av' + anel + '" style="background:hsl(' + hue(u.name) + ',60%,38%)">' + esc(inicial(u.name)) + '</div>';
    return '<div class="cbt-avwrap">' + core + selo + '</div>';
  }

  // ── CSS ───────────────────────────────────────────────────────────────────
  var CSS = [
    '.cba-btn{margin-left:auto;background:rgba(0,170,255,.07);border:1px solid rgba(0,170,255,.22);border-radius:100px;',
    'color:#00c4ff;font-family:var(--font-mono,monospace);font-size:10.5px;font-weight:700;padding:5px 11px;cursor:pointer;',
    'white-space:nowrap;flex:0 0 auto;transition:all .18s;backdrop-filter:blur(8px)}',
    '.cba-btn:hover{background:rgba(0,170,255,.16);box-shadow:0 0 14px rgba(0,170,255,.16);transform:translateY(-1px)}',
    '.cba-btn:disabled{opacity:.55;cursor:default;transform:none;box-shadow:none}',
    '.cba-btn.cba-amigos{color:#7fe3a5;border-color:rgba(52,211,153,.3);background:rgba(52,211,153,.07)}',
    '.cba-btn.cba-amigos:hover{background:rgba(52,211,153,.14);box-shadow:0 0 14px rgba(52,211,153,.16)}',
    '.cba-btn.cba-pendente_enviado{color:#8aa0bd;border-color:rgba(138,160,189,.28);background:rgba(138,160,189,.06)}',
    '.cba-btn.cba-pendente_recebido{color:#ffd977;border-color:rgba(251,191,36,.38);background:rgba(251,191,36,.09)}',
    '.cba-btn.cba-pendente_recebido:hover{background:rgba(251,191,36,.16);box-shadow:0 0 14px rgba(251,191,36,.18)}',
    '.cba-btn+.cbt-menu{margin-left:8px}',
    // painel
    '.cba-ov{position:fixed;inset:0;z-index:9060;background:rgba(2,8,23,.8);backdrop-filter:blur(8px);display:none;align-items:center;justify-content:center;padding:18px}',
    '.cba-ov.on{display:flex}',
    '.cba-box{width:100%;max-width:440px;max-height:82vh;display:flex;flex-direction:column;background:rgba(10,24,48,.86);',
    'backdrop-filter:blur(24px) saturate(140%);-webkit-backdrop-filter:blur(24px) saturate(140%);',
    'border:1px solid rgba(0,170,255,.26);border-radius:24px;box-shadow:0 26px 80px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.06);overflow:hidden}',
    '.cba-head{display:flex;align-items:center;gap:10px;padding:16px 18px 12px;border-bottom:1px solid rgba(0,170,255,.1)}',
    '.cba-head h3{flex:1;margin:0;font-family:var(--font-display,Syne,sans-serif);font-size:16px;color:#fff;letter-spacing:-.3px}',
    '.cba-head button{background:none;border:none;color:#8aa0bd;font-size:19px;cursor:pointer;padding:4px 8px;border-radius:9px}',
    '.cba-head button:hover{background:rgba(255,255,255,.06);color:#fff}',
    '.cba-tabs{display:flex;gap:6px;padding:12px 14px 4px}',
    '.cba-tab{flex:1;background:rgba(10,22,40,.4);border:1px solid transparent;border-radius:100px;color:#8aa0bd;',
    'font-family:var(--font-display,Syne,sans-serif);font-weight:700;font-size:11.5px;padding:8px 4px;cursor:pointer;transition:all .2s}',
    '.cba-tab.on{color:#00d0ff;border-color:rgba(0,170,255,.35);background:rgba(0,170,255,.1)}',
    '.cba-tab i{font-style:normal;font-family:var(--font-mono,monospace);font-size:9.5px;opacity:.75;margin-left:4px}',
    '.cba-list{flex:1;overflow-y:auto;padding:10px 14px 16px}',
    '.cba-row{display:flex;align-items:center;gap:11px;padding:10px 4px;border-bottom:1px solid rgba(0,170,255,.06)}',
    '.cba-row:last-child{border-bottom:none}',
    '.cba-row b{font-size:13px;color:#fff;display:block;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.cba-row small{font-family:var(--font-mono,monospace);font-size:9.5px;color:#5f7590}',
    '.cba-acts{margin-left:auto;display:flex;gap:6px;flex:0 0 auto}',
    '.cba-mini{background:rgba(0,170,255,.1);border:1px solid rgba(0,170,255,.22);border-radius:100px;color:#00c4ff;',
    'font-family:var(--font-mono,monospace);font-size:10.5px;font-weight:700;padding:6px 11px;cursor:pointer;transition:all .18s}',
    '.cba-mini:hover{background:rgba(0,170,255,.2)}',
    '.cba-mini.ok{color:#7fe3a5;border-color:rgba(52,211,153,.32);background:rgba(52,211,153,.1)}',
    '.cba-mini.no{color:#f87171;border-color:rgba(248,113,113,.28);background:rgba(248,113,113,.07)}',
    '.cba-vazio{text-align:center;color:#5f7590;font-family:var(--font-mono,monospace);font-size:11.5px;padding:34px 16px;line-height:1.9}',
  ].join('');

  // ⚠️ O ESTILO NÃO PODE DEPENDER DO PAINEL. Ele morava dentro do montar(),
  // que só roda quando a pessoa ABRE o painel de amigos — mas a pílula
  // "+ Amigo" é pintada no feed assim que a página carrega. O que se via na
  // tela era uma caixa branca crua no cabeçalho do post, sem borda nem cor,
  // até alguém por acaso abrir o painel. Quem pinta garante o estilo.
  function garantirEstilo() {
    if (document.getElementById('cbaStyle')) return;
    var st = document.createElement('style'); st.id = 'cbaStyle'; st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function montar() {
    garantirEstilo();
    if (document.getElementById('cbaOv')) return;
    var ov = document.createElement('div');
    ov.className = 'cba-ov'; ov.id = 'cbaOv';
    ov.innerHTML =
      '<div class="cba-box" role="dialog" aria-label="Amigos da Comunidade">' +
        '<div class="cba-head"><h3>🤝 Amigos</h3><button data-cba-act="fechar" aria-label="Fechar">✕</button></div>' +
        '<div class="cba-tabs">' +
          '<button class="cba-tab on" data-cba-aba="amigos">Amigos<i data-cba-n="amigos"></i></button>' +
          '<button class="cba-tab" data-cba-aba="recebidos">Recebidos<i data-cba-n="recebidos"></i></button>' +
          '<button class="cba-tab" data-cba-aba="enviados">Enviados<i data-cba-n="enviados"></i></button>' +
        '</div>' +
        '<div class="cba-list" id="cbaList"></div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) fechar(); });
  }

  // ── Pílula de estado no card do post ──────────────────────────────────────
  // `am` vem do backend (api/community.js → AM.estadoParaMim): já traz
  // pode_pedir/bloqueado/dias_espera resolvidos, então o botão nunca promete
  // uma ação que o servidor vai recusar.
  var ROTULO = {
    amigos: { txt: '🤝 Amigos', act: 'desfazer' },
    pendente_enviado: { txt: '⏳ Pendente', act: 'cancelar' },
    pendente_recebido: { txt: '✓ Aceitar', act: 'aceitar' },
    nenhum: { txt: '+ Amigo', act: 'pedir' },
  };

  function botao(p) {
    if (!p || p.mine || !liberado()) return '';
    var nome = p && p.name;
    if (!nome) return '';
    // O que o SERVIDOR mandou vence o cache local. O contrário deixava um
    // estado velho ("amigos") sobreviver a um render novo do feed onde a
    // amizade já tinha sido desfeita — a tela mentia até dar F5.
    var am = p.amizade || S.estados[nome] || null;
    if (!am) return '';
    S.estados[nome] = am;
    return pilula(nome, am);
  }

  function pilula(nome, am) {
    var estado = am.estado || 'nenhum';
    if (estado === 'nenhum' && !am.pode_pedir) {
      // Bloqueado ou em carência: não oferecemos um botão fadado ao 429.
      if (am.bloqueado) return '';
      return '<span class="cba-btn cba-espera" style="cursor:default;opacity:.6">⏳ ' + esc(String(am.dias_espera || 1)) + 'd</span>';
    }
    var r = ROTULO[estado] || ROTULO.nenhum;
    return '<button class="cba-btn cba-' + esc(estado) + '" data-cba-act="' + r.act + '" data-cba-name="' + esc(nome) + '">' + r.txt + '</button>';
  }

  // Repinta TODAS as pílulas daquela pessoa (o mesmo autor pode ter vários
  // posts e comentários abertos na tela ao mesmo tempo).
  function repintar(nome, am) {
    S.estados[nome] = am;
    var todos = document.querySelectorAll('[data-cba-name]');
    for (var i = 0; i < todos.length; i++) {
      var el = todos[i];
      if (el.getAttribute('data-cba-name') !== nome) continue;
      var tmp = document.createElement('div');
      tmp.innerHTML = pilula(nome, am);
      if (tmp.firstChild) el.parentNode.replaceChild(tmp.firstChild, el);
      else el.parentNode.removeChild(el);
    }
  }

  // ── Ações ─────────────────────────────────────────────────────────────────
  var ACAO = {
    pedir: { endpoint: 'amizade-pedir', ok: '🤝 Pedido enviado!' },
    aceitar: { endpoint: 'amizade-aceitar', ok: '🤝 Vocês agora são amigos!' },
    recusar: { endpoint: 'amizade-recusar', ok: 'Pedido recusado.', confirma: 'Recusar este pedido de amizade?' },
    cancelar: { endpoint: 'amizade-cancelar', ok: 'Pedido cancelado.', confirma: 'Cancelar o pedido de amizade que você enviou?' },
    desfazer: { endpoint: 'amizade-desfazer', ok: 'Amizade desfeita.', confirma: 'Desfazer a amizade? Pra voltar atrás, essa pessoa vai precisar esperar uma carência antes de te pedir de novo.' },
  };

  async function agir(act, nome, alvoEl) {
    var cfg = ACAO[act];
    if (!cfg || !nome) return;
    if (!liberado()) return toast('🔒 A Comunidade é exclusiva de assinantes.');
    if (cfg.confirma && !confirm(cfg.confirma)) return;
    if (alvoEl) alvoEl.disabled = true;
    var r;
    try { r = await api(cfg.endpoint, { body: { name: nome } }); }
    catch (e) { if (alvoEl) alvoEl.disabled = false; return toast('❌ Falha de rede.'); }
    var d = r.d || {};
    if (!r.ok) {
      if (alvoEl) alvoEl.disabled = false;
      if (r.status === 401) return toast('🔐 Faça login de novo.');
      if (r.status === 403 && d.upgrade) return toast('👑 Amizades são pra assinantes Full e Master.');
      return toast('❌ ' + (d.error || 'Não deu certo.'));
    }
    // 'ja_existia' = pedido duplicado; o backend devolveu o estado, não criou nada
    toast(d.ja_existia ? 'Você já tinha feito isso.' : (d.cruzado ? '🤝 Vocês se pediram ao mesmo tempo — amigos!' : cfg.ok));
    repintar(nome, estadoDepois(act, d, S.estados[nome]));
    if (S.aberto) await carregar();
    else atualizarBadge();
  }

  // Estado local imediato (o backend é a verdade; isso só evita o piscar)
  // ⚠️ O `pode_pedir = false` que morava aqui INVENTAVA uma punição. Recusar,
  // cancelar ou desfazer não punem quem clicou — a penalidade, quando existe, vai
  // pro OUTRO lado. Mas a pílula virava o texto morto "⏳ 1d", anunciando uma
  // carência de um dia que o servidor nunca aplicou, e a pessoa ficava sem
  // conseguir readicionar alguém que o backend aceitaria na hora.
  // A única espera legítima é uma carência PRÓPRIA que já existia antes.
  function estadoDepois(act, d, anterior) {
    var estado = d.estado || 'nenhum';
    var base = { estado: estado, pode_pedir: false, bloqueado: false, espera_ate: null, dias_espera: 0 };
    if (estado !== 'nenhum') return base; // amigos / pendente_* não pedem nada
    var ant = (anterior && typeof anterior === 'object') ? anterior : null;
    var ate = ant && ant.espera_ate ? new Date(ant.espera_ate).getTime() : 0;
    var esperando = !!ate && ate > Date.now();
    base.bloqueado = !!(ant && ant.bloqueado);
    base.espera_ate = esperando ? ant.espera_ate : null;
    base.dias_espera = esperando ? (ant.dias_espera || 1) : 0;
    base.pode_pedir = !esperando && !base.bloqueado;
    return base;
  }

  // ── Painel ────────────────────────────────────────────────────────────────
  async function abrir(aba) {
    if (!liberado()) return toast('🔒 A Comunidade é exclusiva de assinantes.');
    montar();
    S.aberto = true;
    S.aba = aba || S.aba || 'amigos';
    document.getElementById('cbaOv').classList.add('on');
    marcarAba();
    render();
    await carregar();
  }

  function fechar() {
    S.aberto = false;
    var ov = document.getElementById('cbaOv');
    if (ov) ov.classList.remove('on');
  }

  async function carregar() {
    if (S.carregando) return;
    S.carregando = true;
    var r;
    try { r = await api('amizades'); } catch (e) { r = { ok: false, d: {} }; }
    S.carregando = false;
    if (!r.ok) {
      S.erro = r.status === 401 ? '🔐 Sua sessão expirou. Faça login de novo.'
             : r.status === 403 ? '👑 Amizades são pra assinantes Full e Master.'
             : '❌ Não deu pra carregar sua lista de amigos.';
      // Já havia lista boa na tela (o caso do aceite seguido de 401): PRESERVA
      // e avisa por cima. Apagar a lista que funcionava era o pior dos mundos.
      if (S.dados) toast(S.erro);
      render();
      return;
    }
    S.erro = null;
    S.dados = r.d || {};
    // Mantém as pílulas do feed em dia com a lista
    ['amigos', 'recebidos', 'enviados'].forEach(function (k) {
      (S.dados[k] || []).forEach(function (it) {
        if (it && it.user && it.user.name && it.estado) S.estados[it.user.name] = it.estado;
      });
    });
    atualizarBadge();
    render();
  }

  function atualizarBadge() {
    var n = S.dados && S.dados.recebidos ? S.dados.recebidos.length : 0;
    var els = document.querySelectorAll('[data-cba-badge]');
    for (var i = 0; i < els.length; i++) {
      els[i].textContent = n > 99 ? '99+' : String(n);
      els[i].style.display = n > 0 ? 'inline-block' : 'none';
    }
  }

  function marcarAba() {
    var tabs = document.querySelectorAll('.cba-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('on', tabs[i].getAttribute('data-cba-aba') === S.aba);
    }
  }

  var VAZIO = {
    amigos: '🤝 Você ainda não tem amigos por aqui.<br>Peça amizade a quem posta no feed.',
    recebidos: '📭 Nenhum pedido de amizade recebido.',
    enviados: '📤 Você não tem pedidos aguardando resposta.',
  };

  function linhaHtml(it, aba) {
    var u = it.user || {};
    var nome = u.name || 'Usuário';
    var acts = '';
    if (aba === 'recebidos') {
      acts = '<button class="cba-mini ok" data-cba-act="aceitar" data-cba-name="' + esc(nome) + '">Aceitar</button>' +
             '<button class="cba-mini no" data-cba-act="recusar" data-cba-name="' + esc(nome) + '">Recusar</button>';
    } else if (aba === 'enviados') {
      acts = '<button class="cba-mini no" data-cba-act="cancelar" data-cba-name="' + esc(nome) + '">Cancelar</button>';
    } else {
      acts = '<button class="cba-mini no" data-cba-act="desfazer" data-cba-name="' + esc(nome) + '">Desfazer</button>';
    }
    var tag = u.mod ? 'moderador ★' : u.plan === 'master' ? 'Master 👑' : u.plan === 'full' ? 'Full ⚡' : 'assinante';
    return '<div class="cba-row">' + avatar(u) +
      '<div><b>' + esc(nome) + '</b><small>' + esc(tag) + '</small></div>' +
      '<div class="cba-acts">' + acts + '</div></div>';
  }

  function render() {
    var box = document.getElementById('cbaList');
    if (!box) return;
    if (!S.dados) {
      // Erro não pode se disfarçar de "Carregando…" eterno. As frases são
      // constantes deste arquivo, nunca dado de usuário — sem risco de injeção.
      box.innerHTML = S.erro
        ? '<div class="cba-vazio">' + S.erro + '<br><br><button class="cba-mini" data-cba-act="retentar">Tentar de novo</button></div>'
        : '<div class="cba-vazio">Carregando…</div>';
      return;
    }
    ['amigos', 'recebidos', 'enviados'].forEach(function (k) {
      var el = document.querySelector('[data-cba-n="' + k + '"]');
      var n = (S.dados[k] || []).length;
      if (el) el.textContent = n ? '(' + n + ')' : '';
    });
    var lista = S.dados[S.aba] || [];
    box.innerHTML = lista.length
      ? lista.map(function (it) { return linhaHtml(it, S.aba); }).join('')
      : '<div class="cba-vazio">' + VAZIO[S.aba] + '</div>';
  }

  // ── Delegação de cliques (nenhum dado de usuário dentro de onclick) ───────
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-cba-act],[data-cba-aba]') : null;
    if (!el) return;
    var aba = el.getAttribute('data-cba-aba');
    if (aba) { S.aba = aba; marcarAba(); render(); return; }
    var act = el.getAttribute('data-cba-act');
    if (act === 'fechar') { fechar(); return; }
    // ANTES do teste de `nome`: o botão de retentar não tem data-cba-name.
    if (act === 'retentar') { S.erro = null; render(); carregar(); return; }
    var nome = el.getAttribute('data-cba-name');
    if (!act || !nome) return;
    e.preventDefault(); e.stopPropagation();
    agir(act, nome, el);
  });

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.aberto) fechar(); });

  // Deep-link do sininho: dados.url = '/comunidade?amigos=1'
  function autoAbrir() {
    try {
      if (new URLSearchParams(location.search).get('amigos') !== '1') return;
      var tentativas = 0;
      var t = setInterval(function () {
        if (liberado()) { clearInterval(t); abrir('recebidos'); }
        else if (++tentativas > 40) clearInterval(t);
      }, 250);
    } catch (e) {}
  }

  // Badge de pedidos recebidos já no carregamento (sem abrir o painel)
  function prefetch() {
    var tentativas = 0;
    var t = setInterval(function () {
      if (liberado()) { clearInterval(t); carregar(); }
      else if (++tentativas > 40) clearInterval(t);
    }, 250);
  }

  // O estilo entra junto com o módulo, não com o painel: qualquer caminho que
  // pinte pílula (feed, comentários, prefetch) já encontra o CSS no lugar.
  garantirEstilo();

  window.ComunidadeAmigos = {
    botao: botao, abrir: abrir, fechar: fechar, recarregar: carregar,
    _estados: S.estados,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { prefetch(); autoAbrir(); });
  } else { prefetch(); autoAbrir(); }
})();
