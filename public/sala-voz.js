/* sala-voz.js — Sala de voz ao vivo da Comunidade BlueTube (2026-08-11, LiveKit)
 *
 * Uma sala só, sempre aberta, logo abaixo de Dicas. SÓ ÁUDIO. Teto de 10.
 *
 * ── POR QUE O TRANSPORTE MUDOU ────────────────────────────────────────────
 * A versão anterior era P2P mesh com sinalização por Supabase Realtime. Cinco
 * rodadas de conserto e ela nunca funcionou no navegador do dono. A causa raiz
 * foi MEDIDA em bancada (11/08):
 *   · o send() do SDK do Supabase MENTE — com o WebSocket morto ele escapa por
 *     HTTP e devolve 'ok' (9 de 9 sondas), então "mandei" não provava nada;
 *   · a lista de participantes piscava, e o código DESTRUÍA a conexão de voz de
 *     quem sumia da lista: 4 RTCPeerConnection numa sala de 2 pessoas (bancada
 *     antiga ANA=5/BRU=3; consertado 1/1);
 *   · e mesmo com o conserto, no navegador do dono continuou sem áudio.
 * Reconexão, renegociação, TURN e compatibilidade de navegador é exatamente a
 * parte que nos derrubou — e é exatamente o que um SFU gerenciado faz. Agora
 * quem carrega o áudio é o LiveKit; o que era NOSSO continua nosso.
 *
 * ── O QUE SAIU DAQUI ──────────────────────────────────────────────────────
 * RTCPeerConnection, offer/answer, ICE, gerações de negociação, 'opa', batimento
 * por broadcast, censo, tickets HMAC, teto de tentativas, semRota, medidor de
 * fala com AudioContext e o cliente do supabase-js. TUDO isso era transporte.
 *
 * ── O QUE CONTINUA SENDO NOSSO ────────────────────────────────────────────
 *   · o portão Full/Master e o teto de 10 — no BACKEND (api/sala-voz.js): quem
 *     não é assinante não recebe crachá e não entra, mesmo sabendo o endereço;
 *   · o botão com as medidas REAIS do .cbt-snav ("🏛️ Comunidade");
 *   · o painel com cards, borda de quem fala e o cabeçalho "X pessoas · Y falando";
 *   · o modal com "entrar com microfone ligado" e "entrar mudo";
 *   · microfone pedido SÓ DEPOIS do clique, nunca antes — e solto ao sair;
 *   · o contador visível ANTES de entrar, sem pedir microfone (agora ele vem do
 *     nosso /api/sala-voz?action=contar, que pergunta ao SFU pelo servidor);
 *   · sons de entrar e sair (window.BTSom), confirmação de saída dentro do
 *     painel, aviso ao navegar pra outra parte do site, tudo escapado.
 *
 * ── DECISÕES QUE VALEM EXPLICAÇÃO ─────────────────────────────────────────
 *
 * 1) Arquivo próprio, igual ao blublu-suporte.js: não chama nenhuma função do
 *    comunidade.js. Bug aqui não derruba o feed. E script novo no meio de um
 *    HTML grande costuma ser engolido — por isso arquivo + <script src ?v=>.
 *
 * 2) Fica FORA do #cbtFeed. O render() do comunidade.js faz `f.innerHTML = h`
 *    a cada troca de aba: qualquer coisa dentro do feed evapora. A entrada é
 *    irmã das abas (mobile) e do item Dicas (desktop) — duas cópias, porque a
 *    barra de abas some no desktop (≥900px) e a lateral some no mobile.
 *
 * 3) Quem está na sala vem dos EVENTOS DO LIVEKIT, não de uma lista que a gente
 *    monta. Isso apaga de uma vez a classe de defeito que nos derrubou: não
 *    existe mais "a lista discorda da conexão", porque a lista é a conexão.
 *
 * 4) O contador ANTES de entrar não abre socket nenhum: é uma pergunta HTTP ao
 *    nosso backend, que conta pelo RoomService. Ninguém precisa entrar na sala
 *    (nem liberar microfone) pra saber quem está lá.
 *
 * 5) "Quem está falando" é o indicador do PRÓPRIO LiveKit
 *    (ActiveSpeakersChanged), não um medidor nosso. O medidor com AudioContext
 *    foi fonte de dois bugs: limiar fixo 3,5x acima da voz real do dono (a
 *    borda nunca acendia) e contexto fechado lendo 0,00000 pra sempre. O SFU já
 *    calcula isso do lado dele, com o áudio que ele mesmo está encaminhando.
 *
 * 6) O SDK é carregado por CDN, igual o supabase-js já era — e SÓ quando a
 *    pessoa clica em entrar. Quem só passa pela Comunidade não baixa 1,2MB de
 *    WebRTC. Duas CDNs em ordem: se a primeira estiver fora, tenta a segunda;
 *    se as duas falharem, a entrada diz "sala indisponível agora" em vez de
 *    fingir que está tudo bem.
 *
 * 7) `disconnectOnPageLeave: false` no Room é OBRIGATÓRIO. O padrão do SDK é
 *    desconectar no 'pagehide' — que no iPhone dispara quando a tela APAGA.
 *    Com o padrão, guardar o celular no bolso derrubaria a pessoa da conversa
 *    (era o defeito 11 da versão anterior, e ele voltaria de graça).
 */
(function () {
  'use strict';
  if (window.SalaVoz) return;

  // ── constantes ────────────────────────────────────────────────────────────
  var API = '/api/sala-voz';
  // Versão FIXA de propósito: SDK de mídia que muda sozinho é sala que quebra
  // sozinha. Ordem: jsdelivr primeiro porque o arquivo é UM só e autocontido
  // (1,2MB, medido) — o esm.sh serve um stub que puxa mais pedaços, então ele
  // fica de reserva. Trocar de versão aqui é decisão, não atualização.
  var SDKS = [
    'https://cdn.jsdelivr.net/npm/livekit-client@2.21.0/dist/livekit-client.esm.mjs',
    'https://esm.sh/livekit-client@2.21.0?bundle',
  ];
  // Teto de gente. É fallback: o valor que vale vem do servidor (config.max),
  // pra não existir dois números discordando. Pra mudar o teto: api/sala-voz.js.
  var MAX = 10;
  // De quanto em quanto tempo a gente pergunta quem está na sala ESTANDO FORA
  // dela. 20s é folgado de propósito: cada volta é uma invocação na Vercel, e o
  // custo de polling já nos morderam antes (BLUE_REALTIME_ENABLED). Dentro da
  // sala isso vira ZERO: lá os eventos do LiveKit chegam pelo socket dele.
  var POLL_MS = 20000;
  // Contagem velha não é contagem: passado disso a entrada volta a dizer
  // "toque pra ver quem está" em vez de anunciar uma sala de minutos atrás.
  var VALIDADE_CONTAGEM = POLL_MS * 3;
  // Blindagem contra bipe em rajada logo depois de entrar. O LiveKit entrega
  // quem JÁ ESTAVA na sala pelo estado inicial (room.remoteParticipants), não
  // por ParticipantConnected — então a rajada não deveria existir. É seguro
  // barato: se algum navegador emitir os eventos de chegada dos antigos, a sala
  // não vira metralhadora.
  var SILENCIO_ENTRADA = 2000;
  // Os dois textos da MESMA caixa de confirmação (ver montarDock).
  var PERGUNTA_SAIR = {
    tit: 'Sair da sala de voz?',
    sub: 'seu microfone fecha e a conversa segue sem você',
    ok: 'Sair',
  };
  var PERGUNTA_NAVEGAR = {
    tit: 'Sair desta página?',
    sub: 'continuar vai encerrar a conversa: seu microfone fecha e a sala segue sem você',
    ok: 'Continuar',
  };

  // ── estado ────────────────────────────────────────────────────────────────
  var S = {
    cfg: null,             // /config: max, me, sala (SEM crachá: ele é do entrar)
    LK: null,              // módulo do livekit-client (carregado no primeiro clique)
    sala: null,            // Room do LiveKit — é ele o transporte agora
    conn: 'off',           // off | ligando | on | instavel | erro
    entrei: false, mudo: false, entrando: false, suspenso: false,
    semMic: false,         // entrou só pra ouvir porque o microfone não abriu
    saindoDeVerdade: false,// beforeunload avisou que é navegação/fechamento real
    // Quem está na sala. Chave = identity do LiveKit (o user_id, carimbado no
    // crachá pelo servidor). Nome/foto/plano vêm do crachá ASSINADO, então não
    // existe mais o problema de identidade forjável que o ticket HMAC resolvia.
    pessoas: new Map(),    // identity -> { eu, nome, avatar, plano, mudo, entrou }
    falando: new Set(),    // identity — vem do ActiveSpeakersChanged
    qualidade: new Map(),  // identity -> 'excellent'|'good'|'poor'|'lost'
    // Contagem de FORA da sala (a que aparece na entrada e no modal).
    foraN: 0, foraNomes: [], foraOk: false, contadoEm: 0, contando: false,
    indisponivel: false,   // LiveKit fora do ar / sem credencial no servidor
    tPoll: null, tIdle: null, promessaConfig: null, promessaSDK: null,
    silenciarAte: 0,
  };

  // ── utilidades ────────────────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  // Tudo que veio de outra pessoa passa por aqui antes de virar HTML.
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var inicial = function (n) { return (String(n || '?').trim().charAt(0) || '?').toUpperCase(); };
  var hue = function (n) { var h = 0, s = String(n || ''); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };

  function aviso(msg) {
    var el = $('svzToast');
    if (!el) {
      el = document.createElement('div'); el.id = 'svzToast'; el.className = 'svz-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('on'); }, 4200);
  }

  // Som é enfeite: som-notificacao.js é um <script defer> separado e pode não
  // ter carregado (ou a pessoa desligou o som no localStorage). A sala nunca
  // pode quebrar por causa de um bipe.
  function som(nome) {
    try {
      if (window.BTSom && typeof window.BTSom[nome] === 'function') return !!window.BTSom[nome]();
    } catch (e) {}
    return false;
  }

  async function api(action, body) {
    var t = '';
    try { t = localStorage.getItem('bt_token') || ''; } catch (e) {}
    var r = await fetch(API + '?action=' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action, token: t }, body || {})),
    });
    var d = await r.json().catch(function () { return {}; });
    return { ok: r.ok, status: r.status, d: d };
  }

  // ── CSS ───────────────────────────────────────────────────────────────────
  // A entrada é IRMÃ dos itens de navegação da Comunidade — não é um cartão.
  // Ela nasceu como vidro grande, com brilho, ícone de 40px e duas linhas de
  // texto, e disputava o olho com o "Como usar?", que é O destaque da página.
  // Agora ela copia, medida por medida, o .cbt-snav do "🏛️ Comunidade" que
  // aparece logo abaixo dela (comunidade.js, dentro do @media min-width:900px):
  //   padding:13px 15px · border-radius:14px · gap:12px · border 1px transparente
  //   Syne 700 14.5px · cor #c7d5ea · sem fundo · transition .18s
  //   hover: background rgba(0,170,255,.07) + translateX(2px)
  // Mexeu no .cbt-snav de lá, mexe aqui: pro olho os dois são o mesmo botão.
  var CSS = ''
    + '.svz-entrada{display:flex;align-items:center;gap:12px;margin:0;padding:13px 15px;border-radius:14px;cursor:pointer;'
    + 'background:none;border:1px solid transparent;color:#c7d5ea;text-align:left;'
    + 'font-family:var(--font-display,Syne,sans-serif);font-weight:700;font-size:14.5px;transition:all .18s}'
    + '.svz-entrada:hover{background:rgba(0,170,255,.07);transform:translateX(2px)}'
    // Sala com gente: só a COR muda, como no .cbt-snav.on. O peso do item segue
    // igual — quem chama atenção é o pontinho verde e o contador, não a caixa.
    + '.svz-entrada.tem-gente{color:#00d0ff}'
    + '.svz-ico{position:relative;flex:0 0 auto;font-size:15px;line-height:1}'
    + '.svz-ponto{position:absolute;right:-4px;bottom:0;width:8px;height:8px;border-radius:50%;background:#00e0a4;opacity:0;transition:opacity .2s}'
    + '.svz-entrada.tem-gente .svz-ponto{opacity:1;animation:svzPulso 1.8s ease-in-out infinite}'
    + '@keyframes svzPulso{0%,100%{box-shadow:0 0 0 0 rgba(0,224,164,.55)}70%{box-shadow:0 0 0 6px rgba(0,224,164,0)}}'
    + '.svz-txt{flex:1;min-width:0}'
    + '.svz-tit{font:inherit;color:inherit;letter-spacing:.2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    // A legenda ("3 pessoas conversando agora") sai do DESENHO pra caber na
    // mesma altura do item de navegação — mas não sai do CONTEÚDO: pintar()
    // continua escrevendo nela, e a repete no title e no aria-label. Tooltip e
    // leitor de tela seguem contando quem está na sala.
    + '.svz-sub{position:absolute;width:1px;height:1px;padding:0;margin:-1px;border:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}'
    // Mesmas medidas do .cbt-nbadge (o contador das abas), na cor da sala
    + '.svz-badge{flex:0 0 auto;display:none;align-items:center;justify-content:center;padding:2px 7px;border-radius:100px;margin-left:6px;'
    + 'font-family:var(--font-mono,monospace);font-size:9px;font-weight:700;color:#02121f;background:linear-gradient(135deg,#00d0ff,#00a2ff)}'
    + '.svz-entrada.tem-gente .svz-badge{display:flex}'
    // a cópia da lateral só existe no desktop; a das abas, só no mobile
    + '@media(min-width:900px){.cbt-page .svz-em-abas{display:none}}'
    + '@media(max-width:899px){.svz-em-lateral{display:none}}'
    // No mobile ela mora ABAIXO das abas, fora da lateral: precisa da mesma
    // margem lateral do .cbt-tabs (16px) pra não encostar na borda da tela.
    // Na lateral não leva margem nenhuma — o .cbt-side já espaça com gap:6px,
    // igual aos outros itens.
    + '.svz-em-abas{margin:0 16px 8px}'

    // ── modal de entrada ───────────────────────────────────────────────────
    // z-index 9030: acima do lightbox (9020), abaixo dos painéis flutuantes
    // (9040). Não copiei o 100000 do Blublu — foi ele que escalou a corrida.
    + '.svz-dlg{position:fixed;inset:0;z-index:9030;background:rgba(2,8,23,.86);backdrop-filter:blur(10px);'
    + 'display:none;align-items:center;justify-content:center;padding:18px}'
    + '.svz-dlg.on{display:flex}'
    + '.svz-dlgbox{width:100%;max-width:440px;background:linear-gradient(180deg,#0d1b30,#060d1a);border:1px solid rgba(0,170,255,.3);'
    + 'border-radius:22px;padding:24px;box-shadow:0 30px 90px rgba(0,0,0,.6),0 0 46px rgba(0,170,255,.1)}'
    + '.svz-dlgtit{font-family:var(--font-display,Syne,sans-serif);font-weight:800;font-size:19px;color:#fff;letter-spacing:-.4px}'
    + '.svz-dlgsub{font-family:var(--font-mono,monospace);font-size:11.5px;color:#8aa0bd;margin-top:6px;line-height:1.7}'
    + '.svz-quem{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 4px}'
    + '.svz-quem .svz-mini{display:flex;align-items:center;gap:7px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);'
    + 'border-radius:100px;padding:4px 11px 4px 4px;font-family:var(--cbt-sans,Inter,sans-serif);font-size:12px;color:#c7d5ea}'
    + '.svz-mini .svz-ava{width:24px;height:24px;flex:0 0 24px;font-size:11px}'
    + '.svz-dlgbtns{display:flex;flex-direction:column;gap:9px;margin-top:20px}'
    + '.svz-b{border:none;border-radius:14px;padding:14px 16px;font-family:var(--font-display,Syne,sans-serif);font-weight:700;font-size:14.5px;'
    + 'cursor:pointer;display:flex;align-items:center;justify-content:center;gap:9px;transition:all .18s}'
    + '.svz-b:disabled{opacity:.45;cursor:not-allowed}'
    + '.svz-b.pri{background:linear-gradient(135deg,#0077ff,#00c4ff);color:#fff;box-shadow:0 6px 22px rgba(0,140,255,.3)}'
    + '.svz-b.pri:hover:not(:disabled){box-shadow:0 8px 28px rgba(0,170,255,.45);transform:translateY(-1px)}'
    + '.svz-b.sec{background:rgba(255,255,255,.06);color:#c7d5ea;border:1px solid rgba(255,255,255,.12)}'
    + '.svz-b.sec:hover:not(:disabled){background:rgba(255,255,255,.1);color:#fff}'
    + '.svz-b.gh{background:none;color:#5f7590;font-size:12.5px;padding:8px}'
    + '.svz-b.gh:hover{color:#c7d5ea}'
    + '.svz-erro{margin-top:14px;background:rgba(255,90,90,.1);border:1px solid rgba(255,90,90,.28);color:#ffb3a7;'
    + 'border-radius:12px;padding:11px 13px;font-family:var(--cbt-sans,Inter,sans-serif);font-size:12.5px;line-height:1.6}'
    + '.svz-erro .svz-b{margin-top:10px;padding:9px 12px;font-size:12.5px}'

    // ── painel da sala (dock) ──────────────────────────────────────────────
    // Fixo, fora do #cbtFeed: a pessoa continua navegando pelas abas sem cair
    // da chamada, e o render() do comunidade.js não alcança este nó.
    + '.svz-dock{position:fixed;right:20px;bottom:20px;z-index:9030;width:340px;max-width:calc(100vw - 24px);'
    + 'background:linear-gradient(180deg,rgba(13,27,48,.96),rgba(6,13,26,.97));border:1px solid rgba(0,170,255,.32);border-radius:20px;'
    + 'backdrop-filter:blur(24px) saturate(140%);-webkit-backdrop-filter:blur(24px) saturate(140%);'
    + 'box-shadow:0 22px 70px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.06);overflow:hidden}'
    + '.svz-dhead{display:flex;align-items:center;gap:9px;padding:13px 15px;border-bottom:1px solid rgba(255,255,255,.07)}'
    + '.svz-dhead b{font-family:var(--font-display,Syne,sans-serif);font-size:14px;color:#fff;letter-spacing:-.2px}'
    + '.svz-dhead small{display:block;font-family:var(--font-mono,monospace);font-size:10px;color:#5fe3ff;margin-top:2px}'
    + '.svz-dmin{margin-left:auto;background:none;border:none;color:#7d92b8;font-size:16px;cursor:pointer;padding:4px 8px;line-height:1}'
    + '.svz-dmin:hover{color:#fff}'
    + '.svz-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(86px,1fr));gap:10px;padding:14px 15px;max-height:44vh;overflow-y:auto}'
    + '.svz-p{position:relative;display:flex;flex-direction:column;align-items:center;gap:7px;padding:10px 4px;border-radius:14px;'
    + 'background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.07);transition:border-color .15s,box-shadow .15s}'
    + '.svz-p.falando{border-color:#00e0a4;box-shadow:0 0 0 1px #00e0a4,0 0 20px rgba(0,224,164,.3)}'
    // Rede da pessoa PERDIDA (o LiveKit diz 'lost'): o card não mente que está
    // tudo bem nem some — quem sumiu de verdade sai por evento, não por palpite.
    + '.svz-p.caiu{opacity:.5}'
    // Rede RUIM ('poor'): o áudio pode estar picado, mas ela está na sala.
    // Borda tracejada = "o sinal dela oscila", e a conversa segue.
    + '.svz-p.oscila{border-style:dashed;border-color:rgba(255,200,100,.5)}'
    + '.svz-ava{width:46px;height:46px;flex:0 0 46px;border-radius:50%;overflow:hidden;display:flex;align-items:center;justify-content:center;'
    + 'font-family:var(--font-display,Syne,sans-serif);font-weight:800;font-size:18px;color:#fff;border:2px solid transparent}'
    + '.svz-ava img{width:100%;height:100%;object-fit:cover}'
    + '.svz-ava.pfull{border-color:#00aaff}.svz-ava.pmaster{border-color:#fbbf24}.svz-ava.mod{border-color:#ffd977}'
    + '.svz-nome{font-family:var(--cbt-sans,Inter,sans-serif);font-size:11.5px;color:#c7d5ea;max-width:100%;overflow:hidden;'
    + 'text-overflow:ellipsis;white-space:nowrap;text-align:center}'
    + '.svz-mic{position:absolute;right:6px;top:6px;font-size:11px;opacity:.85}'
    + '.svz-ctrl{display:flex;gap:9px;padding:0 15px 14px}'
    + '.svz-ctrl .svz-b{flex:1;padding:12px 10px;font-size:13.5px}'
    + '.svz-b.mudo{background:rgba(255,120,120,.14);color:#ffb3a7;border:1px solid rgba(255,120,120,.32)}'
    + '.svz-b.sair{background:rgba(255,60,60,.16);color:#ff9b8f;border:1px solid rgba(255,60,60,.34)}'
    + '.svz-b.sair:hover{background:rgba(255,60,60,.26);color:#fff}'
    + '.svz-dock.mini .svz-grid,.svz-dock.mini .svz-ctrl{display:none}'
    // confirmação de saída: mesmo vidro do painel, por cima dele. Não é um
    // segundo modal solto na tela — a pergunta é sobre ESTE painel e nasce
    // dentro dele, então o olho não precisa procurar.
    + '.svz-conf{position:absolute;inset:0;z-index:2;display:none;align-items:center;justify-content:center;padding:16px;'
    + 'background:rgba(4,10,22,.9);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}'
    + '.svz-conf.on{display:flex}'
    + '.svz-confbox{width:100%;max-width:290px;text-align:center}'
    + '.svz-conftit{font-family:var(--font-display,Syne,sans-serif);font-weight:800;font-size:15.5px;color:#fff;letter-spacing:-.25px}'
    + '.svz-confsub{font-family:var(--font-mono,monospace);font-size:10.5px;color:#8aa0bd;margin-top:7px;line-height:1.6}'
    + '.svz-confbtns{display:flex;gap:9px;margin-top:16px}'
    + '.svz-confbtns .svz-b{flex:1;padding:11px 10px;font-size:13.5px}'
    + '.svz-nota{padding:0 15px 12px;font-family:var(--font-mono,monospace);font-size:10px;color:#5f7590;line-height:1.6}'
    + '@media(max-width:620px){.svz-dock{right:8px;left:8px;bottom:8px;width:auto}}'
    + '.svz-toast{position:fixed;bottom:26px;left:50%;transform:translateX(-50%);z-index:9060;background:#0a1830;'
    + 'border:1px solid rgba(0,170,255,.35);color:#e8f0fb;font-family:var(--font-mono,monospace);font-size:12.5px;'
    + 'padding:11px 18px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.5);max-width:88vw;opacity:0;'
    + 'pointer-events:none;transition:opacity .3s;text-align:center}'
    + '.svz-toast.on{opacity:1}'
    + '@media(prefers-reduced-motion:reduce){.svz-entrada.tem-gente .svz-ponto{animation:none}.svz-entrada:hover{transform:none}}';

  function estilo() {
    if ($('svzCSS')) return;
    var s = document.createElement('style');
    s.id = 'svzCSS'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ── config ────────────────────────────────────────────────────────────────
  // Não tem mais ticket com prazo pra vigiar: o crachá do LiveKit é emitido no
  // CLIQUE de entrar, não no load da página. Isso mata de raiz o defeito antigo
  // ("aba aberta de manhã, ticket vencido à noite, pessoa entrava fantasma"):
  // credencial velha não existe mais, porque ela nasce na hora do uso.
  function garantirConfig(forcar) {
    if (!forcar && S.cfg) return Promise.resolve(S.cfg);
    if (!S.promessaConfig) {
      S.promessaConfig = api('config').then(function (r) {
        S.promessaConfig = null;
        // 401/403: sem login ou sem plano. A sala simplesmente não existe pra
        // essa pessoa — nada de botão decorativo que dá erro no clique.
        if (!r.ok || !r.d || !r.d.ok) return S.cfg;
        S.cfg = r.d;
        if (r.d.max) MAX = r.d.max;
        if (r.d.indisponivel) { S.indisponivel = true; S.conn = 'erro'; }
        return S.cfg;
      }).catch(function () { S.promessaConfig = null; return S.cfg; });
    }
    return S.promessaConfig;
  }

  // ── SDK do LiveKit ────────────────────────────────────────────────────────
  // Carregado no primeiro clique, não no load: quem só passa pela Comunidade
  // não paga 1,2MB de WebRTC. Duas CDNs em ordem — CDN fora do ar não pode ser
  // o fim da sala, e a segunda tentativa custa só o tempo da primeira falhar.
  function carregarSDK() {
    if (S.LK) return Promise.resolve(S.LK);
    if (!S.promessaSDK) {
      S.promessaSDK = (async function () {
        for (var i = 0; i < SDKS.length; i++) {
          try {
            var mod = await import(SDKS[i]);
            if (mod && mod.Room) { S.LK = mod; return mod; }
          } catch (e) {}
        }
        return null;
      })().then(function (mod) {
        S.promessaSDK = null;
        return mod;
      });
    }
    return S.promessaSDK;
  }

  // ── contagem de FORA da sala ──────────────────────────────────────────────
  // É o que faz o contador aparecer ANTES de entrar sem pedir microfone e sem
  // ocupar vaga: pergunta ao nosso backend, que conta no RoomService do
  // LiveKit. Dentro da sala isto não roda — lá a verdade são os eventos.
  function atualizarContagem(forcar) {
    if (S.entrei && !forcar) return Promise.resolve(false);
    if (S.contando) return Promise.resolve(false);
    if (!S.cfg) return Promise.resolve(false);
    S.contando = true;
    return api('contar').then(function (r) {
      S.contando = false;
      if (!r.ok || !r.d || !r.d.ok) {
        // Falha de rede não pode APAGAR uma contagem boa que ainda está fresca:
        // ela só deixa de ser renovada, e a validade dela resolve o resto.
        if (!S.foraOk) S.conn = 'erro';
        return false;
      }
      if (r.d.max) MAX = r.d.max;
      S.indisponivel = !!r.d.indisponivel;
      S.conn = S.indisponivel ? 'erro' : 'on';
      S.foraN = Number(r.d.n || 0);
      S.foraNomes = Array.isArray(r.d.pessoas) ? r.d.pessoas.slice(0, MAX + 2) : [];
      S.foraOk = true;
      S.contadoEm = Date.now();
      pintar();
      return true;
    }).catch(function () {
      S.contando = false;
      if (!S.foraOk) S.conn = 'erro';
      return false;
    });
  }

  function contagemFresca() {
    return S.foraOk && (Date.now() - S.contadoEm) < VALIDADE_CONTAGEM;
  }

  function ligarPolling() {
    if (S.tPoll) return;
    S.tPoll = setInterval(function () {
      // Dentro da sala e aba escondida não custam invocação nenhuma.
      if (S.entrei || document.hidden) return;
      atualizarContagem();
    }, POLL_MS);
  }

  function pararPolling() {
    if (S.tPoll) { clearInterval(S.tPoll); S.tPoll = null; }
  }

  // ── a lista de pessoas, vinda do LiveKit ──────────────────────────────────
  // Não existe mais lista NOSSA a sincronizar com a conexão: a lista É a
  // conexão. Toda mudança (chegou, saiu, mutou) é um evento do Room, e a gente
  // relê o estado inteiro dele — barato (no máximo 10 pessoas) e sem a chance
  // de divergir, que era a raiz do defeito anterior.
  function dadosDe(p, eu) {
    var meta = {};
    try { meta = p && p.metadata ? JSON.parse(p.metadata) : {}; } catch (e) { meta = {}; }
    var foto = (typeof meta.a === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(meta.a)) ? meta.a : null;
    var quando = 0;
    try {
      var j = p && p.joinedAt;
      quando = j ? (typeof j.getTime === 'function' ? j.getTime() : Number(j) || 0) : 0;
    } catch (e) {}
    return {
      eu: !!eu,
      nome: String((p && p.name) || '').slice(0, 32) || 'criador',
      avatar: foto,
      plano: meta.p === 'mod' ? 'mod' : (meta.p === 'master' ? 'master' : 'full'),
      // O meu mudo é o MEU botão (intenção), o dos outros é o que o SFU diz.
      mudo: eu ? !!S.mudo : !(p && p.isMicrophoneEnabled),
      entrou: quando,
    };
  }

  function sincronizar() {
    var sala = S.sala;
    var nova = new Map();
    if (sala) {
      var lp = sala.localParticipant;
      if (lp && lp.identity) nova.set(lp.identity, dadosDe(lp, true));
      var rem = sala.remoteParticipants;
      if (rem && typeof rem.forEach === 'function') {
        rem.forEach(function (p) { if (p && p.identity) nova.set(p.identity, dadosDe(p, false)); });
      }
    }
    S.pessoas = nova;
    // Quem saiu não pode continuar "falando" nem "com rede ruim": esses dois
    // mapas seguem a lista, senão o rodapé conta gente que não está mais aqui.
    Array.from(S.falando).forEach(function (k) { if (!nova.has(k)) S.falando.delete(k); });
    Array.from(S.qualidade.keys()).forEach(function (k) { if (!nova.has(k)) S.qualidade.delete(k); });
  }

  // Quantas pessoas na sala. Dentro dela: os participantes do LiveKit. Fora
  // dela: a contagem do backend, e só enquanto ela estiver fresca.
  function contarPresentes() {
    if (S.entrei) return S.pessoas.size;
    return contagemFresca() ? S.foraN : 0;
  }

  // "0 pessoas · 1 falando" não pode existir: falando é subconjunto de
  // presentes. Aqui isso é garantido pela interseção — S.falando é alimentado
  // por evento do SFU e o sincronizar() já poda quem saiu, mas a conta continua
  // sendo a interseção porque foi exatamente esse número mentiroso que apareceu
  // na tela do dono na versão anterior.
  function contarFalando() {
    // Fora da sala não existe "falando": ali o número de pessoas vem do
    // backend e não tem nada a ver com este conjunto. Sem esta linha, um
    // estado rasgado (saí da sala, o último ActiveSpeakers ainda na memória)
    // conseguiria imprimir de novo o "0 pessoas · 1 falando" — o número
    // mentiroso que apareceu na tela do dono na versão anterior.
    if (!S.entrei) return 0;
    var n = 0;
    S.falando.forEach(function (k) { if (S.pessoas.has(k)) n++; });
    return n;
  }

  function souEu(identity) {
    return !!(S.cfg && S.cfg.me && S.cfg.me.id === identity);
  }

  // Ordem de chegada pura (sem me pôr na frente): é a régua do desempate de
  // sala cheia, e ela precisa dar o MESMO resultado em todos os navegadores.
  // `entrou` é o joined_at que vem do SFU; a identity desempata empate exato.
  function ordemDeChegada() {
    return Array.from(S.pessoas.entries()).sort(function (a, b) {
      return (a[1].entrou - b[1].entrou) || (a[0] < b[0] ? -1 : 1);
    }).map(function (e) { return e[0]; });
  }

  // O TETO DE 10, camada 2. A camada 1 é o servidor (conta antes de assinar o
  // crachá), mas duas pessoas podem passar por ela no mesmo instante.
  //
  // O `max_participants` da sala do LiveKit NÃO fecha essa fresta: MEDIDO em
  // 11/08 contra esta conta, sala criada com teto 2 aceitou o terceiro e os
  // três ficaram. Então o desempate é aqui: todo mundo ordena igual (chegada,
  // depois identity) e quem ficou além do teto se retira sozinho. Recusar é
  // sempre melhor que deixar entrar e travar — e, ao contrário da versão
  // anterior, a lista que decide isto vem do SFU, não de batimento por
  // broadcast que qualquer um podia forjar pra empurrar gente pra fora.
  function checarLotacao() {
    if (!S.entrei || S.pessoas.size <= MAX) return;
    var eu = (S.cfg && S.cfg.me && S.cfg.me.id) || '';
    if (ordemDeChegada().indexOf(eu) >= MAX) {
      sair('A sala encheu bem na hora que você entrou (limite de ' + MAX + '). Tenta de novo em instantes.');
    }
  }

  // ── eventos do Room ───────────────────────────────────────────────────────
  function ligarEventos(sala, LK) {
    var E = LK.RoomEvent;

    sala.on(E.ParticipantConnected, function () {
      sincronizar();
      if (Date.now() > S.silenciarAte) som('entrou');
      checarLotacao();
      pintar();
    });

    sala.on(E.ParticipantDisconnected, function () {
      sincronizar();
      if (Date.now() > S.silenciarAte) som('saiu');
      pintar();
    });

    // Microfone dos outros (e o meu, quando o SDK confirma): o ícone 🔇 do card
    // vem daqui, não de mensagem que a gente troca com ninguém.
    sala.on(E.TrackMuted, function () { sincronizar(); pintar(); });
    sala.on(E.TrackUnmuted, function () { sincronizar(); pintar(); });
    sala.on(E.TrackSubscribed, function () { sincronizar(); pintar(); });
    sala.on(E.TrackUnsubscribed, function () { sincronizar(); pintar(); });
    sala.on(E.LocalTrackPublished, function () { sincronizar(); pintar(); });
    sala.on(E.ParticipantMetadataChanged, function () { sincronizar(); pintar(); });
    sala.on(E.ParticipantNameChanged, function () { sincronizar(); pintar(); });

    // QUEM ESTÁ FALANDO — o indicador do próprio LiveKit. Não tem medidor nosso
    // aqui de propósito: o AudioContext nos deu dois bugs (limiar fixo 3,5x
    // acima da voz real do dono e contexto fechado lendo 0,00000 pra sempre).
    sala.on(E.ActiveSpeakersChanged, function (lista) {
      var nova = new Set();
      (lista || []).forEach(function (p) { if (p && p.identity) nova.add(p.identity); });
      // Mutado não fala. O SFU já respeita isso, mas o meu próprio mudo é local
      // e instantâneo — sem esta guarda a minha borda ficaria acesa meio segundo
      // depois de eu me mutar.
      if (S.mudo && S.cfg && S.cfg.me) nova.delete(S.cfg.me.id);
      S.falando = nova;
      pintarFala();
    });

    // Rede de cada um, dita pelo SFU. É o que substitui (honestamente) o
    // "sem conexão direta" do mesh: agora ninguém depende da rede do outro, só
    // da própria — então o card marca oscilação sem sugerir culpa de terceiros.
    sala.on(E.ConnectionQualityChanged, function (qualidade, p) {
      if (!p || !p.identity) return;
      S.qualidade.set(p.identity, String(qualidade || ''));
      pintarSala();
    });

    sala.on(E.ConnectionStateChanged, function (estado) {
      var C = LK.ConnectionState || {};
      if (estado === C.Connected) S.conn = 'on';
      else if (estado === C.Reconnecting || estado === C.SignalReconnecting) S.conn = 'instavel';
      else if (estado === C.Disconnected) S.conn = 'off';
      pintar();
    });

    sala.on(E.Reconnecting, function () { S.conn = 'instavel'; pintarSala(); });
    sala.on(E.Reconnected, function () {
      S.conn = 'on';
      sincronizar();
      pintar();
    });

    // Autoplay: o navegador só solta áudio depois de um gesto. Antes isso era
    // um catch no .play() de cada <audio>; agora o SDK avisa uma vez e a gente
    // arma o próximo toque na tela pra liberar tudo de uma vez.
    sala.on(E.AudioPlaybackStatusChanged, function () {
      if (sala.canPlaybackAudio) return;
      aviso('Toque na tela pra liberar o áudio da sala.');
      armarLiberacaoDeAudio(sala);
    });

    sala.on(E.MediaDevicesError, function (e) {
      aviso(mensagemDeMicrofone(e));
    });

    // Fim de linha. Se não fui EU que desliguei, a pessoa merece saber por quê —
    // "a sala sumiu em silêncio" foi metade das reclamações da versão anterior.
    sala.on(E.Disconnected, function (motivo) {
      if (S.sala !== sala) return;            // já era: sair() cuidou de tudo
      var R = LK.DisconnectReason || {};
      var txt = '';
      if (motivo === R.DUPLICATE_IDENTITY) txt = 'Você entrou nesta sala em outra aba ou aparelho.';
      else if (motivo === R.PARTICIPANT_REMOVED) txt = 'Você foi removido da sala de voz.';
      else if (motivo === R.ROOM_DELETED || motivo === R.ROOM_CLOSED) txt = 'A sala de voz foi encerrada.';
      else if (motivo === R.SERVER_SHUTDOWN) txt = 'A sala de voz caiu no servidor. Tente entrar de novo.';
      else if (motivo !== R.CLIENT_INITIATED) txt = 'Você foi desconectado da sala de voz.';
      S.sala = null;
      sair(txt);
    });
  }

  // Um toque na tela e o áudio da sala inteira sai do mudo do navegador. O
  // laço se remove sozinho: ficar pendurado no document pra sempre por causa de
  // uma política de autoplay seria lixo permanente.
  function armarLiberacaoDeAudio(sala) {
    if (sala._svzArmado) return;
    sala._svzArmado = true;
    var ev = window.PointerEvent ? 'pointerdown' : 'mousedown';
    var uma = function () {
      document.removeEventListener(ev, uma, true);
      sala._svzArmado = false;
      try { Promise.resolve(sala.startAudio()).catch(function () {}); } catch (e) {}
    };
    document.addEventListener(ev, uma, true);
  }

  function mensagemDeMicrofone(e) {
    var nome = (e && (e.name || (e.error && e.error.name))) || '';
    if (nome === 'NotAllowedError' || nome === 'SecurityError') return 'Você bloqueou o microfone. Libere no cadeado da barra de endereço e tente de novo.';
    if (nome === 'NotFoundError' || nome === 'OverconstrainedError') return 'Nenhum microfone encontrado neste aparelho.';
    if (nome === 'NotReadableError') return 'Outro programa está usando o microfone. Feche e tente de novo.';
    return 'Não consegui abrir o microfone.';
  }

  // ── entrar / sair ─────────────────────────────────────────────────────────
  // `assumir` só vem do botão "Entrar aqui mesmo" da recusa por sessão
  // duplicada (ver erroDuplicado): é a pessoa dizendo que a outra sessão é dela
  // e pode cair.
  async function entrar(mudo, assumir) {
    if (S.entrei || S.entrando) return;
    if (!window.RTCPeerConnection) { erroModal('Este navegador não fala WebRTC. Use Chrome, Edge, Firefox ou Safari atualizado.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      erroModal('Seu navegador não libera o microfone aqui. Abra o site em https e sem modo restrito.');
      return;
    }
    S.entrando = true; limparErroModal(); pintarModal();

    // 1) o SDK. CDN fora do ar = sala indisponível, dito com essas palavras.
    var LK = await carregarSDK();
    if (!LK) {
      S.entrando = false; S.conn = 'erro';
      erroModal('A sala de voz está indisponível agora (não consegui carregar o áudio ao vivo). Tenta de novo em instantes.');
      pintarModal(); pintar(); return;
    }

    // 2) o crachá. O portão de plano e o teto de 10 são cobrados AQUI, no
    //    servidor: quem não é Full/Master não recebe token e não entra.
    var r = await api('entrar', assumir ? { assumir: 1 } : null);
    if (!r.ok || !r.d || !r.d.ok || !r.d.token || !r.d.url) {
      S.entrando = false;
      var d = r.d || {};
      if (d.jaEstou) { erroDuplicado(mudo); pintarModal(); return; }
      if (d.cheia) {
        // A contagem que o servidor acabou de fazer é mais nova que a nossa.
        S.foraN = Number(d.n || MAX); S.foraOk = true; S.contadoEm = Date.now();
        erroModal('A sala está cheia (' + (d.max || MAX) + ' pessoas). Assim que alguém sair, o botão libera.');
      } else if (d.indisponivel) {
        S.conn = 'erro';
        erroModal('A sala de voz está indisponível agora. Tenta de novo em instantes.');
      } else if (d.login) {
        erroModal('Sua sessão expirou. Atualize a página (F5) e entre de novo.');
      } else if (d.upgrade) {
        erroModal('A sala de voz é exclusiva de assinantes Full e Master.');
      } else {
        erroModal('Não consegui entrar na sala agora. Tenta de novo em instantes.');
      }
      pintarModal(); pintar(); return;
    }
    if (r.d.max) MAX = r.d.max;
    if (r.d.me) S.cfg = Object.assign({}, S.cfg || {}, { me: r.d.me });

    // 3) a sala. `disconnectOnPageLeave:false` é o que impede o SDK de nos
    //    desconectar quando a tela do celular apaga (era o defeito 11).
    //    `stopMicTrackOnMute:false` é o que faz o "Mudo" ser instantâneo: a
    //    faixa continua publicada, só silenciada — e desmutar não renegocia.
    var sala;
    try {
      sala = new LK.Room({
        adaptiveStream: false,
        dynacast: false,
        disconnectOnPageLeave: false,
        stopMicTrackOnMute: false,
        audioCaptureDefaults: {
          echoCancellation: true,   // sem isso a sala vira microfonia na hora
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,          // voz é mono; estéreo só dobra o upload
        },
        publishDefaults: {
          dtx: true,                // cala o encoder no silêncio
          red: true,                // redundância: segura rede ruim
          audioPreset: (LK.AudioPresets && LK.AudioPresets.speech) || undefined,
        },
      });
    } catch (e) {
      S.entrando = false; S.conn = 'erro';
      erroModal('A sala de voz está indisponível agora. Tenta de novo em instantes.');
      pintarModal(); return;
    }

    S.sala = sala;
    ligarEventos(sala, LK);
    S.silenciarAte = Date.now() + SILENCIO_ENTRADA;

    try {
      await sala.connect(r.d.url, r.d.token, { autoSubscribe: true });
    } catch (e) {
      S.entrando = false; S.sala = null; S.conn = 'erro';
      try { sala.disconnect(); } catch (_) {}
      erroModal('Não consegui conectar na sala. Confere a internet e tenta de novo.');
      pintarModal(); pintar(); return;
    }

    // 4) ── Só AGORA o microfone: depois do "sim" da pessoa, nunca antes. ──
    //    Entrar mudo NÃO é entrar sem microfone: a faixa é capturada e
    //    silenciada, então "desmutar" é instantâneo.
    S.semMic = false;
    S.mudo = !!mudo;
    try {
      await sala.localParticipant.setMicrophoneEnabled(true);
      if (mudo) await sala.localParticipant.setMicrophoneEnabled(false);
    } catch (e) {
      // Microfone bloqueado não pode mais custar a entrada inteira: quem clicou
      // em "entrar mudo (só ouvir)" queria justamente ouvir. Entra como ouvinte,
      // MARCADO — o painel diz que o microfone não abriu, em vez de mostrar um
      // botão de mudo que mente.
      S.semMic = true; S.mudo = true;
      // UM aviso só: o toast é um elemento único, e dois seguidos viram um só
      // (o segundo apaga o primeiro antes de a pessoa ler).
      aviso(mensagemDeMicrofone(e) + ' Você entrou só ouvindo.');
    }

    S.entrando = false;
    S.entrei = true;
    S.conn = 'on';
    sincronizar();
    // Entrei numa sala que já estava estourada (corrida com outro pedido no
    // mesmo instante): quem chegou por último se retira, em vez de furar o teto.
    checarLotacao();
    if (!S.entrei) return;
    // Dentro da sala a contagem vem dos eventos: o relógio que pergunta ao
    // backend é desligado e não gasta invocação nenhuma. Quem o rearma é o
    // sair() — e todo caminho de saída passa por ele (inclusive a queda).
    pararPolling();
    fecharModal();
    abrirDock();
    pintar();
    som('entrou');
  }

  function sair(motivo) {
    // O link que estava esperando confirmação é lido AQUI, antes de qualquer
    // coisa: logo abaixo o fecharConfirmacaoSaida() zera o destinoPendente
    // (é o que ele faz quando a pessoa desiste), e sem esta cópia a navegação
    // confirmada se perderia no meio da própria limpeza.
    var destino = destinoPendente;
    destinoPendente = null;
    var estava = S.entrei || !!S.sala;
    if (estava) {
      S.entrei = false;
      var sala = S.sala;
      S.sala = null;
      // disconnect() solta as faixas locais (stopTracks é o padrão), e é assim
      // que a luzinha do microfone apaga. Os laços saem junto: um Room morto
      // ainda emitindo 'Disconnected' chamaria sair() de novo, em laço.
      try { if (sala) { if (typeof sala.removeAllListeners === 'function') sala.removeAllListeners(); sala.disconnect(); } } catch (e) {}
      S.pessoas = new Map();
      S.falando = new Set();
      S.qualidade = new Map();
      som('saiu');
    }
    S.mudo = false;
    S.suspenso = false;
    S.semMic = false;
    S.silenciarAte = 0;
    fecharConfirmacaoSaida();
    fecharDock();
    pintar();
    if (motivo) aviso(motivo);
    // Saí da sala: a contagem volta a ser a de fora, e ela tem que ser
    // perguntada agora — senão a entrada anuncia a sala de antes da minha saída.
    if (estava) atualizarContagem(true);
    ligarPolling();
    // Só agora, com a sala desligada e o microfone solto, a página troca. Nesta
    // altura S.entrei já é false, então o beforeunload lá embaixo não pergunta
    // de novo — a pessoa responde UMA vez.
    if (destino) navegarPara(destino);
  }

  async function alternarMudo() {
    if (!S.entrei || !S.sala) return;
    var lp = S.sala.localParticipant;
    if (!lp) return;
    var querMudo = !S.mudo;
    // Quem entrou sem microfone (bloqueado/ocupado) está tentando ABRIR agora:
    // é uma nova captura, e ela pode falhar de novo — com a mensagem certa.
    try {
      await lp.setMicrophoneEnabled(!querMudo);
      S.mudo = querMudo;
      S.semMic = false;
    } catch (e) {
      S.semMic = true; S.mudo = true;
      aviso(mensagemDeMicrofone(e));
    }
    if (S.mudo && S.cfg && S.cfg.me) S.falando.delete(S.cfg.me.id);
    sincronizar();
    pintar();
  }

  // Depois de um congelamento longo (tela do celular apagada, aba no bfcache) a
  // faixa de áudio pode voltar morta ('ended'). Sem isto a pessoa continua na
  // sala achando que fala, e ninguém ouve nada. O LiveKit republica a faixa sem
  // renegociar com o SFU — é uma troca de track, não uma reentrada.
  async function garantirMicrofone() {
    if (!S.entrei || !S.sala || S.semMic || S.mudo) return true;
    var lp = S.sala.localParticipant;
    if (!lp) return true;
    var viva = false;
    try {
      var pub = lp.getTrackPublication && S.LK && S.LK.Track
        ? lp.getTrackPublication(S.LK.Track.Source.Microphone) : null;
      var mt = pub && pub.track && pub.track.mediaStreamTrack;
      viva = !!(mt && mt.readyState === 'live');
    } catch (e) { viva = true; }   // não sei dizer: não mexe
    if (viva) return true;
    try {
      await lp.setMicrophoneEnabled(false);
      await lp.setMicrophoneEnabled(true);
      sincronizar(); pintar();
      return true;
    } catch (e) {
      S.semMic = true; S.mudo = true;
      aviso('O microfone foi liberado enquanto a tela estava apagada. Toque em "Desmutar" pra abrir de novo.');
      sincronizar(); pintar();
      return false;
    }
  }

  // ── despedida x suspensão ─────────────────────────────────────────────────
  // Saiu de verdade (fechou/navegou): desliga a sala na hora. A ausência
  // resolveria sozinha em segundos, mas contador fantasma faz a sala parecer
  // cheia quando está vazia.
  //
  // A ordem aqui não é estilo: `S.sala` é zerado e os laços saem ANTES do
  // disconnect(). Sem isso o próprio evento 'Disconnected' do SDK cairia no
  // nosso tratador e chamaria sair() no meio de um beforeunload/pagehide — som,
  // repintura e uma chamada de contagem numa página que já está morrendo.
  function despedir() {
    var sala = S.sala;
    S.sala = null;
    S.entrei = false;
    try {
      if (sala) {
        if (typeof sala.removeAllListeners === 'function') sala.removeAllListeners();
        sala.disconnect();
      }
    } catch (e) {}
  }

  // Aba escondida/congelada NÃO é saída. No iOS, apagar a tela do celular
  // dispara 'pagehide' igualzinho a fechar a aba — e o padrão do SDK
  // (disconnectOnPageLeave) desconectaria ali. Por isso ele está desligado e
  // quem decide é este bloco: aqui a gente só MARCA o estado; nada de
  // desconectar, nada de soltar o microfone.
  function suspender() {
    if (S.suspenso) return;
    S.suspenso = true;
    pintarSala();
  }

  // Voltou (destravou a tela, 'resume', bfcache, troca de aba). O LiveKit
  // reconecta sozinho — é o serviço que a gente foi buscar nele. O que sobra
  // pra nós é conferir o microfone e repintar.
  var retomando = false;
  async function retomar() {
    S.suspenso = false;
    if (!S.entrei) {
      // Fora da sala: o contador pode estar velho. Pergunta de novo em vez de
      // mostrar no badge uma sala de minutos atrás.
      atualizarContagem(true);
      pintar();
      return;
    }
    if (retomando) return;
    retomando = true;
    try {
      sincronizar();
      await garantirMicrofone();
      pintar();
    } finally { retomando = false; }
  }

  // ── UI: entrada ───────────────────────────────────────────────────────────
  function entradaHTML(classe) {
    return '<div class="svz-entrada ' + classe + '" role="button" tabindex="0" aria-label="Sala de voz ao vivo">'
      + '<div class="svz-ico">🎙️<span class="svz-ponto"></span></div>'
      + '<div class="svz-txt">'
      + '<div class="svz-tit">Sala de voz ao vivo</div>'
      + '<div class="svz-sub" data-svz-sub>carregando…</div>'
      + '</div>'
      + '<div class="svz-badge" data-svz-badge>0</div>'
      + '</div>';
  }

  function criarEntrada(classe) {
    var w = document.createElement('div');
    w.innerHTML = entradaHTML(classe);
    var el = w.firstElementChild;
    el.addEventListener('click', abrirModal);
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirModal(); }
    });
    return el;
  }

  function depoisDe(alvo, el) { alvo.parentNode.insertBefore(el, alvo.nextSibling); }

  // Duas cópias, uma por âncora: a barra de abas some no desktop e a lateral
  // some no mobile — e o CSS acima esconde a que não é daquela largura.
  function injetar() {
    var abas = $('cbtTabs');
    var dicaLateral = document.querySelector('.cbt-side .cbt-snav[data-tab="dicas"]');
    if (!abas && !dicaLateral) return false;
    estilo();
    if (abas && !abas.parentNode.querySelector('.svz-em-abas')) depoisDe(abas, criarEntrada('svz-em-abas'));
    if (dicaLateral && !dicaLateral.parentNode.querySelector('.svz-em-lateral')) depoisDe(dicaLateral, criarEntrada('svz-em-lateral'));
    pintar();
    return !!(abas && dicaLateral);
  }

  function pintarEntrada() {
    var n = contarPresentes();
    var texto = (S.conn === 'erro' || S.indisponivel) ? 'sala indisponível agora'
      : S.entrei ? 'você está na sala' + (n > 1 ? ' com mais ' + (n - 1) : ' — chame alguém')
        // Contagem velha é passado, não presente: antes o badge ficava congelado
        // com o número de horas atrás e o pontinho verde pulsando, convidando
        // pra uma sala que podia estar vazia fazia tempo.
        : !contagemFresca() ? 'toque pra ver quem está'
          : n === 0 ? 'ninguém na sala — seja o primeiro'
            : n === 1 ? '1 pessoa conversando agora'
              : n + ' pessoas conversando agora';
    document.querySelectorAll('.svz-entrada').forEach(function (el) {
      el.classList.toggle('tem-gente', n > 0);
      var sub = el.querySelector('[data-svz-sub]');
      if (sub) sub.textContent = texto;
      var b = el.querySelector('[data-svz-badge]');
      if (b) b.textContent = String(n);
      // A legenda virou invisível quando a entrada encolheu pro tamanho do
      // item de navegação. Ela não pode virar informação perdida: repete no
      // title (tooltip do mouse) e no aria-label (leitor de tela).
      try {
        el.title = 'Sala de voz ao vivo — ' + texto;
        el.setAttribute('aria-label', 'Sala de voz ao vivo — ' + texto);
      } catch (e) {}
    });
  }

  // ── UI: modal de entrada ──────────────────────────────────────────────────
  function montarModal() {
    if ($('svzDlg')) return;
    estilo();
    var ov = document.createElement('div');
    ov.className = 'svz-dlg'; ov.id = 'svzDlg';
    ov.addEventListener('click', function (e) { if (e.target === ov) fecharModal(); });
    ov.innerHTML =
      '<div class="svz-dlgbox" role="dialog" aria-modal="true" aria-label="Entrar na sala de voz">'
      + '<div class="svz-dlgtit">🎙️ Entrar na sala de voz</div>'
      + '<div class="svz-dlgsub" id="svzDlgSub"></div>'
      + '<div class="svz-quem" id="svzDlgQuem"></div>'
      + '<div id="svzDlgErro"></div>'
      + '<div class="svz-dlgbtns">'
      + '<button class="svz-b pri" id="svzBEntrar">🎤 Entrar com microfone ligado</button>'
      + '<button class="svz-b sec" id="svzBMudo">🔇 Entrar mudo (só ouvir)</button>'
      + '<button class="svz-b gh" id="svzBCancelar">Agora não</button>'
      + '</div></div>';
    document.body.appendChild(ov);
    $('svzBEntrar').addEventListener('click', function () { entrar(false); });
    $('svzBMudo').addEventListener('click', function () { entrar(true); });
    $('svzBCancelar').addEventListener('click', fecharModal);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && $('svzDlg') && $('svzDlg').classList.contains('on')) fecharModal();
    });
  }

  function abrirModal() {
    if (S.entrei) { abrirDock(); return; }
    montarModal();
    limparErroModal();
    $('svzDlg').classList.add('on');
    pintarModal();
    // Esta é exatamente a tela em que a sala mentiu na versão anterior: "quem
    // está lá" tem que ser perguntado na HORA da abertura, não herdado do
    // último ciclo. Custa uma chamada.
    Promise.resolve(garantirConfig()).then(function () { atualizarContagem(true); });
  }

  function fecharModal() {
    var d = $('svzDlg');
    if (d) d.classList.remove('on');
  }

  function erroModal(msg) {
    montarModal();
    var e = $('svzDlgErro');
    if (e) e.innerHTML = '<div class="svz-erro">' + esc(msg) + '</div>';
    var d = $('svzDlg');
    if (d && !d.classList.contains('on')) { d.classList.add('on'); }
    pintarModal();
  }

  // Recusa por sessão duplicada com SAÍDA. A sessão presa no SFU nem sempre é
  // uma aba de verdade: navegador que fechou no tranco fica alguns segundos
  // pendurado, e sem este botão a pessoa levaria "você já está em outra aba"
  // olhando pra uma aba só. Quem confirma toma a vaga; a outra sessão recebe
  // DUPLICATE_IDENTITY e sai avisando.
  function erroDuplicado(mudo) {
    montarModal();
    var e = $('svzDlgErro');
    if (!e) return;
    e.innerHTML = '<div class="svz-erro">'
      + esc('Você já está nesta sala em outra aba ou aparelho.')
      + '<button class="svz-b sec" id="svzBAssumir">Entrar aqui mesmo</button>'
      + '</div>';
    var b = $('svzBAssumir');
    if (b) b.addEventListener('click', function () { entrar(mudo, true); });
    var d = $('svzDlg');
    if (d && !d.classList.contains('on')) d.classList.add('on');
  }

  function limparErroModal() { var e = $('svzDlgErro'); if (e) e.innerHTML = ''; }

  function pintarModal() {
    var d = $('svzDlg');
    if (!d || !d.classList.contains('on')) return;
    var n = contarPresentes();
    var cheia = n >= MAX;
    var fora = S.conn === 'erro' || S.indisponivel;
    var sub = $('svzDlgSub');
    if (sub) {
      sub.textContent = fora ? 'A sala de voz está indisponível agora. Tenta de novo em instantes.'
        : S.entrando ? 'conectando…'
          : cheia ? 'A sala está cheia (' + MAX + ' de ' + MAX + '). Espera alguém sair.'
            : n === 0 ? 'A sala está vazia. Entra e chama a galera no feed — é conversa por voz, só áudio.'
              : n + (n === 1 ? ' pessoa está' : ' pessoas estão') + ' na sala agora. Cabem ' + MAX + '.';
    }
    var quem = $('svzDlgQuem');
    if (quem) {
      var htm = '';
      // Fora da sala os nomes vêm da contagem do backend; dentro dela, do
      // próprio LiveKit. Nos dois casos a origem é servidor, nunca o payload de
      // outro navegador.
      var lista = S.entrei ? Array.from(S.pessoas.values()) : (S.foraNomes || []);
      lista.forEach(function (pe) {
        htm += '<div class="svz-mini">' + avatarHTML(pe) + '<span>' + esc(pe.nome) + '</span></div>';
      });
      quem.innerHTML = htm;
    }
    var b1 = $('svzBEntrar'), b2 = $('svzBMudo');
    if (b1) b1.disabled = S.entrando || cheia || fora;
    if (b2) b2.disabled = S.entrando || cheia || fora;
    if (b1) b1.textContent = S.entrando ? 'entrando…' : '🎤 Entrar com microfone ligado';
  }

  // ── UI: painel da sala ────────────────────────────────────────────────────
  function avatarHTML(pe) {
    var anel = pe.plano === 'mod' ? ' mod' : pe.plano === 'master' ? ' pmaster' : ' pfull';
    if (pe.avatar) return '<div class="svz-ava' + anel + '"><img src="' + esc(pe.avatar) + '" alt=""></div>';
    return '<div class="svz-ava' + anel + '" style="background:hsl(' + hue(pe.nome) + ',60%,38%)">' + esc(inicial(pe.nome)) + '</div>';
  }

  function montarDock() {
    if ($('svzDock')) return;
    estilo();
    var d = document.createElement('div');
    d.className = 'svz-dock'; d.id = 'svzDock';
    d.innerHTML =
      '<div class="svz-dhead"><div><b>🎙️ Sala de voz</b><small id="svzDockSub">—</small></div>'
      + '<button class="svz-dmin" id="svzBMin" aria-label="Minimizar">—</button></div>'
      + '<div class="svz-grid" id="svzGrid"></div>'
      + '<div class="svz-ctrl">'
      + '<button class="svz-b sec" id="svzBMudar">🎤 Mudo</button>'
      + '<button class="svz-b sair" id="svzBSair">Sair</button>'
      + '</div>'
      + '<div class="svz-nota" id="svzNota"></div>'
      + '<div class="svz-conf" id="svzConf" role="alertdialog" aria-label="Confirmar saída da sala">'
      + '<div class="svz-confbox">'
      + '<div class="svz-conftit" id="svzConfTit">' + PERGUNTA_SAIR.tit + '</div>'
      + '<div class="svz-confsub" id="svzConfSub">' + PERGUNTA_SAIR.sub + '</div>'
      + '<div class="svz-confbtns">'
      + '<button class="svz-b sec" id="svzBFicar">Ficar</button>'
      + '<button class="svz-b sair" id="svzBSairSim">' + PERGUNTA_SAIR.ok + '</button>'
      + '</div></div></div>';
    document.body.appendChild(d);
    $('svzBMin').addEventListener('click', function () { d.classList.toggle('mini'); });
    $('svzBMudar').addEventListener('click', alternarMudo);
    $('svzBSair').addEventListener('click', abrirConfirmacaoSaida);
    $('svzBFicar').addEventListener('click', fecharConfirmacaoSaida);
    $('svzBSairSim').addEventListener('click', function () { sair(''); });
    ligarLacosConfirmacao();
  }

  // ── UI: confirmação de saída ──────────────────────────────────────────────
  // "Sair" saía na hora. O botão fica colado no "Mudo", num painel pequeno que
  // no celular ocupa a largura da tela — o toque errado é questão de tempo, e
  // sair não tem desfazer: cai o áudio e a vaga volta pra fila do limite de 10.
  // Confirmação INLINE, no vidro do próprio painel: confirm() do navegador
  // trava a thread (o áudio engasga), não combina com nada daqui e no iOS
  // aparece colado no topo, longe do dedo.
  //
  // A MESMA pergunta atende dois gatilhos, com textos diferentes: o botão Sair
  // e o clique num link que tira a pessoa da página (ver guarda de navegação,
  // mais abaixo). Um único painel de propósito — duas caixas parecidas em
  // momentos parecidos é como se ensina a clicar em "sim" sem ler.
  var lacosConfirmacao = false;
  var guardaNavegacao = false;
  var destinoPendente = null;   // link esperando o "continuar" da pessoa

  function confirmacaoAberta() {
    var c = $('svzConf');
    return !!(c && c.classList.contains('on'));
  }

  function textoConfirmacao(p) {
    var t = $('svzConfTit'); if (t) t.textContent = p.tit;
    var s = $('svzConfSub'); if (s) s.textContent = p.sub;
    var b = $('svzBSairSim'); if (b) b.textContent = p.ok;
  }

  function mostrarConfirmacao(p) {
    textoConfirmacao(p);
    // A pergunta é um inset:0 DENTRO do dock: com o dock minimizado ela teria
    // a altura do cabeçalho e sairia por cima de si mesma. Pelo botão Sair isso
    // nunca acontecia (ele some no mini), mas a pergunta de navegação nasce de
    // um clique lá fora e pega o painel do jeito que estiver. Abre o painel.
    var d = $('svzDock');
    if (d) d.classList.remove('mini');
    $('svzConf').classList.add('on');
    var b = $('svzBSairSim');
    if (b) { try { b.focus(); } catch (e) {} }   // Enter confirma, Esc desiste
  }

  function abrirConfirmacaoSaida() {
    var c = $('svzConf');
    // Painel antigo em cache sem a confirmação: sair continua funcionando. Um
    // botão de sair que não sai seria pior que sair sem perguntar.
    if (!c) { sair(''); return; }
    destinoPendente = null;          // esta pergunta não navega pra lugar nenhum
    mostrarConfirmacao(PERGUNTA_SAIR);
  }

  // Clicou num link que sai da página. Mesmo vidro, outra pergunta — e um
  // destino guardado: quem confirma cai no sair() de sempre (sala desligada,
  // microfone solto, dock fechado) e só DEPOIS a página troca.
  function abrirConfirmacaoNavegacao(destino) {
    destinoPendente = destino;
    var c = $('svzConf');
    // Sem painel (dock de um cache antigo) a navegação NÃO pode ficar refém: o
    // pior defeito possível aqui seria uma página que não deixa a pessoa sair.
    // Vai pelo sair() de sempre, que já sabe navegar no fim.
    if (!c) { sair(''); return; }
    mostrarConfirmacao(PERGUNTA_NAVEGAR);
  }

  function fecharConfirmacaoSaida() {
    destinoPendente = null;          // desistiu: o link some junto com a pergunta
    var c = $('svzConf');
    if (c) c.classList.remove('on');
  }

  // Esc e clique fora dispensam. A pergunta precisa sair da frente tão rápido
  // quanto entrou — senão ela deixa de ser proteção e vira pedágio.
  // Os laços moram no document e são ligados UMA vez: fecharDock() remove o
  // painel inteiro, e re-registrar a cada entrada empilharia listeners.
  function ligarLacosConfirmacao() {
    if (lacosConfirmacao) return;
    lacosConfirmacao = true;
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && confirmacaoAberta()) { e.preventDefault(); fecharConfirmacaoSaida(); }
    });
    // pointerdown em captura: fecha antes do clique chegar em qualquer coisa,
    // então encostar fora nunca aciona outra ação por engano.
    var foraEv = window.PointerEvent ? 'pointerdown' : 'mousedown';
    document.addEventListener(foraEv, function (e) {
      if (!confirmacaoAberta()) return;
      var c = $('svzConf');
      var caixa = c && c.querySelector('.svz-confbox');
      if (caixa && caixa.contains(e.target)) return;   // clicou em Ficar/Sair
      fecharConfirmacaoSaida();
    }, true);
  }

  // ── guarda de navegação ───────────────────────────────────────────────────
  // Estando NA SALA, clicar em qualquer link do site encerrava a conversa em
  // silêncio: a página trocava, a sala morria e os outros ficavam falando
  // sozinhos. São duas redes, e só uma delas é bonita:
  //
  //   (a) link do próprio site — dá pra interceptar ANTES de navegar e usar a
  //       mesma pergunta do painel. É este bloco.
  //   (b) fechar a aba / digitar outra URL — não existe clique pra interceptar;
  //       aí só sobra o beforeunload nativo (lá no fim do arquivo).
  //
  // REGRA das duas: elas só existem enquanto S.entrei. Fora da sala navegar não
  // pode custar um clique a mais — uma página que pergunta à toa é pior que o
  // defeito que ela conserta.

  function navegarPara(destino) {
    try { window.location.href = destino; } catch (e) {}
  }

  // A REGRA, separada do listener de propósito: assim ela é testável sem DOM
  // de verdade, e é ela quem carrega todos os casos em que perguntar seria
  // errado (âncora na própria página, nova aba, download, javascript:, ...).
  function saiDaPagina(a, e) {
    if (!a || !a.getAttribute) return false;
    // Ctrl/Cmd/Shift/Alt e botão do meio abrem OUTRA aba: esta página fica
    // viva, a sala continua, não há nada pra perguntar.
    if (e && (e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) return false;
    var alvo = a.getAttribute('target') || '';
    if (alvo && alvo !== '_self') return false;
    if (a.getAttribute('download') !== null) return false;
    var href = a.getAttribute('href') || '';
    if (!href) return false;
    if (href.charAt(0) === '#') return false;                       // só rola a página
    if (/^(javascript:|mailto:|tel:|sms:|blob:|data:)/i.test(href)) return false;
    // Link pra ESTA mesma página (só o #hash muda) não recarrega nada. Sem
    // isto, o menu interno da Comunidade viraria um interrogatório.
    try {
      var u = new URL(a.href || href, window.location.href);
      if (u.origin === window.location.origin
        && u.pathname === window.location.pathname
        && u.search === window.location.search) return false;
    } catch (err) {}
    return true;
  }

  function ligarGuardaDeNavegacao() {
    if (guardaNavegacao) return;
    guardaNavegacao = true;
    // Captura: a decisão vem ANTES de qualquer onclick da página, senão o
    // navegador já saiu enquanto a gente pensava.
    document.addEventListener('click', function (e) {
      if (!S.entrei) return;                 // fora da sala não se pergunta nada
      if (e.defaultPrevented) return;
      var alvo = e.target;
      var a = alvo && alvo.closest ? alvo.closest('a[href]') : null;
      if (!saiDaPagina(a, e)) return;
      e.preventDefault();
      e.stopPropagation();
      abrirConfirmacaoNavegacao(a.href);
    }, true);
  }

  function abrirDock() { montarDock(); fecharConfirmacaoSaida(); pintarSala(); }
  function fecharDock() { var d = $('svzDock'); if (d) d.remove(); }

  // Eu primeiro, depois por ordem de chegada — card não pula de lugar.
  function listaOrdenada() {
    var eu = (S.cfg && S.cfg.me && S.cfg.me.id) || '';
    return Array.from(S.pessoas.entries()).sort(function (a, b) {
      if (a[0] === eu) return -1;
      if (b[0] === eu) return 1;
      return (a[1].entrou - b[1].entrou) || (a[0] < b[0] ? -1 : 1);
    });
  }

  function pintarSala() {
    var d = $('svzDock');
    if (!d || !S.entrei) return;
    var n = contarPresentes();
    var falando = contarFalando();
    var sub = $('svzDockSub');
    if (sub) sub.textContent = n + (n === 1 ? ' pessoa' : ' pessoas') + ' • ' + falando + ' falando';
    var grid = $('svzGrid');
    if (grid) {
      var htm = '';
      listaOrdenada().forEach(function (e) { htm += cardHTML(e[0], e[1]); });
      grid.innerHTML = htm;
    }
    var bm = $('svzBMudar');
    if (bm) {
      bm.textContent = S.mudo ? '🔇 Desmutar' : '🎤 Mudo';
      bm.className = 'svz-b ' + (S.mudo ? 'mudo' : 'sec');
    }
    var nota = $('svzNota');
    if (nota) {
      var perdidos = 0, ruins = 0;
      S.qualidade.forEach(function (q, k) {
        if (!S.pessoas.has(k) || souEu(k)) return;
        if (q === 'lost') perdidos++;
        else if (q === 'poor') ruins++;
      });
      nota.textContent = S.conn === 'instavel' ? 'conexão instável — tentando voltar'
        : S.conn === 'erro' ? 'sala indisponível agora'
          : S.suspenso ? 'tela bloqueada — você continua na sala'
            : S.semMic ? 'você está só ouvindo — o microfone não abriu'
              : perdidos ? perdidos + ' pessoa(s) sem sinal agora (rede dela)'
                : ruins ? ruins + ' pessoa(s) com sinal oscilando — o áudio continua'
                  : (S.mudo ? 'seu microfone está desligado' : 'seu microfone está ligado');
    }
  }

  // Card: nome e foto vêm SEMPRE do crachá que o servidor assinou (identity,
  // name e metadata do LiveKit), escapados. Participante não recebe
  // canUpdateOwnMetadata, então ninguém reescreve quem é.
  function cardHTML(identity, pe) {
    // Registro faltando não pode virar tela quebrada: um card sem nome ainda é
    // melhor que a grade inteira sumir por causa de um `undefined`.
    pe = pe || { nome: '…', avatar: null, plano: 'full', mudo: false };
    var eu = !!pe.eu || souEu(identity);
    var q = S.qualidade.get(identity) || '';
    // 'lost' e 'poor' são a rede DELA, dita pelo SFU. O card marca, mas não
    // esconde ninguém: quem saiu sai por evento, não por palpite de qualidade.
    var caiu = !eu && q === 'lost';
    var oscila = !eu && q === 'poor';
    var titulo = caiu ? 'sem sinal dela agora'
      : oscila ? 'conexão dela oscilando — o áudio continua' : '';
    return '<div class="svz-p' + (S.falando.has(identity) ? ' falando' : '') + (caiu ? ' caiu' : '')
      + (oscila ? ' oscila' : '') + '" data-svz-card="' + esc(identity) + '"'
      + (titulo ? ' title="' + esc(titulo) + '"' : '') + '>'
      + avatarHTML(pe)
      + '<div class="svz-nome">' + esc(eu ? 'Você' : pe.nome) + '</div>'
      + (pe.mudo ? '<span class="svz-mic">🔇</span>' : '')
      + '</div>';
  }

  // Fala muda muitas vezes por minuto: só troca classe, não repinta a grade.
  function pintarFala() {
    var d = $('svzDock');
    if (!d) return;
    d.querySelectorAll('[data-svz-card]').forEach(function (el) {
      el.classList.toggle('falando', S.falando.has(el.getAttribute('data-svz-card')));
    });
    var n = contarPresentes();
    var sub = $('svzDockSub');
    if (sub) sub.textContent = n + (n === 1 ? ' pessoa' : ' pessoas') + ' • ' + contarFalando() + ' falando';
  }

  function pintar() {
    pintarEntrada();
    pintarModal();
    pintarSala();
  }

  // ── ligar ─────────────────────────────────────────────────────────────────
  function esperarAncoras() {
    if (injetar()) return;
    var tentativas = 0;
    var obs = new MutationObserver(function () {
      if (injetar() || ++tentativas > 80) obs.disconnect();
    });
    try { obs.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    setTimeout(function () { try { obs.disconnect(); } catch (e) {} }, 30000);
  }

  async function ligar() {
    // Portão do cliente: sem plano, sem sala — e nem chamada de contagem é
    // feita. O portão que vale é o do servidor (api/sala-voz.js), este aqui é
    // só pra não desenhar botão que a pessoa não pode usar.
    var cfg = await garantirConfig();
    if (!cfg) return;
    esperarAncoras();
    // Armada desde o carregamento, não desde a entrada na sala: ela mesma só
    // age quando S.entrei, e assim não existe janela entre "entrou" e "guarda
    // ligada" em que um clique escaparia.
    ligarGuardaDeNavegacao();
    atualizarContagem(true);
    ligarPolling();
  }

  // Aba escondida por muito tempo e fora da sala: para de perguntar. Dentro da
  // sala nada é desligado — sair da conversa porque trocou de aba seria péssimo.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (S.entrei) suspender();     // dentro da sala: só marca, continua na conversa
      else S.tIdle = setTimeout(pararPolling, 5 * 60 * 1000);
    } else {
      clearTimeout(S.tIdle);
      ligarPolling();
      if (S.suspenso || S.entrei) retomar();
      else atualizarContagem(true);
    }
  });

  // beforeunload é o ÚNICO sinal que só aparece em saída de verdade
  // (fechar/navegar). Ele nunca dispara quando a tela do celular apaga — é
  // justamente por isso que ele é quem autoriza a despedida (defeito 11).
  //
  // Ele acumulou um segundo papel: fechar a aba ou digitar outra URL não tem
  // clique pra interceptar, então a caixa nativa do navegador é a única rede
  // possível. Ela só aparece DENTRO da sala.
  //
  // E aí muda uma coisa importante: perguntar significa que a pessoa pode
  // responder "ficar". Por isso o despedir() sai daqui quando há pergunta —
  // desligar o microfone e a sala de quem escolheu FICAR seria trocar um
  // defeito por outro pior. Quem despede nesse caso é o 'pagehide' logo abaixo,
  // que só age depois deste sinal e que é justamente o guardião do defeito 11.
  window.addEventListener('beforeunload', function (e) {
    S.saindoDeVerdade = true;
    if (S.entrei) {
      e.preventDefault();
      // Navegador moderno ignora o texto e mostra o dele; o texto continua aqui
      // porque os antigos exigem uma string pra sequer abrir a caixa.
      e.returnValue = 'Você está na sala de voz. Sair encerra a conversa.';
    } else {
      despedir();
    }
    // Se a página continuar viva (a pessoa cancelou, download que não sai da
    // página), o sinal não pode ficar armado: senão o próximo bloqueio de tela
    // seria interpretado como saída de verdade.
    setTimeout(function () { S.saindoDeVerdade = false; }, 4000);
    if (S.entrei) return 'Você está na sala de voz. Sair encerra a conversa.';
  });

  // 'pagehide' é ambíguo: dispara ao fechar a aba E ao apagar a tela do
  // iPhone. Tratá-lo como saída deixava a sala inutilizável no celular — e é
  // exatamente o que o `disconnectOnPageLeave` do SDK faria se a gente não o
  // tivesse desligado. Aqui ele só despede se o beforeunload já tiver
  // confirmado a saída e a página não estiver indo pro bfcache; caso contrário
  // é suspensão, e o LiveKit reconecta sozinho na volta.
  window.addEventListener('pagehide', function (e) {
    if (S.saindoDeVerdade && !e.persisted) { despedir(); return; }
    suspender();
  });

  // Chrome/Android congela a aba de fundo pra poupar bateria. Congelado é
  // exatamente o mesmo caso da tela apagada: continua na sala.
  document.addEventListener('freeze', suspender);
  document.addEventListener('resume', function () { retomar(); });

  // Voltar pelo botão "voltar" restaura a página do cache (bfcache) com o
  // estado antigo. A sala do LiveKit não sobrevive a isso de forma confiável:
  // se ainda houver um Room pendurado, ele é desligado e a pessoa volta pra
  // tela de entrada — melhor sair avisando que ficar num painel que não fala
  // com ninguém.
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    S.saindoDeVerdade = false;
    if (S.entrei || S.sala) sair('A sala de voz foi encerrada quando você saiu da página.');
    else { atualizarContagem(true); pintar(); }
  });

  window.SalaVoz = {
    abrir: abrirModal, entrar: entrar, sair: sair, mudo: alternarMudo,
    _estado: function () { return S; },
    // Superfície de diagnóstico (irmã do _estado, que já existia): deixa o
    // console e os testes exercitarem a lista, a contagem e a casca sem
    // precisar de SFU, microfone e WebRTC de verdade. Nada aqui é usado pela UI.
    _interno: {
      contarPresentes: contarPresentes,
      contarFalando: contarFalando,
      contagemFresca: contagemFresca,
      atualizarContagem: atualizarContagem,
      sincronizar: sincronizar,
      dadosDe: dadosDe,
      checarLotacao: checarLotacao,
      ordemDeChegada: ordemDeChegada,
      ligarEventos: ligarEventos,
      listaOrdenada: listaOrdenada,
      garantirMicrofone: garantirMicrofone,
      suspender: suspender,
      retomar: retomar,
      despedir: despedir,
      cardHTML: cardHTML,
      saiDaPagina: saiDaPagina,
      abrirConfirmacaoNavegacao: abrirConfirmacaoNavegacao,
      fecharConfirmacao: fecharConfirmacaoSaida,
      destino: function () { return destinoPendente; },
      pintar: pintar,
      pararPolling: pararPolling,
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ligar);
  else ligar();
})();
