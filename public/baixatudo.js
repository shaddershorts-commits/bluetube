/* baixatudo.js — BaixaTudo: baixa TODOS os Shorts de um canal (2026-08-03)
 *
 * ISOLADO de propósito (ordem do dono): este arquivo NÃO chama nenhuma função
 * do baixaBlue.html — nem startDownload, nem processarYoutube, nem switchMode.
 * Ele só mostra/esconde os blocos da página e fala com os endpoints próprios
 * (/api/baixatudo e /baixatudo-video do Railway). Um bug aqui não tem como
 * afetar o download normal.
 *
 * Diferença de motor: o BaixaBlue re-encoda cada vídeo pra descaracterizar
 * (minutos). Aqui não existe descaracterização — o merge sai por cópia de
 * stream (segundos). É a feature inteira: velocidade + HD.
 */
(function () {
  'use strict';

  // O download NÃO passa pelo nosso servidor: pedimos o link HD à nossa API
  // (que fala com o Cobalt self-hosted) e o navegador baixa direto do túnel.
  // Assim o container compartilhado do BaixaBlue não vê um byte de mídia.
  var API_LINK = '/api/baixatudo?action=link&id=';
  var lista = [];        // shorts listados
  var baixando = false;
  var cancelar = false;

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function tempo(seg) {
    if (!seg) return '';
    var m = Math.floor(seg / 60), s = Math.floor(seg % 60);
    return m + ':' + String(s).padStart(2, '0');
  }
  function nView(n) {
    if (!n) return '';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'k';
    return String(n);
  }

  // ── liga/desliga o modo ────────────────────────────────────────────────
  function alternar(ligado) {
    var tabs = el('btTabsOriginais');
    var modoUrl = el('modeUrl');
    var modoUp = el('modeUpload');
    var meu = el('btMode');
    var chip = el('btChipAtivo');
    var sw = el('btSwitchKnob');
    var trilho = el('btSwitchTrack');

    if (ligado) {
      if (tabs) tabs.style.display = 'none';
      if (modoUrl) modoUrl.style.display = 'none';
      if (modoUp) modoUp.style.display = 'none';
      if (meu) meu.style.display = '';
      if (chip) chip.style.display = 'inline-flex';
      if (trilho) trilho.style.background = 'linear-gradient(135deg,#92400e,#fbbf24)';
      if (sw) sw.style.transform = 'translateX(20px)';
    } else {
      if (tabs) tabs.style.display = 'flex';
      if (modoUrl) modoUrl.style.display = '';
      if (meu) meu.style.display = 'none';
      if (chip) chip.style.display = 'none';
      if (trilho) trilho.style.background = 'rgba(255,255,255,.15)';
      if (sw) sw.style.transform = 'translateX(0)';
    }
  }

  // ── listar os shorts do canal ──────────────────────────────────────────
  async function listar() {
    var input = el('btCanalUrl');
    var btn = el('btListarBtn');
    var status = el('btStatus');
    var url = (input.value || '').trim();
    if (!url) { status.innerHTML = '<span style="color:#fca5a5">Cola o link do canal primeiro.</span>'; return; }

    btn.disabled = true;
    btn.textContent = 'Procurando…';
    status.innerHTML = '<span style="color:#7d92b8">🔎 Lendo os Shorts do canal…</span>';
    el('btResultado').style.display = 'none';

    try {
      var token = localStorage.getItem('bt_token') || '';
      var r = await fetch('/api/baixatudo?action=listar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token, channel_url: url }),
      });
      var d = await r.json().catch(function () { return {}; });

      if (!r.ok) {
        var msgs = {
          plano_master_necessario: 'O BaixaTudo é do plano Master.',
          canal_invalido: 'Esse link não parece de canal. Use algo como youtube.com/@nomedocanal',
          canal_nao_encontrado: d.detail || 'Não achei esse canal (ou ele não tem Shorts públicos).',
          bot_check: 'O YouTube pediu verificação agora. Tenta de novo em alguns minutos.',
          timeout: 'Demorou demais pra responder. Tenta de novo.',
          login_obrigatorio: 'Entra na sua conta pra usar.',
        };
        status.innerHTML = '<span style="color:#fca5a5">' + esc(msgs[d.error] || d.detail || 'Não consegui listar esse canal.') + '</span>';
        return;
      }

      lista = d.shorts || [];
      if (!lista.length) {
        status.innerHTML = '<span style="color:#fca5a5">Esse canal não tem Shorts públicos.</span>';
        return;
      }

      status.innerHTML = '<span style="color:#22c55e">✓ ' + lista.length + ' Shorts encontrados em <strong>' + esc(d.canal) + '</strong></span>' +
        (d.teto_atingido ? '<span style="color:#fbbf24;display:block;margin-top:4px;font-size:11px">Mostrando os ' + lista.length + ' mais recentes (teto por lote).</span>' : '');
      render();
    } catch (e) {
      status.innerHTML = '<span style="color:#fca5a5">Erro de conexão. Tenta de novo.</span>';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Procurar Shorts';
    }
  }

  function render() {
    var box = el('btLista');
    box.innerHTML = lista.map(function (s, i) {
      return '<label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);cursor:pointer">' +
        '<input type="checkbox" class="bt-check" data-i="' + i + '" checked style="width:16px;height:16px;accent-color:#fbbf24;flex-shrink:0"/>' +
        '<img src="' + esc(s.thumb) + '" loading="lazy" style="width:34px;height:46px;object-fit:cover;border-radius:5px;flex-shrink:0;background:#0a1020" onerror="this.style.visibility=\'hidden\'"/>' +
        '<span style="flex:1;min-width:0">' +
          '<span style="display:block;font-size:12.5px;color:#e8f4ff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(s.titulo) + '</span>' +
          '<span style="display:block;font-family:monospace;font-size:10px;color:#7d92b8;margin-top:2px">' +
            (s.duracao ? tempo(s.duracao) : '') + (s.views ? ' · ' + nView(s.views) + ' views' : '') +
          '</span>' +
        '</span>' +
        '<span class="bt-item-status" data-st="' + i + '" style="font-family:monospace;font-size:10px;color:#7d92b8;flex-shrink:0;min-width:58px;text-align:right"></span>' +
      '</label>';
    }).join('');
    el('btResultado').style.display = '';
    atualizarContador();
    box.querySelectorAll('.bt-check').forEach(function (c) { c.addEventListener('change', atualizarContador); });
  }

  function selecionados() {
    return Array.prototype.slice.call(document.querySelectorAll('.bt-check'))
      .filter(function (c) { return c.checked; })
      .map(function (c) { return parseInt(c.getAttribute('data-i'), 10); });
  }

  function atualizarContador() {
    var n = selecionados().length;
    var b = el('btBaixarBtn');
    b.disabled = n === 0 || baixando;
    b.textContent = baixando ? 'Baixando…' : (n ? '⬇ Baixar ' + n + ' Shorts em HD' : 'Selecione ao menos 1');
  }

  function marcarTodos(v) {
    document.querySelectorAll('.bt-check').forEach(function (c) { c.checked = v; });
    atualizarContador();
  }

  function statusItem(i, texto, cor) {
    var e = document.querySelector('[data-st="' + i + '"]');
    if (e) { e.textContent = texto; e.style.color = cor || '#7d92b8'; }
  }

  // ── baixar em fila (um por vez, com retry quando o servidor está cheio) ─
  async function baixarTodos() {
    if (baixando) return;
    var idx = selecionados();
    if (!idx.length) return;

    baixando = true; cancelar = false;
    atualizarContador();
    el('btCancelarBtn').style.display = '';
    var prog = el('btProgresso');
    prog.style.display = '';

    var ok = 0, falhou = 0;
    for (var k = 0; k < idx.length; k++) {
      if (cancelar) break;
      var i = idx[k];
      var s = lista[i];
      prog.innerHTML = '<strong style="color:#fbbf24">' + (k + 1) + ' de ' + idx.length + '</strong> · ' + esc(s.titulo.slice(0, 48));
      statusItem(i, '⬇ baixando', '#fbbf24');

      var venceu = false;
      for (var tentativa = 0; tentativa < 3 && !venceu && !cancelar; tentativa++) {
        try {
          // 1) nossa API pede o link HD ao Cobalt
          var token = localStorage.getItem('bt_token') || '';
          var rl = await fetch(API_LINK + encodeURIComponent(s.id), {
            headers: { Authorization: 'Bearer ' + token },
          });
          var dl = await rl.json().catch(function () { return {}; });
          if (rl.status === 429) {
            statusItem(i, '⏳ fila', '#7d92b8');
            await new Promise(function (res) { setTimeout(res, 4000); });
            continue;
          }
          if (!rl.ok || !dl.url) throw new Error(dl.error || 'sem link');

          // 2) o navegador baixa direto do túnel (nosso servidor fica fora)
          statusItem(i, '⬇ ' + (dl.qualidade || 'HD') + 'p', '#fbbf24');
          var r = await fetch(dl.url);
          if (!r.ok) throw new Error('http ' + r.status);
          var blob = await r.blob();
          if (blob.size < 1024) throw new Error('vazio');

          var a = document.createElement('a');
          var objUrl = URL.createObjectURL(blob);
          a.href = objUrl;
          a.download = (s.titulo || s.id).replace(/[\\/:*?"<>|]/g, '_').slice(0, 90) + '.mp4';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function (u) { return function () { URL.revokeObjectURL(u); }; }(objUrl), 30000);

          statusItem(i, '✓ ' + (blob.size / 1048576).toFixed(1) + ' MB', '#22c55e');
          ok++; venceu = true;
        } catch (e) {
          if (tentativa === 2) { statusItem(i, '✕ falhou', '#fca5a5'); falhou++; }
          else await new Promise(function (res) { setTimeout(res, 1500); });
        }
      }
      // respiro entre downloads — evita parecer robô pro YouTube
      if (!cancelar && k < idx.length - 1) await new Promise(function (res) { setTimeout(res, 700); });
    }

    baixando = false;
    el('btCancelarBtn').style.display = 'none';
    atualizarContador();
    prog.innerHTML = cancelar
      ? '<span style="color:#fbbf24">Parado. ' + ok + ' baixados.</span>'
      : '<span style="color:#22c55e"><strong>Pronto!</strong> ' + ok + ' baixados' + (falhou ? ' · ' + falhou + ' falharam' : '') + '.</span>';
  }

  // ── liga os eventos quando a página estiver pronta ──────────────────────
  function montar() {
    var sw = el('btSwitch');
    if (!sw) return;
    sw.addEventListener('click', function () {
      var ligado = sw.getAttribute('data-on') !== '1';
      sw.setAttribute('data-on', ligado ? '1' : '0');
      alternar(ligado);
    });
    el('btListarBtn').addEventListener('click', listar);
    el('btCanalUrl').addEventListener('keydown', function (e) { if (e.key === 'Enter') listar(); });
    el('btBaixarBtn').addEventListener('click', baixarTodos);
    el('btCancelarBtn').addEventListener('click', function () { cancelar = true; });
    el('btTodos').addEventListener('click', function () { marcarTodos(true); });
    el('btNenhum').addEventListener('click', function () { marcarTodos(false); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', montar);
  else montar();
})();
