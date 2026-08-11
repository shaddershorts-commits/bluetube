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
  function toast(m) { try { if (window.toast) window.toast(m); else if (BT() && BT().toast) BT().toast(m); } catch (e) {} }

  // O nome vem do CAMINHO (/felipedesignersocial). O ?u= fica como segunda
  // via: é o que salva quem tem display_name igual ao nome de uma página real
  // (/virais, /comunidade…), onde o arquivo vence a reescrita e o caminho
  // limpo nunca chega aqui.
  function nomeDaUrl() {
    try {
      var q = new URLSearchParams(location.search).get('u');
      if (q && q.trim()) return q.trim();
      var seg = decodeURIComponent((location.pathname || '').split('/').filter(Boolean)[0] || '');
      if (seg && seg.toLowerCase() !== 'perfil') return seg.trim();
      return '';
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


  // ── EDIÇÃO DO PRÓPRIO PERFIL ───────────────────────────────────────────────
  // Capa, foto, bio e link. Só aparece no próprio perfil, e o servidor decide
  // isso pelo token — a tela esconder o botão é conveniência, não segurança.
  var MAXBIO = 160;
  var atual = null; // último perfil carregado, pra reabrir o editor sem ir ao ar

  // Encolhe a imagem no NAVEGADOR antes de mandar. Uma foto de celular tem
  // 4-8MB; a API recusa acima de ~2,5MB e, mesmo passando, subir isso no 4G da
  // pessoa é castigo. Capa vira 1500px de largura, foto 400.
  function encolher(file, ladoMax, qualidade) {
    return new Promise(function (ok, falha) {
      var img = new Image();
      var urlObj = URL.createObjectURL(file);
      img.onload = function () {
        try {
          var r = Math.min(1, ladoMax / Math.max(img.width, img.height));
          var c = document.createElement('canvas');
          c.width = Math.round(img.width * r);
          c.height = Math.round(img.height * r);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(urlObj);
          ok(c.toDataURL('image/jpeg', qualidade));
        } catch (e) { URL.revokeObjectURL(urlObj); falha(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(urlObj); falha(new Error('imagem ilegível')); };
      img.src = urlObj;
    });
  }

  async function mandarImagem(file, tipo) {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type || '')) {
      return toast('Use uma imagem JPG, PNG ou WebP.');
    }
    toast(tipo === 'capa' ? 'Enviando a capa…' : 'Enviando a foto…');
    var dados;
    try { dados = await encolher(file, tipo === 'capa' ? 1500 : 400, 0.85); }
    catch (e) { return toast('❌ Não consegui ler essa imagem.'); }

    var r;
    try {
      r = tipo === 'capa'
        ? await BT().call('perfil-salvar', { body: { capa_data: dados } })
        : await BT().call('profile-set', { body: { avatar_data: dados } });
    } catch (e) { r = { ok: false, d: {} }; }

    if (!r.ok) return toast('❌ ' + ((r.d && (r.d.detalhe || r.d.error)) || 'Não deu pra salvar agora.'));
    toast(tipo === 'capa' ? '✅ Capa atualizada!' : '✅ Foto atualizada!');
    carregar();
  }

  function abrirEditor() {
    if (!atual) return;
    var alvo = document.getElementById('pfEditor');
    if (!alvo) return;
    var bio = atual.bio || '';
    var link = atual.link || '';
    alvo.innerHTML =
      '<div class="pf-ed">'
      + '<div class="pf-edlinha"><label for="pfBio">SOBRE VOCÊ</label>'
      + '<textarea id="pfBio" rows="3" maxlength="' + MAXBIO + '" placeholder="Conta em uma frase o que você faz.">' + esc(bio) + '</textarea>'
      + '<div class="pf-conta" id="pfConta"></div></div>'
      + '<div class="pf-edlinha"><label for="pfLink">SEU LINK</label>'
      + '<input id="pfLink" type="url" inputmode="url" maxlength="200" placeholder="seucanal.com" value="' + esc(link) + '"></div>'
      + '<div class="pf-edbot">'
      + '<button class="pf-b ghost" id="pfCancelar">Cancelar</button>'
      + '<button class="pf-b" id="pfSalvar">Salvar</button>'
      + '</div></div>';

    var ta = document.getElementById('pfBio');
    var conta = document.getElementById('pfConta');
    function contar() {
      var n = (ta.value || '').length;
      conta.textContent = n + '/' + MAXBIO;
      conta.className = 'pf-conta' + (n >= MAXBIO ? ' estourou' : n > MAXBIO - 25 ? ' perto' : '');
    }
    ta.addEventListener('input', contar);
    contar();
    ta.focus();

    document.getElementById('pfCancelar').addEventListener('click', function () { alvo.innerHTML = ''; });
    document.getElementById('pfSalvar').addEventListener('click', async function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = 'Salvando…';
      var r;
      try {
        r = await BT().call('perfil-salvar', {
          body: { bio: ta.value || '', link: (document.getElementById('pfLink').value || '') },
        });
      } catch (e) { r = { ok: false, d: {} }; }
      btn.disabled = false;
      btn.textContent = 'Salvar';
      if (!r.ok) return toast('❌ ' + ((r.d && (r.d.detalhe || r.d.error)) || 'Não deu pra salvar agora.'));
      toast('✅ Perfil atualizado!');
      alvo.innerHTML = '';
      carregar();
    });
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

    // Capa: imagem da pessoa quando existe; senão o gradiente do nome, que
    // evita o "banner cinza" de perfil vazio.
    var h = hue(u.name);
    var capa = $('pfCapa');
    if (capa) {
      if (d.capa) {
        capa.style.backgroundImage = 'url("' + String(d.capa).replace(/"/g, '%22') + '")';
        capa.style.backgroundColor = '#0a1830';
      } else {
        capa.style.backgroundImage = 'none';
        capa.style.background = u.mod || u.plan === 'master'
          ? 'linear-gradient(120deg,#3d2f07 0%,#6b4e0a 45%,#0a1830 100%)'
          : 'linear-gradient(120deg,hsl(' + h + ',55%,17%) 0%,hsl(' + ((h + 40) % 360) + ',60%,22%) 50%,#0a1830 100%)';
      }
    }
    // Os botões de editar só existem no PRÓPRIO perfil. Quem manda é d.eu, que
    // vem do servidor comparando o token — não é a tela que decide.
    var cb = $('pfCapaBtn');
    if (cb) cb.innerHTML = d.eu ? '<button class="pf-capabtn" id="pfTrocarCapa">📷 Trocar capa</button>' : '';
    var ae = $('pfAvEdit');
    if (ae) ae.innerHTML = d.eu ? '<button class="pf-avedit" id="pfTrocarFoto" title="Trocar foto" aria-label="Trocar foto">✏️</button>' : '';

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

    atual = d;
    var cab = document.querySelector('.pf-cab');
    var extra = document.createElement('div');

    // Link: rel="noopener noreferrer nofollow" porque o destino é escolhido por
    // outra pessoa. Sem noopener, a página de destino ganha referência à nossa
    // aba e pode trocá-la por uma tela de login falsa.
    var linkHtml = '';
    // Segundo portão. O servidor já só grava https, mas link é conteúdo de
    // outra pessoa indo pra dentro de um href — e href aceita javascript: e
    // data:, que executam. Um portão só é como o microfone ficou aberto na
    // barra final: bastou um caminho não previsto.
    if (d.link && /^https:\/\//i.test(String(d.link))) {
      var rotulo = String(d.link).replace(/^https?:\/\//i, '').replace(/\/$/, '');
      linkHtml = '<a class="pf-link" href="' + esc(d.link) + '" target="_blank" rel="noopener noreferrer nofollow">🔗 ' + esc(rotulo) + '</a>';
    }

    extra.innerHTML =
      '<div class="pf-nome">' + esc(u.name) + selos + '</div>'
      + '<div class="pf-arroba">@' + esc(u.name) + '</div>'
      + (d.bio ? '<div class="pf-bio">' + esc(d.bio) + '</div>' : '')
      + linkHtml
      + (desde ? '<div class="pf-desde">🗓 na Comunidade desde ' + esc(desde) + '</div>' : '')
      + '<div class="pf-nums"><span><b>' + esc(nPosts) + '</b>posts</span>'
      + '<span><b>' + esc(nAmigos) + '</b>' + (d.amigos === 1 ? 'amigo' : 'amigos') + '</span></div>'
      + (d.eu
        ? '<div><button class="pf-b ghost" id="pfEditar" style="margin-top:12px">'
          + (d.bio || d.link ? '✏️ Editar bio e link' : '✏️ Escrever uma bio') + '</button></div>'
        : '')
      + '<div id="pfEditor"></div>';
    cab.appendChild(extra);

    var be = $('pfEditar');
    if (be) be.addEventListener('click', abrirEditor);
    var bc = $('pfTrocarCapa');
    if (bc) bc.addEventListener('click', function () { $('pfFileCapa').click(); });
    var bf = $('pfTrocarFoto');
    if (bf) bf.addEventListener('click', function () { $('pfFileFoto').click(); });

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

  // Os dois inputs de arquivo são ligados UMA vez, aqui — e não dentro do
  // pintar(), que roda de novo a cada salvamento e empilharia handlers.
  var fc = document.getElementById('pfFileCapa');
  if (fc) fc.addEventListener('change', function () { var f = this.files && this.files[0]; this.value = ''; mandarImagem(f, 'capa'); });
  var ff = document.getElementById('pfFileFoto');
  if (ff) ff.addEventListener('change', function () { var f = this.files && this.files[0]; this.value = ''; mandarImagem(f, 'foto'); });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', carregar);
  } else { carregar(); }
})();
