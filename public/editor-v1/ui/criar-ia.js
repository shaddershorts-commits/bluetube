// editor-v1/ui/criar-ia.js
// "CRIAR COM IA" — experiência guiada pelo Blublu (2026-08-13, tijolo 1).
//
// O plano combinado com o dono: construir TIJOLO POR TIJOLO, cada etapa só
// avança quando a anterior funciona. Este arquivo é o palco da experiência
// inteira; hoje ele cobre as duas primeiras etapas de verdade:
//   1. boas-vindas — o Blublu (personalidade real, via api/criar-ia) pergunta
//      o que a pessoa quer criar;
//   2. escolher_video — ele busca nos Virais reais e a pessoa escolhe o card.
// As etapas seguintes (BlueClean → roteiro → voz → legenda → montagem →
// aprovação) entram nos próximos tijolos — o fluxo avisa com honestidade
// onde termina por enquanto (nada de fachada).
//
// Frente SEPARADA do batch do editor que aguarda commit: módulo novo, CSS
// novo (criar-ia.css), endpoint novo. home.js só ganha o botão.

import { montarLinhaDoTempo } from '../core/sync-narracao.js';
import { layoutDoTexto } from '../core/text-layout.js';
import { TEXT_SIZE_PCT } from '../core/schema.js';
import { api } from '../services/api.js';   // audio-search (música de fundo)

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const fmtViews = (v) => {
  const n = Number(v) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k';
  return String(n);
};

export function mountCriarIA({ onExit }) {
  // ── estado do fluxo (a espinha da experiência inteira) ────────────────────
  const fluxo = {
    etapa: 'boasvindas',      // boasvindas → escolher_video → marcar_legenda → legenda_removida
    video: null,              // o card escolhido dos Virais
    historico: [],            // [{role:'user'|'assistant', text}] pro contexto do Blublu
    vistos: [],               // ids já mostrados — "outras opções" traz NOVAS
    arquivoUrl: null,         // o mp4 do vídeo escolhido (Storage, via yt-download)
    videoLimpoUrl: null,      // resultado do BlueClean (ou o original, se pulou)
    idioma: null,             // idioma escolhido pro roteiro (tijolo 3)
    transcript: null,         // { texto, segments (âncoras da sync!), lang_original }
    roteiros: null,           // as versões geradas [{versao, nome, texto}]
    roteiro: null,            // a escolhida
  };

  // ── PERSISTÊNCIA (13/08): a limpeza CUSTA (cota + GPU) — o trabalho não
  // pode evaporar num F5. O fluxo salva no navegador a cada avanço; ao
  // reabrir, o Blublu oferece continuar de onde parou (o vídeo limpo é URL
  // permanente do Storage, então retomar = custo ZERO). Quando o pipeline
  // completo existir, isso migra pra tabela (multi-dispositivo).
  const LS_FLUXO = 'be_criar_ia_fluxo';
  function salvarFluxo() {
    try {
      localStorage.setItem(LS_FLUXO, JSON.stringify({
        etapa: fluxo.etapa, video: fluxo.video,
        arquivoUrl: fluxo.arquivoUrl, videoLimpoUrl: fluxo.videoLimpoUrl,
        idioma: fluxo.idioma, transcript: fluxo.transcript,
        roteiros: fluxo.roteiros, roteiro: fluxo.roteiro,
        chunks: fluxo.chunks, narracao: fluxo.narracao, voz: fluxo.voz,
        estiloLegenda: fluxo.estiloLegenda, renderUrl: fluxo.renderUrl, pacote: fluxo.pacote,
        legendaPos: fluxo.legendaPos, legendaTam: fluxo.legendaTam, musica: fluxo.musica,
        historico: fluxo.historico.slice(-12), salvoEm: Date.now(),
      }));
    } catch {}
  }
  function carregarFluxo() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_FLUXO) || 'null');
      return (s && s.video) ? s : null;
    } catch { return null; }
  }
  function limparFluxo() { try { localStorage.removeItem(LS_FLUXO); } catch {} }

  const el = document.createElement('div');
  el.className = 'be-ia-tela';
  el.id = 'beIaTela';
  el.innerHTML = `
    <canvas class="be-ia-particulas" id="beIaParticulas"></canvas>
    <div class="be-ia-head">
      <button class="be-ia-voltar" id="beIaVoltar">← Voltar</button>
      <span class="be-ia-titulo">Criar com <b>IA</b></span>
      <span class="be-ia-etapa" id="beIaEtapa"></span>
    </div>
    <div class="be-ia-chat">
      <div class="be-ia-msgs" id="beIaMsgs"></div>
      <div class="be-ia-input-row">
        <input class="be-ia-input" id="beIaInput" type="text" autocomplete="off"
          placeholder="Responde aqui pro Blublu…" maxlength="500"/>
        <button class="be-ia-enviar" id="beIaEnviar">Enviar</button>
      </div>
    </div>`;
  document.body.appendChild(el);

  const $ = (sel) => el.querySelector(sel);
  const msgs = $('#beIaMsgs');
  const input = $('#beIaInput');
  const btnEnviar = $('#beIaEnviar');

  const rotuloEtapa = () => ({
    boasvindas: 'etapa 1 · o que criar',
    escolher_video: 'etapa 2 · escolher o vídeo',
    video_escolhido: 'etapa 2 ✓ · vídeo escolhido',
    marcar_legenda: 'etapa 3 · marcar a legenda',
    legenda_removida: 'etapa 3 ✓ · vídeo limpo',
    escolher_idioma: 'etapa 4 · idioma do roteiro',
    gerando_roteiros: 'etapa 4 · escrevendo roteiros…',
    escolher_roteiro: 'etapa 4 · escolher o roteiro',
    roteiro_escolhido: 'etapa 4 ✓ · roteiro pronto',
    escolher_voz: 'etapa 5 · a voz',
    escolher_legenda: 'etapa 6 · a legenda',
    montagem: 'etapa 7 · montagem final…',
    aprovacao: 'etapa 8 · aprovação',
    entrega: 'etapa 8 ✓ · PRONTO 🎉',
  }[fluxo.etapa] || fluxo.etapa);
  const syncEtapa = () => { $('#beIaEtapa').textContent = rotuloEtapa(); };

  // ── PARTÍCULAS: pontos conectados, o "ambiente tecnológico" ───────────────
  // Canvas próprio, leve (≤70 pontos, 1 gradiente por frame). Respeita
  // prefers-reduced-motion (fica um fundo estático).
  const canvas = $('#beIaParticulas');
  const ctx = canvas.getContext('2d');
  let raf = 0;
  const pontos = [];
  function medirCanvas() {
    canvas.width = el.clientWidth;
    canvas.height = el.clientHeight;
  }
  function iniciarParticulas() {
    medirCanvas();
    const N = Math.min(70, Math.round((canvas.width * canvas.height) / 22000));
    pontos.length = 0;
    for (let i = 0; i < N; i++) {
      pontos.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.35,
        vy: (Math.random() - 0.5) * 0.35,
        dourado: Math.random() < 0.18,     // umas poucas faíscas douradas no meio do azul
      });
    }
    const parado = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const frame = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of pontos) {
        if (!parado) {
          p.x += p.vx; p.y += p.vy;
          if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
          if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.dourado ? 1.8 : 1.3, 0, Math.PI * 2);
        ctx.fillStyle = p.dourado ? 'rgba(255,215,94,.75)' : 'rgba(110,180,255,.55)';
        ctx.fill();
      }
      // linhas entre vizinhos próximos (o "circuito")
      for (let i = 0; i < pontos.length; i++) {
        for (let j = i + 1; j < pontos.length; j++) {
          const a = pontos[i], b = pontos[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 130 * 130) {
            ctx.beginPath();
            ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = `rgba(90,160,255,${(1 - Math.sqrt(d2) / 130) * 0.16})`;
            ctx.stroke();
          }
        }
      }
      if (!parado) raf = requestAnimationFrame(frame);
    };
    frame();
  }
  const aoRedimensionar = () => { medirCanvas(); };
  window.addEventListener('resize', aoRedimensionar);
  iniciarParticulas();

  // ── chat: mensagens, digitando, chips ─────────────────────────────────────
  // avatar = a FOTO do Blublu (pedido do user 13/08; o 🤖 genérico saiu).
  // Poses: happy no papo, thumbsup quando comemora a escolha do vídeo.
  const avatar = (pose = 'happy') =>
    `<div class="be-ia-avatar"><img class="be-ia-avatar-img" src="/blublu-${pose}.png" alt="Blublu"/></div>`;
  function bolha(role, texto, pose) {
    const m = document.createElement('div');
    m.className = 'be-ia-msg' + (role === 'user' ? ' user' : '');
    m.innerHTML = role === 'user'
      ? `<div class="be-ia-bolha">${esc(texto)}</div>`
      : `${avatar(pose)}<div class="be-ia-bolha">${esc(texto)}</div>`;
    msgs.appendChild(m);
    msgs.scrollTop = msgs.scrollHeight;
    return m;
  }
  function digitando() {
    const m = document.createElement('div');
    m.className = 'be-ia-msg be-ia-msg-digitando';
    m.innerHTML = `${avatar()}
      <div class="be-ia-bolha"><span class="be-ia-digitando"><i></i><i></i><i></i></span></div>`;
    msgs.appendChild(m);
    msgs.scrollTop = msgs.scrollHeight;
    return { fim: () => m.remove() };
  }
  function chips(lista) {
    const row = document.createElement('div');
    row.className = 'be-ia-chips';
    for (const c of lista) {
      const b = document.createElement('button');
      b.className = 'be-ia-chip';
      b.textContent = c.rotulo;
      b.addEventListener('click', () => { row.remove(); c.acao(); });
      row.appendChild(b);
    }
    msgs.appendChild(row);
    msgs.scrollTop = msgs.scrollHeight;
  }

  // ── conversa com o Blublu (api/criar-ia) ──────────────────────────────────
  const token = () => localStorage.getItem('bt_token') || '';
  async function blublu(msg) {
    const r = await fetch('/api/criar-ia', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'chat',
        token: token(),
        etapa: fluxo.etapa,
        historico: fluxo.historico.slice(-12),
        msg: msg || null,
        video: fluxo.video ? { titulo: fluxo.video.titulo, canal: fluxo.video.canal_nome, views: fluxo.video.views } : null,
        vistos: fluxo.vistos.slice(-200),
      }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || ('HTTP ' + r.status));
    }
    return r.json();   // { resposta, videos: [...]|null } — a busca é do Blublu
  }

  /** Fala com o Blublu e desenha a resposta (com fallback honesto se a API
   *  cair — a tela nunca fica muda). `silencioso` = não desenha a bolha de
   *  erro (a abertura tem apresentação local própria; erro + apresentação
   *  juntos pareciam bug). `pose` troca a foto do Blublu na bolha. */
  async function rodadaBlublu(msg, silencioso = false, pose = 'happy') {
    const d = digitando();
    let out = null;
    try { out = await blublu(msg); }
    catch (e) {
      d.fim();
      if (!silencioso) bolha('assistant', 'Deu ruim na minha conexão agora (' + (e.message || 'erro') + '). Tenta de novo em instantes — ou me manda a mensagem outra vez.');
      return null;
    }
    d.fim();
    if (out.resposta) {
      fluxo.historico.push({ role: 'assistant', text: out.resposta });
      bolha('assistant', out.resposta, pose);
    }
    return out;
  }

  // ── etapa 2: cards dos Virais reais (a lista vem do PRÓPRIO Blublu — a
  // busca roda no servidor via ferramenta dele, e ele comenta o que achou) ──
  function mostrarVideos(videos) {
    fluxo.etapa = 'escolher_video';
    syncEtapa();
    if (!videos.length) {
      bolha('assistant', 'Não achei vídeos nessa busca agora. Me fala outro nicho (ex.: futebol, curiosidades, receitas) que eu procuro de novo.');
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'be-ia-videos';
    grid.id = 'beIaVideos';
    // vistos por youtube_id (o motor da Virais identifica assim) — "outras
    // opções" nunca repete o que já apareceu nesta conversa
    for (const v of videos) fluxo.vistos.push(String(v.youtube_id || v.url));
    for (const v of videos) {
      const card = document.createElement('button');
      card.className = 'be-ia-vcard';
      const dur = v.duracao_segundos ? ` · ${v.duracao_segundos}s` : '';
      card.innerHTML = `
        ${v.thumbnail_url ? `<img class="be-ia-vthumb" src="${esc(v.thumbnail_url)}" alt="" loading="lazy"/>` : '<div class="be-ia-vthumb"></div>'}
        <span class="be-ia-vplay">▶</span>
        <div class="be-ia-vinfo">
          <div class="be-ia-vtit">${esc(v.titulo || 'Sem título')}</div>
          <div class="be-ia-vmeta">${fmtViews(v.views)} views${dur} · ${esc(v.canal_nome || '')}</div>
        </div>`;
      // clique = ASSISTIR primeiro (user 13/08: "tá pra escolher sem ver o
      // vídeo antes") — a escolha é o botão dentro do preview
      card.addEventListener('click', () => abrirPreview(v, grid, card));
      grid.appendChild(card);
    }
    msgs.appendChild(grid);
    msgs.scrollTop = msgs.scrollHeight;
    chips([
      // os chips viram MENSAGEM pro Blublu: ele decide a busca (ferramenta dele)
      { rotulo: '🔁 Outras opções', acao: () => enviarTexto('me mostra outras opções') },
      { rotulo: '🎯 Trocar o nicho', acao: () => { input.placeholder = 'Fala o nicho que você quer…'; input.focus(); } },
    ]);
  }

  /** Lightbox com o vídeo TOCANDO (embed — custo zero) + escolha explícita. */
  function abrirPreview(v, grid, card) {
    document.getElementById('beIaPreviewFundo')?.remove();
    const fundo = document.createElement('div');
    fundo.className = 'be-ia-preview-fundo';
    fundo.id = 'beIaPreviewFundo';
    // MESMO formato de embed da BlueTendências (comprovado em produção) — o
    // autoplay=1 da 1ª versão veio recusado no teste do user (13/08)
    fundo.innerHTML = `
      <div class="be-ia-preview">
        <iframe src="https://www.youtube.com/embed/${esc(v.youtube_id)}?modestbranding=1&rel=0&playsinline=1"
          allow="encrypted-media; picture-in-picture" allowfullscreen></iframe>
        <div class="be-ia-preview-tit">${esc(v.titulo || '')}</div>
        <div class="be-ia-preview-acoes">
          <button class="be-ia-btn-acao" id="beIaPreviewUsar">✓ Usar este vídeo</button>
          <button class="be-ia-btn-acao sec" id="beIaPreviewFechar">✕ Fechar</button>
        </div>
        <a class="be-ia-preview-fora" href="${esc(v.url || ('https://youtube.com/shorts/' + v.youtube_id))}"
          target="_blank" rel="noopener">não carregou? assiste no YouTube ↗</a>
      </div>`;
    el.appendChild(fundo);
    const fechar = () => fundo.remove();
    fundo.addEventListener('click', (e) => { if (e.target === fundo) fechar(); });
    fundo.querySelector('#beIaPreviewFechar').addEventListener('click', fechar);
    fundo.querySelector('#beIaPreviewUsar').addEventListener('click', () => {
      fechar();
      escolherVideo(v, grid, card);
    });
  }

  async function escolherVideo(v, grid, card) {
    for (const c of grid.querySelectorAll('.be-ia-vcard')) c.classList.remove('sel');
    card.classList.add('sel');
    fluxo.video = v;
    fluxo.etapa = 'video_escolhido';
    syncEtapa();
    salvarFluxo();
    fluxo.historico.push({ role: 'user', text: `[escolheu o vídeo: "${v.titulo}" do canal ${v.canal_nome}, ${fmtViews(v.views)} views]` });
    await rodadaBlublu(null, false, 'thumbsup');
    etapaMarcarLegenda();   // tijolo 2: baixar o arquivo e marcar a legenda
  }

  // ── TIJOLO 2 (13/08): marcar a legenda → BlueClean com progresso REAL ─────

  /** Baixa o mp4 do short escolhido (yt-download já existente: Railway baixa
   *  e sobe pro Storage) e abre a marcação. A espera é real, então a conversa
   *  avisa o que está fazendo. */
  async function etapaMarcarLegenda() {
    fluxo.etapa = 'marcar_legenda';
    syncEtapa();
    bolha('assistant', 'Já tô puxando teu vídeo em alta qualidade pra gente trabalhar nele. Uns segundinhos… ⏳');
    const d = digitando();
    let arq = null;
    try {
      // preparar-video: cadeia HQ do BaixaBlue no servidor; o erro que chega
      // aqui JÁ vem amigável (nunca stderr técnico na bolha — lição de 13/08)
      const r = await fetch('/api/criar-ia', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preparar-video', token: token(), url_youtube: fluxo.video.url }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.url) arq = j.url;
      else throw new Error(j.error || 'Não consegui puxar esse vídeo agora. Escolhe outro card.');
    } catch (e) {
      d.fim();
      bolha('assistant', e.message || 'Não consegui puxar esse vídeo agora. Escolhe outro card, ou pede outras opções que eu busco mais.');
      fluxo.etapa = 'escolher_video';
      syncEtapa();
      return;
    }
    d.fim();
    fluxo.arquivoUrl = arq;
    salvarFluxo();
    bolha('assistant', 'Chegou! Agora arrasta essa caixa dourada pra cobrir a legenda que tá QUEIMADA no vídeo (aquele texto colado na imagem). Cobriu tudo? Aperta "Remover legenda" que eu limpo.');
    montarMarcador(arq);
  }

  /** Player + BOX arrastável/redimensionável. Coordenadas em FRAÇÕES do
   *  quadro (0..1) — exatamente o que o api/blueclean espera em `boxes`. */
  function montarMarcador(arqUrl) {
    const wrap = document.createElement('div');
    wrap.className = 'be-ia-marcar';
    wrap.id = 'beIaMarcar';
    // box inicial no terço de baixo — onde legenda queimada vive
    const box = { x: 0.08, y: 0.6, w: 0.84, h: 0.24 };
    wrap.innerHTML = `
      <div class="be-ia-marcar-palco" id="beIaMarcarPalco">
        <video src="${esc(arqUrl)}" muted loop playsinline autoplay></video>
        <div class="be-ia-box" id="beIaBox">
          <span class="be-ia-box-rotulo">área da legenda</span>
          <span class="be-ia-box-alca" id="beIaBoxAlca"></span>
        </div>
      </div>
      <div class="be-ia-marcar-acoes">
        <button class="be-ia-btn-acao" id="beIaLimpar">🧽 Remover legenda</button>
        <button class="be-ia-btn-acao sec" id="beIaPular">Não tem legenda → pular</button>
      </div>`;
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;

    const palco = wrap.querySelector('#beIaMarcarPalco');
    const boxEl = wrap.querySelector('#beIaBox');
    const alca = wrap.querySelector('#beIaBoxAlca');
    const CL = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    function desenhar() {
      boxEl.style.left = (box.x * 100) + '%';
      boxEl.style.top = (box.y * 100) + '%';
      boxEl.style.width = (box.w * 100) + '%';
      boxEl.style.height = (box.h * 100) + '%';
    }
    desenhar();
    // arrastar (corpo) e redimensionar (alça) — pointer events, funciona no touch
    function prender(el, aoMover) {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        el.setPointerCapture(e.pointerId);
        const r = palco.getBoundingClientRect();
        const ini = { x: e.clientX, y: e.clientY, box: { ...box } };
        const mover = (ev) => {
          aoMover(ini, (ev.clientX - ini.x) / r.width, (ev.clientY - ini.y) / r.height);
          desenhar();
        };
        const soltar = () => {
          el.removeEventListener('pointermove', mover);
          el.removeEventListener('pointerup', soltar);
        };
        el.addEventListener('pointermove', mover);
        el.addEventListener('pointerup', soltar);
      });
    }
    prender(boxEl, (ini, dx, dy) => {
      box.x = CL(ini.box.x + dx, 0, 1 - box.w);
      box.y = CL(ini.box.y + dy, 0, 1 - box.h);
    });
    prender(alca, (ini, dx, dy) => {
      box.w = CL(ini.box.w + dx, 0.08, 1 - box.x);
      box.h = CL(ini.box.h + dy, 0.04, 1 - box.y);
    });

    wrap.querySelector('#beIaLimpar').addEventListener('click', () => {
      wrap.querySelector('#beIaLimpar').disabled = true;
      wrap.querySelector('#beIaPular').disabled = true;
      iniciarLimpeza({ ...box });
    });
    wrap.querySelector('#beIaPular').addEventListener('click', async () => {
      wrap.remove();
      fluxo.videoLimpoUrl = fluxo.arquivoUrl;
      fluxo.etapa = 'legenda_removida';
      syncEtapa();
      salvarFluxo();
      fluxo.historico.push({ role: 'user', text: '[o vídeo não tinha legenda queimada — seguiu sem limpeza]' });
      await rodadaBlublu(null);
      fronteiraDoTijolo();
    });
  }

  /** Dispara o BlueClean REAL (endpoint existente) e narra o progresso do
   *  job — barra com o progress verdadeiro do polling, sem teatrinho. */
  async function iniciarLimpeza(box) {
    const inicio = await fetch('/api/blueclean', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'start', token: token(),
        video_url: fluxo.arquivoUrl,
        engine: 'guided',
        boxes: [{ x_pct: box.x, y_pct: box.y, w_pct: box.w, h_pct: box.h }],
        duration_sec: Number(fluxo.video?.duracao_segundos) || undefined,
      }),
    }).then((r) => r.json().then((j) => ({ ok: r.ok, ...j }))).catch(() => ({ ok: false, error: 'rede' }));
    if (!inicio.ok || !inicio.job_id) {
      bolha('assistant', 'A limpeza não começou: ' + (inicio.error || 'erro') + (inicio.limit_reached ? '' : ' — tenta de novo.'));
      const m = document.getElementById('beIaMarcar');
      if (m) { m.querySelector('#beIaLimpar').disabled = false; m.querySelector('#beIaPular').disabled = false; }
      return;
    }
    document.getElementById('beIaMarcar')?.remove();
    bolha('assistant', 'Boa. Marquei a área e já tô APAGANDO essa legenda do vídeo — trabalho fino, quadro por quadro. Acompanha aí:');
    const prog = document.createElement('div');
    prog.className = 'be-ia-prog';
    prog.innerHTML = `
      <div class="be-ia-prog-barra"><div class="be-ia-prog-fill" id="beIaProgFill"></div></div>
      <div class="be-ia-prog-info"><span id="beIaProgStage">começando…</span><span id="beIaProgPct">0%</span></div>`;
    msgs.appendChild(prog);
    msgs.scrollTop = msgs.scrollHeight;

    // falas do meio do caminho (locais, variadas — o progresso é o real)
    const falas = [
      'Enquanto isso: essa técnica preserva o fundo do vídeo — não fica aquele borrão quadrado de app vagabundo.',
      'Tô reconstruindo o que tava ATRÁS do texto. É por isso que demora um tiquinho — qualidade tem preço.',
      'Quase lá. O resultado sai melhor quando a caixa cobre a legenda com uma folguinha.',
    ];
    let falou = 0;
    let tentativasErro = 0;
    const poll = setInterval(async () => {
      const st = await fetch(`/api/blueclean?action=status&job_id=${encodeURIComponent(inicio.job_id)}&token=${encodeURIComponent(token())}`)
        .then((r) => r.json()).catch(() => null);
      if (!st) {
        if (++tentativasErro >= 5) {
          clearInterval(poll);
          bolha('assistant', 'Perdi o contato com o processamento. Abre o BlueClean no painel que o job pode ter terminado lá — ou tenta de novo.');
        }
        return;
      }
      tentativasErro = 0;
      const pct = Math.max(2, Math.min(99, Number(st.progress) || 2));
      const fill = document.getElementById('beIaProgFill');
      if (fill) {
        fill.style.width = (st.status === 'completed' ? 100 : pct) + '%';
        document.getElementById('beIaProgPct').textContent = (st.status === 'completed' ? 100 : pct) + '%';
        document.getElementById('beIaProgStage').textContent = st.stage || st.status || '…';
      }
      if (st.status === 'processing' && falou < falas.length && pct > (falou + 1) * 25) {
        bolha('assistant', falas[falou++]);
      }
      if (st.status === 'completed' && st.output_url) {
        clearInterval(poll);
        fluxo.videoLimpoUrl = st.output_url;
        fluxo.etapa = 'legenda_removida';
        syncEtapa();
        salvarFluxo();
        const player = document.createElement('div');
        player.className = 'be-ia-player';
        player.innerHTML = `<video src="${esc(st.output_url)}" controls playsinline></video>`;
        msgs.appendChild(player);
        msgs.scrollTop = msgs.scrollHeight;
        fluxo.historico.push({ role: 'user', text: '[a legenda queimada foi removida com sucesso — o vídeo limpo está na tela]' });
        await rodadaBlublu(null, false, 'thumbsup');
        fronteiraDoTijolo();
      }
      if (st.status === 'failed') {
        clearInterval(poll);
        bolha('assistant', 'A limpeza falhou: ' + (st.error_message || 'erro no processamento') + '. Tua cota NÃO foi gasta — quer tentar de novo com a caixa noutra posição?');
        montarMarcador(fluxo.arquivoUrl);
      }
    }, 4000);
  }

  function fronteiraDoTijolo() {
    // vídeo tratado → próxima etapa REAL: o roteiro (tijolo 3, 13/08)
    etapaEscolherIdioma();
  }

  // ── TIJOLO 3 (13/08): idioma → transcrição → 3 versões de roteiro ─────────

  const IDIOMAS = [
    { rotulo: '🇧🇷 Português', lang: 'Português (Brasil)' },
    { rotulo: '🇺🇸 English', lang: 'English' },
    { rotulo: '🇪🇸 Español', lang: 'Español' },
  ];

  async function etapaEscolherIdioma() {
    fluxo.etapa = 'escolher_idioma';
    syncEtapa();
    salvarFluxo();
    await rodadaBlublu(null);   // o Blublu pergunta o idioma com personalidade
    chips([
      ...IDIOMAS.map((i) => ({ rotulo: i.rotulo, acao: () => escolherIdioma(i.lang) })),
      { rotulo: '✍️ Outro', acao: () => { input.placeholder = 'Escreve o idioma que você quer…'; input.focus(); } },
    ]);
  }

  function escolherIdioma(lang) {
    fluxo.idioma = lang;
    salvarFluxo();
    bolha('user', lang);
    fluxo.historico.push({ role: 'user', text: `[escolheu o idioma do roteiro: ${lang}]` });
    etapaGerarRoteiros();
  }

  // digitado livre no input durante a escolha de idioma = idioma
  // (tratado no enviarTexto — ver flag abaixo)

  async function etapaGerarRoteiros() {
    fluxo.etapa = 'gerando_roteiros';
    syncEtapa();
    bolha('assistant', 'Fechou: roteiro em ' + fluxo.idioma + '. Vou transcrever o vídeo original e escrever 3 versões pra você escolher a que curtir mais. Segura aí… ✍️');
    const d = digitando();
    // 1. transcrição do ORIGINAL (cache de 30d no servidor; os TEMPOS dos
    //    segmentos ficam guardados — são as âncoras da sincronização futura)
    let bruto = null;
    try {
      const r = await fetch('/api/transcript?url=' + encodeURIComponent(fluxo.video.url));
      if (r.ok) bruto = await r.json();
    } catch {}
    if (!bruto || !bruto.content) {
      d.fim();
      bolha('assistant', 'Esse vídeo não tem legenda disponível pra eu transcrever agora. Me desculpa — escolhe outro vídeo por enquanto (a transcrição direto do áudio tá chegando numa próxima etapa).');
      fluxo.etapa = 'legenda_removida';
      syncEtapa();
      return;
    }
    const segs = Array.isArray(bruto.content) ? bruto.content : null;
    fluxo.transcript = {
      texto: (segs ? segs.map((s) => s.text || '').join(' ') : String(bruto.content)).replace(/\s+/g, ' ').trim().slice(0, 5000),
      segments: segs ? segs.map((s) => ({ text: s.text, offset: s.offset, duration: s.duration })) : null,
      lang_original: bruto.lang || null,
    };
    salvarFluxo();
    // 2. as 3 versões EM PARALELO (mesmo motor da home: V1 Casual, V2
    //    Apelativo, V3 Tradução Fiel — gate Master do V3 já coberto)
    const pedir = (version) => fetch('/api/rewrite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: fluxo.transcript.texto, lang: fluxo.idioma, version, token: token() }),
    }).then((r) => r.json()).then((j) => (j && j.text) ? j.text : null).catch(() => null);
    const [v1, v2, v3] = await Promise.all([pedir('V1'), pedir('V2'), pedir('V3')]);
    d.fim();
    const versoes = [
      v1 && { versao: 'V1', nome: '💬 Casual', texto: v1 },
      v2 && { versao: 'V2', nome: '🔥 Apelativo', texto: v2 },
      v3 && { versao: 'V3', nome: '🌍 Tradução Fiel', texto: v3 },
    ].filter(Boolean);
    if (!versoes.length) {
      bolha('assistant', 'Meus roteiristas travaram aqui. Tenta de novo em instantes — a transcrição já ficou guardada, não se perde.');
      fluxo.etapa = 'escolher_idioma';
      syncEtapa();
      chips([...IDIOMAS.map((i) => ({ rotulo: '🔁 ' + i.rotulo, acao: () => escolherIdioma(i.lang) }))]);
      return;
    }
    fluxo.roteiros = versoes;
    fluxo.etapa = 'escolher_roteiro';
    syncEtapa();
    salvarFluxo();
    fluxo.historico.push({ role: 'user', text: `[as ${versoes.length} versões do roteiro em ${fluxo.idioma} estão na tela]` });
    await rodadaBlublu(null);
    mostrarRoteiros(versoes);
  }

  function mostrarRoteiros(versoes) {
    const wrap = document.createElement('div');
    wrap.className = 'be-ia-roteiros';
    wrap.id = 'beIaRoteiros';
    for (const v of versoes) {
      const cardR = document.createElement('div');
      cardR.className = 'be-ia-rcard';
      cardR.innerHTML = `
        <div class="be-ia-rcard-nome">${esc(v.nome)}</div>
        <div class="be-ia-rcard-texto">${esc(v.texto)}</div>
        <button class="be-ia-btn-acao">✓ Usar este roteiro</button>`;
      cardR.querySelector('button').addEventListener('click', () => escolherRoteiro(v, wrap, cardR));
      wrap.appendChild(cardR);
    }
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;
  }

  async function escolherRoteiro(v, wrap, cardR) {
    for (const c of wrap.querySelectorAll('.be-ia-rcard')) c.classList.remove('sel');
    cardR.classList.add('sel');
    fluxo.roteiro = { versao: v.versao, nome: v.nome, texto: v.texto };
    fluxo.etapa = 'roteiro_escolhido';
    syncEtapa();
    salvarFluxo();
    fluxo.historico.push({ role: 'user', text: `[escolheu o roteiro ${v.nome} (${v.versao})]` });
    await rodadaBlublu(null, false, 'thumbsup');
    etapaVoz();
  }

  // ── TIJOLO 4 (13/08): a VOZ — acervo TTS ou gravar no teleprompter ────────

  const chamarAction = async (body) => {
    const r = await fetch('/api/criar-ia', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token(), ...body }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  };

  /** Divide o roteiro nas âncoras do vídeo original (uma vez por roteiro). */
  async function garantirChunks() {
    if (fluxo.chunks?.length) return true;
    if (!fluxo.transcript?.segments?.length) {
      // sem âncoras (transcrição veio corrida): narração corrida do início
      fluxo.chunks = [{ offset_ms: 0, texto: fluxo.roteiro.texto.slice(0, 600) }];
      salvarFluxo();
      return true;
    }
    const d = digitando();
    try {
      const j = await chamarAction({ action: 'segmentar-roteiro', roteiro: fluxo.roteiro.texto, segments: fluxo.transcript.segments });
      fluxo.chunks = j.chunks;
      salvarFluxo();
      d.fim();
      return true;
    } catch (e) {
      d.fim();
      bolha('assistant', e.message || 'Não consegui alinhar o roteiro agora. Tenta de novo.');
      chips([{ rotulo: '🔁 Tentar de novo', acao: () => etapaVoz() }]);
      return false;
    }
  }

  async function etapaVoz() {
    if (!(await garantirChunks())) return;
    fluxo.etapa = 'escolher_voz';
    syncEtapa();
    salvarFluxo();
    await rodadaBlublu(null);
    chips([
      { rotulo: '🎙 Vozes do acervo', acao: () => mostrarVozes() },
      { rotulo: '🎤 Gravar minha voz', acao: () => teleprompter() },
    ]);
  }

  async function mostrarVozes() {
    const d = digitando();
    let voices = [];
    try {
      const r = await fetch('/api/blue-voices?action=premade-previews');
      if (r.ok) ({ voices = [] } = await r.json());
    } catch {}
    d.fim();
    if (!voices.length) {
      bolha('assistant', 'O acervo de vozes não respondeu agora. Quer gravar a tua voz, ou tentar o acervo de novo?');
      chips([
        { rotulo: '🎤 Gravar minha voz', acao: () => teleprompter() },
        { rotulo: '🔁 Acervo de novo', acao: () => mostrarVozes() },
      ]);
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'be-ia-vozes';
    for (const v of voices.slice(0, 8)) {
      const c = document.createElement('div');
      c.className = 'be-ia-voz';
      c.innerHTML = `
        <div class="be-ia-voz-nome">${esc(v.name || 'Voz')}</div>
        <div class="be-ia-voz-acoes">
          ${v.preview_url ? `<button class="be-ia-chip" data-act="ouvir">▶ Prévia</button>` : ''}
          <button class="be-ia-btn-acao" data-act="usar">Usar</button>
        </div>`;
      let audio = null;
      c.querySelector('[data-act="ouvir"]')?.addEventListener('click', () => {
        if (audio) { audio.pause(); audio = null; return; }
        audio = new Audio(v.preview_url);
        audio.play().catch(() => {});
        audio.addEventListener('ended', () => { audio = null; });
      });
      c.querySelector('[data-act="usar"]').addEventListener('click', () => {
        if (audio) audio.pause();
        gerarNarracaoTTS(v);
      });
      grid.appendChild(c);
    }
    msgs.appendChild(grid);
    msgs.scrollTop = msgs.scrollHeight;
  }

  /** duração real de um áudio remoto (metadata) — com teto de espera */
  function medirDuracao(url) {
    return new Promise((resolve) => {
      const a = new Audio();
      const timer = setTimeout(() => resolve(null), 12000);
      a.addEventListener('loadedmetadata', () => {
        clearTimeout(timer);
        resolve(Number.isFinite(a.duration) && a.duration > 0 ? a.duration : null);
      });
      a.addEventListener('error', () => { clearTimeout(timer); resolve(null); });
      a.preload = 'metadata';
      a.src = url;
    });
  }

  async function gerarNarracaoTTS(voz) {
    document.querySelector('.be-ia-vozes')?.remove();
    bolha('user', 'Voz: ' + (voz.name || 'do acervo'));
    fluxo.historico.push({ role: 'user', text: `[escolheu a voz "${voz.name}" do acervo]` });
    bolha('assistant', 'Gravando a narração inteira com essa voz — trecho por trecho, já no tempo certo do vídeo. Uns segundos… 🎙');
    const d = digitando();
    try {
      const j = await chamarAction({
        action: 'gerar-voz',
        chunks: fluxo.chunks.map((c) => c.texto),
        voice_id: voz.voice_id || null,
        language: fluxo.idioma,
      });
      const narracao = [];
      for (let i = 0; i < fluxo.chunks.length; i++) {
        const url = j.urls[i];
        if (!url) continue;
        const dur = await medirDuracao(url);
        if (!dur) throw new Error('não consegui medir um dos áudios');
        narracao.push({ url, dur, fala_in: 0, fala_out: dur, offset_ms: fluxo.chunks[i].offset_ms, texto: fluxo.chunks[i].texto });
      }
      if (!narracao.length) throw new Error('nenhum áudio gerado');
      fluxo.narracao = narracao;
      fluxo.voz = { tipo: 'acervo', nome: voz.name || 'acervo' };
      salvarFluxo();
      d.fim();
      etapaLegenda();
    } catch (e) {
      d.fim();
      bolha('assistant', (e.message || 'A voz falhou.') + ' Bora tentar de novo?');
      chips([
        { rotulo: '🔁 Tentar de novo', acao: () => gerarNarracaoTTS(voz) },
        { rotulo: '🎙 Outra voz', acao: () => mostrarVozes() },
      ]);
    }
  }

  // ── TELEPROMPTER: gravar a própria voz, trecho a trecho ───────────────────
  // Aparo de respiro das PONTAS medido de verdade (RMS por janela): o que
  // entra no render é só a fala — o "corte de respiros" da ideia, na prática.
  async function medirFala(blob) {
    try {
      const ctxA = new (window.AudioContext || window.webkitAudioContext)();
      const buf = await ctxA.decodeAudioData(await blob.arrayBuffer());
      const ch = buf.getChannelData(0);
      const win = Math.floor(buf.sampleRate * 0.03);
      let ini = 0, fim = buf.duration;
      const nivel = (i0) => {
        let s = 0;
        for (let i = i0; i < Math.min(i0 + win, ch.length); i++) s += ch[i] * ch[i];
        return Math.sqrt(s / win);
      };
      // limiar relativo ao pico do próprio áudio (gravação baixa não quebra)
      let pico = 0;
      for (let i = 0; i < ch.length; i += win) pico = Math.max(pico, nivel(i));
      const limiar = Math.max(0.004, pico * 0.08);
      for (let i = 0; i < ch.length; i += win) { if (nivel(i) > limiar) { ini = i / buf.sampleRate; break; } }
      for (let i = ch.length - win; i >= 0; i -= win) { if (nivel(i) > limiar) { fim = (i + win) / buf.sampleRate; break; } }
      ctxA.close();
      if (fim - ini < 0.2) { ini = 0; fim = buf.duration; }   // detecção falhou: usa inteiro
      return { dur_total: buf.duration, fala_in: Math.max(0, ini - 0.06), fala_out: Math.min(buf.duration, fim + 0.08) };
    } catch {
      return null;
    }
  }

  async function teleprompter() {
    if (!navigator.mediaDevices?.getUserMedia) {
      bolha('assistant', 'Teu navegador não liberou o microfone aqui. Usa uma voz do acervo, ou tenta pelo Chrome/Edge.');
      chips([{ rotulo: '🎙 Vozes do acervo', acao: () => mostrarVozes() }]);
      return;
    }
    let stream = null;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch {
      bolha('assistant', 'Sem permissão do microfone. Libera o mic pro site e clica de novo — ou usa uma voz do acervo.');
      chips([
        { rotulo: '🎤 Tentar de novo', acao: () => teleprompter() },
        { rotulo: '🎙 Vozes do acervo', acao: () => mostrarVozes() },
      ]);
      return;
    }
    bolha('user', 'Vou gravar minha voz');
    fluxo.historico.push({ role: 'user', text: '[vai gravar a própria narração no teleprompter]' });
    const gravacoes = [];
    let idx = 0;
    const tela = document.createElement('div');
    tela.className = 'be-ia-preview-fundo';
    tela.id = 'beIaTele';
    const render = () => {
      const c = fluxo.chunks[idx];
      tela.innerHTML = `
        <div class="be-ia-tele">
          <div class="be-ia-tele-passo">trecho ${idx + 1} de ${fluxo.chunks.length}</div>
          <div class="be-ia-tele-texto">${esc(c.texto)}</div>
          <div class="be-ia-tele-acoes">
            <button class="be-ia-btn-acao" id="beTeleRec">⏺ Gravar</button>
            <button class="be-ia-btn-acao sec" id="beTeleCancel">✕ Sair</button>
          </div>
          <div class="be-ia-tele-dica">aperta Gravar, lê o trecho, e para — eu corto os respiros das pontas</div>
        </div>`;
      let rec = null, pedacos = [];
      const bRec = tela.querySelector('#beTeleRec');
      bRec.addEventListener('click', async () => {
        if (!rec) {
          pedacos = [];
          rec = new MediaRecorder(stream);
          rec.ondataavailable = (e) => pedacos.push(e.data);
          rec.onstop = async () => {
            const blob = new Blob(pedacos, { type: rec.mimeType || 'audio/webm' });
            bRec.textContent = '…processando';
            const m = (await medirFala(blob)) || { dur_total: 0, fala_in: 0, fala_out: 0 };
            if (m.dur_total < 0.4) { render(); return; }
            const b64 = btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
            try {
              const j = await chamarAction({ action: 'upload-voz', audio_b64: b64, mime: 'audio/webm' });
              gravacoes[idx] = { url: j.url, dur: m.fala_out - m.fala_in, fala_in: m.fala_in, fala_out: m.fala_out, offset_ms: fluxo.chunks[idx].offset_ms, texto: fluxo.chunks[idx].texto };
              idx++;
              if (idx < fluxo.chunks.length) render();
              else {
                tela.remove();
                stream.getTracks().forEach((t) => t.stop());
                fluxo.narracao = gravacoes.filter(Boolean);
                fluxo.voz = { tipo: 'propria', nome: 'sua voz' };
                salvarFluxo();
                etapaLegenda();
              }
            } catch (e) {
              bRec.textContent = '⏺ Gravar de novo';
              rec = null;
            }
          };
          rec.start();
          bRec.textContent = '⏹ Parar';
        } else {
          rec.stop();
          rec = null;
        }
      });
      tela.querySelector('#beTeleCancel').addEventListener('click', () => {
        tela.remove();
        stream.getTracks().forEach((t) => t.stop());
        bolha('assistant', 'Sem problema. Quer usar uma voz do acervo então?');
        chips([{ rotulo: '🎙 Vozes do acervo', acao: () => mostrarVozes() }]);
      });
    };
    render();
    el.appendChild(tela);
  }

  // ── TIJOLO 5 (13/08): o estilo da legenda ─────────────────────────────────

  const ESTILOS_LEGENDA = [
    { id: 'clean', nome: 'Clean', color: '#FFFFFF', stroke: '#000000' },
    { id: 'impacto', nome: 'Impacto', color: '#FFE84D', stroke: '#000000' },
    { id: 'tarja', nome: 'Tarja', color: '#FFFFFF', box: '#000000' },
    { id: 'neon', nome: 'Neon', color: '#7DF3FF', stroke: '#003A55' },
    { id: 'sem', nome: 'Sem legenda' },
  ];

  async function etapaLegenda() {
    fluxo.etapa = 'escolher_legenda';
    syncEtapa();
    salvarFluxo();
    await rodadaBlublu(null);
    const grid = document.createElement('div');
    grid.className = 'be-ia-estilos';
    for (const e2 of ESTILOS_LEGENDA) {
      const c = document.createElement('button');
      c.className = 'be-ia-estilo';
      c.innerHTML = e2.id === 'sem'
        ? `<span class="be-ia-estilo-demo be-ia-estilo-sem">—</span><span>${esc(e2.nome)}</span>`
        : `<span class="be-ia-estilo-demo" style="color:${e2.color};${e2.box ? 'background:' + e2.box + ';padding:2px 8px;border-radius:4px;' : ''}${e2.stroke ? 'text-shadow:-1px -1px 0 ' + e2.stroke + ',1px -1px 0 ' + e2.stroke + ',-1px 1px 0 ' + e2.stroke + ',1px 1px 0 ' + e2.stroke + ';' : ''}">Sua legenda</span><span>${esc(e2.nome)}</span>`;
      c.addEventListener('click', () => {
        grid.remove();
        fluxo.estiloLegenda = e2;
        salvarFluxo();
        bolha('user', 'Legenda: ' + e2.nome);
        fluxo.historico.push({ role: 'user', text: `[escolheu o estilo de legenda: ${e2.nome}]` });
        if (e2.id === 'sem') { etapaMusica(); return; }
        escolherPosicaoLegenda();
      });
      grid.appendChild(c);
    }
    msgs.appendChild(grid);
    msgs.scrollTop = msgs.scrollHeight;
  }

  // posição e tamanho da legenda À ESCOLHA (user 14/08) — antes era fixo
  // embaixo/médio e a pessoa não mandava em nada
  function escolherPosicaoLegenda() {
    bolha('assistant', 'E onde ela fica na tela?');
    chips([
      { rotulo: '⬆️ No topo', acao: () => { fluxo.legendaPos = 'topo'; depoisDaPos('no topo'); } },
      { rotulo: '↔️ No meio', acao: () => { fluxo.legendaPos = 'meio'; depoisDaPos('no meio'); } },
      { rotulo: '⬇️ Embaixo', acao: () => { fluxo.legendaPos = 'baixo'; depoisDaPos('embaixo'); } },
    ]);
    const depoisDaPos = (nome) => {
      salvarFluxo();
      bolha('user', 'Posição: ' + nome);
      bolha('assistant', 'E o tamanho da letra?');
      chips([
        { rotulo: 'Pequena', acao: () => { fluxo.legendaTam = 'small'; fecha('pequena'); } },
        { rotulo: 'Média', acao: () => { fluxo.legendaTam = 'medium'; fecha('média'); } },
        { rotulo: 'Grande', acao: () => { fluxo.legendaTam = 'large'; fecha('grande'); } },
      ]);
    };
    const fecha = (nome) => {
      salvarFluxo();
      bolha('user', 'Tamanho: ' + nome);
      fluxo.historico.push({ role: 'user', text: `[legenda ${fluxo.legendaPos}, letra ${nome}]` });
      etapaMusica();
    };
  }

  // ── MÚSICA DE FUNDO (user 14/08): da biblioteca curada, volume BAIXO ─────
  // (0.18 fixo — não pode brigar com a narração; o limiter do render segura picos)
  const VOLUME_MUSICA = 0.18;
  async function etapaMusica() {
    fluxo.etapa = 'escolher_musica';
    syncEtapa();
    salvarFluxo();
    bolha('assistant', '🎵 Quer uma música de fundo? Ela entra BAIXINHA, por trás da narração. Busca pelo clima (ex.: "épica", "lofi", "tensão") ou segue sem.');
    const caixa = document.createElement('div');
    caixa.className = 'be-ia-musica';
    caixa.innerHTML = `
      <div class="be-ia-musica-busca">
        <input type="text" id="beIaMusQ" placeholder="🔎 Buscar música pelo clima…" maxlength="60"/>
        <button type="button" id="beIaMusGo" class="be-ia-chip">Buscar</button>
        <button type="button" id="beIaMusSem" class="be-ia-chip">🔇 Sem música</button>
      </div>
      <div id="beIaMusLista" class="be-ia-musica-lista"></div>`;
    msgs.appendChild(caixa);
    msgs.scrollTop = msgs.scrollHeight;
    let tocando = null;
    const buscar = async () => {
      const lista = caixa.querySelector('#beIaMusLista');
      lista.innerHTML = '<div class="be-ia-dim">buscando…</div>';
      let r = null;
      try { r = await api.audioSearch(caixa.querySelector('#beIaMusQ').value.trim(), 'music'); } catch {}
      const results = (r?.results || []).slice(0, 12);
      lista.innerHTML = '';
      if (!results.length) {
        lista.innerHTML = '<div class="be-ia-dim">Nada encontrado — tenta outro clima, ou segue sem música.</div>';
        return;
      }
      for (const m of results) {
        const row = document.createElement('div');
        row.className = 'be-ia-musica-row';
        row.innerHTML = `<button type="button" class="be-ia-chip" data-mp>▶</button>
          <span class="be-ia-musica-nome">${esc(m.name)}<i>${esc(m.category || '')}${m.duration ? ' · ' + Math.round(m.duration) + 's' : ''}</i></span>
          <button type="button" class="be-ia-chip" data-mu>Usar</button>`;
        row.querySelector('[data-mp]').addEventListener('click', (ev) => {
          if (tocando) { tocando.pause(); tocando = null; }
          tocando = new Audio(m.preview || m.url);
          tocando.volume = 0.5;
          tocando.play().catch(() => {});
          ev.target.textContent = '♪';
          setTimeout(() => { ev.target.textContent = '▶'; tocando?.pause(); }, 8000);
        });
        row.querySelector('[data-mu]').addEventListener('click', () => {
          if (tocando) { tocando.pause(); tocando = null; }
          caixa.remove();
          fluxo.musica = { url: m.url, nome: m.name, dur: Number(m.duration) || null };
          salvarFluxo();
          bolha('user', '🎵 Música: ' + m.name);
          fluxo.historico.push({ role: 'user', text: `[escolheu música de fundo: ${m.name}]` });
          etapaMontagem();
        });
        lista.appendChild(row);
      }
    };
    caixa.querySelector('#beIaMusGo').addEventListener('click', buscar);
    caixa.querySelector('#beIaMusQ').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') buscar(); });
    caixa.querySelector('#beIaMusSem').addEventListener('click', () => {
      if (tocando) { tocando.pause(); tocando = null; }
      caixa.remove();
      fluxo.musica = null;
      salvarFluxo();
      bolha('user', 'Sem música de fundo.');
      etapaMontagem();
    });
    buscar();
  }

  // ── TIJOLO 6 (13/08): MONTAGEM — solver + render real ─────────────────────

  function medirVideo(url) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      const timer = setTimeout(() => resolve(null), 12000);
      v.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve(v.duration || null); });
      v.addEventListener('error', () => { clearTimeout(timer); resolve(null); });
      v.preload = 'metadata';
      v.src = url;
    });
  }

  async function etapaMontagem() {
    fluxo.etapa = 'montagem';
    syncEtapa();
    salvarFluxo();
    await rodadaBlublu(null);
    const durVideo = (await medirVideo(fluxo.videoLimpoUrl)) || Number(fluxo.video.duracao_segundos) || 30;
    const plano = montarLinhaDoTempo({
      duracaoVideo: durVideo,
      chunks: fluxo.narracao.map((n) => ({ offset_ms: n.offset_ms, dur: n.dur, texto: n.texto })),
    });
    // honestidade em números ANTES de renderizar
    if (plano.estouro_s > 0.5) {
      bolha('assistant', `⚠️ A narração ficou ${plano.estouro_s.toFixed(1)}s MAIOR que o vídeo (${durVideo.toFixed(0)}s) — o final falaria sobre tela preta. Recomendo um roteiro mais curto ou regravar mais rápido.`);
      chips([
        { rotulo: '▶️ Montar mesmo assim', acao: () => rodarRender(plano, durVideo) },
        { rotulo: '🔁 Trocar o roteiro', acao: () => { fluxo.chunks = null; fluxo.narracao = null; fluxo.etapa = 'escolher_roteiro'; syncEtapa(); salvarFluxo(); mostrarRoteiros(fluxo.roteiros); } },
        { rotulo: '🎤 Regravar', acao: () => { fluxo.narracao = null; salvarFluxo(); etapaVoz(); } },
      ]);
      return;
    }
    if (plano.atraso_max_s > 2) {
      bolha('assistant', `Aviso honesto: em um trecho a fala nova é mais longa que a original, então ela termina ${plano.atraso_max_s.toFixed(1)}s depois do momento exato da cena. Nada quebra — só não fica 100% colado no acontecimento.`);
    }
    rodarRender(plano, durVideo);
  }

  function textosDoPlano(plano) {
    const est = fluxo.estiloLegenda;
    if (!est || est.id === 'sem') return [];
    // O drawtext do render desenha CONTENT numa linha só (não quebra):
    // então cada LINHA do layout vira um text próprio com o y escalonado —
    // sem isso a legenda sangrava pras bordas (medido no E2E de 13/08).
    const out = [];
    for (const item of plano.itens) {
      // posição e tamanho À ESCOLHA (user 14/08): topo/meio/baixo + P/M/G
      const tam = ['small', 'medium', 'large'].includes(fluxo.legendaTam) ? fluxo.legendaTam : 'medium';
      const yEscolhido = fluxo.legendaPos === 'topo' ? 0.18 : fluxo.legendaPos === 'meio' ? 0.5 : 0.78;
      const lay = layoutDoTexto({ content: item.texto, x_pct: 0.5, y_pct: yEscolhido, font: 'Anton', size: tam }, TEXT_SIZE_PCT[tam]);
      const linhas = lay.linhas?.length ? lay.linhas : [item.texto];
      const altura = (lay.fontePct || 0.06) * 1.15 * (1080 / 1920);   // fração da ALTURA por linha
      const yBase = (lay.yPct || yEscolhido) - ((linhas.length - 1) * altura) / 2;
      linhas.forEach((linha, i) => {
        out.push({
          content: linha, lines: [linha], font_pct: lay.fontePct || 0.06,
          font: 'Anton', x_pct: 0.5, y_pct: Math.min(0.94, Math.max(0.06, yBase + i * altura)),
          start_sec: item.start, end_sec: item.start + item.dur,
          color: est.color, ...(est.box ? { box: est.box } : {}), ...(est.stroke ? { stroke: est.stroke } : {}),
        });
      });
    }
    return out;
  }

  async function rodarRender(plano, durVideo) {
    const audio_clips = plano.itens.map((item, i) => ({
      url: fluxo.narracao[i].url,
      start: item.start,
      source_in: fluxo.narracao[i].fala_in,
      source_out: fluxo.narracao[i].fala_out,
    }));
    // música de fundo (user 14/08): BAIXINHA por trás da narração, do início
    // ao fim do vídeo (ou até a música acabar)
    if (fluxo.musica?.url) {
      audio_clips.push({
        url: fluxo.musica.url, start: 0, source_in: 0,
        source_out: Math.min(Number(fluxo.musica.dur) || durVideo, durVideo),
        volume: VOLUME_MUSICA,
      });
    }
    let inicio = null;
    try {
      inicio = await chamarAction({
        action: 'render',
        payload: {
          video_url: fluxo.videoLimpoUrl, dur_video: durVideo,
          audio_clips, texts: textosDoPlano(plano),
        },
      });
    } catch (e) {
      bolha('assistant', e.message || 'A montagem não começou.');
      chips([{ rotulo: '🔁 Tentar de novo', acao: () => etapaMontagem() }]);
      return;
    }
    bolha('assistant', 'Montando: narração no tempo certo + legenda queimada + arquivo novo. Acompanha aí: 🎬');
    const prog = document.createElement('div');
    prog.className = 'be-ia-prog';
    prog.innerHTML = `
      <div class="be-ia-prog-barra"><div class="be-ia-prog-fill" id="beIaRenderFill"></div></div>
      <div class="be-ia-prog-info"><span id="beIaRenderStage">renderizando…</span><span id="beIaRenderPct">0%</span></div>`;
    msgs.appendChild(prog);
    msgs.scrollTop = msgs.scrollHeight;
    let erros2 = 0;
    const poll = setInterval(async () => {
      let st = null;
      try { st = await chamarAction({ action: 'render-status', job_id: inicio.job_id }); }
      catch { if (++erros2 >= 5) { clearInterval(poll); bolha('assistant', 'Perdi o contato com a montagem. Tenta de novo.'); chips([{ rotulo: '🔁 Montar de novo', acao: () => etapaMontagem() }]); } return; }
      const pct = Math.max(2, Math.min(99, Number(st.progress) || 2));
      const fill = document.getElementById('beIaRenderFill');
      if (fill) {
        fill.style.width = (st.status === 'done' ? 100 : pct) + '%';
        document.getElementById('beIaRenderPct').textContent = (st.status === 'done' ? 100 : pct) + '%';
      }
      if (st.status === 'done' && st.output_url) {
        clearInterval(poll);
        fluxo.renderUrl = st.output_url;
        salvarFluxo();
        etapaAprovacao();
      }
      if (st.status === 'error') {
        clearInterval(poll);
        bolha('assistant', st.error || 'A montagem falhou. Bora tentar de novo?');
        chips([{ rotulo: '🔁 Montar de novo', acao: () => etapaMontagem() }]);
      }
    }, 4000);
  }

  // ── TIJOLO 7 (13/08): aprovação → pacote de publicação + download ─────────

  async function etapaAprovacao() {
    fluxo.etapa = 'aprovacao';
    syncEtapa();
    salvarFluxo();
    const player = document.createElement('div');
    player.className = 'be-ia-player';
    player.innerHTML = `<video src="${esc(fluxo.renderUrl)}" controls playsinline></video>`;
    msgs.appendChild(player);
    msgs.scrollTop = msgs.scrollHeight;
    fluxo.historico.push({ role: 'user', text: '[o vídeo FINAL montado está na tela]' });
    await rodadaBlublu(null, false, 'thumbsup');
    chips([
      { rotulo: '✅ Aprovar', acao: () => etapaEntrega() },
      { rotulo: '🎙 Trocar a voz', acao: () => { fluxo.narracao = null; fluxo.renderUrl = null; salvarFluxo(); etapaVoz(); } },
      { rotulo: '💬 Trocar a legenda', acao: () => { fluxo.renderUrl = null; salvarFluxo(); etapaLegenda(); } },
      { rotulo: '📝 Trocar o roteiro', acao: () => { fluxo.chunks = null; fluxo.narracao = null; fluxo.renderUrl = null; fluxo.etapa = 'escolher_roteiro'; syncEtapa(); salvarFluxo(); mostrarRoteiros(fluxo.roteiros); } },
    ]);
  }

  async function etapaEntrega() {
    fluxo.etapa = 'entrega';
    syncEtapa();
    salvarFluxo();
    fluxo.historico.push({ role: 'user', text: '[APROVOU o vídeo final]' });
    const d = digitando();
    let pacote = fluxo.pacote || null;
    if (!pacote) {
      try {
        pacote = await chamarAction({
          action: 'titulo-tags',
          roteiro: fluxo.roteiro.texto, idioma: fluxo.idioma,
          titulo_original: fluxo.video.titulo,
        });
        fluxo.pacote = pacote;
        salvarFluxo();
      } catch {}
    }
    d.fim();
    const caixa = document.createElement('div');
    caixa.className = 'be-ia-entrega';
    const tags = (pacote?.tags || []).join(', ');
    caixa.innerHTML = `
      <div class="be-ia-entrega-sec"><b>Títulos</b>${(pacote?.titulos || []).map((t) =>
        `<div class="be-ia-copiavel" data-copia="${esc(t)}">${esc(t)} <span>copiar</span></div>`).join('') || '<div class="be-ia-copiavel">—</div>'}</div>
      <div class="be-ia-entrega-sec"><b>Descrição</b>
        <div class="be-ia-copiavel" data-copia="${esc(pacote?.descricao || '')}">${esc(pacote?.descricao || '—')} <span>copiar</span></div></div>
      <div class="be-ia-entrega-sec"><b>Tags</b>
        <div class="be-ia-copiavel" data-copia="${esc(tags)}">${esc(tags || '—')} <span>copiar</span></div></div>
      <button class="be-ia-btn-acao" id="beIaBaixar">⬇ Baixar o vídeo</button>`;
    caixa.querySelectorAll('.be-ia-copiavel[data-copia]').forEach((elC) => {
      elC.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(elC.dataset.copia); elC.classList.add('ok'); setTimeout(() => elC.classList.remove('ok'), 900); } catch {}
      });
    });
    caixa.querySelector('#beIaBaixar').addEventListener('click', async () => {
      const b = caixa.querySelector('#beIaBaixar');
      b.disabled = true; b.textContent = '⬇ Baixando…';
      try {
        const blob = await (await fetch(fluxo.renderUrl)).blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'bluetube-criar-com-ia.mp4';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      } catch { window.open(fluxo.renderUrl, '_blank'); }
      b.disabled = false; b.textContent = '⬇ Baixar o vídeo';
    });
    msgs.appendChild(caixa);
    msgs.scrollTop = msgs.scrollHeight;
    await rodadaBlublu(null, false, 'thumbsup');
  }

  // ── envio do usuário ──────────────────────────────────────────────────────
  let ocupado = false;
  async function enviarTexto(texto) {
    if (!texto || ocupado) return;
    // na escolha de idioma, o que for digitado É o idioma ("✍️ Outro")
    if (fluxo.etapa === 'escolher_idioma') {
      escolherIdioma(texto.slice(0, 40));
      return;
    }
    ocupado = true; btnEnviar.disabled = true;
    bolha('user', texto);
    fluxo.historico.push({ role: 'user', text: texto });
    const out = await rodadaBlublu(texto);
    if (out && Array.isArray(out.videos)) mostrarVideos(out.videos);
    ocupado = false; btnEnviar.disabled = false;
    input.focus();
  }
  function enviar() {
    const texto = input.value.trim();
    if (!texto) return;
    input.value = '';
    input.placeholder = 'Responde aqui pro Blublu…';
    enviarTexto(texto);
  }
  btnEnviar.addEventListener('click', enviar);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') enviar(); });

  // ── RETOMADA: trabalho em andamento não evapora (a limpeza custa!) ────────
  function retomarFluxo(salvo) {
    Object.assign(fluxo, {
      etapa: salvo.etapa || 'video_escolhido',
      video: salvo.video,
      arquivoUrl: salvo.arquivoUrl || null,
      videoLimpoUrl: salvo.videoLimpoUrl || null,
      idioma: salvo.idioma || null,
      transcript: salvo.transcript || null,
      roteiros: salvo.roteiros || null,
      roteiro: salvo.roteiro || null,
      chunks: salvo.chunks || null,
      narracao: salvo.narracao || null,
      voz: salvo.voz || null,
      estiloLegenda: salvo.estiloLegenda || null,
      legendaPos: salvo.legendaPos || null,
      legendaTam: salvo.legendaTam || null,
      musica: salvo.musica || null,
      renderUrl: salvo.renderUrl || null,
      pacote: salvo.pacote || null,
      historico: Array.isArray(salvo.historico) ? salvo.historico : [],
    });
    syncEtapa();
    if (fluxo.renderUrl && fluxo.etapa === 'entrega') {
      bolha('assistant', `Retomando "${fluxo.video.titulo}" — teu vídeo FINAL já estava pronto e aprovado. Pacote de publicação aí embaixo:`);
      etapaEntrega();
    } else if (fluxo.renderUrl) {
      bolha('assistant', `Retomando "${fluxo.video.titulo}" — a montagem já estava PRONTA. Assiste e decide:`);
      etapaAprovacao();
    } else if (fluxo.narracao && (fluxo.etapa === 'escolher_musica' || fluxo.estiloLegenda)) {
      // legenda já decidida: retoma na MÚSICA (etapa nova 14/08)
      bolha('assistant', `Retomando "${fluxo.video.titulo}" — legenda pronta. Só falta a música de fundo e montar:`);
      etapaMusica();
    } else if (fluxo.narracao) {
      bolha('assistant', `Retomando "${fluxo.video.titulo}" — narração (${fluxo.voz?.nome || 'gravada'}) guardada. Falta pouco: legenda e montagem.`);
      etapaLegenda();
    } else if (fluxo.roteiro) {
      bolha('assistant', `Retomando "${fluxo.video.titulo}" — vídeo limpo e roteiro ${fluxo.roteiro.nome} em ${fluxo.idioma} guardados. Bora pra voz:`);
      etapaVoz();
    } else if (fluxo.roteiros) {
      bolha('assistant', `Retomando "${fluxo.video.titulo}" — as versões do roteiro em ${fluxo.idioma} já estavam prontas (não gerei de novo). Escolhe a tua:`);
      fluxo.etapa = 'escolher_roteiro';
      syncEtapa();
      mostrarRoteiros(fluxo.roteiros);
    } else if (fluxo.videoLimpoUrl) {
      bolha('assistant', `Retomando "${fluxo.video.titulo}" — teu vídeo já tá tratado e GUARDADO (a limpeza não se perde nem se paga de novo). Olha ele aí:`);
      const player = document.createElement('div');
      player.className = 'be-ia-player';
      player.innerHTML = `<video src="${esc(fluxo.videoLimpoUrl)}" controls playsinline></video>`;
      msgs.appendChild(player);
      msgs.scrollTop = msgs.scrollHeight;
      fronteiraDoTijolo();
    } else if (fluxo.arquivoUrl) {
      bolha('assistant', `Retomando "${fluxo.video.titulo}" — o arquivo já tá aqui. Bora marcar a legenda:`);
      fluxo.etapa = 'marcar_legenda';
      syncEtapa();
      montarMarcador(fluxo.arquivoUrl);
    } else {
      bolha('assistant', `Retomando: você tinha escolhido "${fluxo.video.titulo}". Deixa eu puxar o arquivo de novo:`);
      etapaMarcarLegenda();
    }
  }

  function aberturaNormal() {
    rodadaBlublu(null, true).then((out) => {
      if (!out) {
        // API fora do ar na abertura: a experiência ainda se apresenta
        bolha('assistant', 'Eu sou o Blublu — aqui eu monto teu vídeo do zero: você escolhe um viral, eu cuido da edição inteira. Me conta: o que você quer criar hoje?');
      } else if (Array.isArray(out.videos)) {
        mostrarVideos(out.videos);   // ele pode decidir já abrir com sugestões
      }
    });
  }

  // ── abertura ──────────────────────────────────────────────────────────────
  syncEtapa();
  const salvo = carregarFluxo();
  if (salvo) {
    bolha('assistant', `Opa — a gente tem trabalho em andamento: "${(salvo.video?.titulo || '').slice(0, 80)}". Quer continuar de onde parou ou começar outro do zero?`);
    chips([
      { rotulo: '▶️ Continuar de onde parei', acao: () => retomarFluxo(salvo) },
      { rotulo: '🗑 Começar do zero', acao: () => { limparFluxo(); aberturaNormal(); } },
    ]);
  } else {
    aberturaNormal();
  }
  input.focus();

  // ── sair ──────────────────────────────────────────────────────────────────
  function destruir() {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', aoRedimensionar);
    el.remove();
    onExit?.();
  }
  $('#beIaVoltar').addEventListener('click', destruir);
  return { destroy: destruir, _fluxo: fluxo };
}
