/* public/comunidade-perfil.js — o nome do feed leva à página de perfil.
 * ---------------------------------------------------------------------------
 * A primeira versão disto abria um MODAL. Estava errado: o pedido era página, e
 * o plano aprovado já dizia "estilo Twitter". Modal mostra uma carteira de
 * identidade e some; página é um lugar — dá pra chegar por link, voltar pelo
 * botão do navegador, compartilhar com alguém.
 *
 * Então este arquivo encolheu pro que ele realmente é: o pedaço que torna nome
 * e foto clicáveis no feed e manda pra /perfil?u=<nome>. Quem desenha a página
 * é /perfil-pagina.js.
 *
 * ARQUIVO ISOLADO: ninguém o chama. Ele se pendura no clique por delegação. Se
 * falhar ao carregar, o feed continua idêntico — só não abre perfil.
 */
(function () {
  'use strict';
  if (window.ComunidadePerfil) return;

  var CSS = [
    // Sem isto ninguém descobre que o nome é clicável.
    '[data-cbp-name]{cursor:pointer}',
    '.cbt-pname[data-cbp-name]:hover,.cbt-cname[data-cbp-name]:hover{text-decoration:underline;text-underline-offset:3px}',
    '.cbt-avwrap[data-cbp-name]:hover{filter:brightness(1.12)}',
  ].join('');

  // ⚠️ O estilo entra no ARRANQUE, não em algum caminho tardio. Foi assim que a
  // pílula "+ Amigo" saiu crua na tela: o CSS dela morava dentro da função que
  // montava o painel, e o painel só era montado quando alguém o abria.
  function garantirEstilo() {
    if (document.getElementById('cbpStyle')) return;
    var st = document.createElement('style');
    st.id = 'cbpStyle';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function url(nome) { return '/perfil?u=' + encodeURIComponent(nome); }

  function abrir(nome) {
    if (!nome) return;
    location.href = url(nome);
  }

  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-cbp-name]') : null;
    if (!el) return;
    // O botão de amizade mora DENTRO do cabeçalho do post. Clique nele é dele,
    // não do perfil — senão pedir amizade viraria uma navegação sem querer.
    if (e.target.closest && e.target.closest('[data-cba-act]')) return;
    // Ctrl/Cmd/meio: deixa o navegador fazer o dele (abrir noutra aba).
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    var nome = el.getAttribute('data-cbp-name');
    if (!nome) return;
    e.preventDefault();
    e.stopPropagation();
    abrir(nome);
  });

  garantirEstilo();

  window.ComunidadePerfil = { abrir: abrir, url: url };
})();
