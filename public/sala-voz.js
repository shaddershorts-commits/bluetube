/* sala-voz.js — Sala de voz ao vivo da Comunidade BlueTube (2026-08-10)
 *
 * Uma sala só, sempre aberta, logo abaixo de Dicas. SÓ ÁUDIO. Teto de 10.
 *
 * ── Decisões que valem explicação ─────────────────────────────────────────
 *
 * 1) Arquivo próprio, igual ao blublu-suporte.js: não chama nenhuma função do
 *    comunidade.js. Bug aqui não derruba o feed. E script novo no meio de um
 *    HTML grande costuma ser engolido — por isso arquivo + <script src ?v=>.
 *
 * 2) Fica FORA do #cbtFeed. O render() do comunidade.js faz `f.innerHTML = h`
 *    a cada troca de aba: qualquer coisa dentro do feed evapora. A entrada é
 *    irmã das abas (mobile) e do item Dicas (desktop) — duas cópias, porque a
 *    barra de abas some no desktop (≥900px) e a lateral some no mobile. Uma
 *    âncora só deixaria metade dos aparelhos sem a sala.
 *
 * 3) Quem está na sala é a PRESENCE do Realtime, não uma tabela. Fechou a aba,
 *    caiu o socket, sumiu da sala — sem cron de faxina, sem contador fantasma.
 *    O untrack() imediato só sai quando a saída é CONFIRMADA (beforeunload);
 *    'pagehide' sozinho não vale, porque o iPhone dispara ele ao apagar a tela
 *    e ninguém pode ser expulso da conversa por bloquear o celular. Nos casos
 *    ambíguos quem limpa é o timeout do socket — o cinto de segurança.
 *
 * 4) O contador aparece ANTES de entrar porque a gente assina o canal em modo
 *    OBSERVADOR: subscribe sem track(). Quem só observa recebe os eventos de
 *    presença mas não aparece pra ninguém — e, principalmente, não pede
 *    microfone. Permissão de mic só depois que a pessoa confirma no modal.
 *
 * 5) Identidade NUNCA vem do payload do outro navegador. Canal broadcast é
 *    aberto: dá pra forjar. Cada participante anuncia só um TICKET assinado
 *    pelo servidor; o nome/foto/plano que aparecem no card vêm da resposta do
 *    /api/sala-voz?action=verificar. Ticket inválido = nem RTCPeerConnection
 *    a gente abre, então intruso não recebe áudio de ninguém.
 *
 * 6) Mesh P2P: cada um fala com cada um. Quem oferta é decidido por comparação
 *    de chave (a menor oferta) — sem isso, os dois lados ofertam ao mesmo tempo
 *    e a negociação colide. Nas chamadas 1:1 do app existe um "souCaller"
 *    booleano; em N pessoas isso não existe, e todo payload leva `to`.
 *
 * 7) Sem TURN de propósito (decisão do dono). STUN público resolve a maioria
 *    das redes domésticas; quem estiver atrás de NAT simétrico/corporativo pode
 *    não conectar — o card fica marcado como "sem conexão" em vez de mentir que
 *    está tudo certo.
 */
(function () {
  'use strict';
  if (window.SalaVoz) return;

  // ── constantes ────────────────────────────────────────────────────────────
  var API = '/api/sala-voz';
  // MESMA URL do support-chat.js de propósito: o bundle já está no cache do
  // navegador de quem passou pela home (immutable, 1 ano). Zero download novo.
  var SDK = 'https://esm.sh/@supabase/supabase-js@2.45.4?bundle';
  // Teto de gente. É fallback: o valor que vale vem do servidor (config.max),
  // pra não existir dois números discordando. Pra mudar o teto: api/sala-voz.js.
  var MAX = 10;
  var STUN = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  // Voz humana normal passa fácil disso; ruído de teclado/ventilador não.
  var LIMIAR_FALA = 0.045;
  // Segura o "falando" por meio segundo: sem isso a borda pisca entre sílabas.
  var SOLTURA_FALA = 550;
  // Renova o ticket 15min antes de vencer. Sem margem, o ticket vence no meio
  // de uma sincronização e a pessoa vira fantasma (aparece na lista, ninguém
  // abre áudio com ela, e ela nunca fica sabendo).
  var MARGEM_TICKET = 15 * 60 * 1000;
  // Teto de reconstruções por PAR. Vive fora do objeto do peer de propósito:
  // se morasse nele, todo criarPeer() nasceria zerado e o teto nunca chegaria.
  var MAX_TENTATIVAS = 3;
  // Teto de cutucadas ('opa') pro mesmo par. O else do vigia não tinha teto
  // nenhum: mandava 'opa' a cada 12s pra sempre.
  var MAX_OPAS = 6;
  // Uma reconstrução/cutucada por par a cada 12s, no máximo.
  var THROTTLE_PAR = 12000;
  // Sumiu da presence? Espera antes de matar o peer — reconexão de socket
  // devolve presence vazia por um instante (ver mesh()).
  var CARENCIA_SUMICO = 10000;
  // 'disconnected' costuma voltar sozinho. Espera antes de mexer.
  var ESPERA_DISCONNECTED = 6000;

  // ── estado ────────────────────────────────────────────────────────────────
  var S = {
    cfg: null, sb: null, canal: null, sub: 'off',   // off | ligando | on | erro
    sessao: null,          // chave desta ABA na presence (userId~aleatorio)
    entrei: false, mudo: false, entrando: false, dormindo: false,
    stream: null,
    entrouEm: 0,           // hora de entrada IMUTÁVEL enquanto a pessoa está na sala
    suspenso: false,       // aba congelada (tela do celular apagada) — NÃO é sair
    saindoDeVerdade: false,// beforeunload avisou que é navegação/fechamento real
    peers: new Map(),      // chave -> { pc, audio, g, desde, tDesc }
    presentes: new Map(),  // chave -> { ticket, mudo, entrou }
    ids: new Map(),        // ticket -> { id, nome, avatar, plano }  (verificado)
    ruins: new Map(),      // ticket -> quando falhou (não fica batendo na API)
    ofertasPend: new Map(),// offer que chegou antes da identidade
    iceP: new Map(),       // candidatos que chegaram antes do remoteDescription
    alo: new Map(),        // chave -> última cutucada do vigia
    tentativas: new Map(), // chave -> reconstruções já gastas (NÃO zera por mensagem do outro lado)
    opasEnviados: new Map(),// chave -> quantos 'opa' já mandamos
    opaRecebido: new Map(),// chave -> quando aceitamos o último 'opa' (throttle)
    semRota: new Set(),    // chave -> desistimos: rede não atravessa sem TURN
    sumido: new Map(),     // chave -> quando sumiu da presence (carência)
    ger: new Map(),        // chave -> geração da negociação (quem oferta numera)
    filaSdp: new Map(),    // chave -> promessa: serializa aoSdp por par
    audioCtx: null, medidores: new Map(), timerFala: null, falando: new Set(),
    tIdle: null, tVigia: null, tTicket: null,
    promessaConfig: null, promessaConexao: null, resolvendo: false,
    sincronizou: false, aguardandoSync: [],
    // Primeira sincronização depois de entrar não toca som: quem já estava na
    // sala não "acabou de chegar", e sem isto entrar numa sala com 6 pessoas
    // dispara 6 bipes de uma vez.
    silenciarDiff: true,
    // O ESTADO DO SERVIDOR me incluía na última sincronização? É diferente de
    // "eu estou em S.presentes": desde o conserto do "0 pessoas", eu me insiro
    // na lista local sempre, então S.presentes.has(S.sessao) virou constante e
    // parou de servir como sinal. Quem poda o mesh precisa do sinal ORIGINAL
    // (ver mesh()). Começa false = na dúvida, não poda ninguém.
    euNoServidor: false,
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
  // Segue os tokens da Comunidade: Syne em título, DM Mono em legenda, a receita
  // de vidro (glass + blur + a linha de luz no topo) dos .cbt-card.
  var CSS = ''
    + '.svz-entrada{display:flex;align-items:center;gap:12px;margin:0 16px 12px;padding:12px 14px;border-radius:16px;cursor:pointer;'
    + 'background:linear-gradient(135deg,rgba(0,170,255,.13),rgba(10,22,40,.52));border:1px solid rgba(0,170,255,.3);'
    + 'backdrop-filter:blur(24px) saturate(140%);-webkit-backdrop-filter:blur(24px) saturate(140%);'
    + 'box-shadow:0 8px 34px rgba(0,20,60,.22),inset 0 1px 0 rgba(255,255,255,.06);transition:all .2s}'
    + '.svz-entrada:hover{border-color:rgba(0,208,255,.55);box-shadow:0 0 32px rgba(0,208,255,.18),inset 0 1px 0 rgba(255,255,255,.09);transform:translateY(-1px)}'
    + '.svz-entrada.tem-gente{border-color:rgba(0,208,255,.5);box-shadow:0 0 26px rgba(0,208,255,.16),inset 0 1px 0 rgba(255,255,255,.07)}'
    + '.svz-ico{position:relative;width:40px;height:40px;flex:0 0 40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:19px;'
    + 'background:radial-gradient(circle at 50% 35%,rgba(0,208,255,.28),rgba(0,120,255,.07));border:1px solid rgba(0,208,255,.42)}'
    + '.svz-ponto{position:absolute;right:-1px;bottom:-1px;width:11px;height:11px;border-radius:50%;background:#00e0a4;border:2px solid #061224;opacity:0;transition:opacity .2s}'
    + '.svz-entrada.tem-gente .svz-ponto{opacity:1;animation:svzPulso 1.8s ease-in-out infinite}'
    + '@keyframes svzPulso{0%,100%{box-shadow:0 0 0 0 rgba(0,224,164,.55)}70%{box-shadow:0 0 0 7px rgba(0,224,164,0)}}'
    + '.svz-txt{flex:1;min-width:0}'
    + '.svz-tit{font-family:var(--font-display,Syne,sans-serif);font-weight:800;font-size:14.5px;color:#eaf6ff;line-height:1.2;letter-spacing:-.2px}'
    + '.svz-sub{font-family:var(--font-mono,monospace);font-size:10.5px;color:#8aa0bd;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.svz-entrada.tem-gente .svz-sub{color:#5fe3ff}'
    + '.svz-badge{flex:0 0 auto;min-width:24px;height:24px;padding:0 7px;border-radius:100px;display:none;align-items:center;justify-content:center;'
    + 'font-family:var(--font-mono,monospace);font-size:11.5px;font-weight:500;color:#02121f;background:linear-gradient(135deg,#00d0ff,#00a2ff)}'
    + '.svz-entrada.tem-gente .svz-badge{display:flex}'
    // a cópia da lateral só existe no desktop; a das abas, só no mobile
    + '@media(min-width:900px){.cbt-page .svz-em-abas{display:none}}'
    + '@media(max-width:899px){.svz-em-lateral{display:none}}'
    + '.svz-em-lateral{margin:8px 0 4px;padding:11px 12px}'

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
    + '.svz-p.caiu{opacity:.5}'
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

  // ── config + SDK ──────────────────────────────────────────────────────────
  // O ticket vem com prazo (api/sala-voz.js:51 — 12h). Antes ninguém lia esse
  // prazo: S.cfg era cacheado PRA SEMPRE e o ticket era emitido no load da
  // página, não na entrada. Aba aberta de manhã = ticket vencido à noite = a
  // pessoa entrava e virava fantasma silencioso (aparecia na lista da sala,
  // mas o `verificar` recusava o ticket dela e ninguém abria áudio).
  function ticketVivo(margem) {
    if (!S.cfg || !S.cfg.ticket) return false;
    var x = Number(S.cfg.expira_em || 0);
    if (!x) return true;    // servidor sem expira_em: não trava a sala por isso
    return Date.now() + (margem || 0) < x;
  }

  function garantirConfig(forcar) {
    // Cache só vale enquanto o ticket estiver LONGE de vencer.
    if (!forcar && S.cfg && ticketVivo(MARGEM_TICKET)) return Promise.resolve(S.cfg);
    if (!S.promessaConfig) {
      S.promessaConfig = api('config').then(function (r) {
        S.promessaConfig = null;
        // 401/403: sem login ou sem plano. A sala simplesmente não existe pra
        // essa pessoa — nada de botão decorativo que dá erro no clique.
        // Falha de rede numa RENOVAÇÃO não pode apagar um ticket ainda válido:
        // devolve o antigo enquanto ele ainda estiver de pé.
        if (!r.ok || !r.d || !r.d.ok) return ticketVivo(0) ? S.cfg : null;
        S.cfg = r.d;
        if (r.d.max) MAX = r.d.max;
        // Ticket novo = identidade nova a registrar. Sem isto, logo depois de
        // uma renovação eu voltava a ser um ticket desconhecido pro meu
        // próprio painel até o `verificar` responder.
        registrarMinhaIdentidade();
        return S.cfg;
      }).catch(function () {
        S.promessaConfig = null;
        return ticketVivo(0) ? S.cfg : null;
      });
    }
    return S.promessaConfig;
  }

  // Renovação em segundo plano pra quem fica horas na sala: sem isto o ticket
  // vence com a pessoa falando e quem chegar depois recusa o áudio dela.
  function ligarRenovacaoTicket() {
    if (S.tTicket) return;
    S.tTicket = setInterval(function () {
      if (!S.entrei || ticketVivo(MARGEM_TICKET)) return;
      var antigo = S.cfg && S.cfg.ticket;
      garantirConfig(true).then(function (cfg) {
        if (!S.entrei) return;
        if (!cfg || !ticketVivo(0)) {
          // Não dá pra continuar: ticket vencido = fantasma. Sai avisando, em
          // vez de deixar a pessoa achando que está sendo ouvida.
          sair('Sua sessão da Comunidade expirou. Entre na sala de novo.');
          return;
        }
        if (cfg.ticket !== antigo) anunciar();   // re-anuncia com o ticket novo
      });
    }, 5 * 60 * 1000);
  }

  function pararRenovacaoTicket() {
    if (S.tTicket) { clearInterval(S.tTicket); S.tTicket = null; }
  }

  var promessaSDK = null;
  function carregarSDK() {
    if (!promessaSDK) promessaSDK = import(SDK);
    return promessaSDK;
  }

  // ── canal ─────────────────────────────────────────────────────────────────
  function conectar() {
    if (S.canal) return Promise.resolve(S.canal);
    if (S.promessaConexao) return S.promessaConexao;
    S.sub = 'ligando';
    S.promessaConexao = (async function () {
      var cfg = await garantirConfig();
      if (!cfg) { S.sub = 'erro'; return null; }
      var mod = await carregarSDK();
      if (!S.sb) {
        S.sb = mod.createClient(cfg.supabase_url, cfg.anon_key, {
          auth: { persistSession: false, autoRefreshToken: false },
          // ICE chega em rajada; 10/s (padrão) engasga a negociação com 9 peers
          realtime: { params: { eventsPerSecond: 30 } },
        });
      }
      // Chave da presence = usuário + aleatório. Se fosse só o user_id, duas
      // abas da mesma pessoa colidiriam e a sinalização iria pro lugar errado.
      if (!S.sessao) S.sessao = cfg.me.id + '~' + Math.random().toString(36).slice(2, 8);

      var ch = S.sb.channel(cfg.canal, {
        config: { broadcast: { self: false }, presence: { key: S.sessao } },
      });
      ch.on('presence', { event: 'sync' }, sincronizar);
      ch.on('broadcast', { event: 'sdp' }, function (m) { aoSdp(m.payload); });
      ch.on('broadcast', { event: 'ice' }, function (m) { aoIce(m.payload); });
      ch.on('broadcast', { event: 'opa' }, function (m) { aoOpa(m.payload); });
      ch.subscribe(function (status) {
        if (status === 'SUBSCRIBED') {
          S.sub = 'on';
          // Reconexão: o socket voltou, mas a gente já estava na sala. Re-anuncia
          // presença, senão a pessoa fica ouvindo e ninguém a enxerga.
          // O ticket pode ter vencido enquanto o socket estava fora do ar —
          // por isso passa pelo garantirConfig antes de se anunciar de novo.
          if (S.entrei) garantirConfig().then(function () { anunciar(); });
          // NÃO chama sincronizar() aqui: logo depois do subscribe o
          // presenceState ainda vem vazio e isso zerava o contador e (antes da
          // carência do mesh) matava todos os peers. O evento 'sync' chega
          // sozinho em seguida, com o estado de verdade.
          //
          // MAS: numa sala VAZIA o 'sync' pode nunca chegar — não há estado de
          // presença pra sincronizar. Como entrar() esperava esse evento antes
          // de liberar, a PRIMEIRA pessoa nunca conseguia entrar, e a sala
          // ficava vazia pra sempre (impasse de origem, achado em 11/08).
          //
          // Estar SUBSCRIBED já é resposta suficiente: o estado do canal é
          // autoritativo a partir daqui, e "vazio" é um estado válido. Isso
          // libera o portão sem chamar sincronizar(), que continua sendo
          // trabalho do evento 'sync' quando ele existir.
          if (!S.sincronizou) {
            S.sincronizou = true;
            var fila = S.aguardandoSync.splice(0);
            for (var i = 0; i < fila.length; i++) { try { fila[i](); } catch (e) {} }
          }
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          S.sub = 'erro'; pintar();
        } else if (status === 'CLOSED') {
          S.sub = 'off';
        }
      });
      S.canal = ch;
      S.promessaConexao = null;
      return ch;
    })().catch(function () {
      // CDN do SDK fora do ar, socket bloqueado, o que for: a entrada passa a
      // dizer "sala indisponível agora" em vez de fingir que está tudo certo.
      S.promessaConexao = null; S.sub = 'erro'; pintar(); return null;
    });
    return S.promessaConexao;
  }

  // Desligar o canal em UM lugar só. Antes o pageshow(bfcache) fazia
  // `S.canal = null` sem remover: o canal antigo continuava pendurado no
  // cliente Supabase, recebendo broadcast e segurando socket, enquanto a
  // gente assinava um segundo canal por cima (canal órfão).
  function limparCanal() {
    try { if (S.sb && S.canal) S.sb.removeChannel(S.canal); } catch (e) {}
    S.canal = null; S.sub = 'off';
    S.sincronizou = false; S.aguardandoSync.length = 0;
  }

  function desconectarObservador() {
    if (S.entrei || !S.canal) return;   // dentro da sala nunca desliga
    limparCanal();
    S.dormindo = true;
    // Sem limpar a lista, a entrada ficava com o número de horas atrás e o
    // pontinho verde pulsando — anunciando gente que talvez nem esteja lá.
    S.presentes = new Map();
    pintar();
  }

  // Anúncio de presença: SEMPRE por aqui. `j` é a hora de entrada e é
  // IMUTÁVEL — antes cada track() (inclusive o de mutar) mandava Date.now(),
  // então quem mutava virava "o mais novo da sala" e era o primeiro escolhido
  // pelo desempate de sala cheia. Mutar não pode te expulsar.
  function anunciar() {
    if (!S.canal || !S.cfg || !S.cfg.ticket) return Promise.resolve(false);
    if (!S.entrouEm) S.entrouEm = Date.now();
    registrarMinhaIdentidade();
    var r;
    try {
      r = S.canal.track({ t: S.cfg.ticket, m: S.mudo ? 1 : 0, j: S.entrouEm });
    } catch (e) { return Promise.resolve(false); }
    // track() NÃO rejeita: devolve 'ok' | 'timed out' | 'error'. Por isso o
    // catch sozinho era código morto (dava pra "entrar" sem estar na presence).
    return Promise.resolve(r).then(function (res) { return res === 'ok'; }, function () { return false; });
  }

  // send() também devolve status em vez de rejeitar. O resultado era jogado
  // fora: broadcast é fire-and-forget e um pacote perdido deixava os dois
  // lados calados. Agora dá pra saber e reenviar.
  function enviar(evento, payload) {
    if (!S.canal) return Promise.resolve(false);
    var r;
    try { r = S.canal.send({ type: 'broadcast', event: evento, payload: payload }); } catch (e) { return Promise.resolve(false); }
    return Promise.resolve(r).then(function (res) { return res === 'ok'; }, function () { return false; });
  }

  // Reenvio curto pro que não tem quem peça de novo (ICE, offer/answer, opa).
  // `valido` corta a insistência quando a negociação já virou outra geração.
  function enviarFirme(evento, payload, valido) {
    var tent = 0;
    (function tenta() {
      enviar(evento, payload).then(function (ok) {
        if (ok || tent >= 2) return;
        if (valido && !valido()) return;
        tent++;
        setTimeout(tenta, 350 * tent);
      });
    })();
  }

  // ── presença ──────────────────────────────────────────────────────────────

  // Meu próprio registro na sala. Não depende de nada que venha da rede: o
  // ticket é o meu (assinado pelo servidor pra mim), o mudo é o meu botão e a
  // hora de entrada é a que eu mesmo marquei em entrar().
  function euPresenca() {
    return {
      ticket: (S.cfg && S.cfg.ticket) || '',
      mudo: !!S.mudo,
      entrou: S.entrouEm || Date.now(),
    };
  }

  // ⚠️ BUG DE PRODUÇÃO (11/08): o dono entrou na sala e o painel mostrou
  // "0 pessoas · 1 falando", sem card nenhum — nem o dele.
  //
  // Causa: quem preenchia S.presentes era SÓ o evento 'presence sync' do
  // Realtime. Na sala vazia esse evento não chega (não existe diferença de
  // estado pra sincronizar — é o mesmo impasse já anotado no subscribe, lá
  // resolvido só pro portão de entrada). Resultado: a pessoa fazia track(),
  // entrava de verdade, mas o mapa local continuava vazio pra sempre. Zero
  // cards, zero na contagem — e o medidor de fala, que roda em cima do
  // microfone e não da presence, dizia "1 falando".
  //
  // Conserto: minha presença eu conheço sem perguntar. Registro localmente e
  // deixo o 'sync' só confirmar/atualizar quando (e se) chegar. Regra do
  // pedido: a pessoa SEMPRE se vê e SEMPRE é contada.
  function garantirEuNaLista() {
    if (!S.entrei || !S.sessao) return false;
    var atual = S.presentes.get(S.sessao);
    var novo = euPresenca();
    if (atual && atual.ticket === novo.ticket && atual.mudo === novo.mudo && atual.entrou === novo.entrou) return false;
    S.presentes.set(S.sessao, novo);
    return true;
  }

  // Minha identidade também já está comigo: veio assinada em
  // /api/sala-voz?action=config junto com o ticket. Sem isto o meu card
  // dependia de uma ida à rede (`verificar`) só pra descobrir o meu próprio
  // nome — e se ela falhasse eu virava "…" ou, pior, ticket "recusado".
  function registrarMinhaIdentidade() {
    if (!S.cfg || !S.cfg.ticket || !S.cfg.me) return false;
    if (S.ids.has(S.cfg.ticket)) return false;
    S.ids.set(S.cfg.ticket, {
      id: S.cfg.me.id,
      nome: S.cfg.me.nome || 'criador',
      avatar: S.cfg.me.avatar || null,
      plano: S.cfg.me.mod ? 'mod' : (S.cfg.me.plano || 'full'),
    });
    S.ruins.delete(S.cfg.ticket);
    return true;
  }

  function sincronizar() {
    if (!S.canal) return;
    var st = {};
    try { st = S.canal.presenceState() || {}; } catch (e) { return; }
    var novos = new Map();
    Object.keys(st).forEach(function (k) {
      var m = (st[k] || [])[0];
      if (!m || !m.t) return;
      novos.set(k, { ticket: String(m.t), mudo: !!m.m, entrou: Number(m.j) || 0 });
    });
    // ⚠️ Lido AQUI, antes de qualquer remendo local. Depois do garantirEuNaLista()
    // esta pergunta não tem mais resposta honesta — eu sempre estarei lá.
    var euNoEstado = novos.has(S.sessao);
    if (S.entrei && !euNoEstado) {
      // Estou na sala e o estado não me inclui. Vazio = estado ainda não
      // chegou (acontece a cada reconexão de socket): ignora o estado, senão o
      // mesh começa a derrubar áudio de gente que não saiu. Mas AINDA ASSIM me
      // garanto na lista — o contador não pode zerar quem está com o microfone
      // aberto (era exatamente o "0 pessoas").
      if (!novos.size) { S.euNoServidor = false; if (garantirEuNaLista()) pintar(); return; }
      // Não-vazio sem mim = meu track sumiu de verdade (socket caiu e voltou).
      anunciar();
    }
    S.euNoServidor = euNoEstado;
    var antes = S.presentes;
    S.presentes = novos;
    garantirEuNaLista();
    S.dormindo = false;
    anunciarChegadasESaidas(antes);
    marcarSincronizado();
    resolverIdentidades();
    pintar();
    if (S.entrei) { checarLotacao(); mesh(); }
  }

  // Som de sala viva: alguém chegou / alguém saiu. Só dentro da sala — quem
  // está só olhando a entrada da Comunidade não pode ouvir bipe de uma sala em
  // que não entrou. O teto anti-rajada mora no som-notificacao.js, mas aqui
  // também vale só UM bipe por sincronização: 4 pessoas entrando no mesmo
  // 'sync' é um evento ("chegou gente"), não quatro.
  function anunciarChegadasESaidas(antes) {
    if (!S.entrei) { S.silenciarDiff = true; return; }
    if (S.silenciarDiff) { S.silenciarDiff = false; return; }
    var entrou = false, saiu = false;
    S.presentes.forEach(function (p, k) {
      if (k === S.sessao || antes.has(k)) return;
      if (!fantasma(p, k)) entrou = true;
    });
    antes.forEach(function (p, k) {
      if (k === S.sessao || S.presentes.has(k)) return;
      if (!fantasma(p, k)) saiu = true;
    });
    if (entrou) som('entrou');
    if (saiu) som('saiu');
  }

  function marcarSincronizado() {
    S.sincronizou = true;
    var fila = S.aguardandoSync.slice();
    S.aguardandoSync.length = 0;
    fila.forEach(function (f) { try { f(); } catch (e) {} });
  }

  // Espera o primeiro 'sync' antes de decidir qualquer coisa que dependa de
  // quem está na sala. Os dois portões da entrada (sala cheia / você já está
  // em outra aba) rodavam contra uma presence ainda VAZIA: davam sempre
  // "pode entrar", e o limite só era descoberto depois, expulsando alguém.
  function presencaPronta(ms) {
    if (S.sincronizou) return Promise.resolve(true);
    return new Promise(function (res) {
      var t = setTimeout(function () { res(false); }, ms || 3500);
      S.aguardandoSync.push(function () { clearTimeout(t); res(true); });
    });
  }

  // Ticket que o servidor recusou (vencido ou forjado). Não é participante:
  // não conta no total, não ocupa vaga e aparece marcado no painel — antes
  // entrava na conta como uma pessoa normal, muda e sem nenhuma marcação.
  //
  // EU NUNCA SOU FANTASMA. Meu ticket é o que o servidor acabou de assinar pra
  // mim; se ele vencer, quem trata é a renovação (ligarRenovacaoTicket), que me
  // TIRA da sala avisando. Deixar a regra genérica valer pra mim fazia uma
  // falha de rede no `verificar` me apagar do meu próprio painel — a pessoa com
  // o microfone aberto sumia da contagem e do card.
  function fantasma(pres, chave) {
    if (chave && chave === S.sessao) return false;
    return !!(pres && pres.ticket && !S.ids.has(pres.ticket) && S.ruins.has(pres.ticket));
  }

  function contarPresentes() {
    var n = 0;
    S.presentes.forEach(function (p, k) { if (!fantasma(p, k)) n++; });
    return n;
  }

  // "0 pessoas · 1 falando" não pode existir: falando é subconjunto de
  // presentes. S.falando é alimentado pelos MEDIDORES de áudio (microfone e
  // faixas remotas), que vivem em outro ciclo de vida — chave que já saiu da
  // presence, ou fantasma, ainda podia estar lá piscando. Aqui a contagem passa
  // a ser a interseção, então o segundo número nunca ultrapassa o primeiro.
  function contarFalando() {
    var n = 0;
    S.falando.forEach(function (k) {
      var p = S.presentes.get(k);
      if (p && !fantasma(p, k)) n++;
    });
    return n;
  }

  // Resolve no servidor quem é dono de cada ticket. Em lote: numa sala de 10
  // seriam 9 chamadas por sincronização; assim é uma só.
  function resolverIdentidades() {
    if (S.resolvendo) return;
    var agora = Date.now();
    var faltam = [];
    S.presentes.forEach(function (p) {
      if (!p.ticket || S.ids.has(p.ticket)) return;
      // Ticket que já voltou inválido (vencido/forjado) espera 60s pra ser
      // perguntado de novo — senão vira uma chamada por sincronização, pra
      // sempre, por causa de um único participante estranho.
      var falhou = S.ruins.get(p.ticket);
      if (falhou && agora - falhou < 60000) return;
      faltam.push(p.ticket);
    });
    if (!faltam.length) return;
    S.resolvendo = true;
    api('verificar', { tickets: faltam }).then(function (r) {
      S.resolvendo = false;
      if (!r.ok || !r.d || !r.d.pessoas) return;
      // O servidor agora diz QUAIS recusou. Marcar como ruim só por ausência
      // confunde "ticket vencido" com "resposta que veio pela metade" — e é a
      // marca de ruim que faz o fantasma aparecer sinalizado no painel.
      var recusados = Array.isArray(r.d.invalidos) ? r.d.invalidos : null;
      faltam.forEach(function (t) {
        if (r.d.pessoas[t]) { S.ids.set(t, r.d.pessoas[t]); S.ruins.delete(t); }
        else if (!recusados || recusados.indexOf(t) >= 0) S.ruins.set(t, Date.now());
      });
      pintar();
      if (S.entrei) mesh();
      // Chegou gente nova enquanto a gente resolvia? Resolve agora (o guarda
      // S.resolvendo faz o pedido do meio ser ignorado, não enfileirado).
      resolverIdentidades();
    }).catch(function () { S.resolvendo = false; });
  }

  // Sala cheia com corrida: todo mundo ordena igual (entrou, depois chave) e
  // quem ficou além do teto se retira sozinho. Sem isso, dois entrando no mesmo
  // segundo furariam o limite — e o certo é recusar, nunca deixar entrar e travar.
  function checarLotacao() {
    if (!S.entrei || contarPresentes() <= MAX) return;
    var ordem = Array.from(S.presentes.entries()).filter(function (e) {
      return !fantasma(e[1], e[0]);
    }).sort(function (a, b) {
      return (a[1].entrou - b[1].entrou) || (a[0] < b[0] ? -1 : 1);
    }).map(function (e) { return e[0]; });
    if (ordem.indexOf(S.sessao) >= MAX) {
      sair('A sala encheu bem na hora que você entrou (limite de ' + MAX + '). Tenta de novo em instantes.');
    }
  }

  // ── mesh WebRTC ───────────────────────────────────────────────────────────
  // Quem tem a chave "menor" oferta. Regra idêntica dos dois lados = nunca os
  // dois ofertam ao mesmo tempo (glare), sem precisar de perfect negotiation.
  function souOfertante(chave) { return String(S.sessao) < String(chave); }

  function mesh() {
    if (!S.entrei) return;
    S.presentes.forEach(function (p, k) {
      if (k === S.sessao) return;
      if (!S.ids.get(p.ticket)) return;            // identidade não confirmada: não conecta
      S.sumido.delete(k);
      if (S.semRota.has(k)) return;                // já desistimos desse par
      if (!S.peers.has(k) && souOfertante(k)) criarPeer(k, true);
    });
    // offers que chegaram antes da identidade
    S.ofertasPend.forEach(function (m, k) {
      var pres = S.presentes.get(k);
      if (pres && S.ids.get(pres.ticket)) { S.ofertasPend.delete(k); aoSdp(m); }
      else if (!pres) S.ofertasPend.delete(k);
    });
    // Quem saiu da presença sai do mesh — mas COM CARÊNCIA. Toda reconexão de
    // socket entrega presence vazia por um instante; sem carência isso
    // derrubava o áudio de TODO MUNDO a cada oscilação de rede, e a
    // reconstrução seguinte zerava os contadores de tentativa.
    // O sinal é "o SERVIDOR me viu", não "eu estou na minha própria lista".
    // Desde o conserto do "0 pessoas" eu me insiro em S.presentes sempre, então
    // ler daqui daria confiável=true até durante um socket flap — e a poda
    // derrubaria o áudio de quem não saiu, exatamente o que a carência evita.
    var confiavel = S.euNoServidor;
    var agora = Date.now();
    Array.from(S.peers.keys()).forEach(function (k) {
      if (S.presentes.has(k)) { S.sumido.delete(k); return; }
      if (!confiavel) return;                      // estado suspeito: não poda nada
      var t = S.sumido.get(k);
      if (!t) { S.sumido.set(k, agora); return; }
      if (agora - t < CARENCIA_SUMICO) return;
      destruirPeer(k);
      esquecerPar(k);
    });
    // Par que saiu sem nunca ter virado peer (ex.: eu era o lado que só
    // responde e ele nunca ofertou) deixava lixo em tentativas/semRota/ger
    // pra sempre. Varre pelas chaves, não pelos peers.
    if (confiavel) {
      [S.tentativas, S.opasEnviados, S.opaRecebido, S.ger, S.filaSdp, S.alo].forEach(function (mapa) {
        Array.from(mapa.keys()).forEach(function (k) {
          if (!S.presentes.has(k) && !S.peers.has(k)) mapa.delete(k);
        });
      });
      Array.from(S.semRota).forEach(function (k) {
        if (!S.presentes.has(k)) S.semRota.delete(k);
      });
    }
  }

  // Zera tudo que a gente guardava sobre um par que saiu de verdade.
  function esquecerPar(chave) {
    S.sumido.delete(chave);
    S.tentativas.delete(chave);
    S.opasEnviados.delete(chave);
    S.opaRecebido.delete(chave);
    S.semRota.delete(chave);
    S.alo.delete(chave);
    S.ger.delete(chave);
    S.filaSdp.delete(chave);
    S.ofertasPend.delete(chave);
  }

  // Geração da negociação. Quem OFERTA numera; quem responde copia o número
  // recebido. Sem isso, uma oferta antiga que chegava atrasada (ou o ICE de um
  // peer já destruído) era aplicada na conexão nova e a matava em silêncio.
  function proximaGeracao(chave) {
    var g = (S.ger.get(chave) || 0) + 1;
    S.ger.set(chave, g);
    return g;
  }

  function criarPeer(chave, ofertar, geracao) {
    var p = { pc: null, audio: null, desde: Date.now(), g: 0, tDesc: null };
    p.g = ofertar ? proximaGeracao(chave) : (geracao || S.ger.get(chave) || 1);
    if (!ofertar) S.ger.set(chave, p.g);
    var pc = new RTCPeerConnection({ iceServers: STUN, bundlePolicy: 'max-bundle' });
    p.pc = pc;
    S.peers.set(chave, p);
    if (S.stream) S.stream.getTracks().forEach(function (t) { pc.addTrack(t, S.stream); });
    pc.onicecandidate = function (e) {
      if (!e.candidate) return;
      var c = e.candidate.toJSON ? e.candidate.toJSON() : e.candidate;
      enviarFirme('ice', { to: chave, from: S.sessao, g: p.g, c: c }, function () {
        return S.peers.get(chave) === p;   // geração velha: para de insistir
      });
    };
    pc.ontrack = function (e) { anexarAudio(chave, e.streams && e.streams[0]); };
    pc.onconnectionstatechange = function () {
      var est = pc.connectionState;
      if (est === 'connected') {
        // Deu certo: o orçamento de tentativas volta pro cheio pra este par.
        S.tentativas.delete(chave);
        S.opasEnviados.delete(chave);
        S.semRota.delete(chave);
        if (p.tDesc) { clearTimeout(p.tDesc); p.tDesc = null; }
      } else if (est === 'disconnected') {
        // 'disconnected' quase sempre é oscilação (Wi-Fi↔4G, celular saindo do
        // bolso) e se recupera sozinho. Antes ele caía no mesmo caminho do
        // 'failed' e a negociação inteira era refeita por causa de 2s de rede
        // ruim. Espera, e se persistir tenta o barato: reiniciar o ICE.
        if (!p.tDesc) p.tDesc = setTimeout(function () {
          p.tDesc = null;
          if (S.peers.get(chave) !== p) return;
          if (pc.connectionState === 'disconnected') reiniciarIce(chave);
        }, ESPERA_DISCONNECTED);
      } else if (est === 'failed') {
        // Sem TURN, NAT simétrico não fecha: marca o card em vez de fingir.
        if (p.tDesc) { clearTimeout(p.tDesc); p.tDesc = null; }
        recuperar(chave);
      }
      pintarEstadoPeers();
    };
    if (ofertar) negociar(chave);
    return p;
  }

  async function negociar(chave) {
    var p = S.peers.get(chave);
    if (!p) return;
    try {
      var of = await p.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
      if (S.peers.get(chave) !== p) return;
      of.sdp = opusMono(of.sdp);
      await p.pc.setLocalDescription(of);
      if (S.peers.get(chave) !== p) return;
      enviarFirme('sdp', { to: chave, from: S.sessao, g: p.g, tipo: 'offer', sdp: p.pc.localDescription },
        function () { return S.peers.get(chave) === p; });
    } catch (e) {}
  }

  // Reinício de ICE: mantém a conexão (e a geração) de pé e só reconstrói o
  // caminho de rede. É o passo do meio que faltava entre "espera" e "derruba".
  async function reiniciarIce(chave) {
    var p = S.peers.get(chave);
    if (!p || !p.pc) return;
    if (!souOfertante(chave)) { pedirOpa(chave); return; }   // quem não oferta, cutuca
    if (p.pc.signalingState !== 'stable') return;
    try {
      var of = await p.pc.createOffer({ iceRestart: true });
      if (S.peers.get(chave) !== p) return;
      of.sdp = opusMono(of.sdp);
      await p.pc.setLocalDescription(of);
      if (S.peers.get(chave) !== p) return;
      enviarFirme('sdp', { to: chave, from: S.sessao, g: p.g, tipo: 'offer', sdp: p.pc.localDescription },
        function () { return S.peers.get(chave) === p; });
    } catch (e) { recuperar(chave); }
  }

  // Reconstrói a conexão gastando UMA tentativa do orçamento do par. O
  // orçamento mora em S.tentativas (fora do objeto do peer): antes ele morava
  // no peer, então todo criarPeer() nascia com tentativas:0 e o teto nunca era
  // alcançado — rede sem rota virava rebuild eterno a cada 12s.
  function recuperar(chave) {
    if (!S.presentes.has(chave)) return;
    var t = S.tentativas.get(chave) || 0;
    if (t >= MAX_TENTATIVAS) {
      S.semRota.add(chave);      // desistiu: a nota do painel para de piscar
      destruirPeer(chave);
      pintarSala();
      return;
    }
    S.tentativas.set(chave, t + 1);
    destruirPeer(chave);
    if (souOfertante(chave)) criarPeer(chave, true);
    else pedirOpa(chave);        // sem oferta minha pra fazer: peço a dele
  }

  function destruirPeer(chave) {
    var p = S.peers.get(chave);
    if (!p) return;
    if (p.tDesc) { try { clearTimeout(p.tDesc); } catch (e) {} p.tDesc = null; }
    try { p.pc.onicecandidate = null; p.pc.ontrack = null; p.pc.onconnectionstatechange = null; p.pc.close(); } catch (e) {}
    if (p.audio) { try { p.audio.srcObject = null; p.audio.remove(); } catch (e) {} }
    pararMedidor(chave);
    S.peers.delete(chave);
    S.iceP.delete(chave);
    S.falando.delete(chave);
  }

  // aoSdp é assíncrono e mexe em máquina de estado: duas mensagens do MESMO
  // par chegando juntas (offer + ice restart, ou offer reenviada) entravam em
  // paralelo e se atropelavam no setRemoteDescription. Uma fila por par
  // resolve — e é por par, não global, pra um peer lento não travar os outros.
  function aoSdp(m) {
    if (!m || m.to !== S.sessao || !m.from || !m.sdp) return;
    var k = m.from;
    var fila = S.filaSdp.get(k) || Promise.resolve();
    var prox = fila.then(function () { return tratarSdp(m); }).catch(function () {});
    S.filaSdp.set(k, prox);
  }

  async function tratarSdp(m) {
    if (!S.entrei) return;                        // observador não negocia áudio
    var pres = S.presentes.get(m.from);
    if (!pres || !S.ids.get(pres.ticket)) {
      // Ninguém entra no mesh sem ticket verificado. Guarda a offer: se a
      // presença confirmar essa pessoa daqui a pouco, a gente responde.
      if (m.tipo === 'offer') S.ofertasPend.set(m.from, m);
      return;
    }
    var g = Number(m.g) || 0;
    try {
      var p = S.peers.get(m.from);
      if (m.tipo === 'offer') {
        // Quem oferta é decidido por comparação de chave e é sempre o mesmo
        // lado. Oferta vinda de quem eu OFERTO é atraso/ruído — aplicá-la
        // colidiria com a minha própria negociação (glare).
        if (souOfertante(m.from)) return;
        var atual = S.ger.get(m.from) || 0;
        if (g && g < atual) return;                        // oferta atrasada de geração morta
        if (p && g && g > p.g) { destruirPeer(m.from); p = null; }   // ele recomeçou: acompanha
        if (!p) p = criarPeer(m.from, false, g || undefined);
        if (p.pc.signalingState !== 'stable' && p.pc.signalingState !== 'have-remote-offer') return;
        await p.pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
        if (S.peers.get(m.from) !== p) return;
        var ans = await p.pc.createAnswer();
        ans.sdp = opusMono(ans.sdp);
        await p.pc.setLocalDescription(ans);
        if (S.peers.get(m.from) !== p) return;
        enviarFirme('sdp', { to: m.from, from: S.sessao, g: p.g, tipo: 'answer', sdp: p.pc.localDescription },
          function () { return S.peers.get(m.from) === p; });
        drenarIce(m.from);
      } else if (m.tipo === 'answer' && p && p.pc.signalingState === 'have-local-offer') {
        if (g && g !== p.g) return;                        // resposta de uma oferta que já morreu
        await p.pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
        drenarIce(m.from);
      }
    } catch (e) {}
  }

  function aoIce(m) {
    if (!m || m.to !== S.sessao || !m.from || !m.c) return;
    var p = S.peers.get(m.from);
    var g = Number(m.g) || 0;
    // Candidato antes do remoteDescription é erro garantido — mesma fila que o
    // app usa nas chamadas 1:1 (pendingIce). A geração viaja junto pra um
    // candidato velho não ser drenado dentro de uma conexão nova.
    if (!p || !p.pc.remoteDescription) {
      var b = S.iceP.get(m.from) || [];
      if (b.length < 60) b.push({ c: m.c, g: g });
      S.iceP.set(m.from, b);
      return;
    }
    if (g && g !== p.g) return;
    try { p.pc.addIceCandidate(new RTCIceCandidate(m.c)).catch(function () {}); } catch (e) {}
  }

  // "opa": alguém que esperava minha oferta cansou de esperar. Broadcast é
  // fire-and-forget — não tem entrega garantida —, então um pacote perdido
  // deixaria os dois calados pra sempre achando que o outro ia falar.
  function aoOpa(m) {
    if (!m || m.to !== S.sessao || !m.from || !S.entrei) return;
    if (!souOfertante(m.from)) return;
    var pres = S.presentes.get(m.from);
    if (!pres || !S.ids.get(pres.ticket)) return;
    // Throttle: sem ele, cada 'opa' recebido reconstruía o peer na hora. Como
    // o contador de tentativas ficava DENTRO do peer, o rebuild o zerava — o
    // teto nunca chegava e os dois lados ficavam em rebuild eterno a cada 12s,
    // com a nota "sem conexão direta" piscando e sumindo justo quando era
    // preciso mostrá-la.
    var agora = Date.now();
    var ultimo = S.opaRecebido.get(m.from) || 0;
    if (agora - ultimo < THROTTLE_PAR) return;
    S.opaRecebido.set(m.from, agora);

    var p = S.peers.get(m.from);
    if (p && conectado(p)) {
      // Eu me acho conectado e ele não me ouve: reinicia o ICE (barato, não
      // gasta tentativa) em vez de derrubar uma conexão possivelmente boa.
      reiniciarIce(m.from);
      return;
    }
    // O teto é MEU e não pode ser zerado por mensagem do outro lado.
    var t = S.tentativas.get(m.from) || 0;
    if (t >= MAX_TENTATIVAS) { S.semRota.add(m.from); pintarSala(); return; }
    S.tentativas.set(m.from, t + 1);
    if (p) destruirPeer(m.from);
    criarPeer(m.from, true);
  }

  // Cutucada com teto próprio: o else do vigia mandava 'opa' pra sempre.
  function pedirOpa(chave) {
    var n = S.opasEnviados.get(chave) || 0;
    if (n >= MAX_OPAS) { S.semRota.add(chave); pintarSala(); return; }
    S.opasEnviados.set(chave, n + 1);
    enviarFirme('opa', { to: chave, from: S.sessao }, function () {
      return S.presentes.has(chave) && !S.semRota.has(chave);
    });
  }

  function conectado(p) {
    var e = p && p.pc && p.pc.connectionState;
    return e === 'connected' || e === 'completed';
  }

  // Vigia: a cada 8s procura par presente que não fechou conexão. Quem oferta
  // refaz a oferta; quem espera cutuca. Teto de tentativas pra não virar loop
  // em rede que simplesmente não atravessa sem TURN.
  function ligarVigia() {
    if (S.tVigia) return;
    S.tVigia = setInterval(function () {
      if (!S.entrei || S.suspenso) return;
      // Rede voltou mas o canal não: sem isto a pessoa ficaria na sala com o
      // socket morto, sem nada tentando reassinar.
      if (!S.canal && S.cfg) { conectar(); return; }
      mesh();      // também é aqui que a carência do sumiço vence
      var agora = Date.now();
      S.presentes.forEach(function (pres, k) {
        if (k === S.sessao || !S.ids.get(pres.ticket)) return;
        if (S.semRota.has(k)) return;                         // desistimos: nota fica estável
        var p = S.peers.get(k);
        if (p && conectado(p)) return;
        if (p && p.pc.connectionState === 'disconnected') return;  // o temporizador do restart cuida
        if (p && agora - p.desde < 12000) return;             // ainda negociando
        var ultimo = S.alo.get(k) || 0;
        if (agora - ultimo < THROTTLE_PAR) return;
        S.alo.set(k, agora);
        var t = S.tentativas.get(k) || 0;
        if (souOfertante(k)) {
          if (t >= MAX_TENTATIVAS) { S.semRota.add(k); pintarSala(); return; }
          S.tentativas.set(k, t + 1);
          if (p) destruirPeer(k);
          criarPeer(k, true);
        } else {
          pedirOpa(k);
        }
      });
    }, 8000);
  }

  function pararVigia() {
    if (S.tVigia) { clearInterval(S.tVigia); S.tVigia = null; }
    S.alo.clear();
    S.tentativas.clear();
    S.opasEnviados.clear();
    S.opaRecebido.clear();
    S.semRota.clear();
    S.sumido.clear();
    S.ger.clear();
    S.filaSdp.clear();
  }

  function drenarIce(chave) {
    var b = S.iceP.get(chave);
    var p = S.peers.get(chave);
    if (!b || !p) return;
    S.iceP.delete(chave);
    b.forEach(function (item) {
      var c = item && item.c ? item.c : item;
      var g = item && item.g;
      if (g && g !== p.g) return;      // candidato de uma geração já enterrada
      try { p.pc.addIceCandidate(new RTCIceCandidate(c)).catch(function () {}); } catch (e) {}
    });
  }

  // Opus mono + DTX. Mono porque voz não precisa de estéreo (metade do bitrate
  // por peer, e com 9 peers isso é o que segura o celular). DTX faz o encoder
  // calar quando ninguém fala. FEC ajuda em rede ruim.
  function opusMono(sdp) {
    try {
      var pt = (sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i) || [])[1];
      if (!pt) return sdp;
      var extras = 'stereo=0;sprop-stereo=0;usedtx=1;useinbandfec=1;maxaveragebitrate=24000';
      var linhas = sdp.split(/\r\n|\n/);
      var achou = false;
      for (var i = 0; i < linhas.length; i++) {
        if (linhas[i].indexOf('a=fmtp:' + pt + ' ') === 0) {
          achou = true;
          if (linhas[i].indexOf('usedtx') === -1) linhas[i] = linhas[i] + ';' + extras;
        }
      }
      if (!achou) {
        for (var j = 0; j < linhas.length; j++) {
          if (linhas[j].indexOf('a=rtpmap:' + pt + ' ') === 0) {
            linhas.splice(j + 1, 0, 'a=fmtp:' + pt + ' ' + extras);
            break;
          }
        }
      }
      return linhas.join('\r\n');
    } catch (e) { return sdp; }
  }

  // ── áudio que chega ───────────────────────────────────────────────────────
  function anexarAudio(chave, stream) {
    var p = S.peers.get(chave);
    if (!p || !stream) return;
    if (!p.audio) {
      var a = document.createElement('audio');
      a.autoplay = true;
      a.setAttribute('playsinline', '');
      a.style.display = 'none';
      (document.body || document.documentElement).appendChild(a);
      p.audio = a;
    }
    p.audio.srcObject = stream;
    var pr = p.audio.play();
    if (pr && pr.catch) pr.catch(function () { aviso('Toque na tela pra liberar o áudio da sala.'); });
    // Chrome só faz o áudio remoto fluir se o stream estiver preso num elemento
    // <audio> — por isso o medidor vem DEPOIS de anexar, nunca antes.
    medir(chave, stream);
  }

  // ── medidor de fala ───────────────────────────────────────────────────────
  function ctxAudio() {
    if (!S.audioCtx) {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      try { S.audioCtx = new C(); } catch (e) { return null; }
    }
    if (S.audioCtx.state === 'suspended') { try { S.audioCtx.resume(); } catch (e) {} }
    return S.audioCtx;
  }

  function medir(chave, stream) {
    var c = ctxAudio();
    if (!c || !stream) return;
    pararMedidor(chave);
    try {
      var src = c.createMediaStreamSource(stream);
      var an = c.createAnalyser();
      an.fftSize = 512; an.smoothingTimeConstant = 0.35;
      src.connect(an);
      S.medidores.set(chave, { an: an, src: src, buf: new Uint8Array(an.fftSize), ate: 0 });
      ligarLoopFala();
    } catch (e) {}
  }

  function pararMedidor(chave) {
    var m = S.medidores.get(chave);
    if (!m) return;
    try { m.src.disconnect(); } catch (e) {}
    S.medidores.delete(chave);
  }

  function pararMedidores() {
    Array.from(S.medidores.keys()).forEach(pararMedidor);
    if (S.timerFala) { clearInterval(S.timerFala); S.timerFala = null; }
    S.falando.clear();
    if (S.audioCtx) { try { S.audioCtx.close(); } catch (e) {} S.audioCtx = null; }
  }

  // Um timer só pra todo mundo (10 rAF paralelos seria desperdício de bateria).
  function ligarLoopFala() {
    if (S.timerFala) return;
    S.timerFala = setInterval(function () {
      var mudou = false, agora = Date.now();
      S.medidores.forEach(function (m, k) {
        try { m.an.getByteTimeDomainData(m.buf); } catch (e) { return; }
        var soma = 0;
        for (var i = 0; i < m.buf.length; i++) { var v = (m.buf[i] - 128) / 128; soma += v * v; }
        var rms = Math.sqrt(soma / m.buf.length);
        if (rms > LIMIAR_FALA) m.ate = agora + SOLTURA_FALA;
        var fala = agora < m.ate && !(k === S.sessao && S.mudo);
        if (fala !== S.falando.has(k)) {
          mudou = true;
          if (fala) S.falando.add(k); else S.falando.delete(k);
        }
      });
      if (mudou) pintarFala();
    }, 130);
  }

  function medirLocal() {
    if (S.stream) medir(S.sessao, S.stream);
  }

  // ── entrar / sair ─────────────────────────────────────────────────────────
  async function entrar(mudo) {
    if (S.entrei || S.entrando) return;
    if (!window.RTCPeerConnection) { erroModal('Este navegador não fala WebRTC. Use Chrome, Edge, Firefox ou Safari atualizado.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      erroModal('Seu navegador não libera o microfone aqui. Abra o site em https e sem modo restrito.');
      return;
    }
    S.entrando = true; pintarModal();

    await conectar();
    if (!S.canal || S.sub === 'erro') {
      S.entrando = false; erroModal('Não consegui conectar na sala. Confere a internet e tenta de novo.'); return;
    }

    // O ticket é emitido no LOAD da página, não aqui. Aba aberta há horas
    // carrega um ticket vencido — e entrar com ele fazia a pessoa virar
    // fantasma: aparecia na lista pros outros e ninguém abria áudio com ela,
    // sem nenhum aviso. Renova antes de entrar; se não der, não entra.
    await garantirConfig();
    if (!S.cfg || !ticketVivo(60000)) {
      S.entrando = false;
      erroModal('Sua sessão da Comunidade expirou. Atualize a página (F5) e entre de novo.');
      pintarModal();
      return;
    }

    // Espera o primeiro 'sync' antes dos portões: sem isso os dois rodavam
    // contra uma presence vazia e liberavam sempre — o limite só aparecia
    // depois, expulsando alguém que já tinha entrado.
    await presencaPronta(3500);
    if (!S.sincronizou) {
      S.entrando = false;
      erroModal('Não consegui ver quem está na sala agora. Tenta de novo em instantes.');
      pintarModal();
      return;
    }

    if (contarPresentes() >= MAX) {
      S.entrando = false;
      erroModal('A sala está cheia (' + MAX + ' pessoas). Assim que alguém sair, o botão libera.');
      pintarModal();
      return;
    }
    // Mesma pessoa em duas abas = ela se ouve e aparece duas vezes. Bloqueia.
    var jaEstou = false;
    S.presentes.forEach(function (p, k) {
      if (k !== S.sessao && k.split('~')[0] === S.cfg.me.id) jaEstou = true;
    });
    if (jaEstou) { S.entrando = false; erroModal('Você já está nesta sala em outra aba.'); return; }

    // ── Só AGORA pede microfone: depois do "sim" da pessoa, nunca antes. ──
    try {
      S.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,   // sem isso a sala vira microfonia na hora
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,          // voz é mono; estéreo só dobra o upload
        },
        video: false,
      });
    } catch (e) {
      S.entrando = false;
      var nome = (e && e.name) || '';
      var msg = 'Não consegui abrir o microfone.';
      if (nome === 'NotAllowedError' || nome === 'SecurityError') msg = 'Você bloqueou o microfone. Libere no cadeado da barra de endereço e tente de novo.';
      else if (nome === 'NotFoundError' || nome === 'OverconstrainedError') msg = 'Nenhum microfone encontrado neste aparelho.';
      else if (nome === 'NotReadableError') msg = 'Outro programa está usando o microfone. Feche e tente de novo.';
      erroModal(msg);
      pintarModal();
      return;
    }

    // Entrar mudo NÃO é entrar sem microfone: a gente captura e desliga a
    // faixa. Assim o "desmudar" é instantâneo, sem renegociar com 9 peers.
    S.mudo = !!mudo;
    S.stream.getAudioTracks().forEach(function (t) { t.enabled = !S.mudo; });
    S.entrouEm = Date.now();      // a partir daqui é imutável (ver anunciar())

    // Antes isto era `try { await track() } catch`: como track() devolve
    // 'error' em vez de rejeitar, o catch era código morto e dava pra "entrar"
    // na sala sem estar na presence — microfone aberto, ninguém te vendo.
    // `S.entrei` só vira true DEPOIS do 'ok': enquanto o anúncio não fecha, a
    // gente ainda é observador e não abre áudio com ninguém.
    var ok = await anunciar();
    S.entrando = false;
    if (!ok) {
      S.entrouEm = 0;
      pararMicrofone();
      erroModal('Falhou ao anunciar sua entrada. Tenta de novo.');
      pintarModal();
      return;
    }
    S.entrei = true;
    // Entro na lista AQUI, não quando o Realtime resolver me contar. Era este o
    // buraco do "0 pessoas · 1 falando": na sala vazia o 'sync' nunca chega e a
    // pessoa nunca aparecia pra si mesma.
    registrarMinhaIdentidade();
    garantirEuNaLista();
    // A próxima sincronização é a foto de quem JÁ estava aqui: não é chegada.
    S.silenciarDiff = true;
    // Ainda não houve sync NESTA sessão: o servidor não me confirmou. Sem
    // zerar, um "confiável" herdado da sessão anterior deixaria o mesh podar
    // com base num estado que não é mais deste ingresso.
    S.euNoServidor = false;
    medirLocal();
    ligarVigia();
    ligarRenovacaoTicket();
    fecharModal();
    abrirDock();
    pintar();
    som('entrou');
  }

  // Depois de um congelamento longo (tela do celular apagada, aba no bfcache)
  // a faixa de áudio pode voltar morta ('ended'). Sem isto a pessoa continua
  // na sala achando que fala, e ninguém ouve nada.
  async function garantirMicrofone() {
    var vivo = !!(S.stream && S.stream.getAudioTracks().some(function (t) { return t.readyState === 'live'; }));
    if (vivo) return true;
    if (S.stream) pararMicrofone();
    try {
      S.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      });
    } catch (e) { return false; }
    S.stream.getAudioTracks().forEach(function (t) { t.enabled = !S.mudo; });
    // Troca a faixa nos peers já abertos: replaceTrack não renegocia, então
    // recuperar o microfone não custa uma rodada de SDP com 9 pessoas.
    var faixa = S.stream.getAudioTracks()[0];
    if (faixa) {
      S.peers.forEach(function (p) {
        try {
          var s = p.pc.getSenders().filter(function (x) { return x.track && x.track.kind === 'audio'; })[0];
          if (s) s.replaceTrack(faixa);
        } catch (e) {}
      });
    }
    medirLocal();
    return true;
  }

  function pararMicrofone() {
    if (!S.stream) return;
    // Solta o mic de verdade: sem isso a luzinha do aparelho fica acesa e
    // (com razão) a pessoa acha que continua sendo ouvida.
    S.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    S.stream = null;
  }

  function sair(motivo) {
    if (S.entrei) {
      S.entrei = false;
      S.entrouEm = 0;
      try { S.canal && S.canal.untrack(); } catch (e) {}
      Array.from(S.peers.keys()).forEach(destruirPeer);
      S.ofertasPend.clear(); S.iceP.clear();
      pararVigia();
      pararRenovacaoTicket();
      pararMicrofone();
      pararMedidores();
      // Saí: some da minha própria lista na hora. Se ficasse esperando o
      // 'sync', a entrada continuaria dizendo "você está na sala".
      S.presentes.delete(S.sessao);
      som('saiu');
      // A chave de presença MORRE junto com a sessão. Ela era criada uma vez
      // e reusada pra sempre — então, ao entrar de novo, a pessoa tentava se
      // anunciar com uma chave que o servidor ainda tinha registrada da vez
      // anterior, e o track() falhava com "Falhou ao anunciar sua entrada".
      // Batia com o sintoma: as primeiras entradas passavam, e depois de
      // algumas idas e vindas parava de funcionar (achado em 11/08).
      // Zerar aqui faz a próxima entrada nascer com chave nova e limpa.
      S.sessao = null;
      limparCanal();
    }
    S.mudo = false;
    S.suspenso = false;
    S.silenciarDiff = true;
    S.euNoServidor = false;
    fecharConfirmacaoSaida();
    fecharDock();
    pintar();
    if (motivo) aviso(motivo);
  }

  function alternarMudo() {
    if (!S.entrei || !S.stream) return;
    S.mudo = !S.mudo;
    S.stream.getAudioTracks().forEach(function (t) { t.enabled = !S.mudo; });
    // Avisa os outros pelo próprio presence (é o canal natural do estado).
    // Vai por anunciar() de propósito: aqui o track() mandava `j: Date.now()`,
    // ou seja, mutar reescrevia a hora de entrada. Quem mutava virava o mais
    // recente da sala e era exatamente quem o desempate de sala cheia expulsa.
    anunciar();
    if (S.mudo) S.falando.delete(S.sessao);
    garantirEuNaLista();   // meu registro local carrega o mudo novo
    pintar();
  }

  // ── despedida x suspensão ─────────────────────────────────────────────────
  // Saiu de verdade (fechou/navegou): untrack imediato + microfone solto. O
  // timeout do socket resolveria sozinho, mas demora — e contador fantasma faz
  // a sala parecer cheia quando está vazia (e vazia quando está cheia).
  function despedir() {
    try { if (S.entrei && S.canal) S.canal.untrack(); } catch (e) {}
    pararMicrofone();
    try { if (S.sb && S.canal) S.sb.removeChannel(S.canal); } catch (e) {}
  }

  // Aba escondida/congelada NÃO é saída. No iOS, apagar a tela do celular
  // dispara 'pagehide' igualzinho a fechar a aba — e como o despedir() era
  // ligado direto nele, bastava a tela apagar (ou o telefone tocar, ou trocar
  // de app) pra pessoa cair da conversa. Numa sala de voz isso é o uso normal:
  // ninguém fica olhando a tela enquanto conversa. Aqui a gente só marca o
  // estado; nada de untrack, nada de soltar o microfone.
  function suspender() {
    if (S.suspenso) return;
    S.suspenso = true;
  }

  // Voltou (destravou a tela, 'resume', bfcache, troca de aba). O socket pode
  // ter morrido congelado: reassina, revalida o ticket e se re-anuncia com a
  // MESMA hora de entrada, pra não perder a vez no desempate de sala cheia.
  var retomando = false;
  async function retomar() {
    S.suspenso = false;
    if (!S.entrei) {
      if (!S.canal && S.cfg) conectar();
      pintar();
      return;
    }
    if (retomando) return;
    retomando = true;
    try {
      if (!S.canal || S.sub !== 'on') { limparCanal(); await conectar(); }
      if (!S.canal) { aviso('Reconectando você na sala…'); return; }
      await garantirConfig();
      // Ticket morto é o único caso em que ficar é pior que sair: a pessoa
      // estaria na lista dos outros sem que ninguém abrisse áudio com ela.
      if (!ticketVivo(0)) { sair('Sua sessão expirou enquanto o aparelho estava bloqueado. Entre na sala de novo.'); return; }
      if (!(await garantirMicrofone())) { sair('O microfone foi liberado enquanto a tela estava apagada. Entre na sala de novo.'); return; }
      // Re-anúncio que não passou é transitório: quem conserta é o próximo
      // 'sync' (ele re-anuncia quem não se vê no estado). Derrubar aqui seria
      // repetir o defeito que este conserto existe pra matar — expulsar quem
      // só desbloqueou a tela.
      if (!(await anunciar())) aviso('Reconectando você na sala…');
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
    // Sem canal a contagem é passado, não presente: zera. Antes o badge ficava
    // congelado com o número de horas atrás e o pontinho verde pulsando,
    // convidando pra uma sala que podia estar vazia fazia tempo.
    var vivo = !!S.canal && S.sub === 'on' && !S.dormindo;
    var n = vivo ? contarPresentes() : 0;
    var texto = S.sub === 'erro' ? 'sala indisponível agora'
      : !vivo ? 'toque pra ver quem está'
        : S.entrei ? 'você está na sala' + (n > 1 ? ' com mais ' + (n - 1) : ' — chame alguém')
          : n === 0 ? 'ninguém na sala — seja o primeiro'
            : n === 1 ? '1 pessoa conversando agora'
              : n + ' pessoas conversando agora';
    document.querySelectorAll('.svz-entrada').forEach(function (el) {
      el.classList.toggle('tem-gente', n > 0);
      var sub = el.querySelector('[data-svz-sub]');
      if (sub) sub.textContent = texto;
      var b = el.querySelector('[data-svz-badge]');
      if (b) b.textContent = String(n);
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
    conectar();   // se estava dormindo (aba escondida por muito tempo), acorda
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
  function limparErroModal() { var e = $('svzDlgErro'); if (e) e.innerHTML = ''; }

  function pintarModal() {
    var d = $('svzDlg');
    if (!d || !d.classList.contains('on')) return;
    var n = contarPresentes();
    var cheia = n >= MAX;
    var sub = $('svzDlgSub');
    if (sub) {
      sub.textContent = S.entrando ? 'conectando…'
        : cheia ? 'A sala está cheia (' + MAX + ' de ' + MAX + '). Espera alguém sair.'
          : n === 0 ? 'A sala está vazia. Entra e chama a galera no feed — é conversa por voz, só áudio.'
            : n + (n === 1 ? ' pessoa está' : ' pessoas estão') + ' na sala agora. Cabem ' + MAX + '.';
    }
    var quem = $('svzDlgQuem');
    if (quem) {
      var htm = '';
      S.presentes.forEach(function (p) {
        var pe = S.ids.get(p.ticket);
        if (!pe) return;
        htm += '<div class="svz-mini">' + avatarHTML(pe) + '<span>' + esc(pe.nome) + '</span></div>';
      });
      quem.innerHTML = htm;
    }
    var b1 = $('svzBEntrar'), b2 = $('svzBMudo');
    if (b1) b1.disabled = S.entrando || cheia;
    if (b2) b2.disabled = S.entrando || cheia;
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
      + '<div class="svz-conftit">Sair da sala de voz?</div>'
      + '<div class="svz-confsub">seu microfone fecha e a conversa segue sem você</div>'
      + '<div class="svz-confbtns">'
      + '<button class="svz-b sec" id="svzBFicar">Ficar</button>'
      + '<button class="svz-b sair" id="svzBSairSim">Sair</button>'
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
  // sair não tem desfazer: cai o áudio, morre o mesh e a vaga volta pra fila do
  // limite de 10. Confirmação INLINE, no vidro do próprio painel: confirm() do
  // navegador trava a thread (o áudio engasga), não combina com nada daqui e
  // no iOS aparece colado no topo, longe do dedo.
  var lacosConfirmacao = false;

  function confirmacaoAberta() {
    var c = $('svzConf');
    return !!(c && c.classList.contains('on'));
  }

  function abrirConfirmacaoSaida() {
    var c = $('svzConf');
    // Painel antigo em cache sem a confirmação: sair continua funcionando. Um
    // botão de sair que não sai seria pior que sair sem perguntar.
    if (!c) { sair(''); return; }
    c.classList.add('on');
    var b = $('svzBSairSim');
    if (b) { try { b.focus(); } catch (e) {} }   // Enter confirma, Esc desiste
  }

  function fecharConfirmacaoSaida() {
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

  function abrirDock() { montarDock(); fecharConfirmacaoSaida(); pintarSala(); }
  function fecharDock() { var d = $('svzDock'); if (d) d.remove(); }

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
      // eu primeiro, depois por ordem de chegada — card não pula de lugar
      var lista = Array.from(S.presentes.entries()).sort(function (a, b) {
        if (a[0] === S.sessao) return -1;
        if (b[0] === S.sessao) return 1;
        return (a[1].entrou - b[1].entrou) || (a[0] < b[0] ? -1 : 1);
      });
      lista.forEach(function (e) { htm += cardHTML(e[0], e[1]); });
      grid.innerHTML = htm;
    }
    var bm = $('svzBMudar');
    if (bm) {
      bm.textContent = S.mudo ? '🔇 Desmutar' : '🎤 Mudo';
      bm.className = 'svz-b ' + (S.mudo ? 'mudo' : 'sec');
    }
    var nota = $('svzNota');
    if (nota) {
      // Conta também quem a gente já desistiu de alcançar (S.semRota): antes a
      // nota olhava só pro connectionState do peer do momento, e como o peer
      // era destruído e recriado a cada 12s a mensagem piscava e sumia
      // exatamente quando ela era necessária.
      var caidos = 0;
      S.peers.forEach(function (p, k) {
        if (!S.semRota.has(k) && p.pc && p.pc.connectionState === 'failed') caidos++;
      });
      caidos += S.semRota.size;
      var ghosts = 0;
      S.presentes.forEach(function (p, k) { if (fantasma(p, k)) ghosts++; });
      nota.textContent = S.sub === 'erro' ? 'conexão instável — tentando voltar'
        : S.suspenso ? 'tela bloqueada — você continua na sala'
          : caidos ? caidos + ' pessoa(s) sem conexão direta com você (rede bloqueando)'
            : ghosts ? ghosts + ' presença não verificada na sala (sessão vencida do outro lado)'
              : (S.mudo ? 'seu microfone está desligado' : 'seu microfone está ligado');
    }
  }

  // Card: nome e foto vêm SEMPRE da identidade verificada no servidor, escapados.
  function cardHTML(chave, pres) {
    var eu = chave === S.sessao;
    // Ticket que o servidor recusou. Antes caía no mesmo "…" de quem ainda
    // estava sendo verificado: ficava lá, contado como pessoa, mudo pra
    // sempre, sem nada indicando que aquilo não ia funcionar nunca.
    if (fantasma(pres, chave)) {
      return '<div class="svz-p caiu" data-svz-card="' + esc(chave) + '" title="sessão vencida — sem áudio">'
        + '<div class="svz-ava" style="background:#26374f">?</div>'
        + '<div class="svz-nome">não verificado</div>'
        + '<span class="svz-mic">🚫</span>'
        + '</div>';
    }
    var pe = S.ids.get(pres.ticket) || { nome: '…', avatar: null, plano: 'full' };
    var mudo = eu ? S.mudo : pres.mudo;
    var p = S.peers.get(chave);
    var caiu = !eu && (S.semRota.has(chave) || (p && p.pc && p.pc.connectionState === 'failed'));
    return '<div class="svz-p' + (S.falando.has(chave) ? ' falando' : '') + (caiu ? ' caiu' : '') + '" data-svz-card="' + esc(chave) + '">'
      + avatarHTML(pe)
      + '<div class="svz-nome">' + esc(eu ? 'Você' : pe.nome) + '</div>'
      + (mudo ? '<span class="svz-mic">🔇</span>' : '')
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

  function pintarEstadoPeers() { pintarSala(); }

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
    // Portão do cliente: sem plano, sem sala — e nem socket é aberto. O portão
    // que vale é o do servidor (api/sala-voz.js), este aqui é só pra não
    // desenhar botão que a pessoa não pode usar.
    var cfg = await garantirConfig();
    if (!cfg) return;
    esperarAncoras();
    conectar();
  }

  // Aba escondida por muito tempo e fora da sala: solta o socket. Dentro da
  // sala nunca desliga — sair da chamada porque trocou de aba seria péssimo.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (!S.entrei) S.tIdle = setTimeout(desconectarObservador, 5 * 60 * 1000);
      else suspender();     // dentro da sala: só marca, continua na conversa
    } else {
      clearTimeout(S.tIdle);
      if (S.suspenso) { retomar(); return; }
      if (!S.canal && S.cfg) conectar();
    }
  });

  // beforeunload é o ÚNICO sinal que só aparece em saída de verdade
  // (fechar/navegar). Ele nunca dispara quando a tela do celular apaga — é
  // justamente por isso que ele é quem autoriza a despedida.
  window.addEventListener('beforeunload', function () {
    S.saindoDeVerdade = true;
    despedir();
    // Se a página continuar viva (navegação cancelada, download que não sai da
    // página), o sinal não pode ficar armado: senão o próximo bloqueio de tela
    // seria interpretado como saída de verdade.
    setTimeout(function () { S.saindoDeVerdade = false; }, 4000);
  });

  // 'pagehide' é ambíguo: dispara ao fechar a aba E ao apagar a tela do
  // iPhone. Tratá-lo como saída deixava a sala inutilizável no celular. Aqui
  // ele só despede se o beforeunload já tiver confirmado a saída e a página
  // não estiver indo pro bfcache; caso contrário é suspensão. Se for mesmo um
  // fechamento silencioso (iOS não garante beforeunload), quem limpa é o
  // timeout do socket — que é o cinto de segurança que a sala já usava.
  window.addEventListener('pagehide', function (e) {
    if (S.saindoDeVerdade && !e.persisted) { despedir(); return; }
    suspender();
  });

  // Chrome/Android congela a aba de fundo pra poupar bateria. Congelado é
  // exatamente o mesmo caso da tela apagada: continua na sala.
  document.addEventListener('freeze', suspender);
  document.addEventListener('resume', function () { retomar(); });

  // Voltar pelo botão "voltar" restaura a página do cache (bfcache) com o
  // estado antigo. O canal antigo tem que ser REMOVIDO do cliente Supabase, e
  // não só esquecido com `S.canal = null` — senão ele fica órfão, pendurado,
  // enquanto a gente assina outro por cima.
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    S.saindoDeVerdade = false;
    limparCanal();
    S.presentes = new Map();
    if (S.entrei) retomar();          // continua na sala: reassina e re-anuncia
    else if (S.cfg) conectar();
    pintar();
  });

  window.SalaVoz = {
    abrir: abrirModal, entrar: entrar, sair: sair, mudo: alternarMudo,
    _estado: function () { return S; },
    // Superfície de diagnóstico (irmã do _estado, que já existia): deixa o
    // console e os testes exercitarem a contagem e a lista sem precisar de
    // socket, microfone e WebRTC de verdade. Nada aqui é usado pela UI.
    _interno: {
      contarPresentes: contarPresentes,
      contarFalando: contarFalando,
      fantasma: fantasma,
      garantirEuNaLista: garantirEuNaLista,
      registrarMinhaIdentidade: registrarMinhaIdentidade,
      sincronizar: sincronizar,
      cardHTML: cardHTML,
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ligar);
  else ligar();
})();
