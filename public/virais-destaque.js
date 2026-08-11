/* public/virais-destaque.js — holofote do vídeo que veio da notificação
 * ==========================================================================
 * A notificação do sininho leva pra /virais?v=<youtube_id>. Aqui o vídeo
 * avisado aparece em destaque no meio, com o resto da página desfocado.
 *
 * POR QUE CLONAR O CARD EM VEZ DE DESENHAR UM NOVO: o card da Virais é
 * montado inline dentro do grid, com os botões de roteiro, BaixaBlue, salvar
 * etc. Escrever uma segunda versão dele aqui significaria que todo ajuste
 * futuro num dos dois lados deixaria o outro desatualizado — e o usuário
 * pediu justamente "o card normal, com os botões que já tem".
 *
 * Arquivo separado: virais.html já tem <script src>, e um <script> inline
 * novo no meio dele seria engolido em silêncio.
 */
(function () {
  'use strict';

  var ALVO = new URLSearchParams(location.search).get('v');
  if (!ALVO || !/^[A-Za-z0-9_-]{6,15}$/.test(ALVO)) return;

  // 3s, não 15. O grid chega em ~1s; esperar 15 deixava a pessoa olhando pra
  // uma página normal, achando que o clique não fez nada — foi exatamente o
  // que aconteceu no primeiro teste.
  var MAX_ESPERA = 3000;
  var montado = false;

  function estilo() {
    if (document.getElementById('vdStyle')) return;
    var s = document.createElement('style');
    s.id = 'vdStyle';
    s.textContent = [
      '#vdOverlay{position:fixed;inset:0;z-index:900;display:flex;align-items:center;justify-content:center;',
      'padding:24px;background:rgba(2,8,23,.82);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}',
      '#vdCaixa{position:relative;max-width:340px;width:100%;animation:vdEntra .32s cubic-bezier(.2,.9,.3,1)}',
      '@keyframes vdEntra{from{opacity:0;transform:translateY(14px) scale(.96)}to{opacity:1;transform:none}}',
      '#vdSelo{text-align:center;font-family:var(--mono,monospace);font-size:11px;letter-spacing:.1em;',
      'text-transform:uppercase;color:#fbbf24;margin-bottom:12px}',
      '#vdFechar{position:absolute;top:-14px;right:-14px;z-index:2;width:32px;height:32px;border-radius:50%;',
      'border:1px solid rgba(0,170,255,.3);background:#0a1628;color:#e8f4ff;font-size:16px;cursor:pointer;line-height:1}',
      '#vdCaixa .short-card{transform:none!important;box-shadow:0 0 0 2px rgba(251,191,36,.5),0 24px 60px rgba(0,0,0,.7)!important}',
      '#vdDica{text-align:center;font-family:var(--mono,monospace);font-size:11px;color:rgba(150,190,230,.55);margin-top:14px}',
      '#vdErro{max-width:360px;background:#0a1628;border:1px solid rgba(0,170,255,.25);border-radius:16px;padding:26px;text-align:center;color:#e8f4ff}',
      '@media(prefers-reduced-motion:reduce){#vdCaixa{animation:none}}',
    ].join('');
    document.head.appendChild(s);
  }

  function abrir(conteudo, ehErro) {
    if (montado) return;
    montado = true;
    estilo();
    var ov = document.createElement('div');
    ov.id = 'vdOverlay';
    if (ehErro) {
      ov.innerHTML = '<div id="vdErro">' + conteudo + '</div>';
    } else {
      var cx = document.createElement('div');
      cx.id = 'vdCaixa';
      cx.innerHTML = '<button id="vdFechar" title="Fechar">✕</button>' +
        '<div id="vdSelo">👑 o vídeo que te avisamos</div>';
      cx.appendChild(conteudo);
      cx.insertAdjacentHTML('beforeend', '<div id="vdDica">Clique fora pra voltar pra Virais</div>');
      ov.appendChild(cx);
    }
    document.body.appendChild(ov);

    // Fecha por clique fora, pelo ✕ e por Esc — e limpa o ?v= da URL pra um
    // F5 não reabrir o holofote de um vídeo que a pessoa já dispensou.
    var fechar = function () {
      ov.remove();
      try {
        var u = new URL(location.href);
        u.searchParams.delete('v');
        history.replaceState({}, '', u.pathname + (u.search || '') + u.hash);
      } catch (e) {}
    };
    ov.addEventListener('click', function (e) { if (e.target === ov) fechar(); });
    var x = ov.querySelector('#vdFechar');
    if (x) x.addEventListener('click', fechar);
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { fechar(); document.removeEventListener('keydown', esc); }
    });
  }

  // Procura o card no grid. Ele já existe na página com todos os botões —
  // clonar é o que garante que o destaque nunca fique diferente do normal.
  function procurar() {
    var card = document.querySelector('a.short-card[data-vid="' + ALVO + '"]');
    if (!card) return false;
    abrir(card.cloneNode(true), false);
    return true;
  }

  function iniciar() {
    if (procurar()) return;
    // O grid chega por fetch. Observa até aparecer, com prazo — se o vídeo
    // saiu do acervo ou está fora do filtro atual, avisa em vez de girar.
    var obs = new MutationObserver(function () { if (procurar()) obs.disconnect(); });
    var grid = document.getElementById('grid') || document.body;
    obs.observe(grid, { childList: true, subtree: true });
    setTimeout(function () {
      obs.disconnect();
      if (montado) return;
      buscarNoAcervo();
    }, MAX_ESPERA);
  }

  // Não está no grid (filtro diferente, fora da janela de tempo, outra página
  // da lista). Em vez de desistir — que era o comportamento antigo e deixava a
  // notificação sem serventia — busca o vídeo no acervo e monta o destaque.
  function buscarNoAcervo() {
    fetch('/api/virais?action=historico&youtube_id=' + encodeURIComponent(ALVO))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var v = (d && (d.videos || d.data || d.results) || []).filter(function (x) {
          return x.youtube_id === ALVO;
        })[0];
        if (!v) return semSorte();
        montarCard(v);
      })
      .catch(semSorte);
  }

  function montarCard(v) {
    var url = v.url || ('https://youtube.com/shorts/' + v.youtube_id);
    var views = Number(v.views) || 0;
    var vf = views >= 1e6 ? (views / 1e6).toFixed(1).replace('.', ',') + 'M'
      : views >= 1e3 ? Math.round(views / 1e3) + 'K' : String(views);
    var el = document.createElement('div');
    el.className = 'short-card';
    el.style.cssText = 'display:block;background:#0a1628;border:1px solid rgba(0,170,255,.2);border-radius:16px;overflow:hidden';
    el.innerHTML =
      '<a href="' + url + '" target="_blank" rel="noopener" style="display:block;text-decoration:none;color:inherit">' +
      (v.thumbnail_url ? '<img src="' + v.thumbnail_url + '" alt="" style="width:100%;display:block;aspect-ratio:9/16;object-fit:cover">' : '') +
      '<div style="padding:13px">' +
      '<div style="font-size:13.5px;font-weight:600;color:#e8f4ff;line-height:1.4;margin-bottom:6px">' +
      String(v.titulo || '').replace(/</g, '&lt;').slice(0, 90) + '</div>' +
      '<div style="font-family:var(--mono,monospace);font-size:11px;color:rgba(150,190,230,.6)">' +
      '👁 ' + vf + ' · ' + String(v.canal_nome || '').replace(/</g, '&lt;').slice(0, 30) + '</div>' +
      '</div></a>' +
      '<div style="display:flex;gap:8px;padding:0 13px 13px">' +
      '<a href="' + url + '" target="_blank" rel="noopener" style="flex:1;text-align:center;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;text-decoration:none;padding:10px;border-radius:9px;font-size:12.5px;font-weight:700">▶ Assistir</a>' +
      '</div>';
    abrir(el, false);
  }

  function semSorte() {
    if (montado) return;
    abrir(
      '<div style="font-size:34px;margin-bottom:10px">🔍</div>' +
      '<div style="font-size:16px;font-weight:700;margin-bottom:8px">Não achei esse vídeo no acervo</div>' +
      '<div style="font-size:13px;color:rgba(150,190,230,.7);line-height:1.6;margin-bottom:18px">' +
      'Ele pode ter sido removido do YouTube ou saído da nossa base.</div>' +
      '<a href="https://youtube.com/shorts/' + ALVO + '" target="_blank" rel="noopener" ' +
      'style="display:inline-block;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;text-decoration:none;' +
      'padding:12px 26px;border-radius:10px;font-weight:700;font-size:14px">Ver no YouTube →</a>', true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
