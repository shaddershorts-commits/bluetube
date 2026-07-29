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
  // Dois convites BEM diferentes, e a ordem importa:
  //  1) sem conta  → modal de CADASTRO puro. Zero menção a pagar: a pessoa
  //     acabou de experimentar, cobrar agora espanta.
  //  2) free estourou os 5 → aí sim o modal de planos, ou voltar em 24h.
  function convidarCadastro() {
    if (typeof window.openAuthModal !== 'function') return;
    window.openAuthModal();
    try { if (typeof window.switchAuthTab === 'function') window.switchAuthTab('signup'); } catch (e) {}
    // troca o subtítulo do modal pra explicar o ganho, sem falar de plano
    var box = document.querySelector('#authModal .auth-modal-box');
    if (!box) return;
    var sub = box.children[2];   // <div>Crie sua conta ou entre</div>
    if (sub && !sub.dataset.blublu) {
      sub.dataset.blublu = '1';
      sub.innerHTML = 'Cria tua conta <strong style="color:#e8f4ff">de graça</strong> e o Blublu te dá <strong style="color:var(--neon,#00aaff)">5 ajustes de roteiro por dia</strong>.';
      sub.style.fontSize = '12.5px';
      sub.style.lineHeight = '1.55';
    }
  }

  function convidarPlano() {
    if (typeof window.openUpgradeModal !== 'function') return;
    window.openUpgradeModal('adjust_limit_free', 'full');
    var t = $('upgradeModalTitle'), s = $('upgradeModalSub');
    if (t) t.innerHTML = 'Seus <span>5 ajustes</span> de hoje acabaram';
    if (s) s.innerHTML = 'Nos planos pagos o Blublu fica sem limite nenhum.<br>Ou volta daqui 24 horas que teus 5 renovam.';
  }

  // ── posicionamento: AO LADO do roteiro, não por cima ──────────────────────
  // No print de 29/07 o painel cobria a tela e escurecia o fundo — o usuário
  // não via o roteiro mudando e tinha que fechar o chat pra conferir. Em tela
  // larga o painel vira coluna lateral e o escurecimento some. Em celular não
  // tem espaço pra isso: continua como folha embaixo, com o fundo escuro.
  var LARGO = 900;
  function ehTelaLarga() { return window.innerWidth >= LARGO; }

  function posicionar() {
    var p = $('adjustPanel'), f = $('adjustBackdrop');
    if (!p) return;
    if (ehTelaLarga()) {
      // ESQUERDA (pedido do user em 29/07): o roteiro fica à direita, livre.
      p.style.cssText =
        'display:flex;position:fixed;left:22px;top:50%;transform:translateY(-50%);' +
        'right:auto;bottom:auto;width:370px;max-width:calc(100vw - 44px);z-index:900;' +
        'background:rgba(2,8,23,0.97);border:1px solid rgba(0,170,255,.22);' +
        'border-radius:18px;backdrop-filter:blur(20px);' +
        'box-shadow:0 12px 48px rgba(0,20,60,.55);flex-direction:column;max-height:74vh';
      if (f) f.style.display = 'none';           // roteiro visível o tempo todo
    } else {
      p.style.cssText =
        'display:flex;position:fixed;bottom:0;left:50%;transform:translateX(-50%);' +
        'right:auto;top:auto;width:100%;max-width:520px;z-index:900;' +
        'background:rgba(2,8,23,0.97);border:1px solid rgba(0,170,255,.2);border-bottom:none;' +
        'border-radius:20px 20px 0 0;backdrop-filter:blur(20px);' +
        'box-shadow:0 -8px 40px rgba(0,50,160,.3);flex-direction:column;max-height:60vh';
      if (f) f.style.display = 'block';
    }
  }
  window.addEventListener('resize', function () {
    var p = $('adjustPanel');
    if (p && p.style.display === 'flex') posicionar();
  });

  // Pisca o roteiro quando ele muda, pra o olho achar a alteração sozinho.
  function piscarRoteiro(el) {
    if (!el) return;
    var cx = el.parentElement || el;
    var antes = cx.style.boxShadow;
    cx.style.transition = 'box-shadow .35s ease';
    cx.style.boxShadow = 'inset 0 0 0 2px rgba(0,190,255,.55)';
    setTimeout(function () { cx.style.boxShadow = antes || ''; }, 900);
  }

  // ── abrir / fechar ────────────────────────────────────────────────────────
  function abrir(versao) {
    versaoAtual = versao || 'V1';
    // Sem conta o chat ABRE: a pessoa tem 2 ajustes de teste. O convite só
    // aparece quando o servidor disser que acabaram.

    var alvo = $('adjustTarget');
    if (alvo) alvo.textContent = NOME_ABA[versaoBase(versaoAtual)] || 'Casual';
    marcarCabecalho();
    garantirBarraDesfazer();

    posicionar();

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

      // acabaram os 2 de teste → convite pra CRIAR CONTA (sem falar de plano)
      if (r.status === 401 || d.needs_account) {
        falaBlublu(d.mensagem || 'Cria tua conta pra continuar comigo.', 'normal');
        convidarCadastro();
        return;
      }
      // já tem conta e estourou os 5 → aí sim a conversa de plano
      if (r.status === 429 || d.limit_reached) {
        falaBlublu(d.mensagem || 'Você usou seus ajustes de hoje.', 'triste');
        if (d.limit_reached) convidarPlano();
        return;
      }
      // ele entendeu "volta pro original" como o botão Desfazer
      if (d.desfazer) {
        if (pilhaDesfazer.length) desfazer();
        else falaBlublu('Não tenho versão anterior guardada ainda — esse é o original.', 'normal');
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
        piscarRoteiro(el);   // o painel agora fica ao lado: dá pra ver mudando
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

  // ── o botão: dourado, com o Blublu flutuando do lado ──────────────────────
  // Feito daqui e não na index.html de propósito: assim o HTML não é tocado e
  // o bloco inline do pixel fica intacto.
  function estilizarBotoes() {
    var botoes = document.querySelectorAll('[onclick*="openAdjustChat"]');
    for (var i = 0; i < botoes.length; i++) {
      var b = botoes[i];
      if (b.dataset.blubluOuro === '1') continue;
      b.dataset.blubluOuro = '1';

      // o visual vem da classe (com !important): o botão já tem style inline no
      // HTML, e inline ganha de classe sem isso
      b.classList.add('blublu-btn-ouro');
      b.style.position = 'relative';
      b.style.overflow = 'visible';   // a foto dele fica pra FORA do botão
      b.style.paddingLeft = '34px';

      // tira o ✏️ do rótulo — quem anuncia agora é a cara dele
      b.innerHTML = b.innerHTML.replace(/✏️\s*/, '');

      var img = document.createElement('img');
      img.src = CARA.normal;
      img.alt = 'Blublu';
      img.className = 'blublu-flutua';
      img.style.cssText =
        'position:absolute;left:-20px;top:50%;width:44px;height:44px;object-fit:contain;' +
        'pointer-events:none;filter:drop-shadow(0 3px 8px rgba(0,120,200,.55))';
      b.appendChild(img);
    }
  }

  // flutuação do avatar (respeita quem pediu menos animação no sistema)
  (function () {
    if (document.getElementById('blubluFlutuaCss')) return;
    var st = document.createElement('style');
    st.id = 'blubluFlutuaCss';
    st.textContent = [
      '@keyframes blubluFlutua{0%,100%{transform:translateY(-50%)}50%{transform:translateY(-64%)}}',
      '.blublu-flutua{animation:blubluFlutua 3.2s ease-in-out infinite;transform:translateY(-50%)}',

      // OURO. O brilho é uma faixa de luz que atravessa o PRÓPRIO fundo —
      // nada de ::after com overflow:hidden, que cortaria a foto do Blublu
      // (ela fica pra fora da borda do botão de propósito).
      '.blublu-btn-ouro{',
      '  background-image:',
      '    linear-gradient(100deg,transparent 36%,rgba(255,255,255,.62) 48%,transparent 61%),',
      '    linear-gradient(160deg,#ffe9a3 0%,#f0cd68 16%,#d4a63a 46%,#b3841f 70%,#f2d489 100%) !important;',
      '  background-size:230% 100%,100% 100% !important;',
      '  background-position:210% 0,0 0;',
      '  background-repeat:no-repeat !important;',
      '  border:1px solid rgba(255,240,190,.9) !important;',
      // texto quase preto + realce claro por baixo: é o que fica legível sobre
      // ouro. O tom escuro anterior sumia no meio do gradiente.
      '  color:#1c1201 !important;',
      '  font-weight:800 !important;',
      '  letter-spacing:.35px !important;',
      '  text-shadow:0 1px 0 rgba(255,248,215,.75) !important;',
      '  box-shadow:0 0 0 1px rgba(120,80,10,.4),0 4px 10px rgba(0,0,0,.25),',
      '    0 8px 30px rgba(226,175,60,.55),inset 0 1px 0 rgba(255,255,255,.8),',
      '    inset 0 -3px 8px rgba(120,80,10,.4) !important;',
      '  animation:blubluBrilho 3.8s ease-in-out infinite;',
      '}',
      '@keyframes blubluBrilho{0%,64%{background-position:210% 0,0 0}100%{background-position:-70% 0,0 0}}',
      '@media (prefers-reduced-motion:reduce){',
      '  .blublu-flutua{animation:none}',
      '  .blublu-btn-ouro{animation:none;background-position:-70% 0,0 0}',
      '}',
    ].join('');
    document.head.appendChild(st);
  })();

  // os botões nascem escondidos e só aparecem quando o roteiro é gerado
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', estilizarBotoes);
  else estilizarBotoes();
  setInterval(estilizarBotoes, 1500);

  // ── assume o controle ─────────────────────────────────────────────────────
  // defer garante que isto roda DEPOIS do inline, então sobrescreve.
  window.openAdjustChat = abrir;
  window.closeAdjustChat = fechar;
  window.sendAdjust = enviar;
  window.__blubluRoteiro = { versao: function () { return versaoAtual; }, historico: function () { return historico; } };
})();
