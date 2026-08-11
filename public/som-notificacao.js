/* public/som-notificacao.js — som curto de notificação, compartilhado
 * ==========================================================================
 * Usado pelo sininho e pelo chat de suporte, pra ser o MESMO som nos dois.
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

  window.BTSom = {
    tocar: tocar,
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
