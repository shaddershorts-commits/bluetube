/* public/som-notificacao.js — som curto de notificação, compartilhado
 * ==========================================================================
 * Usado pelo sininho e pelo chat de suporte, pra ser o MESMO som nos dois.
 *
 * Expõe três timbres: tocar() (o sininho, inalterado), entrou() e saiu() — os
 * dois últimos são da sala de voz e sobem/descem pra dizer o que aconteceu.
 *
 * SEM ARQUIVO DE ÁUDIO: o som é sintetizado no Web Audio API. Um .mp3 seria
 * mais uma requisição em toda página, mais um arquivo pra hospedar e um
 * ponto a mais pra falhar — pra dois bipes de meio segundo não compensa.
 *
 * O navegador BLOQUEIA áudio antes do primeiro clique da pessoa (política de
 * autoplay). Por isso o contexto é criado no primeiro gesto dela, e antes
 * disso tocar() simplesmente não faz nada — em vez de estourar erro no console.
 */
(function () {
  'use strict';

  var ctx = null;
  var liberado = false;
  var ultimo = 0;

  var PREF = 'bt_som_notif';          // 'off' desliga
  var INTERVALO_MIN = 1500;           // não metralhar em rajada de avisos

  function ligado() {
    try { return localStorage.getItem(PREF) !== 'off'; } catch (e) { return true; }
  }

  // O contexto só pode nascer dentro de um gesto do usuário. Qualquer clique,
  // tecla ou toque serve — depois disso o som funciona pelo resto da sessão.
  function liberar() {
    if (liberado) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      if (ctx.state === 'suspended') ctx.resume();
      liberado = true;
    } catch (e) {}
  }
  ['click', 'keydown', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, liberar, { once: true, passive: true });
  });

  // Dois tons curtos subindo — lê como "chegou algo", não como alarme.
  function tocar() {
    if (!ligado() || !liberado || !ctx) return;
    var agora = Date.now();
    if (agora - ultimo < INTERVALO_MIN) return;
    ultimo = agora;
    try {
      if (ctx.state === 'suspended') ctx.resume();
      [[880, 0], [1174.7, 0.11]].forEach(function (par) {
        var osc = ctx.createOscillator();
        var vol = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = par[0];
        var t0 = ctx.currentTime + par[1];
        // envelope curto: sem isso o corte seco vira um "clique" desagradável
        vol.gain.setValueAtTime(0.0001, t0);
        vol.gain.exponentialRampToValueAtTime(0.14, t0 + 0.02);
        vol.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
        osc.connect(vol); vol.connect(ctx.destination);
        osc.start(t0); osc.stop(t0 + 0.24);
      });
    } catch (e) {}
  }

  // ── timbres da sala de voz (entrar / sair) ────────────────────────────────
  // São timbres NOVOS, e distintos do sininho de propósito: numa conversa a
  // pessoa vai ouvir entrada/saída várias vezes, e repetir o bipe de "chegou
  // mensagem" faria ela olhar pro sino toda vez. Aqui a informação está no
  // MOVIMENTO — sobe = chegou alguém, desce = saiu alguém — que se entende sem
  // ninguém explicar e sem precisar de volume alto.
  var ultimoTimbre = {};              // nome -> quando tocou pela última vez
  var INTERVALO_TIMBRE = 1200;        // mesmo timbre não repete antes disso

  // Teto anti-metralhadora: a sala abrindo com 5 pessoas clicando junto não
  // pode virar 5 bipes seguidos. Passou do teto dentro da janela, o resto da
  // rajada é engolido em silêncio (não enfileirado — bipe atrasado mente sobre
  // quando a pessoa entrou).
  var JANELA_RAJADA = 10000;
  var MAX_NA_JANELA = 3;
  var rajada = [];

  function podeTimbre(nome) {
    if (!ligado() || !liberado || !ctx) return false;
    var agora = Date.now();
    if (agora - (ultimoTimbre[nome] || 0) < INTERVALO_TIMBRE) return false;
    rajada = rajada.filter(function (t) { return agora - t < JANELA_RAJADA; });
    if (rajada.length >= MAX_NA_JANELA) return false;
    ultimoTimbre[nome] = agora;
    rajada.push(agora);
    return true;
  }

  // notas = [freqInicial, freqFinal, atraso, duração]. O glissando (rampa de
  // frequência) é o que faz o ouvido perceber "subindo"/"descendo" — com dois
  // tons fixos a diferença some quando a sala está com barulho de fundo.
  function soar(notas, ganho) {
    try {
      if (ctx.state === 'suspended') ctx.resume();
      notas.forEach(function (n) {
        var osc = ctx.createOscillator();
        var vol = ctx.createGain();
        osc.type = 'sine';
        var t0 = ctx.currentTime + n[2];
        var t1 = t0 + n[3];
        osc.frequency.setValueAtTime(n[0], t0);
        osc.frequency.exponentialRampToValueAtTime(n[1], t1);
        // mesmo envelope do tocar(): corte seco vira "clique" no alto-falante
        vol.gain.setValueAtTime(0.0001, t0);
        vol.gain.exponentialRampToValueAtTime(ganho, t0 + 0.02);
        vol.gain.exponentialRampToValueAtTime(0.0001, t1);
        osc.connect(vol); vol.connect(ctx.destination);
        osc.start(t0); osc.stop(t1 + 0.02);
      });
      return true;
    } catch (e) { return false; }
  }

  // Entrar: SOL→DÓ→SOL agudo, subindo, com o segundo tom mais longo. Acolhedor
  // porque termina aberto (não resolve pra baixo): lê como "senta aí".
  function entrou() {
    if (!podeTimbre('entrou')) return false;
    return soar([[392, 523.25, 0, 0.13], [523.25, 784, 0.1, 0.2]], 0.1);
  }

  // Sair: um tom só, descendo e curto. Alongar aqui soa como alarme de erro —
  // e ninguém saiu com erro, só saiu.
  function saiu() {
    if (!podeTimbre('saiu')) return false;
    return soar([[587.33, 293.66, 0, 0.16]], 0.085);
  }

  window.BTSom = {
    tocar: tocar,
    entrou: entrou,
    saiu: saiu,
    ligado: ligado,
    alternar: function () {
      try {
        var novo = ligado() ? 'off' : 'on';
        localStorage.setItem(PREF, novo);
        if (novo === 'on') tocar();
        return novo === 'on';
      } catch (e) { return true; }
    },
  };
})();
