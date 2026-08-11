/* public/comunidade-perfil.js — o perfil de quem posta na Comunidade.
 * ---------------------------------------------------------------------------
 * POR QUE ESTE ARQUIVO EXISTE
 *
 * O dono relatou, testando as amizades: "não tem nada nos usuários pra
 * adicionar". Estava certo. Só dava pra pedir amizade a quem, por acaso,
 * tivesse um post visível no feed naquele instante — e um nome no feed era
 * texto morto, sem nada pra clicar. A amizade existia sem lugar para acontecer.
 *
 * O perfil é esse lugar: o nome vira clicável, a pessoa vira alguém (foto,
 * plano, desde quando está aqui, quantos posts), e o botão de amizade fica
 * onde faz sentido — dentro dela, não perdido num cabeçalho de post.
 *
 * ARQUIVO ISOLADO de propósito, como o comunidade-amigos.js: não é chamado por
 * ninguém. Ele se pendura no clique por delegação. Se falhar ao carregar, a
 * Comunidade inteira continua de pé e só não abre perfil.
 *
 * ⚠️ O CSS ENTRA NO ARRANQUE, não quando o painel abre. Esse erro exato acabou
 * de acontecer com a pílula "+ Amigo": o estilo morava na função que constrói
 * o painel, então a pílula nascia crua no feed e só ficava bonita se alguém
 * abrisse o painel antes. Quem pinta garante o estilo.
 */
(function () {
  'use strict';
  if (window.ComunidadePerfil) return;

  var S = { aberto: false, carregando: false, dados: null, erro: null, nome: null };

  function BT() { return window.ComunidadeBT || null; }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
  }
  function toast(m) { try { if (window.toast) window.toast(m); } catch (e) {} }

  // Chamada à API pela mesma porta do resto da Comunidade, pra herdar token e
  // tratamento de sessão em vez de inventar um caminho paralelo.
  async function api(action, extra) {
    var bt = BT();
    if (!bt || !bt.call) return { ok: false, status: 0, d: {} };
    return bt.call(action, extra);
  }

  var CSS = [
    '.cbp-ov{position:fixed;inset:0;z-index:1200;display:none;align-items:center;justify-content:center;',
    'background:rgba(2,8,23,.72);backdrop-filter:blur(6px);padding:18px}',
    '.cbp-ov.on{display:flex}',
    '.cbp-box{width:min(430px,100%);max-height:88vh;overflow:auto;background:#081426;',
    'border:1px solid rgba(0,170,255,.18);border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.6)}',
    '.cbp-topo{position:relative;padding:26px 22px 18px;text-align:center;',
    'background:radial-gradient(ellipse 120% 90% at 50% -20%,rgba(0,110,255,.22),transparent 70%)}',
    '.cbp-x{position:absolute;top:12px;right:12px;background:rgba(10,22,40,.7);border:1px solid rgba(0,170,255,.2);',
    'color:#8aa0bd;border-radius:100px;width:30px;height:30px;cursor:pointer;font-size:14px;line-height:1}',
    '.cbp-x:hover{color:#fff;border-color:rgba(0,170,255,.45)}',
    '.cbp-av{width:88px;height:88px;border-radius:50%;margin:0 auto 12px;overflow:hidden;display:flex;',
    'align-items:center;justify-content:center;font-weight:700;color:#fff;font-size:34px;font-family:var(--font-display,sans-serif)}',
    '.cbp-av img{width:100%;height:100%;object-fit:cover}',
    '.cbp-av.mod{box-shadow:0 0 0 3px #081426,0 0 0 5px #fbbf24,0 0 22px rgba(251,191,36,.45)}',
    '.cbp-av.pfull{box-shadow:0 0 0 3px #081426,0 0 0 5px #00aaff,0 0 22px rgba(0,170,255,.45)}',
    '.cbp-av.pmaster{box-shadow:0 0 0 3px #081426,0 0 0 5px #fbbf24,0 0 26px rgba(251,191,36,.5)}',
    '.cbp-nome{font-family:var(--font-display,sans-serif);font-weight:800;font-size:21px;color:#e8f0fb;',
    'letter-spacing:-.3px;display:flex;align-items:center;justify-content:center;gap:7px;flex-wrap:wrap}',
    '.cbp-selo{font-family:var(--font-mono,monospace);font-size:9.5px;font-weight:700;padding:3px 8px;border-radius:100px;',
    'background:rgba(251,191,36,.14);color:#fbbf24;border:1px solid rgba(251,191,36,.3)}',
    '.cbp-selo.plano{background:rgba(0,170,255,.1);color:#00c4ff;border-color:rgba(0,170,255,.26)}',
    '.cbp-desde{font-family:var(--font-mono,monospace);font-size:11px;color:#5f7590;margin-top:7px}',
    '.cbp-nums{display:flex;gap:10px;justify-content:center;margin:16px 0 4px}',
    '.cbp-num{flex:1 1 0;max-width:130px;background:rgba(10,22,40,.55);border:1px solid rgba(0,170,255,.12);',
    'border-radius:12px;padding:11px 8px}',
    '.cbp-num b{display:block;font-family:var(--font-display,sans-serif);font-size:19px;color:#e8f0fb;font-variant-numeric:tabular-nums}',
    '.cbp-num span{display:block;font-family:var(--font-mono,monospace);font-size:9.5px;color:#5f7590;margin-top:2px;letter-spacing:.4px}',
    '.cbp-acao{padding:6px 22px 24px;display:flex;justify-content:center}',
    '.cbp-vazio{padding:38px 22px;text-align:center;font-family:var(--font-mono,monospace);font-size:12.5px;color:#8aa0bd;line-height:1.7}',
    '.cbp-mini{margin-top:14px;background:rgba(0,170,255,.08);border:1px solid rgba(0,170,255,.24);color:#00c4ff;',
    'font-family:var(--font-mono,monospace);font-size:11px;padding:7px 15px;border-radius:100px;cursor:pointer}',
    // O nome no feed passa a PARECER clicável — senão ninguém descobre que é.
    '[data-cbp-name]{cursor:pointer}',
    '[data-cbp-name]:hover{text-decoration:underline;text-underline-offset:3px}',
  ].join('');

  function garantirEstilo() {
    if (document.getElementById('cbpStyle')) return;
    var st = document.createElement('style');
    st.id = 'cbpStyle';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function montar() {
    garantirEstilo();
    if (document.getElementById('cbpOv')) return;
    var ov = document.createElement('div');
    ov.className = 'cbp-ov';
    ov.id = 'cbpOv';
    ov.innerHTML = '<div class="cbp-box" role="dialog" aria-label="Perfil" id="cbpBox"></div>';
    document.body.appendChild(ov);
    // Clicar no fundo fecha; clicar na caixa, não.
    ov.addEventListener('click', function (e) { if (e.target === ov) fechar(); });
  }

  function inicial(n) { return String(n || '?').trim().charAt(0).toUpperCase() || '?'; }
  function hue(n) {
    var h = 0, s = String(n || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  function anelDe(u) {
    if (!u) return '';
    if (u.mod) return ' mod';
    if (u.plan === 'master') return ' pmaster';
    if (u.plan === 'full') return ' pfull';
    return '';
  }

  function mesAno(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    var M = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    return M[d.getMonth()] + '/' + d.getFullYear();
  }

  function render() {
    var box = document.getElementById('cbpBox');
    if (!box) return;

    if (S.erro) {
      box.innerHTML = '<div class="cbp-topo"><button class="cbp-x" data-cbp-act="fechar" aria-label="Fechar">✕</button></div>'
        + '<div class="cbp-vazio">' + esc(S.erro)
        + '<br><button class="cbp-mini" data-cbp-act="retentar">Tentar de novo</button></div>';
      return;
    }
    if (!S.dados) {
      box.innerHTML = '<div class="cbp-topo"><button class="cbp-x" data-cbp-act="fechar" aria-label="Fechar">✕</button></div>'
        + '<div class="cbp-vazio">Carregando…</div>';
      return;
    }

    var d = S.dados;
    var u = d.user || {};
    var anel = anelDe(u);
    var foto = u.avatar
      ? '<div class="cbp-av' + anel + '"><img src="' + esc(u.avatar) + '" alt=""></div>'
      : '<div class="cbp-av' + anel + '" style="background:hsl(' + hue(u.name) + ',60%,38%)">' + esc(inicial(u.name)) + '</div>';

    var selos = '';
    if (u.mod) selos += '<span class="cbp-selo">★ MOD</span>';
    if (u.plan === 'master') selos += '<span class="cbp-selo">MASTER</span>';
    else if (u.plan === 'full') selos += '<span class="cbp-selo plano">FULL</span>';

    var quando = mesAno(d.desde);
    // "0 posts" é fato; "não sei quantos" não pode virar 0 na tela — foi
    // exatamente esse tipo de mentira que a revisão pegou nas amizades.
    var posts = (typeof d.posts === 'number') ? String(d.posts) : '—';

    var botao = '';
    if (d.eu) {
      botao = '<div class="cbp-vazio" style="padding:4px 22px 20px">Esse é você 👋</div>';
    } else if (window.ComunidadeAmigos && ComunidadeAmigos.botao) {
      botao = ComunidadeAmigos.botao({ name: u.name, mine: false, amizade: d.amizade }) || '';
    }

    box.innerHTML =
      '<div class="cbp-topo">'
      + '<button class="cbp-x" data-cbp-act="fechar" aria-label="Fechar">✕</button>'
      + foto
      + '<div class="cbp-nome">' + esc(u.name) + selos + '</div>'
      + (quando ? '<div class="cbp-desde">na Comunidade desde ' + esc(quando) + '</div>' : '')
      + '<div class="cbp-nums">'
      + '<div class="cbp-num"><b>' + esc(posts) + '</b><span>POSTS</span></div>'
      + '</div>'
      + '</div>'
      + (botao ? '<div class="cbp-acao">' + botao + '</div>' : '');
  }

  async function carregar(nome) {
    S.carregando = true;
    S.erro = null;
    var r;
    try { r = await api('perfil', { name: nome }); } catch (e) { r = { ok: false, status: 0, d: {} }; }
    S.carregando = false;
    if (!r.ok) {
      // Erro é estado PRÓPRIO, com motivo. "Carregando…" pra sempre foi um dos
      // defeitos confirmados no painel de amigos; não repito aqui.
      S.erro = r.status === 404 ? 'Não achei esse perfil.'
        : r.status === 401 ? '🔐 Sua sessão expirou. Faça login de novo.'
          : r.status === 403 ? '👑 A Comunidade é pra assinantes Full e Master.'
            : '❌ Não deu pra carregar esse perfil agora.';
      S.dados = null;
      render();
      return;
    }
    S.dados = r.d || {};
    render();
  }

  function abrir(nome) {
    if (!nome) return;
    montar();
    S.aberto = true;
    S.nome = nome;
    S.dados = null;
    S.erro = null;
    var ov = document.getElementById('cbpOv');
    if (ov) ov.classList.add('on');
    render();
    carregar(nome);
  }

  function fechar() {
    S.aberto = false;
    var ov = document.getElementById('cbpOv');
    if (ov) ov.classList.remove('on');
  }

  // ── Cliques ────────────────────────────────────────────────────────────────
  // Delegação, nunca onclick inline com nome de usuário dentro: nome é dado de
  // outra pessoa, e dado de outra pessoa não entra em atributo executável.
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-cbp-act],[data-cbp-name]') : null;
    if (!el) return;

    var act = el.getAttribute('data-cbp-act');
    if (act === 'fechar') { fechar(); return; }
    if (act === 'retentar') { S.erro = null; render(); carregar(S.nome); return; }

    var nome = el.getAttribute('data-cbp-name');
    if (!nome) return;
    // Se o clique pegou o botão de amizade (que vive dentro do cabeçalho), o
    // dono do clique é ele, não o perfil.
    if (e.target.closest && e.target.closest('[data-cba-act]')) return;
    e.preventDefault();
    e.stopPropagation();
    abrir(nome);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && S.aberto) fechar();
  });

  // Estilo no arranque: quem só passa pelo feed já encontra o nome clicável
  // com a mão de "clicável", sem depender de ninguém ter aberto nada antes.
  garantirEstilo();

  window.ComunidadePerfil = { abrir: abrir, fechar: fechar };
})();
