/* public/perfil-pagina.js — o motor da página /perfil?u=<nome>
 * ---------------------------------------------------------------------------
 * O primeiro perfil que eu entreguei era um MODAL. O pedido era página, e o
 * plano aprovado já dizia "estilo Twitter": capa, avatar grande sobreposto,
 * nome, contadores, e os posts da pessoa listados embaixo. Modal não é isso —
 * ele mostra uma carteira de identidade e some. A página é um lugar: dá pra
 * chegar por link, voltar, compartilhar.
 *
 * O token e a sessão vêm do ComunidadeBT (mesmo caminho do resto da
 * Comunidade). O botão de amizade vem do ComunidadeAmigos, então um só lugar
 * decide como ele se comporta em todas as telas.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
  }
  function $(id) { return document.getElementById(id); }
  function BT() { return window.ComunidadeBT || null; }

  function nomeDaUrl() {
    try {
      var p = new URLSearchParams(location.search);
      return (p.get('u') || p.get('nome') || '').trim();
    } catch (e) { return ''; }
  }

  function hue(n) {
    var h = 0, s = String(n || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }
  function inicial(n) { return String(n || '?').trim().charAt(0).toUpperCase() || '?'; }

  function fmt(n) {
    var v = parseInt(n, 10);
    if (!Number.isFinite(v)) return '—';
    if (v >= 1000000) return (v / 1000000).toFixed(1).replace('.', ',').replace(',0', '') + ' mi';
    if (v >= 1000) return (v / 1000).toFixed(1).replace('.', ',').replace(',0', '') + ' mil';
    return String(v);
  }

  function mesAno(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    var M = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
      'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
    return M[d.getMonth()] + ' de ' + d.getFullYear();
  }

  function quando(iso) {
    if (!iso) return '';
    var d = new Date(iso), s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'agora';
    if (s < 3600) return Math.floor(s / 60) + 'min';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 604800) return Math.floor(s / 86400) + 'd';
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  }

  function anelDe(u) {
    if (!u) return '';
    if (u.mod) return ' mod';
    if (u.plan === 'master') return ' pmaster';
    if (u.plan === 'full') return ' pfull';
    return '';
  }

  // ── Mídia do post ──────────────────────────────────────────────────────────
  // Só o que a gente mesmo hospeda, mais o embed do YouTube com o id validado.
  // Nada de src vindo cru do banco pra dentro de um iframe.
  function midiaHtml(m) {
    if (!m || !m.type) return '';
    if (m.type === 'youtube') {
      if (!/^[A-Za-z0-9_-]{6,15}$/.test(m.id || '')) return '';
      return '<div class="pf-mid"><div class="pf-yt"><iframe src="https://www.youtube.com/embed/' + esc(m.id)
        + '" title="YouTube" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture"'
        + ' allowfullscreen loading="lazy"></iframe></div></div>';
    }
    if (!m.url || !/^https:\/\//i.test(m.url)) return '';
    if (m.type === 'image') return '<div class="pf-mid"><img src="' + esc(m.url) + '" alt="" loading="lazy"></div>';
    if (m.type === 'video') return '<div class="pf-mid"><video src="' + esc(m.url) + '" controls playsinline preload="metadata"></video></div>';
    if (m.type === 'audio') return '<div class="pf-mid" style="padding:12px"><audio src="' + esc(m.url) + '" controls style="width:100%"></audio></div>';
    return '';
  }

  function postHtml(p, u) {
    var tag = (p.tab === 'dicas' && p.pinned) ? '<div class="pf-tag">🎓 TREINAMENTO OFICIAL</div>' : '';
    var mid = (p.media || []).map(midiaHtml).join('');
    return '<article class="pf-post">'
      + tag
      + '<div class="pf-ph"><b>' + esc(u.name) + '</b>· ' + esc(quando(p.created_at))
      + (p.edited_at ? ' · editado' : '') + '</div>'
      + (p.content ? '<div class="pf-txt">' + esc(p.content) + '</div>' : '')
      + mid
      + '<div class="pf-pe"><span>❤ ' + esc(fmt(p.likes_count)) + '</span><span>💬 ' + esc(fmt(p.comments_count)) + '</span></div>'
      + '</article>';
  }

  // ── Desenho da página ──────────────────────────────────────────────────────
  function pintarErro(msg, comRetentar) {
    $('pfAv').style.display = 'none';
    var sk = $('pfSk1'); if (sk) sk.style.display = 'none';
    $('pfCorpo').innerHTML = '<div class="pf-msg">' + esc(msg)
      + (comRetentar ? '<br><button class="pf-btn" id="pfRetry">Tentar de novo</button>' : '')
      + '<br><a class="pf-btn" href="/comunidade">Voltar pra Comunidade</a></div>';
    var b = $('pfRetry');
    if (b) b.addEventListener('click', carregar);
  }

  function pintar(d) {
    var u = d.user || {};
    var anel = anelDe(u);

    document.title = u.name + ' — Comunidade BlueTube';
    var tn = $('pfTopNome');
    if (tn) { tn.textContent = u.name; tn.classList.add('on'); }

    // A capa tira a cor do nome: cada perfil ganha a sua sem ninguém precisar
    // subir imagem — e some o "banner cinza" que todo perfil vazio tem.
    var h = hue(u.name);
    var capa = $('pfCapa');
    if (capa) {
      capa.style.background = u.mod || u.plan === 'master'
        ? 'linear-gradient(120deg,#3d2f07 0%,#6b4e0a 45%,#0a1830 100%)'
        : 'linear-gradient(120deg,hsl(' + h + ',55%,17%) 0%,hsl(' + ((h + 40) % 360) + ',60%,22%) 50%,#0a1830 100%)';
    }

    var av = $('pfAv');
    av.className = 'pf-av' + anel;
    av.innerHTML = u.avatar
      ? '<img src="' + esc(u.avatar) + '" alt="">'
      : esc(inicial(u.name));
    if (!u.avatar) av.style.background = 'hsl(' + h + ',60%,38%)';

    // Botão de amizade — quem desenha é o módulo de amigos, sempre.
    var acao = $('pfAcao');
    if (acao) {
      if (d.eu) {
        acao.innerHTML = '<span style="font-family:var(--font-mono);font-size:11.5px;color:var(--text-dim)">esse é você 👋</span>';
      } else if (window.ComunidadeAmigos && ComunidadeAmigos.botao) {
        acao.innerHTML = ComunidadeAmigos.botao({ name: u.name, mine: false, amizade: d.amizade }) || '';
      }
    }

    var selos = '';
    if (u.mod) selos += '<span class="pf-selo">★ MOD</span>';
    if (u.plan === 'master') selos += '<span class="pf-selo">👑 MASTER</span>';
    else if (u.plan === 'full') selos += '<span class="pf-selo full">⚡ FULL</span>';

    var desde = mesAno(d.desde);
    var lista = d.lista || [];

    var sk = $('pfSk1'); if (sk) sk.remove();

    // Contagem que não veio sai como "—". Zero é fato; "não sei" não pode
    // virar zero na tela — é o mesmo defeito que já apareceu duas vezes aqui.
    var nPosts = (typeof d.posts === 'number') ? fmt(d.posts) : '—';
    var nAmigos = (typeof d.amigos === 'number') ? fmt(d.amigos) : '—';

    var cab = document.querySelector('.pf-cab');
    var extra = document.createElement('div');
    extra.innerHTML =
      '<div class="pf-nome">' + esc(u.name) + selos + '</div>'
      + '<div class="pf-arroba">@' + esc(u.name) + '</div>'
      + (desde ? '<div class="pf-desde">🗓 na Comunidade desde ' + esc(desde) + '</div>' : '')
      + '<div class="pf-nums"><span><b>' + esc(nPosts) + '</b>posts</span>'
      + '<span><b>' + esc(nAmigos) + '</b>' + (d.amigos === 1 ? 'amigo' : 'amigos') + '</span></div>';
    cab.appendChild(extra);

    $('pfCorpo').innerHTML =
      '<div class="pf-abas"><div class="pf-aba on">POSTS</div></div>'
      + '<div class="pf-lista">'
      + (lista.length
        ? lista.map(function (p) { return postHtml(p, u); }).join('')
        : '<div class="pf-msg">' + (d.eu ? 'Você ainda não postou nada por aqui.' : esc(u.name) + ' ainda não postou nada.') + '</div>')
      + '</div>';
  }

  async function carregar() {
    var nome = nomeDaUrl();
    if (!nome) return pintarErro('Faltou dizer de quem é o perfil.', false);

    var bt = BT();
    if (!bt || !bt.call) {
      // O comunidade.js é quem carrega token e sessão. Sem ele não dá pra
      // perguntar nada — e dizer "perfil não existe" seria mentira.
      return pintarErro('Não consegui iniciar a página. Recarrega, por favor.', true);
    }

    var r;
    // { qs } é o envelope que o api() do comunidade.js entende. Passar o nome
    // solto faz ele nunca sair do navegador — foi o defeito da primeira versão.
    try { r = await bt.call('perfil', { qs: '&name=' + encodeURIComponent(nome) }); }
    catch (e) { r = { ok: false, status: 0, d: {} }; }

    if (!r.ok) {
      if (r.status === 404) return pintarErro('Não achei o perfil de "' + nome + '".', false);
      if (r.status === 401) return pintarErro('🔐 Sua sessão expirou. Faça login de novo.', false);
      if (r.status === 403) return pintarErro('👑 A Comunidade é pra assinantes Full e Master.', false);
      return pintarErro('❌ Não deu pra carregar esse perfil agora.', true);
    }
    pintar(r.d || {});
  }

  // O botão de amizade é do módulo de amigos e já se pendura por delegação;
  // depois de agir, recarrega pra contagem e estado saírem do servidor, não
  // de um palpite local.
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-cba-act]') : null;
    if (!el) return;
    setTimeout(carregar, 900);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', carregar);
  } else { carregar(); }
})();
