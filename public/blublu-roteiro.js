/* blublu-roteiro.js — Blublu no chat de ajuste de roteiro (home)
 *
 * POR QUE ESTE ARQUIVO EXISTE SEPARADO:
 * a index.html tem um <script> inline gigante que contém as chamadas de
 * fbq()/ttq() (Meta e TikTok Pixel), inclusive o CompleteRegistration do
 * cadastro. Um erro de sintaxe nesse bloco mata toda função depois dele e o
 * tráfego pago para de ser atribuído SEM AVISO. Então nada de chat entra lá.
 *
 * Este arquivo carrega com defer — ou seja, DEPOIS do inline — e sobrescreve
 * window.openAdjustChat e window.sendAdjust. A index.html ganha 1 linha só.
 *
 * Se este arquivo falhar em carregar, o chat antigo continua funcionando
 * (com os bugs antigos, mas funcionando) e o pixel nem fica sabendo.
 */
(function () {
  'use strict';

  var API = '/api/roteiro-chat';
  var MAX_DESFAZER = 3;

  var versaoAtual = 'V1';
  var historico = [];          // [{quem:'user'|'blublu', texto, tom}]
  var pilhaDesfazer = [];      // [{versao, texto}]
  var enviando = false;

  // ── utilidades ────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(id) { return document.getElementById(id); }
  function token() { try { return localStorage.getItem('bt_token'); } catch (e) { return null; } }

  // 'V1'|'V2'|'V3' → elemento do roteiro. 'ZV1'/'ZV2' = fluxo Gerar do Zero.
  function elDoRoteiro(v) {
    var zero = v.charAt(0) === 'Z';
    var base = zero ? v.slice(1) : v;
    return $((zero ? 'zScript' : 'script') + base);
  }
  function versaoBase(v) { return v.charAt(0) === 'Z' ? v.slice(1) : v; }

  var NOME_ABA = { V1: 'Casual', V2: 'Apelativo', V3: 'Tradução' };

  // ── desenho das mensagens ─────────────────────────────────────────────────
  // O layout do painel NÃO muda (pedido do user). O que muda é que as falas
  // do Blublu passam a vir com a carinha dele, como na Virais.
  var CARA = {
    normal: '/blublu-pointing.png',
    feliz: '/blublu-thumbsup.png',
    triste: '/blublu-sad.png',
  };

  function desenhar() {
    var box = $('adjustMessages');
    if (!box) return;
    if (!historico.length) {
      box.innerHTML =
        '<div style="display:flex;align-items:center;gap:10px;padding:14px 4px">' +
        '<img src="' + CARA.normal + '" alt="Blublu" style="width:34px;height:34px;object-fit:contain;flex-shrink:0;filter:drop-shadow(0 0 8px rgba(0,190,255,.45))">' +
        '<div style="font-family:\'DM Mono\',monospace;font-size:11px;line-height:1.5;color:rgba(150,190,230,.55)">' +
        'Fala o que tu quer mudar. Tipo: <em>encurta o final</em>, <em>troca ponte por passarela</em>, <em>deixa mais tenso</em>.' +
        '</div></div>';
      return;
    }
    box.innerHTML = historico.map(function (m) {
      if (m.quem === 'user') {
        return '<div style="align-self:flex-end;max-width:80%;background:rgba(0,100,255,.2);border:1px solid rgba(0,170,255,.3);border-radius:14px 14px 4px 14px;padding:8px 14px;font-family:\'DM Mono\',monospace;font-size:12px;color:#e8f4ff">' + esc(m.texto) + '</div>';
      }
      var img = CARA[m.tom] || CARA.normal;
      return '<div style="align-self:flex-start;max-width:88%;display:flex;gap:8px;align-items:flex-start">' +
        '<img src="' + img + '" alt="Blublu" style="width:28px;height:28px;object-fit:contain;flex-shrink:0;margin-top:2px;filter:drop-shadow(0 0 6px rgba(0,190,255,.4))">' +
        '<div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:14px 14px 14px 4px;padding:8px 14px;font-family:\'DM Mono\',monospace;font-size:12px;line-height:1.5;color:rgba(200,225,255,.75)">' + esc(m.texto) + '</div>' +
        '</div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  function falaBlublu(texto, tom) { historico.push({ quem: 'blublu', texto: texto, tom: tom || 'normal' }); desenhar(); }
  function falaUser(texto) { historico.push({ quem: 'user', texto: texto }); desenhar(); }

  function salvarHistorico() {
    try { localStorage.setItem('bt_adjust_' + versaoAtual, JSON.stringify(historico.slice(-6))); } catch (e) {}
  }

  // ── botão desfazer ────────────────────────────────────────────────────────
  // Não existia. Combinado com a falta de validação, um ajuste ruim era perda
  // definitiva do roteiro.
  function pintarDesfazer() {
    var barra = $('blubluDesfazerBarra');
    if (!barra) return;
    barra.style.display = pilhaDesfazer.length ? 'flex' : 'none';
  }

  function desfazer() {
    var ant = pilhaDesfazer.pop();
    if (!ant) return;
    var el = elDoRoteiro(ant.versao);
    if (el) {
      el.textContent = ant.texto;
      if (typeof window._saveRoteiroState === 'function') window._saveRoteiroState();
    }
    falaBlublu('Voltei pra versão anterior.', 'normal');
    pintarDesfazer();
    salvarHistorico();
  }
  window.blubluDesfazer = desfazer;

  // Barra de desfazer injetada uma vez, logo acima do campo de digitar.
  function garantirBarraDesfazer() {
    if ($('blubluDesfazerBarra')) return;
    var input = $('adjustInput');
    if (!input || !input.parentElement || !input.parentElement.parentElement) return;
    var barra = document.createElement('div');
    barra.id = 'blubluDesfazerBarra';
    barra.style.cssText = 'display:none;align-items:center;justify-content:flex-end;padding:0 20px 6px';
    barra.innerHTML = '<button onclick="blubluDesfazer()" style="background:none;border:1px solid rgba(0,170,255,.25);border-radius:8px;padding:5px 12px;font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(0,170,255,.8);cursor:pointer">↩ Desfazer</button>';
    input.parentElement.parentElement.insertBefore(barra, input.parentElement);
  }

  // ── cabeçalho: quem tá falando é o Blublu ─────────────────────────────────
  function marcarCabecalho() {
    var alvo = $('adjustTarget');
    if (!alvo || alvo.dataset.blublu === '1') return;
    var titulo = alvo.previousElementSibling;   // <span>Pedir ajuste</span>
    if (titulo) {
      titulo.textContent = 'Blublu';
      titulo.id = 'blubluNomeCab';
      // o ✏️ que vinha antes vira redundante ao lado da foto dele
      var lapis = titulo.previousElementSibling;
      if (lapis && !lapis.id) lapis.style.display = 'none';
    }
    var cab = alvo.parentElement;
    if (cab && !$('blubluAvatarCab')) {
      var img = document.createElement('img');
      img.id = 'blubluAvatarCab';
      img.src = CARA.normal;
      img.alt = 'Blublu';
      img.style.cssText = 'width:26px;height:26px;object-fit:contain;margin-right:2px;filter:drop-shadow(0 0 6px rgba(0,190,255,.5))';
      cab.insertBefore(img, cab.firstChild);
    }
    alvo.dataset.blublu = '1';
  }

  // ── convite (cadastro / upgrade) ──────────────────────────────────────────
  // Reaproveita o modal que já existe. Ele cai no ramo genérico e, quando não
  // há token, já mostra sozinho os botões de criar conta. A gente só troca o
  // texto DEPOIS da chamada — assim não precisa editar o <script> inline da
  // index.html, que é onde mora o pixel.
  var CONVITE = {
    sem_conta: {
      titulo: 'Fala com o <span>Blublu</span>',
      sub: 'Cria tua conta e o Blublu ajusta teu roteiro.<br><strong>5 ajustes por dia no grátis</strong> — no Full e no Master, sem limite.',
    },
    acabou: {
      titulo: 'Seus <span>5 ajustes</span> de hoje acabaram',
      sub: 'No Full e no Master o Blublu fica à disposição sem limite nenhum.<br>Volta amanhã ou desbloqueia agora.',
    },
  };

  function convidar(tipo) {
    var c = CONVITE[tipo];
    if (typeof window.openUpgradeModal !== 'function') {
      if (typeof window.openAuthModal === 'function') window.openAuthModal();
      return;
    }
    window.openUpgradeModal(tipo === 'sem_conta' ? 'adjust_no_account' : 'adjust_limit_free', 'full');
    // sobrescreve o texto genérico com o nosso, já com o modal na tela
    var t = $('upgradeModalTitle'), s = $('upgradeModalSub');
    if (t && c) t.innerHTML = c.titulo;
    if (s && c) s.innerHTML = c.sub;
  }

  // ── abrir / fechar ────────────────────────────────────────────────────────
  function abrir(versao) {
    versaoAtual = versao || 'V1';

    // PORTÃO DE CADASTRO: sem conta não abre o chat — abre o convite.
    if (!token()) { convidar('sem_conta'); return; }

    var alvo = $('adjustTarget');
    if (alvo) alvo.textContent = NOME_ABA[versaoBase(versaoAtual)] || 'Casual';
    marcarCabecalho();
    garantirBarraDesfazer();

    var fundo = $('adjustBackdrop'), painel = $('adjustPanel');
    if (fundo) fundo.style.display = 'block';
    if (painel) painel.style.display = 'flex';

    try { historico = JSON.parse(localStorage.getItem('bt_adjust_' + versaoAtual) || '[]').slice(-6); } catch (e) { historico = []; }
    desenhar();
    pintarDesfazer();
    setTimeout(function () { var i = $('adjustInput'); if (i) i.focus(); }, 100);
  }

  function fechar() {
    var f = $('adjustBackdrop'), p = $('adjustPanel');
    if (f) f.style.display = 'none';
    if (p) p.style.display = 'none';
  }

  // ── enviar ────────────────────────────────────────────────────────────────
  function botaoOcupado(ocupado) {
    var b = $('adjustSendBtn');
    if (!b) return;
    b.disabled = ocupado;
    b.innerHTML = ocupado
      ? '<div style="width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite"></div>'
      : '↑';
  }

  async function enviar() {
    if (enviando) return;
    var input = $('adjustInput');
    if (!input) return;
    var pedido = (input.value || '').trim();
    if (!pedido) return;

    var el = elDoRoteiro(versaoAtual);
    var atual = el && el.textContent ? el.textContent.trim() : '';
    if (!atual) {
      falaUser(pedido);
      falaBlublu('Não achei o roteiro na tela. Recarrega a página e me chama de novo.', 'triste');
      input.value = '';
      return;
    }

    falaUser(pedido);
    input.value = '';
    input.style.height = 'auto';
    enviando = true;
    botaoOcupado(true);

    var lang = ($('langSelect') && $('langSelect').value) || 'Português (Brasil)';

    try {
      var r = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token(),
          transcript: atual,
          instruction: pedido,
          version: versaoBase(versaoAtual),
          lang: lang,
          // memória: sem isso "mais ainda" / "volta como estava" não têm a que
          // se referir, e a IA acabava colando as palavras dentro do roteiro
          historico: historico.slice(-6).map(function (m) {
            return { quem: m.quem, texto: String(m.texto || '').slice(0, 300) };
          }),
        }),
      });
      var d = await r.json().catch(function () { return {}; });

      // sem conta (token expirou no meio) → convite
      if (r.status === 401 || d.needs_account) {
        falaBlublu(d.mensagem || 'Cria tua conta pra falar comigo.', 'normal');
        convidar('sem_conta');
        return;
      }
      // acabou a cota do dia → convite pro upgrade
      if (r.status === 429 || d.limit_reached) {
        falaBlublu(d.mensagem || 'Você usou seus ajustes de hoje.', 'triste');
        convidar('acabou');
        return;
      }
      // erro de entrada
      if (!r.ok && d.mensagem) { falaBlublu(d.mensagem, 'triste'); return; }
      if (!r.ok) { falaBlublu('Deu problema aqui. Teu roteiro não foi alterado.', 'triste'); return; }

      // aplicou de verdade
      if (d.aplicado && d.texto) {
        pilhaDesfazer.push({ versao: versaoAtual, texto: atual });
        if (pilhaDesfazer.length > MAX_DESFAZER) pilhaDesfazer.shift();
        el.textContent = d.texto;
        if (typeof window._saveRoteiroState === 'function') window._saveRoteiroState();
        var sobra = (d.restantes != null && d.restantes >= 0)
          ? ' (te sobram ' + d.restantes + ' hoje)' : '';
        falaBlublu((d.mensagem || 'Pronto.') + sobra, 'feliz');
        pintarDesfazer();
        return;
      }

      // não aplicou — e agora ele FALA o porquê em vez de mentir "atualizado"
      falaBlublu(d.mensagem || 'Não mexi no teu roteiro.', 'triste');
    } catch (e) {
      falaBlublu('Não consegui te responder agora. Teu roteiro tá intacto — tenta de novo.', 'triste');
    } finally {
      enviando = false;
      botaoOcupado(false);
      salvarHistorico();
      // NÃO fecha sozinho: antes fechava em 1,5s e o usuário nem lia a resposta.
    }
  }

  // ── assume o controle ─────────────────────────────────────────────────────
  // defer garante que isto roda DEPOIS do inline, então sobrescreve.
  window.openAdjustChat = abrir;
  window.closeAdjustChat = fechar;
  window.sendAdjust = enviar;
  window.__blubluRoteiro = { versao: function () { return versaoAtual; }, historico: function () { return historico; } };
})();
