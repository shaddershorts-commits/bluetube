// editor-v1/ui/shell.js
// Monta a UI no layout CapCut: preview central + painel de propriedades
// CONTEXTUAL a direita (muda com a selecao) + timeline multi-track embaixo
// com cabecalhos de track. Store continua a unica fonte de verdade.

import * as act from '../core/actions.js';
import { totalDuration, canExport, timelineSegments, captionAudioPlan, mainTrackItems, compoundTemAudio, propriedadeDaCena, segmentAt, mediaUrlFor, fitDaCena, formatoDoProjeto } from '../core/selectors.js';
import { TEXT_FONTS, TEXT_SIZES, MAX_AUDIO_LANE, FORMATOS } from '../core/schema.js';
import { ANIMACOES } from '../core/text-anim.js';
import { agruparFrases, normalizarIdioma, podeMudarCaixa } from '../core/idioma.js';
import { arquivoParaTimeline } from '../core/caption-sync.js';
import { detectarFala, resumoDoCorte } from '../core/silencio.js';
import { scanAudio } from '../preview/audio-scan.js';
import { modeloPorId, estiloDaPalavra } from '../core/caption-styles.js';
import { createCaptionsPanel } from './captions-panel.js';
import { formatTime } from '../timeline/layout.js';
import { createPlayer } from '../preview/player.js';
import { createOverlay } from '../preview/overlay.js';
import { createPip } from '../preview/pip.js';
import { createMaskUI } from '../preview/mask-ui.js';
import { createFrameUI } from '../preview/frame-ui.js';
import { createTransitionsPanel } from './transitions-panel.js';
import { createTransitionFx } from '../preview/transition-fx.js';
import { transicaoPorId, TRANSICOES } from '../core/transitions.js';
import { ANIMACOES_CENA, ANIM_CATEGORIAS, ANIM_POR_ID, progressoDaAnimacao, previewDaAnimacao, previewDoLoop } from '../core/animacoes-cena.js';
import { criarGuardiao } from '../core/guardiao.js';
import {
  CAMPOS_COR, svgDoGrade, vinhetaCss, temAjuste, TODAS_CHAVES,
  FAIXAS_HSL, EIXOS_HSL, CANAIS_CURVA, ANCORAS_CURVA, FAIXAS_RODA, CANAIS_RODA,
} from '../preview/color-grade.js';
import { createTimelineController } from './timeline-controller.js';
import { attachShortcuts, splitSelectedAt } from './shortcuts.js';
import { createThumbnails } from '../timeline/thumbnails.js';
import { createWaveform } from '../timeline/waveform.js';
import { uploadMedia } from '../services/upload.js';
import { createAutosave } from '../services/autosave.js';
import { createExporter } from '../services/exporter.js';
import { api } from '../services/api.js';
import { attachResizers } from './resizer.js';

export function mountEditor(root, store, opts = {}) {
  root.innerHTML = buildTemplate();
  const $ = (sel) => root.querySelector(sel);

  const videoEl = $('#beVideo');
  const videoEl2 = $('#beVideo2');
  // primaryUrl: o player troca o src por take (multi-midia); pro PRINCIPAL a
  // url preferida e o objectURL local (instantaneo, pre-CDN) quando existir
  const player = createPlayer(videoEl, {
    bufferEl: videoEl2,  // double-buffer: pré-carrega o próximo take (sem tela preta)
    primaryUrl: () => {
      const v = store.getState().video;
      if (!v) return null;
      return (localPreview.for === v.url && localPreview.url) ? localPreview.url : v.url;
    },
  }, store);
  const timeline = createTimelineController({
    canvas: $('#beTimeline'),
    store, player,
    onEditText: openTextPanel,
    onOpenCompound: enterCompound,
    // clique no marcador da timeline abre/fecha os parametros da transicao
    onSelectTransition: (between) => selecionarJuncao(between),
    // camada fantasma do arrasto: redesenha os cabecalhos SEM passar pelo store
    // (lambda de proposito — syncTrackHeaders so existe mais abaixo no arquivo)
    onLanesChanged: () => syncTrackHeaders(),
    // botão direito no áudio → "Gerar legenda deste áudio": seleciona o clipe
    // e dispara a mesma geração do painel (que prioriza o áudio do editor)
    onGerarLegenda: (audioId) => {
      store.dispatch(act.selectAudioClip(audioId));
      generateCaptions();
    },
    // botão direito no áudio → "Separar voz × música" (Demucs, 2026-08-14)
    onSepararVoz: (audioId) => separarVozMusica(audioId),
    // botão direito no áudio → "⭐ Adicionar" → músicas/efeitos + renomear
    // (user 14/08). Salva na MESMA lista da aba Favoritos da biblioteca.
    onFavoritarAudio: (audioId, kind) => {
      const a = store.getState().audio_clips.find((k) => k.id === audioId);
      if (!a) return;
      if (!/^https?:\/\//.test(a.url || '')) {
        toast('Esse áudio ainda não tem arquivo próprio (gravação local?). Salva o projeto primeiro.', true);
        return;
      }
      const sugerido = (a.filename || 'áudio').replace(/\.[a-z0-9]+$/i, '');
      const nome = prompt(kind === 'music' ? 'Nome pra salvar em Minhas músicas:' : 'Nome pra salvar em Meus efeitos:', sugerido);
      if (nome == null || !nome.trim()) return;
      const favs = getAudioFavs();
      // O RECORTE VIAJA JUNTO (user 14/08: "salvei só a parte cortada e foi a
      // faixa inteira"): o favorito guarda source_in/out do clipe — usar da
      // biblioteca recoloca EXATAMENTE o trecho salvo. Por isso o dedup é por
      // url+recorte: dois trechos do mesmo arquivo são favoritos diferentes.
      const sIn = a.source_in || 0;
      const sOut = a.source_out || a.media_duration || 0;
      if (favs.some((f) => f.url === a.url && (f.source_in || 0) === sIn && (f.source_out || f.duration) === sOut)) {
        toast('Esse trecho já está nos favoritos ⭐');
        return;
      }
      favs.push({
        name: nome.trim().slice(0, 80), url: a.url, preview: a.url,
        duration: a.media_duration || sOut,
        source_in: sIn, source_out: sOut,
        ...(a.speed ? { speed: a.speed } : {}),
        kind, category: kind === 'music' ? 'Minhas músicas' : 'Meus efeitos',
      });
      try { localStorage.setItem(AUDIO_FAV_KEY, JSON.stringify(favs)); } catch {}
      toast('⭐ Salvo em ' + (kind === 'music' ? 'Minhas músicas' : 'Meus efeitos') + ': ' + nome.trim() + ' (' + Math.round(sOut - sIn) + 's)');
    },
  });

  // ── SEPARAR VOZ × MÚSICA (IA) ──────────────────────────────────────────────
  // Troca o clipe por DOIS stems do MESMO arquivo (voz + música), nascendo com
  // o MESMO recorte/posição/volume — na timeline soa idêntico, mas agora cada
  // lado tem a própria faixa. Job no Replicate via endpoint isolado; os stems
  // ficam no NOSSO Storage (permanentes). 1 gestureId = a troca inteira é UM
  // undo (desfazer devolve o clipe original).
  const separandoAudio = new Set();
  async function separarVozMusica(audioId) {
    const a = store.getState().audio_clips.find((k) => k.id === audioId);
    if (!a) return;
    if (a.kind !== 'extra' || !/^https?:\/\//.test(a.url || '')) {
      toast('Separação vale pra faixas de áudio importadas/da biblioteca. Pro áudio do vídeo: destaca ele primeiro (Ctrl+Shift+S).', true);
      return;
    }
    if (separandoAudio.has(audioId)) { toast('Já estou separando essa faixa — segura aí.'); return; }
    separandoAudio.add(audioId);
    toast('🎙 Separando voz × música com IA…');
    try {
      const chamar = async (body) => {
        const r = await fetch('/api/separar-audio', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: localStorage.getItem('bt_token') || '', ...body }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      };
      const { job_id } = await chamar({ action: 'start', audio_url: a.url });
      let st = null;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        st = await chamar({ action: 'status', job_id });
        if (st.status === 'done' || st.status === 'error') break;
      }
      if (st?.status !== 'done') throw new Error(st?.error || 'A separação não terminou. Tenta de novo.');
      // o clipe pode ter sido editado/apagado durante o job: re-lê o estado
      const atual = store.getState().audio_clips.find((k) => k.id === audioId);
      if (!atual) { toast('A faixa foi apagada durante a separação — os arquivos ficaram na sua biblioteca de resultados.', true); return; }
      const g = 'sepvoz-' + audioId + '-' + Date.now();
      const base = {
        duration: atual.media_duration, start: atual.start,
        source_in: atual.source_in, source_out: atual.source_out,
        volume: atual.volume, ...(atual.speed ? { speed: atual.speed } : {}),
      };
      const lane = Number.isInteger(atual.lane) ? atual.lane : 0;
      store.dispatch({ ...act.addAudioClip({ ...base, url: st.vocals_url, filename: '🎙 voz — ' + (atual.filename || 'áudio'), lane }), gestureId: g });
      store.dispatch({ ...act.addAudioClip({ ...base, url: st.no_vocals_url, filename: '🎵 música — ' + (atual.filename || 'áudio'), lane: lane + 1 }), gestureId: g });
      store.dispatch({ ...act.deleteAudioClip(audioId), gestureId: g });
      toast('✅ Separado: faixa de VOZ + faixa de MÚSICA no lugar da original (Ctrl+Z desfaz).');
    } catch (e) {
      toast('Separação falhou: ' + (e.message || 'erro'), true);
    } finally {
      separandoAudio.delete(audioId);
    }
  }
  const overlay = createOverlay($('#beOverlay'), store, player, openTextPanel);
  const pip = createPip($('#beOverlay').parentElement, videoEl, store, player);
  // marcador da máscara: arrastar/redimensionar direto no vídeo
  const maskUI = createMaskUI($('#beStage'), store);
  // moldura do vídeo (mover/escalar a cena) — alterna com a máscara pela sub-aba
  const frameUI = createFrameUI($('#beStage'), store, player);
  // efeito da transicao rodando no player (progresso vem do relogio do player)
  const fxTransicao = createTransitionFx($('#beStage'), store, player);
  // AUTORREPARADOR (user 15/08, v2): watchdog do relógio + sentinela
  // CIRÚRGICA do estado — 100% em background (pedido do user: nada na tela),
  // nunca remove conteúdo, tudo logado com [guardião] no console
  const guardiao = criarGuardiao({ store, player });
  fxTransicao.registrarCatalogo(TRANSICOES);
  const exporter = createExporter(store);
  const autosave = createAutosave(store, (s, detail) => {
    // O save é assíncrono e pode terminar DEPOIS do editor ser desmontado
    // (voltar pra home, fechar a aba). Sem esta guarda o callback escrevia num
    // elemento que não existe mais — "Cannot set properties of null" dentro de
    // uma promise, barulho no console que escondia erro de verdade.
    const el = $('#beSaveStatus');
    if (!el) return;
    el.textContent = s === 'saving' ? '◌ salvando…' : s === 'saved' ? '✓ salvo' : s === 'error' ? '⚠ ' + (detail || 'erro ao salvar') : '';
    el.className = 'be-save-status ' + s;
  });
  const detachShortcuts = attachShortcuts({ store, player, timeline });

  // thumbnails/waveforms vivem em registries POR FONTE (ver setupThumbsAndWave)
  // preview local do arquivo recem-enviado (playback instantaneo pre-CDN)
  const localPreview = { url: null, for: null };
  let captionsPanelOpen = false; // painel 💬 Legendas (escolher estilo antes)
  let capChosenPreset = 'classico'; // estilo escolhido pra aplicar ao gerar
  let audioLibOpen = false;      // painel ♪ Áudio (biblioteca)
  let transOpen = false;         // painel ⧓ Transições
  let transArrastando = null;    // id sendo arrastado pra timeline
  let audioLibTab = 'musicas';   // musicas | efeitos | favoritos
  let audioLibQuery = '';
  let audioLibCat = null;        // categoria filtrada (null = todas)
  let filledClipId = null;    // guard: não sobrescreve sliders enquanto arrasta
  let filledAudioId = null;
  let filledOvId = null;
  // mapeamento log do slider de velocidade: value -100..200 -> 0.10x..100x,
  // 0 = 1.00x (controle fino perto de 1x)
  const sliderToSpeed = (v) => Math.min(100, Math.max(0.1, Math.pow(10, v / 100)));
  const speedToSlider = (s) => Math.round(Math.log10(s > 0 ? s : 1) * 100);
  const fmtSpeed = (s) => s.toFixed(2) + 'x';

  // ── expose pra E2E (fora de producao) ──
  if (location.hostname !== 'www.bluetubeviral.com' && location.hostname !== 'bluetubeviral.com') {
    window.__BE__ = { store, player, timeline, guardiao, getState: () => store.getState() };
  }

  // ── reatividade da UI ──
  function sync() {
    const state = store.getState();
    const has = !!state.video;
    // ENTRA DIRETO NO EDITOR (2026-07-29): antes, projeto sem vídeo abria uma
    // tela de importação em cima de tudo — o usuário era obrigado a escolher
    // arquivo ANTES de ver a ferramenta. Agora o editor aparece sempre, e a
    // importação acontece por dentro (rail 🎞 Mídia, Ctrl+O ou arrastar).
    // O #beDrop continua existindo escondido: ele guarda o <input type=file>
    // e a barra de progresso que o fluxo de upload usa.
    $('#beDrop').style.display = 'none';
    $('#beWorkspace').style.display = 'grid';
    // convite discreto no palco enquanto não há mídia nenhuma
    const vazio = $('#beVazio');
    if (vazio) vazio.style.display = (has || state.media?.length || state.audio_clips?.length) ? 'none' : 'flex';
    $('#beProjectName').value = state.nome_projeto || '';
    $('#beTimeLabel').textContent = `${formatTime(player.getTime())} / ${formatTime(totalDuration(state))}`;
    $('#bePlayBtn').textContent = player.isPlaying() ? '⏸' : '▶';
    $('#beUndo').disabled = !store.canUndo();
    $('#beRedo').disabled = !store.canRedo();
    $('#beExportBtn').disabled = !canExport(state);
    $('#beVolVideo').value = state.volumes.video;
    $('#beAudioCount').textContent = state.audio_clips.length
      ? state.audio_clips.length + ' áudio(s) na timeline'
      : 'Nenhum áudio adicional';
    $('#beAspect').value = state.aspect_strategy;
    // PROPORÇÃO DO PROJETO (user 14/08): o palco segue o formato escolhido —
    // e o export usa as MESMAS dimensões (formatoDoProjeto é o ponto único).
    const fp = formatoDoProjeto(state);
    const arStr = fp.ar.toFixed(5);
    const stageEl = $('#beStage');
    if (stageEl.style.getPropertyValue('--be-arn') !== arStr) {
      stageEl.style.setProperty('--be-arn', arStr);
    }
    const fmtDef = FORMATOS.find(x => x.id === fp.id);
    $('#beFormatoBtn').textContent = (fp.ar > 1.02 ? '▭ ' : fp.ar < 0.98 ? '▯ ' : '□ ')
      + (fp.id === 'original' || fp.id === 'custom' ? (fmtDef?.nome || fp.id) : fp.id);
    $('#beProjSaida').textContent = `Saída: ${fp.w}×${fp.h} `
      + (fp.ar > 1.02 ? 'horizontal' : fp.ar < 0.98 ? 'vertical' : 'quadrado');
    // WYSIWYG do formato: letterbox = video inteiro com barras (contain).
    // aplica nos DOIS elementos do double-buffer.
    const fit = state.aspect_strategy === 'letterbox' ? 'contain' : 'cover';
    videoEl.style.objectFit = fit; videoEl2.style.objectFit = fit;
    // O MUDO É DO PLAYER, NÃO DA SHELL (bug 2026-07-29). Aqui havia
    // `videoEl.muted = !!state.audio_detached`, e isso rodava a CADA mudança
    // de estado — ou seja, a cada edição. Dois estragos:
    //   1. ignorava o mudo POR CENA (clip.muted): quem removia o áudio de uma
    //      cena via o som VOLTAR sozinho no próximo ajuste que fizesse;
    //   2. escrevia sempre em #beVideo, mas depois de uma troca de take quem
    //      está em exibição pode ser #beVideo2 — mutava o elemento errado.
    // O player conhece o segmento sob o playhead e qual elemento está visível.
    player.refreshMute();
    // video source: usa preview local (objectURL) quando disponivel —
    // instantaneo e imune a atraso de propagacao do CDN
    if (has) {
      // url preferida do video PRINCIPAL (blob local > CDN) — pip/player leem
      videoEl.dataset.primaryChoice = (localPreview.for === state.video.url && localPreview.url)
        ? localPreview.url : state.video.url;
    }
    if (has && videoEl.dataset.src !== state.video.url) {
      videoEl.dataset.src = state.video.url;
      videoEl.src = videoEl.dataset.primaryChoice;
      videoEl.load();
      setupThumbsAndWave(state);
    }
    // takes importados depois: garante miniatura+waveform deles (idempotente)
    if (has) syncMediaRegistries(state);

    renderTransitionsRow(state);
    syncPropsPanel(state);
    applyClipTransform();
    $('#beCapStyleRow').style.display = state.texts.some(t => t.caption) ? 'flex' : 'none';
  }
  store.subscribe(sync);
  player.onUpdate(() => {
    const state = store.getState();
    $('#beTimeLabel').textContent = `${formatTime(player.getTime())} / ${formatTime(totalDuration(state))}`;
    $('#bePlayBtn').textContent = player.isPlaying() ? '⏸' : '▶';
    if (player.isPlaying()) timeline.followPlayhead();
    applyClipTransform();
  });

  // WYSIWYG da aba Vídeo > Básico: aplica escala + opacidade da cena SOB o
  // playhead no <video> do preview (compound = transform do bloco inteiro).
  function applyClipTransform() {
    aplicarGrade();
    // Efeito da transição: o progresso vem do RELÓGIO DO PLAYER, não de um
    // timer próprio — assim ele acompanha play, pause, scrub e velocidade sem
    // dessincronizar do vídeo.
    try {
      const st0 = store.getState();
      fxTransicao.tick(player.getTime(), mainTrackItems(st0), st0.transitions || []);
    } catch (e) {}
    const state = store.getState();
    const t = player.getTime();
    // TRANSIÇÃO RODANDO: cada elemento recebe o visual da SUA cena — o que
    // sai com a cena que sai, o que entra com a que entra. Aplicar só no
    // ativo deixava máscara/escala VELHAS no vídeo que entrava (2026-08-07).
    const roles = fxTransicao.rolesAtuais?.();
    if (roles) {
      aplicarVisualDaCena(roles.elSai, segmentAt(state, roles.jun - 1e-3));
      aplicarVisualDaCena(roles.elEntra, segmentAt(state, roles.jun + 1e-3));
      return;
    }
    // aplica no elemento ATIVO do double-buffer (pode ter trocado no swap)
    const el = player.getDisplayEl ? player.getDisplayEl() : videoEl;
    aplicarVisualDaCena(el, segmentAt(state, t));
  }

  function aplicarVisualDaCena(el, seg) {
    if (!el) return;
    const state = store.getState();
    // ⚠️ MESMO RESOLVEDOR DO EXPORT (propriedadeDaCena): o preview lia do
    // BLOCO (mainTrackItems) e o export lia do SUB-CLIPE — exatamente opostos.
    // Resultado: máscara/retoque aplicados no composto sumiam no arquivo, e
    // aplicados numa cena de dentro não apareciam na tela. Agora os dois usam
    // a mesma regra: valor da cena vence, na falta herda do bloco.
    const dono = (campo) => propriedadeDaCena(state, seg, campo);
    // mídia com proporção diferente do quadro (vídeo horizontal em projeto
    // vertical) entra INTEIRA — 'contain' por cena, mesma regra do export
    const fitGlobal = state.aspect_strategy === 'letterbox' ? 'contain' : 'cover';
    const of = fitDaCena(state, seg) || fitGlobal;
    if (el.style.objectFit !== of) el.style.objectFit = of;
    const scale = dono('scale') ?? 1;
    const opacity = dono('opacity') ?? 1;
    const sx = dono('mirrored') ? -scale : scale;   // Espelhar = inverte no eixo X
    // POSIÇÃO da cena no quadro (mover o vídeo, como no CapCut) — fração do
    // próprio quadro a partir do centro
    const px = (dono('pos_x') ?? 0) * 100, py = (dono('pos_y') ?? 0) * 100;
    const mover = (px || py) ? `translate(${px.toFixed(2)}%, ${py.toFixed(2)}%) ` : '';
    // ANIMAÇÃO DA CENA (aba Animação, user 14/08): entrada/saída/combinação
    // compõem transform e opacity POR TICK — o relógio manda, igual à transição
    let animTf = '', animOp = 1;
    {
      const tNow = player.getTime();
      const tLocal = tNow - (seg?.tStart ?? 0);
      const durCena = Math.max(0.01, (seg?.tEnd ?? 0) - (seg?.tStart ?? 0));
      const compoe = (id, slot) => {
        const def = ANIM_POR_ID.get(id);
        if (!def) return;
        let fx = null;
        if (slot === 'loop') fx = previewDoLoop(id, tNow);
        else {
          const p = progressoDaAnimacao(def, slot, tLocal, durCena) ?? 1;
          if (p >= 0.999) return;   // assentada: fora da janela não escreve nada
          fx = previewDaAnimacao(id, p);
        }
        if (!fx) return;
        if (fx.transform) animTf += fx.transform + ' ';
        if (fx.opacity != null) animOp *= fx.opacity;
      };
      if (seg?.clip?.anim_in) compoe(seg.clip.anim_in, 'in');
      if (seg?.clip?.anim_out) compoe(seg.clip.anim_out, 'out');
      if (seg?.clip?.anim_loop) compoe(seg.clip.anim_loop, 'loop');
    }
    const tfCena = (scale !== 1 || dono('mirrored') || px || py) ? `${mover}scale(${sx}, ${scale})` : '';
    const tf = (animTf + tfCena).trim();
    if (el.style.transform !== tf) el.style.transform = tf;
    // o transform da cena TAMBÉM viaja em --betf: durante a transição os
    // efeitos vencem o inline (!important) mas compõem a cena via var(--betf,)
    if (tf) el.style.setProperty('--betf', tf);
    else el.style.removeProperty('--betf');
    const op = String(Math.max(0, Math.min(1, opacity * animOp)));
    if (el.style.opacity !== op) el.style.opacity = op;
    // MÁSCARA da cena (WYSIWYG — o Railway aplica igual no export):
    // círculo = radial-gradient (suavizar nativo); retângulo = SVG com rx
    // (cantos) + feGaussianBlur (suavizar). Coordenadas em % do quadro.
    const maskCss = maskCssFor(dono('mask'));
    if (el.style.webkitMaskImage !== maskCss) {
      el.style.webkitMaskImage = maskCss;
      el.style.maskImage = maskCss;
      el.style.webkitMaskRepeat = maskCss ? 'no-repeat' : '';
      el.style.maskRepeat = maskCss ? 'no-repeat' : '';
      el.style.webkitMaskSize = maskCss ? '100% 100%' : '';
      el.style.maskSize = maskCss ? '100% 100%' : '';
    }
  }

  // Proporção da CAIXA onde a máscara é aplicada — não a do arquivo de vídeo.
  //
  // Esta distinção é a diferença entre círculo e oval: o SVG da máscara é
  // esticado até preencher o elemento (preserveAspectRatio="none"), e o palco
  // é sempre 9:16. Usar a proporção INTRÍNSECA do vídeo (o que esta função
  // fazia antes) deformava tudo sempre que a fonte não fosse 9:16 — vídeo em
  // paisagem virava oval deitado. O teste não pegou porque usava fonte 1080x1920,
  // que por coincidência batia com o palco.
  function frameAR() {
    const el = player.getDisplayEl ? player.getDisplayEl() : videoEl;
    const w = el?.clientWidth || 0, h = el?.clientHeight || 0;
    if (w > 0 && h > 0) return w / h;
    return 9 / 16; // antes da primeira medida do layout
  }

  function maskCssFor(m) {
    if (!m) return '';
    // ── ESPAÇO DE COORDENADAS COM A PROPORÇÃO DO QUADRO (fix 2026-07-29) ────
    // Antes o SVG usava viewBox 0 0 100 100 com preserveAspectRatio="none",
    // esticado num quadro 9:16. Consequência: TUDO deformava — o círculo saía
    // oval e o canto arredondado virava elipse ("arredondou o vídeo todo").
    // Agora o viewBox tem a mesma proporção do vídeo, então 1 unidade vale o
    // mesmo na horizontal e na vertical e o desenho sai do jeito que se vê.
    const ar = frameAR();
    const W = 1000, H = Math.round(W / ar);           // ex.: 1000 x 1778 (9:16)
    const cx = m.x_pct * W, cy = m.y_pct * H;
    const std = ((m.feather || 0) / 100) * (Math.min(W, H) * 0.12);
    const blurDef = std > 0
      ? `<filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${std.toFixed(1)}"/></filter>`
      : '';
    const filtro = std > 0 ? ' filter="url(#f)"' : '';

    let forma;
    if (m.shape === 'circle') {
      // CÍRCULO É CÍRCULO: um raio só, em unidades reais. A altura deixa de
      // deformar a forma (o painel esconde o controle de altura no círculo).
      const r = (m.w_pct * W) / 2;
      forma = `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="white"${filtro}/>`;
    } else {
      const rw = m.w_pct * W, rh = m.h_pct * H;
      // raio do canto em unidades reais → canto redondo de verdade, e no
      // máximo vira um "stadium", nunca uma elipse deformada
      const rx = ((m.radius || 0) / 100) * (Math.min(rw, rh) / 2);
      forma = `<rect x="${(cx - rw / 2).toFixed(1)}" y="${(cy - rh / 2).toFixed(1)}" width="${rw.toFixed(1)}" height="${rh.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${rx.toFixed(1)}" fill="white"${filtro}/>`;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${blurDef}${forma}</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }


  // ── RETOQUE: correção de cor da cena (2026-07-29) ────────────────────────
  // O filtro vive num <svg> escondido e é referenciado por url(#id). Um <svg>
  // por editor, reescrito quando o ajuste muda — recriar nó a cada frame
  // causaria piscada.
  let _gradeSig = null;
  let _gradeIdFlip = false;        // id alternado do filtro SVG (anti-stall)
  let _gradeFiltroAtual = '';
  function aplicarGrade() {
    const state = store.getState();
    const t = player.getTime();
    // mesmo resolvedor do export: cena vence, herda do bloco composto
    const g = propriedadeDaCena(state, segmentAt(state, t), 'grade');
    const el = player.getDisplayEl ? player.getDisplayEl() : videoEl;
    const sig = JSON.stringify(g || null);
    if (sig !== _gradeSig) {
      _gradeSig = sig;
      let defs = $('#beGradeDefs');
      if (!defs) {
        defs = document.createElement('div');
        defs.id = 'beGradeDefs';
        defs.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
        root.appendChild(defs);
      }
      // ID ALTERNADO (fix do travamento, user 14/08): antes o innerHTML
      // destruía e recriava o filtro com o MESMO id dezenas de vezes por
      // segundo durante o arrasto do slider, com o vídeo apontando
      // filter:url(#...) — o compositor ficava com a referência pendurada e
      // podia parar de desenhar o vídeo DE VEZ. Agora o filtro novo nasce com
      // o id alternado, o style aponta pro novo, e só então o velho sai:
      // nunca existe um url() apontando pro nada.
      _gradeIdFlip = !_gradeIdFlip;
      const idNovo = _gradeIdFlip ? 'beGradeF_a' : 'beGradeF_b';
      const svg = svgDoGrade(g, idNovo);
      const holder = document.createElement('div');
      if (svg) holder.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg">' + svg + '</svg>';
      const antigos = [...defs.children];
      if (svg) defs.appendChild(holder.firstChild);
      const filtroNovo = temAjuste(g) ? `url(#${idNovo})` : '';
      videoEl.style.filter = filtroNovo; videoEl2.style.filter = filtroNovo;
      for (const a of antigos) a.remove();
      _gradeFiltroAtual = filtroNovo;
    }
    const filtro = _gradeFiltroAtual || '';
    if (videoEl.style.filter !== filtro) { videoEl.style.filter = filtro; videoEl2.style.filter = filtro; }
    // vinheta é sombra POR CIMA (não é cor) — vai no palco
    const vin = vinhetaCss(g);
    const palco = $('#beStage');
    let camada = $('#beVinheta');
    if (vin && !camada) {
      camada = document.createElement('div');
      camada.id = 'beVinheta';
      camada.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:6';
      palco.appendChild(camada);
    }
    if (camada) camada.style.background = vin;
  }

  // controles montados a partir da lista — painel e comportamento não podem
  // sair de sincronia
  function montarPainelGrade() {
    const box = $('#beGradeCampos');
    if (!box || box.dataset.pronto) return;
    box.dataset.pronto = '1';
    let grupoAtual = null;
    for (const c of CAMPOS_COR) {
      if (c.grupo !== grupoAtual) {
        grupoAtual = c.grupo;
        const h = document.createElement('div');
        h.className = 'be-grade-grupo';
        h.textContent = c.grupo;
        box.appendChild(h);
      }
      const linha = document.createElement('div');
      linha.className = 'be-grade-linha';
      const min = c.min != null ? c.min : -100;
      linha.innerHTML =
        '<label>' + c.rotulo + '</label>' +
        '<input type="range" min="' + min + '" max="100" step="1" value="0" data-grade="' + c.id + '"' +
        (c.trilha ? ' class="be-grade-trilha-' + c.trilha + '"' : '') + '/>' +
        '<output data-grade-val="' + c.id + '">0</output>';
      box.appendChild(linha);
    }
    // um listener só pro painel inteiro
    box.addEventListener('input', (e) => {
      const inp = e.target.closest('[data-grade]'); if (!inp) return;
      const st = store.getState();
      const id = st.selected_clip_id; if (id == null) return;
      const campo = inp.dataset.grade;
      const v = parseInt(inp.value, 10) || 0;
      const saida = box.querySelector('[data-grade-val="' + campo + '"]');
      if (saida) saida.textContent = v;
      // gestureId por campo = 1 undo por arraste
      store.dispatch({ ...act.setClipGrade(id, { [campo]: v }), gestureId: 'grade-' + id + '-' + campo });
      aplicarGrade();
    });
    $('#beGradeReset')?.addEventListener('click', () => {
      const st = store.getState();
      if (st.selected_clip_id == null) return;
      store.dispatch(act.setClipGrade(st.selected_clip_id, null));
      preencherPainelGrade(store.getState());
      aplicarGrade();
      toast('Retoque redefinido ✓');
    });

    // ── as 3 abas novas (HSL, Curvas, Roda) ──────────────────────────────
    // Mesmo `data-grade` dos sliders do Básico: o listener acima já cuida do
    // dispatch, e preencherPainelGrade já reflete o estado. Nada de fiação
    // paralela — foi o que deixou as animações de legenda mortas no painel.
    const linhaSlider = (chave, rotulo, classe) =>
      '<div class="be-grade-linha"><label>' + rotulo + '</label>' +
      '<input type="range" min="-100" max="100" step="1" value="0" data-grade="' + chave + '"' +
      (classe ? ' class="' + classe + '"' : '') + '/>' +
      '<output data-grade-val="' + chave + '">0</output></div>';

    const boxHsl = $('#beGradeHsl');
    if (boxHsl && !boxHsl.dataset.pronto) {
      boxHsl.dataset.pronto = '1';
      let html = '<div class="be-dim be-grade-nota">Mexe só na faixa de cor escolhida — o resto da imagem fica.</div>';
      for (const f of FAIXAS_HSL) {
        html += '<div class="be-grade-grupo">' + f.rotulo + '</div>';
        for (const e of EIXOS_HSL) {
          html += linhaSlider(`hsl_${f.id}_${e.id}`, e.rotulo,
            e.id === 'h' ? 'be-grade-trilha-matiz' : e.id === 's' ? 'be-grade-trilha-sat' : '');
        }
      }
      boxHsl.innerHTML = html;
    }

    const boxCur = $('#beGradeCurvas');
    if (boxCur && !boxCur.dataset.pronto) {
      boxCur.dataset.pronto = '1';
      let html = '<div class="be-dim be-grade-nota">Curva tonal: RGB mexe nos três canais juntos; R/G/B, em um só.</div>';
      for (const c of CANAIS_CURVA) {
        html += '<div class="be-grade-grupo">' + c.rotulo + '</div>';
        for (const a of ANCORAS_CURVA) html += linhaSlider(`cur_${c.id}_${a.id}`, a.rotulo);
      }
      boxCur.innerHTML = html;
    }

    const boxRoda = $('#beGradeRoda');
    if (boxRoda && !boxRoda.dataset.pronto) {
      boxRoda.dataset.pronto = '1';
      let html = '<div class="be-dim be-grade-nota">Desloca a cor por faixa de luz: sombras, médios e altas separados.</div>';
      for (const f of FAIXAS_RODA) {
        html += '<div class="be-grade-grupo">' + f.rotulo + '</div>';
        for (const c of CANAIS_RODA) {
          html += linhaSlider(`roda_${f.id}_${c.id}`, c.rotulo, 'be-grade-canal-' + c.id);
        }
      }
      boxRoda.innerHTML = html;
    }

    // o listener de input vive no #beGradeCampos; os painéis novos são irmãos,
    // então cada um ganha o MESMO tratamento (delegação por painel)
    for (const b of [boxHsl, boxCur, boxRoda]) {
      b?.addEventListener('input', (e) => {
        const inp = e.target.closest('[data-grade]'); if (!inp) return;
        const st = store.getState();
        const id = st.selected_clip_id; if (id == null) return;
        const campo = inp.dataset.grade;
        const v = parseInt(inp.value, 10) || 0;
        const saida = b.querySelector('[data-grade-val="' + campo + '"]');
        if (saida) saida.textContent = v;
        store.dispatch({ ...act.setClipGrade(id, { [campo]: v }), gestureId: 'grade-' + id + '-' + campo });
        aplicarGrade();
      });
    }

    $('#beGradeAbas')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-gaba]'); if (!b) return;
      const aba = b.dataset.gaba;
      $('#beGradeAbas').querySelectorAll('[data-gaba]').forEach(x =>
        x.classList.toggle('active', x === b));
      for (const p of root.querySelectorAll('[data-gaba-painel]')) {
        p.style.display = p.dataset.gabaPainel === aba ? '' : 'none';
      }
    });
  }

  // reflete o estado nos controles (troca de cena, undo). Varre TODAS as
  // chaves (Básico + HSL + Curvas + Roda) — uma lista só evita aba que mostra
  // zero enquanto o valor existe no estado.
  function preencherPainelGrade(state) {
    if (!$('#beGradeCampos')) return;
    const clip = state.clips.find(c => c.id === state.selected_clip_id);
    const g = clip?.grade || {};
    for (const chave of TODAS_CHAVES) {
      const inp = root.querySelector('[data-grade="' + chave + '"]');
      const out = root.querySelector('[data-grade-val="' + chave + '"]');
      const v = Math.round(Number(g[chave]) || 0);
      if (inp && document.activeElement !== inp) inp.value = v;
      if (out) out.textContent = v;
    }
  }


  // ── ABA DE TRANSIÇÕES (2026-07-29) ───────────────────────────────────────
  const transPanel = createTransitionsPanel(root, {
    // clique = PRÉVIA, não aplica (regra do user). Toca o trecho em volta da
    // emenda mais próxima com o efeito aplicado, e volta pro ponto de origem.
    onPreview: (id) => previewTransicao(id),
    onDragStart: (id) => { transArrastando = id; timeline.setDropTransicao?.(id); },
  });

  function abrirTransicoes(abrir) {
    transOpen = abrir;
    if (abrir) { audioLibOpen = false; captionsPanelOpen = false; }
    $('#beTransPanel').style.display = abrir ? 'flex' : 'none';
    $('#beMediaPanel') && ($('#beMediaPanel').style.display = abrir ? 'none' : '');
    if (abrir) transPanel.render();
  }
  $('#beAbrirTransicoes')?.addEventListener('click', () => abrirTransicoes(!transOpen));
  $('#beTransFechar')?.addEventListener('click', () => abrirTransicoes(false));

  // Emendas da timeline: onde uma cena termina e a próxima começa.
  function juncoes() {
    const itens = mainTrackItems(store.getState());
    const js = [];
    for (let i = 0; i < itens.length - 1; i++) js.push({ indice: i, t: itens[i].tEnd });
    return js;
  }

  // PRÉVIA: leva a agulha pra pouco antes da emenda mais próxima e toca por
  // cima dela com o efeito. Não grava nada no projeto.
  let previewTimer = null;
  function previewTransicao(id) {
    const def = transicaoPorId(id);
    const js = juncoes();
    if (!def || !js.length) { toast('Corte a cena em duas pra usar transição', true); return; }
    const t = player.getTime();
    const alvo = js.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    const dur = 0.7;
    clearTimeout(previewTimer);
    fxTransicao.tocar(def, alvo.t, dur);
    player.seek(Math.max(0, alvo.t - dur));
    player.play();
    previewTimer = setTimeout(() => player.pause(), (dur * 2) * 1000);
    toast('Prévia: ' + def.nome + ' · arraste até a emenda pra aplicar');
  }

  // Soltar na timeline = aplicar na emenda mais próxima do ponto do drop.
  $('#beTimeline')?.addEventListener('dragover', (e) => {
    if (!transArrastando) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  $('#beTimeline')?.addEventListener('drop', (e) => {
    const id = transArrastando ||
      (e.dataTransfer.getData('text/be-transicao') ||
       (e.dataTransfer.getData('text/plain') || '').replace('be-transicao:', ''));
    transArrastando = null;
    timeline.setDropTransicao?.(null);
    const def = transicaoPorId(id);
    if (!def) return;
    e.preventDefault();
    const js = juncoes();
    if (!js.length) { toast('Precisa de duas cenas pra ter emenda', true); return; }
    const tDrop = timeline.tempoDoX ? timeline.tempoDoX(e.offsetX) : player.getTime();
    const alvo = js.reduce((a, b) => (Math.abs(b.t - tDrop) < Math.abs(a.t - tDrop) ? b : a));
    // longe demais da emenda: o usuário provavelmente errou o alvo
    if (Math.abs(alvo.t - tDrop) > 1.2) { toast('Solte em cima da emenda entre duas cenas', true); return; }
    store.dispatch(act.setTransition(alvo.indice, def.id, 0.5, 50));
    selecionarJuncao(alvo.indice);
    toast(def.nome + ' aplicada ✓');
  });


  // ── PARÂMETROS DA TRANSIÇÃO ──────────────────────────────────────────────
  // Qual emenda está sendo editada. Vive na UI e não no projeto: é seleção,
  // não conteúdo — some ao recarregar sem sujar o autosave.
  let juncaoSelecionada = null;

  function selecionarJuncao(indice) {
    if (juncaoSelecionada === indice) return;
    juncaoSelecionada = indice;
    // o desenho do marcador le isto pra saber qual esta aceso
    timeline.setJuncaoSelecionada?.(indice);
    if (indice != null) store.dispatch(act.clearSelection());
    sync();
  }

  function syncPainelTransicao(state) {
    const painel = $('#bePropsTrans');
    if (!painel) return false;
    const tr = juncaoSelecionada == null ? null
      : (state.transitions || []).find(x => x.between === juncaoSelecionada);
    if (!tr) { painel.style.display = 'none'; return false; }
    const def = transicaoPorId(tr.type);
    painel.style.display = 'flex';
    $('#beTransNome').textContent = def ? def.nome : tr.type;
    if (document.activeElement !== $('#beTransDur')) $('#beTransDur').value = Math.round(tr.duration * 100);
    $('#beTransDurVal').textContent = tr.duration.toFixed(2).replace('.', ',') + 's';
    if (document.activeElement !== $('#beTransInt')) $('#beTransInt').value = Math.round(tr.intensity ?? 50);
    $('#beTransIntVal').textContent = Math.round(tr.intensity ?? 50) + '%';
    return true;
  }

  const mexerTransicao = (patch) => {
    const st = store.getState();
    const tr = (st.transitions || []).find(x => x.between === juncaoSelecionada);
    if (!tr) return;
    store.dispatch({
      ...act.setTransition(tr.between, tr.type, patch.duration ?? tr.duration, patch.intensity ?? tr.intensity),
      gestureId: 'trans-' + tr.between + '-' + Object.keys(patch)[0],
    });
  };
  $('#beTransDur')?.addEventListener('input', (e) => mexerTransicao({ duration: (parseInt(e.target.value, 10) || 50) / 100 }));
  $('#beTransInt')?.addEventListener('input', (e) => mexerTransicao({ intensity: parseInt(e.target.value, 10) || 0 }));
  $('#beTransRemover')?.addEventListener('click', () => {
    if (juncaoSelecionada == null) return;
    store.dispatch(act.setTransition(juncaoSelecionada, 'cut'));
    juncaoSelecionada = null;
    toast('Transição removida ✓');
    sync();
  });

  // ── painel de propriedades CONTEXTUAL (estilo CapCut) ──
  // nada selecionado -> propriedades do projeto
  // clip selecionado -> acoes do clip | texto selecionado -> editor de texto
  function syncPropsPanel(state) {
    // emenda selecionada manda: os parâmetros da transição tomam a coluna
    if (syncPainelTransicao(state)) {
      for (const id of ['#beTextPanel', '#bePropsAudio', '#bePropsOverlay', '#bePropsClip', '#bePropsCaptions', '#bePropsProject']) {
        const el = $(id); if (el) el.style.display = 'none';
      }
      return;
    }
    const showText = state.selected_text_id != null;
    const showOv = !showText && state.selected_overlay_id != null;
    const showAudio = !showText && !showOv && state.selected_audio_id != null;
    const showClip = !showText && !showOv && !showAudio && state.selected_clip_id != null;
    const nadaSel = !showText && !showOv && !showAudio && !showClip;
    const showCaptions = captionsPanelOpen && nadaSel;
    const showAudioLib = audioLibOpen && nadaSel && !showCaptions;
    $('#beTextPanel').style.display = showText ? 'flex' : 'none';
    $('#bePropsAudio').style.display = showAudio ? 'flex' : 'none';
    $('#bePropsOverlay').style.display = showOv ? 'flex' : 'none';
    $('#bePropsClip').style.display = showClip ? 'flex' : 'none';
    $('#bePropsCaptions').style.display = showCaptions ? 'flex' : 'none';
    $('#bePropsAudioLib').style.display = showAudioLib ? 'flex' : 'none';
    $('#bePropsProject').style.display = (nadaSel && !showCaptions && !showAudioLib) ? 'flex' : 'none';
    if (showAudioLib) renderAudioLib();
    renderMediaPanel(); // biblioteca (coluna 1) sempre atualizada
    if (showText) fillTextPanel(state);
    if (showAudio) {
      const ac = state.audio_clips.find(a => a.id === state.selected_audio_id);
      if (ac) {
        $('#beAudioPanelTitle').textContent = '♪ ' + (ac.filename || 'áudio');
        $('#beVolSelected').value = ac.volume ?? 1;
        $('#beAudioClipDur').textContent = (ac.source_out - ac.source_in).toFixed(1) + 's';
        if (filledAudioId !== ac.id) {
          filledAudioId = ac.id;
          const sp = ac.speed ?? 1;
          $('#beAudioSpeed').value = speedToSlider(sp); $('#beAudioSpeedVal').textContent = fmtSpeed(sp);
        }
      }
    } else { filledAudioId = null; }
    // o botão 🎚 vive na toolbar (sempre visível): sincroniza com o ÁUDIO DA
    // SELEÇÃO (clipe de áudio, cena com som ou composto)
    syncAudioFxPanel(alvoDoFx(state));
    if (showOv) {
      const ov = state.overlays.find(o => o.id === state.selected_overlay_id);
      if (ov && filledOvId !== ov.id) {
        filledOvId = ov.id;
        const sp = ov.speed ?? 1;
        $('#beOvSpeed').value = speedToSlider(sp); $('#beOvSpeedVal').textContent = fmtSpeed(sp);
        $('#beOvRot').value = Math.round(ov.rotation || 0); $('#beOvRotVal').textContent = Math.round(ov.rotation || 0) + '°';
      }
      // som embutido: o rótulo segue o estado A CADA sync (fora do filledOvId,
      // senão o clique no próprio botão não atualizava o texto); imagem não tem som
      if (ov) {
        $('#beOvMute').style.display = ov.kind === 'image' ? 'none' : '';
        $('#beOvMute').textContent = ov.muted ? '🔊 Devolver o som da camada' : '🔇 Remover o som da camada';
      }
    } else { filledOvId = null; }
    if (showClip) {
      const clip = state.clips.find(c => c.id === state.selected_clip_id);
      if (clip) {
        const it = mainTrackItems(state).find(x => x.clip.id === clip.id);
        const dur = it ? it.tEnd - it.tStart : (clip.source_out - clip.source_in);
        $('#beClipDur').textContent = `${dur.toFixed(1)}s`;
        $('#beToggleClip2').textContent = clip.active === false ? '◉ Reativar cena' : '◌ Desativar cena';
        // sliders da aba Vídeo>Básico: só refila ao TROCAR de cena (não
        // sobrescreve enquanto o user arrasta o slider)
        if (filledClipId !== clip.id) {
          filledClipId = clip.id;
          const sc = Math.round((clip.scale ?? 1) * 100);
          const op = Math.round((clip.opacity ?? 1) * 100);
          $('#beClipScale').value = sc; $('#beClipScaleVal').textContent = sc + '%';
          $('#beClipOpacity').value = op; $('#beClipOpacityVal').textContent = op + '%';
          const sp = clip.speed ?? 1;
          $('#beClipSpeed').value = speedToSlider(sp); $('#beClipSpeedVal').textContent = fmtSpeed(sp);
          // máscara: refila os VALORES dos sliders ao trocar de cena
          const m = clip.mask;
          if (m) {
            $('#beMaskX').value = Math.round(m.x_pct * 100);
            $('#beMaskY').value = Math.round(m.y_pct * 100);
            $('#beMaskW').value = Math.round(m.w_pct * 100);
            $('#beMaskH').value = Math.round(m.h_pct * 100);
            $('#beMaskFeather').value = Math.round(m.feather);
            $('#beMaskRadius').value = Math.round(m.radius);
          }
        }
        // ── VISIBILIDADE QUE DEPENDE DA FORMA — SEMPRE (fix 2026-07-29) ─────
        // Isto vivia dentro do `if (filledClipId !== clip.id)`, que só roda ao
        // TROCAR de cena. Resultado: trocar círculo↔retângulo na mesma cena não
        // atualizava nada — a linha do raio já sofria disso antes da altura.
        // Alternar visibilidade não corre o risco de atropelar slider em
        // arrasto, então não precisa estar sob aquela trava.
        {
          const mk = clip.mask;
          $('#beMaskShapes').querySelectorAll('button').forEach(b =>
            b.classList.toggle('active', (mk ? mk.shape : 'none') === b.dataset.mask));
          $('#beMaskCtrls').style.display = mk ? 'flex' : 'none';
          // círculo tem UM raio: altura não faz sentido e só confundia
          const wrapH = root.querySelector('[data-mask-campo="h"]');
          if (wrapH) wrapH.style.display = (mk && mk.shape === 'circle') ? 'none' : '';
          const rowR = $('#beMaskRadiusRow');
          if (rowR) rowR.style.display = (mk && mk.shape === 'rect') ? '' : 'none';
        }
        // 🔇 mudo por cena: label reflete o estado sempre (toggle barato)
        $('#beClipMute').textContent = clip.muted ? '🔊 Restaurar áudio desta cena' : '🔇 Remover áudio desta cena';
        montarPainelGrade();
        preencherPainelGrade(state);
      }
    } else {
      filledClipId = null;
    }
    // botao "separar audio" so faz sentido antes do detach
    $('#beDetachAudio').style.display = state.audio_detached ? 'none' : 'block';
  }

  // registries POR FONTE de midia: cada vídeo (principal + takes) tem sua
  // própria miniatura e waveform, senão o take importado vinha sem thumbnail
  // e sem forma de onda (user 2026-07-20). Chave: 'main' ou media.id.
  const thumbsRegistry = new Map();
  const videoWaveRegistry = new Map();

  function setupThumbsAndWave(state) {
    // (re)cria a fonte PRINCIPAL ('main')
    thumbsRegistry.get('main')?.destroy();
    videoWaveRegistry.get('main')?.destroy();
    const mainSrc = (localPreview.for === state.video.url && localPreview.url)
      ? localPreview.url : state.video.url;
    thumbsRegistry.set('main', createThumbnails(mainSrc, state.video.duration, () => timeline.draw()));
    videoWaveRegistry.set('main', createWaveform(mainSrc, () => timeline.draw(), { color: 'rgba(34,197,94,.9)' }));
    // lookups por chave (o render escolhe pela midia de cada clip)
    timeline.setThumbs({ get: (k) => thumbsRegistry.get(k == null ? 'main' : k) });
    timeline.setVideoWave({ get: (k) => videoWaveRegistry.get(k == null ? 'main' : k) });
    syncMediaRegistries(state);
    syncWaveRegistry(state);
  }

  // garante miniatura + waveform pra cada TAKE do pool (idempotente)
  function syncMediaRegistries(state) {
    for (const m of (state.media || [])) {
      if (!thumbsRegistry.has(m.id)) {
        thumbsRegistry.set(m.id, createThumbnails(m.url, m.duration, () => timeline.draw()));
      }
      if (!videoWaveRegistry.has(m.id)) {
        videoWaveRegistry.set(m.id, createWaveform(m.url, () => timeline.draw(), { color: 'rgba(34,197,94,.9)' }));
      }
    }
  }

  // ── upload de video ──
  const drop = $('#beDrop');
  const fileInput = $('#beFile');
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    importFiles(e.dataTransfer?.files);
  });
  fileInput.addEventListener('change', () => {
    importFiles(fileInput.files);
    fileInput.value = '';
  });
  // drag&drop com a edicao JA aberta: solta em qualquer lugar do editor e a
  // midia e ACRESCENTADA na timeline (nao reseta o projeto) — user 2026-07-20
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if ($('#beWorkspace').style.display !== 'none') importFiles(e.dataTransfer?.files);
  });

  const isVideoFile = (f) => /^video\//.test(f.type) || /\.(mp4|mov|webm)$/i.test(f.name);
  const isAudioFile = (f) => /^audio\//.test(f.type) || /\.(mp3|wav|m4a|aac)$/i.test(f.name);
  const isImageFile = (f) => /^image\//.test(f.type) || /\.(png|jpg|jpeg|webp|gif)$/i.test(f.name);

  /** Importa QUALQUER quantidade de midias. 1º video de projeto vazio =
   *  principal; demais videos = takes ACRESCENTADOS no fim da timeline;
   *  audios = faixa de audio. Nunca reseta o que ja esta em edicao. */
  // popup de carregamento (dentro do editor) durante o import
  const importModal = () => $('#beImportModal');
  function importProg(pct) {
    const p = Math.max(0, Math.min(100, pct || 0));
    const bar = $('#beImportBar'); if (bar) bar.style.width = p + '%';
    const lbl = $('#beImportPct'); if (lbl) lbl.textContent = Math.round(p) + '%';
    const title = $('#beImportTitle');
    if (title && p >= 100) title.textContent = 'Processando…';
  }
  function importShow(name, idx, total) {
    $('#beImportTitle').textContent = total > 1 ? `Enviando ${idx} de ${total}…` : 'Enviando mídia…';
    $('#beImportName').textContent = name || '';
    importProg(0);
    importModal().style.display = 'flex';
  }

  async function importFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    let ok = 0, idx = 0;
    const total = files.length;
    try {
      for (const file of files) {
        idx++;
        try {
          if (isVideoFile(file)) {
            // ⚠️ o 1º vídeo TAMBÉM mostra o popup: antes ele usava a barra da
            // tela de importação (#beDropProgress), mas desde "Criar projeto
            // entra direto no editor" essa tela fica escondida — o progresso ia
            // pra um elemento invisível e o usuário achava que nada acontecia
            if (!store.getState().video) {
              importShow(file.name, idx, total);
              await uploadPrimary(file, importProg);
            }
            else {
              importShow(file.name, idx, total);
              const media = await uploadMedia(file, 'video', importProg);
              store.dispatch(act.addMediaClip(media));
            }
            ok++;
          } else if (isAudioFile(file)) {
            importShow(file.name, idx, total);
            const media = await uploadMedia(file, 'audio', importProg);
            store.dispatch(act.addAudioClip(media));
            syncWaveRegistry(store.getState());
            ok++;
          } else if (isImageFile(file)) {
            importShow(file.name, idx, total);
            const media = await uploadMedia(file, 'image', importProg);
            store.dispatch(act.addImageOverlay(media, player.getTime()));
            ok++;
          } else {
            toast(`Formato não suportado: ${file.name}`, true);
          }
        } catch (e) { toast(`${file.name}: ${e.message}`, true); }
      }
    } finally {
      importModal().style.display = 'none';
    }
    if (ok > 1) toast(`${ok} mídias adicionadas à timeline ✓`);
    else if (ok === 1) toast('Mídia adicionada ✓');
    renderMediaPanel();
  }

  async function uploadPrimary(file, onProg) {
    // a barra da tela de importação só é atualizada se ela estiver NA TELA
    // (hoje o normal é o popup #beImportModal, via onProg)
    const bar = $('#beDropProgress');
    const msg = $('#beDropMsg');
    const dropVisivel = !!bar && bar.closest('#beDrop')?.style.display !== 'none';
    try {
      if (dropVisivel) { bar.style.display = 'block'; msg.textContent = 'Enviando 0%'; }
      const media = await uploadMedia(file, 'video', (pct) => {
        onProg?.(pct);
        if (dropVisivel) {
          msg.textContent = `Enviando ${pct}%`;
          bar.querySelector('i').style.width = pct + '%';
        }
      });
      if (dropVisivel) msg.textContent = 'Processando…';
      if (localPreview.url) URL.revokeObjectURL(localPreview.url);
      localPreview.url = URL.createObjectURL(file);
      localPreview.for = media.url;
      store.dispatch(act.setVideo(media));
      player.seek(0);
      // zoomFit apos o browser medir o canvas recem-visivel; fallback
      // pendingFit no controller cobre se o RO ainda nao mediu
      requestAnimationFrame(() => requestAnimationFrame(() => timeline.zoomFit()));
      toast('Vídeo carregado ✓');
    } catch (e) {
      toast(e.message, true);
      if (msg) msg.textContent = 'Arraste um vídeo ou clique pra escolher';
      throw e;
    } finally {
      if (bar) { bar.style.display = 'none'; bar.querySelector('i').style.width = '0%'; }
    }
  }

  // ── biblioteca de mídia (coluna 1, sempre visível) ──
  // "Mídia" e "＋ Importar" abrem o seletor de arquivos
  $('#beAddMedia').addEventListener('click', () => fileInput.click());
  $('#beMediaImport')?.addEventListener('click', () => fileInput.click());
  $('#beVazioBtn')?.addEventListener('click', () => fileInput.click());

  // ── mini-thumbnails do painel de mídia (estilo CapCut) ──
  // cache url→dataURL do 1º frame do vídeo. Imagem usa a própria url. Falha de
  // CORS/decode cai graciosamente no emoji (marca '' pra não re-tentar).
  const _mediaThumbs = new Map();
  const _thumbPending = new Set();
  function ensureThumb(url, kind) {
    if (!url || _mediaThumbs.has(url) || _thumbPending.has(url)) return;
    if (kind === 'image') { _mediaThumbs.set(url, url); return; }
    if (kind !== 'video') return; // áudio não tem thumbnail visual
    _thumbPending.add(url);
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous'; v.muted = true; v.preload = 'metadata'; v.playsInline = true;
    let settled = false;
    const done = (dataUrl) => {
      if (settled) return; settled = true;
      _thumbPending.delete(url);
      _mediaThumbs.set(url, dataUrl || ''); // '' = falhou, não re-tenta
      try { v.src = ''; v.load?.(); } catch {}
      _mediaSig = null; renderMediaPanel();
    };
    v.onloadeddata = () => { try { v.currentTime = Math.min(1, (v.duration || 2) / 2); } catch { done(null); } };
    v.onseeked = () => {
      try {
        const c = document.createElement('canvas'); c.width = 64; c.height = 40;
        const g = c.getContext('2d');
        const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
        const sc = Math.max(c.width / vw, c.height / vh);
        g.drawImage(v, (c.width - vw * sc) / 2, (c.height - vh * sc) / 2, vw * sc, vh * sc);
        done(c.toDataURL('image/jpeg', 0.6));
      } catch { done(null); }
    };
    v.onerror = () => done(null);
    setTimeout(() => done(null), 8000);
    v.src = url;
  }

  let _mediaSig = null;
  function renderMediaPanel() {
    const list = $('#beMediaList');
    if (!list) return;
    const s = store.getState();
    const rows = [];
    if (s.video) {
      rows.push({ icon: '🎬', kind: 'video', url: s.video.url, name: s.video.filename || 'vídeo principal', dur: s.video.duration, tag: 'principal', added: true, base: true });
    }
    for (const m of (s.media || [])) {
      const added = (s.clips || []).some(c => c.media_id === m.id);
      rows.push({ icon: '🎞', kind: 'video', url: m.url, name: m.filename, dur: m.duration, mediaId: m.id, tag: 'take', added });
    }
    const audUrls = new Set();
    for (const a of (s.audio_clips || []).filter(a => a.kind !== 'video' && a.url)) {
      if (audUrls.has(a.url)) continue;
      audUrls.add(a.url);
      rows.push({ icon: '🎵', kind: 'audio', url: a.url, name: a.filename || 'áudio', dur: a.media_duration, tag: 'áudio', added: true });
    }
    const imgUrls = new Set();
    for (const o of (s.overlays || []).filter(o => o.kind === 'image' && o.url)) {
      if (imgUrls.has(o.url)) continue;
      imgUrls.add(o.url);
      rows.push({ icon: '🖼', kind: 'image', url: o.url, name: (o.url.split('/').pop() || 'imagem'), tag: 'imagem', added: true });
    }
    // dispara geração dos thumbs que faltam (não bloqueia o render)
    for (const r of rows) ensureThumb(r.url, r.kind);
    // guard: só reconstrói quando muda o conjunto, o estado "adicionada" ou os thumbs
    const sig = rows.map(r => r.icon + r.name + r.tag + (r.added ? '1' : '0') + (_mediaThumbs.has(r.url) ? 't' : '')).join('|');
    if (sig === _mediaSig) return;
    _mediaSig = sig;
    list.innerHTML = rows.length ? '' : '<div class="be-dim">Nenhuma mídia importada ainda</div>';
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'be-media-row';
      // thumbnail (mini-visualização) ou emoji de fallback
      const thumb = _mediaThumbs.get(r.url);
      const thumbHtml = (thumb && r.kind !== 'audio')
        ? `<img class="be-media-thumb" src="${thumb}" alt="">`
        : `<span class="be-media-thumb be-media-thumb-ph">${r.icon}</span>`;
      const secs = r.dur ? Math.round(r.dur) + 's' : '';
      // etiqueta "na timeline" só faz sentido pros takes (podem sair e voltar)
      const badge = r.mediaId != null
        ? (r.added ? '<span class="be-media-badge on">● na timeline</span>'
                   : '<span class="be-media-badge off">○ fora</span>')
        : '';
      row.innerHTML =
        `${thumbHtml}` +
        `<div class="be-media-info">` +
          `<span class="be-media-name" title="${r.name}">${r.name}</span>` +
          `<span class="be-dim be-media-meta">${secs ? secs + ' · ' : ''}${r.tag}${badge ? ' ' : ''}</span>` +
          `${badge}` +
        `</div>` +
        `<div class="be-media-actions"></div>`;
      const actions = row.querySelector('.be-media-actions');
      // ＋ re-adicionar take na timeline (só takes fora/na timeline)
      if (r.mediaId != null) {
        const add = document.createElement('button');
        add.className = 'be-tool-btn be-media-btn';
        add.textContent = '＋';
        add.title = r.added ? 'Adicionar de novo na timeline' : 'Adicionar na timeline';
        add.addEventListener('click', () => { store.dispatch(act.addClipFromMedia(r.mediaId)); toast('Take adicionado ✓'); });
        actions.appendChild(add);
      }
      // 🗑 excluir — AGORA TAMBÉM o vídeo principal (2026-07-29). Antes ele
      // era o único sem botão: quem importava o arquivo errado primeiro ficava
      // preso com ele pro resto do projeto.
      {
        const del = document.createElement('button');
        del.className = 'be-tool-btn be-media-btn be-media-del';
        del.textContent = '🗑';
        del.title = r.base
          ? 'Excluir o vídeo principal do projeto'
          : 'Excluir da biblioteca e da timeline';
        del.addEventListener('click', () => {
          const st = store.getState();
          if (r.base) {
            const temTake = (st.media || []).length > 0;
            const aviso = temTake
              ? 'Excluir o vídeo principal? O próximo take assume o lugar dele.'
              : 'Excluir o vídeo principal? O projeto fica vazio (dá pra desfazer com Ctrl+Z).';
            if (!confirm(aviso)) return;
            store.dispatch(act.removePrimary());
            toast(temTake ? 'Principal trocado ✓' : 'Projeto esvaziado ✓');
            return;
          }
          if (r.mediaId != null) {
            store.dispatch(act.removeMedia(r.mediaId));
          } else if (r.kind === 'audio') {
            for (const a of (st.audio_clips || []).filter(a => a.url === r.url)) store.dispatch(act.deleteAudioClip(a.id));
          } else if (r.kind === 'image') {
            for (const o of (st.overlays || []).filter(o => o.kind === 'image' && o.url === r.url)) store.dispatch(act.deleteOverlay(o.id));
          }
          toast('Mídia removida');
        });
        actions.appendChild(del);
      }
      list.appendChild(row);
    }
  }

  // ── ZOOM DO PREVIEW (user 2026-07-29, print do CapCut) ────────────────────
  // Roda do mouse sobre o vídeo aproxima/afasta; aproximado, arrastar o palco
  // desloca a vista. SÓ VISUAL: transform CSS no #beStage — o projeto, o
  // autosave e o export não sabem que isso existe. Como todos os overlays
  // (texto/pip/máscara) medem frações do próprio palco, o transform escala
  // tudo junto e os arrastos continuam certos.
  const frame = $('#beFrame');
  let pvZoom = 1, pvPanX = 0, pvPanY = 0;
  function aplicarZoomPreview() {
    const palco = $('#beStage'); if (!palco) return;
    const limX = palco.offsetWidth * (pvZoom - 1) / 2;
    const limY = palco.offsetHeight * (pvZoom - 1) / 2;
    pvPanX = Math.max(-limX, Math.min(limX, pvPanX));
    pvPanY = Math.max(-limY, Math.min(limY, pvPanY));
    palco.style.transform = (pvZoom === 1 && !pvPanX && !pvPanY) ? '' :
      `translate(${pvPanX.toFixed(1)}px, ${pvPanY.toFixed(1)}px) scale(${pvZoom.toFixed(3)})`;
    const val = $('#bePvZoomVal'); if (val) val.textContent = Math.round(pvZoom * 100) + '%';
    $('#bePvZoom')?.classList.toggle('ativo', Math.abs(pvZoom - 1) > 0.001);
    if (frame) frame.style.cursor = pvZoom > 1 ? 'grab' : '';
  }
  function setZoomPreview(z) {
    pvZoom = Math.max(0.5, Math.min(3, z));
    if (Math.abs(pvZoom - 1) < 0.001) { pvZoom = 1; pvPanX = 0; pvPanY = 0; }
    aplicarZoomPreview();
  }
  frame?.addEventListener('wheel', (e) => {
    e.preventDefault();
    setZoomPreview(pvZoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });
  frame?.addEventListener('pointerdown', (e) => {
    if (pvZoom <= 1 || e.button !== 0) return;
    // não rouba o gesto de quem já é interativo (texto, alças do pip, botões)
    if (e.target.closest('.be-text-overlay, button, input, .be-pvzoom')) return;
    const x0 = e.clientX, y0 = e.clientY, px0 = pvPanX, py0 = pvPanY;
    let moveu = false;
    const mover = (e2) => {
      if (!moveu && Math.hypot(e2.clientX - x0, e2.clientY - y0) < 4) return;
      moveu = true;
      frame.style.cursor = 'grabbing';
      pvPanX = px0 + (e2.clientX - x0);
      pvPanY = py0 + (e2.clientY - y0);
      aplicarZoomPreview();
    };
    const soltar = () => {
      window.removeEventListener('pointermove', mover);
      window.removeEventListener('pointerup', soltar);
      window.removeEventListener('pointercancel', soltar);
      frame.style.cursor = pvZoom > 1 ? 'grab' : '';
    };
    window.addEventListener('pointermove', mover);
    window.addEventListener('pointerup', soltar);
    window.addEventListener('pointercancel', soltar);
  });
  $('#bePvZoomIn')?.addEventListener('click', () => setZoomPreview(pvZoom * 1.25));
  $('#bePvZoomOut')?.addEventListener('click', () => setZoomPreview(pvZoom / 1.25));
  $('#bePvZoomFit')?.addEventListener('click', () => setZoomPreview(1));
  // DOIS CLIQUES = VOLTA AO 100% (user 2026-08-05: "pra voltar pro 100% é bem
  // difícil"). Achar de novo o botão ⤢ depois de aproximar e arrastar dá
  // trabalho; dois cliques em qualquer lugar da imagem desfazem tudo.
  // Só quando há zoom: com 100% o duplo-clique não pode roubar nada de quem
  // já usa duplo-clique (texto do preview abre pra editar).
  frame?.addEventListener('dblclick', (e) => {
    if (Math.abs(pvZoom - 1) < 0.001 && !pvPanX && !pvPanY) return;
    if (e.target.closest('.be-text-overlay, button, input, .be-pvzoom')) return;
    e.preventDefault();
    setZoomPreview(1);      // zera o pan junto (regra do próprio setZoomPreview)
  });

  // ── fullscreen do preview (tecla F) com barra de tempo ──
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else frame.requestFullscreen?.().catch(() => {});
  }
  $('#beFsExit').addEventListener('click', () => document.exitFullscreen?.());
  $('#beFsPlay').addEventListener('click', () => player.toggle());
  // scrub na barra do fullscreen
  const fsProg = $('#beFsProgress');
  let fsScrub = false;
  const fsSeekTo = (clientX) => {
    const r = fsProg.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    player.seek(pct * player.getDuration());
  };
  fsProg.addEventListener('pointerdown', (e) => { fsScrub = true; fsProg.setPointerCapture(e.pointerId); fsSeekTo(e.clientX); });
  fsProg.addEventListener('pointermove', (e) => { if (fsScrub) fsSeekTo(e.clientX); });
  fsProg.addEventListener('pointerup', () => { fsScrub = false; });
  // atualiza a barra do fullscreen
  player.onUpdate(() => {
    if (!document.fullscreenElement) return;
    const dur = player.getDuration() || 1;
    $('#beFsFill').style.width = (player.getTime() / dur * 100) + '%';
    $('#beFsPlay').textContent = player.isPlaying() ? '⏸' : '▶';
    $('#beFsTime').textContent = `${formatTime(player.getTime())} / ${formatTime(dur)}`;
  });
  // tecla F: entra/sai do fullscreen (ignora quando digitando)
  window.addEventListener('keydown', (e) => {
    const el = document.activeElement;
    const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    if (!typing && (e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); toggleFullscreen();
    }
  });

  // ── transporte ──
  $('#bePlayBtn').addEventListener('click', () => player.toggle());

  // ── PROPORÇÃO DO PROJETO (menu estilo CapCut sob o preview, user 14/08) ───
  // Ícone de cada item = retângulo na proporção real (largura fixa, altura
  // proporcional) — bate o olho e reconhece o formato, como no CapCut.
  {
    const btn = $('#beFormatoBtn'), menu = $('#beFormatoMenu');
    const icone = (ar) => {
      const w = ar >= 1 ? 18 : Math.max(7, Math.round(14 * ar));
      const h = ar >= 1 ? Math.max(7, Math.round(18 / ar)) : 14;
      return `<span class="be-formato-ico"><i style="width:${w}px;height:${h}px"></i></span>`;
    };
    const render = () => {
      const st = store.getState();
      const atual = st.formato?.id || '9:16';
      menu.innerHTML = FORMATOS.map(f => {
        const dims = f.id === 'original' || f.id === 'custom'
          ? (f.id === atual ? `${formatoDoProjeto(st).w}×${formatoDoProjeto(st).h}` : '')
          : `${f.w}×${f.h}`;
        const ar = f.w ? f.w / f.h : (f.id === atual ? formatoDoProjeto(st).ar : 1);
        return `<button type="button" class="be-formato-item${f.id === atual ? ' active' : ''}" data-fmt="${f.id}">
          ${icone(ar)}<span>${f.nome}</span><span class="be-formato-dims">${dims}</span>
        </button>`;
      }).join('');
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const aberto = menu.style.display !== 'none';
      if (aberto) { menu.style.display = 'none'; return; }
      render(); menu.style.display = 'block';
    });
    document.addEventListener('click', (e) => {
      if (menu.style.display !== 'none' && !menu.contains(e.target)) menu.style.display = 'none';
    });
    menu.addEventListener('click', (e) => {
      const it = e.target.closest('[data-fmt]');
      if (!it) return;
      const id = it.dataset.fmt;
      if (id === 'custom') {
        const resp = prompt('Tamanho personalizado (largura×altura em pixels):', '1920x1080');
        if (resp == null) return;
        const m = /^\s*(\d{3,4})\s*[x×:]\s*(\d{3,4})\s*$/.exec(resp);
        if (!m) { toast('Formato inválido — use largura×altura, ex.: 1920x1080.', true); return; }
        store.dispatch(act.setFormato({ id: 'custom', w: +m[1], h: +m[2] }));
      } else {
        store.dispatch(act.setFormato({ id }));
      }
      menu.style.display = 'none';
      const fp = formatoDoProjeto(store.getState());
      toast(`Formato do projeto: ${fp.w}×${fp.h}`);
    });
  }
  $('#beProjectName').addEventListener('change', (e) => store.dispatch(act.renameProject(e.target.value)));
  // ← voltar pra tela inicial (projetos): garante o salvamento antes de sair
  $('#beBackHome')?.addEventListener('click', () => {
    try { autosave.flush(); } catch {}
    // desmonta ANTES de trocar de tela: o DOM some logo em seguida e qualquer
    // assinatura viva passa a escrever no vazio
    desmontar();
    if (opts.onExit) opts.onExit();
    else location.href = '/blueEditor';
  });
  $('#beUndo').addEventListener('click', () => store.undo());
  $('#beRedo').addEventListener('click', () => store.redo());

  // ── toolbar ──
  $('#beSplit').addEventListener('click', () => splitSelectedAt(store, player.getTime()));
  $('#beDelLeft').addEventListener('click', () => { store.dispatch(act.deleteRangeLeft(player.getTime())); player.seek(0.001); });
  $('#beDelRight').addEventListener('click', () => store.dispatch(act.deleteRangeRight(player.getTime())));
  const doToggleClip = () => {
    const s = store.getState();
    if (s.selected_clip_id != null) store.dispatch(act.toggleClip(s.selected_clip_id));
  };
  const doDeleteClip = () => {
    const s = store.getState();
    if (s.selected_clip_id != null) store.dispatch(act.deleteClip(s.selected_clip_id));
  };
  $('#beToggleClip').addEventListener('click', doToggleClip);
  $('#beDelClip').addEventListener('click', doDeleteClip);
  $('#beToggleClip2').addEventListener('click', doToggleClip);
  $('#beDelClip2').addEventListener('click', doDeleteClip);

  // ── painel de config com abas (Vídeo>Básico: Escala + Opacidade) ──
  // troca de aba de topo (Vídeo/Áudio/Velocidade/Animação/Ajuste)
  $('#beCfgTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.be-cfg-tab'); if (!btn) return;
    const tab = btn.dataset.tab;
    $('#beCfgTabs').querySelectorAll('.be-cfg-tab').forEach(b => b.classList.toggle('active', b === btn));
    $('#bePropsClip').querySelectorAll('.be-cfg-panel').forEach(p =>
      p.style.display = p.dataset.panel === tab ? 'flex' : 'none');
  });
  // ── ABA ANIMAÇÃO (user 14/08): clique aplica na cena selecionada ────────
  {
    let animCat = 'in';
    const cards = $('#beAnimCards');
    const renderAnimCards = () => {
      const st = store.getState();
      const clip = st.clips.find((c) => c.id === st.selected_clip_id);
      const campo = animCat === 'in' ? 'anim_in' : animCat === 'out' ? 'anim_out' : 'anim_loop';
      const atual = clip?.[campo] || null;
      cards.innerHTML = [
        `<button type="button" class="be-anim-card${atual == null ? ' active' : ''}" data-anim=""><span class="be-anim-ico">⃠</span><span>Nenhum</span></button>`,
        ...ANIMACOES_CENA.filter((a) => a.slot === animCat).map((a) =>
          `<button type="button" class="be-anim-card${atual === a.id ? ' active' : ''}" data-anim="${a.id}"><span class="be-anim-ico">${a.icone}</span><span>${a.nome}</span></button>`),
      ].join('');
    };
    $('#beAnimCats').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-acat]'); if (!btn) return;
      animCat = btn.dataset.acat;
      $('#beAnimCats').querySelectorAll('.be-cfg-subtab').forEach((b) => b.classList.toggle('active', b === btn));
      renderAnimCards();
    });
    cards.addEventListener('click', (e) => {
      const card = e.target.closest('[data-anim]'); if (!card) return;
      const st = store.getState();
      if (st.selected_clip_id == null) { toast('Selecione uma cena primeiro.', true); return; }
      const id = card.dataset.anim || null;
      store.dispatch(act.setClipAnim(st.selected_clip_id, animCat, id));
      renderAnimCards();
      toast(id ? `Animação aplicada: ${ANIM_POR_ID.get(id)?.nome} ✓` : 'Animação removida ✓');
    });
    // re-render quando a seleção muda (o sync geral já roda a cada dispatch)
    store.subscribe(() => { if ($('#bePropsClip').style.display !== 'none') renderAnimCards(); });
    renderAnimCards();
  }

  // ── ANIMAÇÃO DA CAMADA (painel da camada — user 14/08) ──────────────────
  {
    let ovAnimCat = 'in';
    const cards = $('#beOvAnimCards');
    const renderOvAnim = () => {
      const st = store.getState();
      const ov = st.overlays.find((o) => o.id === st.selected_overlay_id);
      // imagem não tem timeline própria no filtro — sem animação por ora
      $('#beOvAnimSec').style.display = ov && ov.kind !== 'image' ? '' : 'none';
      if (!ov || ov.kind === 'image') return;
      const campo = ovAnimCat === 'in' ? 'anim_in' : ovAnimCat === 'out' ? 'anim_out' : 'anim_loop';
      const atual = ov[campo] || null;
      cards.innerHTML = [
        `<button type="button" class="be-anim-card${atual == null ? ' active' : ''}" data-oanim=""><span class="be-anim-ico">⃠</span><span>Nenhum</span></button>`,
        ...ANIMACOES_CENA.filter((a) => a.slot === ovAnimCat && a.camada !== false).map((a) =>
          `<button type="button" class="be-anim-card${atual === a.id ? ' active' : ''}" data-oanim="${a.id}"><span class="be-anim-ico">${a.icone}</span><span>${a.nome}</span></button>`),
      ].join('');
    };
    $('#beOvAnimCats').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-oacat]'); if (!btn) return;
      ovAnimCat = btn.dataset.oacat;
      $('#beOvAnimCats').querySelectorAll('.be-cfg-subtab').forEach((b) => b.classList.toggle('active', b === btn));
      renderOvAnim();
    });
    cards.addEventListener('click', (e) => {
      const card = e.target.closest('[data-oanim]'); if (!card) return;
      const st = store.getState();
      if (st.selected_overlay_id == null) return;
      const id = card.dataset.oanim || null;
      store.dispatch(act.setOverlayAnim(st.selected_overlay_id, ovAnimCat, id));
      renderOvAnim();
      toast(id ? `Animação da camada: ${ANIM_POR_ID.get(id)?.nome} ✓` : 'Animação removida ✓');
    });
    store.subscribe(() => { if ($('#bePropsOverlay').style.display !== 'none') renderOvAnim(); });
  }

  // troca de sub-aba dentro de Vídeo (Básico/Remover fundo/Mascarar)
  $('#beCfgSubtabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.be-cfg-subtab'); if (!btn) return;
    const sub = btn.dataset.sub;
    $('#beCfgSubtabs').querySelectorAll('.be-cfg-subtab').forEach(b => b.classList.toggle('active', b === btn));
    $('#bePropsClip').querySelectorAll('.be-cfg-sub').forEach(p =>
      p.style.display = p.dataset.sub === sub ? 'flex' : 'none');
    aplicarModoPreview(sub);
  });

  // ── UM MARCADOR POR VEZ NO PREVIEW (2026-07-29) ──────────────────────────
  // Antes o marcador da máscara ficava sobre o vídeo o tempo todo: saía-se da
  // aba "Mascarar" e continuava editando a máscara sem querer, sem jeito de
  // mexer no vídeo em si. Agora a sub-aba escolhe QUEM está sendo editado:
  //   Mascarar → alças da máscara
  //   qualquer outra → moldura do vídeo (mover/escalar a cena)
  function aplicarModoPreview(sub) {
    const naMascara = sub === 'mascarar';
    maskUI.setAtivo(naMascara);
    frameUI.setAtivo(!naMascara);
  }
  // Escala + Opacidade: coalesce por gesto (1 undo por arraste), aplica ao vivo
  const bindClipSlider = (sel, valSel, field, toModel, toLabel) => {
    $(sel).addEventListener('input', (e) => {
      const id = store.getState().selected_clip_id;
      if (id == null) return;
      const raw = parseInt(e.target.value, 10);
      $(valSel).textContent = toLabel(raw);
      store.dispatch({ ...act.setClipTransform(id, { [field]: toModel(raw) }), gestureId: 'clip-' + field + '-' + id });
      applyClipTransform();
    });
    $(sel).addEventListener('change', () => store.endGesture());
  };
  bindClipSlider('#beClipScale', '#beClipScaleVal', 'scale', v => v / 100, v => v + '%');
  bindClipSlider('#beClipOpacity', '#beClipOpacityVal', 'opacity', v => v / 100, v => v + '%');

  // 🔇 remover/restaurar áudio SÓ da cena selecionada (user 2026-07-24: o
  // detach global tirava o áudio de TODAS as faixas de vídeo)
  $('#beClipMute').addEventListener('click', () => {
    const s = store.getState();
    const clip = s.clips.find(c => c.id === s.selected_clip_id);
    if (!clip) return;
    store.dispatch(act.setClipFx(clip.id, { muted: !clip.muted }));
    toast(clip.muted ? 'Áudio da cena restaurado ✓' : 'Áudio removido só desta cena ✓');
  });

  // ── MÁSCARA da cena (CapCut: círculo/retângulo + suavizar + cantos) ──
  $('#beMaskShapes').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mask]'); if (!btn) return;
    const s = store.getState();
    const id = s.selected_clip_id; if (id == null) return;
    filledClipId = null; // força refill dos controles (mostra/esconde sliders)
    store.dispatch(act.setClipMask(id, btn.dataset.mask === 'none' ? null : { shape: btn.dataset.mask }));
    applyClipTransform();
  });
  const bindMaskSlider = (sel, field, toModel) => {
    $(sel).addEventListener('input', (e) => {
      const s = store.getState();
      const id = s.selected_clip_id; if (id == null) return;
      store.dispatch({ ...act.setClipMask(id, { [field]: toModel(parseInt(e.target.value, 10)) }), gestureId: 'mask-' + id });
      applyClipTransform();
    });
    $(sel).addEventListener('change', () => store.endGesture());
  };
  bindMaskSlider('#beMaskX', 'x_pct', v => v / 100);
  bindMaskSlider('#beMaskY', 'y_pct', v => v / 100);
  bindMaskSlider('#beMaskW', 'w_pct', v => v / 100);
  bindMaskSlider('#beMaskH', 'h_pct', v => v / 100);
  bindMaskSlider('#beMaskFeather', 'feather', v => v);
  bindMaskSlider('#beMaskRadius', 'radius', v => v);

  // Velocidade (aba Velocidade do clip). Aplica só na CENA selecionada.
  $('#beClipSpeed').addEventListener('input', (e) => {
    const id = store.getState().selected_clip_id;
    if (id == null) return;
    const sp = sliderToSpeed(parseInt(e.target.value, 10));
    $('#beClipSpeedVal').textContent = fmtSpeed(sp);
    store.dispatch({ ...act.setSpeed('clip', id, sp), gestureId: 'clipspeed-' + id });
  });
  $('#beClipSpeed').addEventListener('change', () => store.endGesture());
  $('#beClipSpeedReset').addEventListener('click', () => {
    const id = store.getState().selected_clip_id;
    if (id == null) return;
    store.dispatch(act.setSpeed('clip', id, 1));
    $('#beClipSpeed').value = 0; $('#beClipSpeedVal').textContent = '1.00x';
  });
  // Velocidade do ÁUDIO selecionado (painel de áudio)
  $('#beAudioSpeed').addEventListener('input', (e) => {
    const id = store.getState().selected_audio_id;
    if (id == null) return;
    const sp = sliderToSpeed(parseInt(e.target.value, 10));
    $('#beAudioSpeedVal').textContent = fmtSpeed(sp);
    store.dispatch({ ...act.setSpeed('audio', id, sp), gestureId: 'audiospeed-' + id });
  });
  $('#beAudioSpeed').addEventListener('change', () => store.endGesture());
  // Velocidade + Giro da CAMADA (overlay) — igual à faixa principal
  $('#beOvSpeed').addEventListener('input', (e) => {
    const id = store.getState().selected_overlay_id;
    if (id == null) return;
    const sp = sliderToSpeed(parseInt(e.target.value, 10));
    $('#beOvSpeedVal').textContent = fmtSpeed(sp);
    store.dispatch({ ...act.setSpeed('overlay', id, sp), gestureId: 'ovspeed-' + id });
  });
  $('#beOvSpeed').addEventListener('change', () => store.endGesture());
  $('#beOvRot').addEventListener('input', (e) => {
    const id = store.getState().selected_overlay_id;
    if (id == null) return;
    const deg = parseInt(e.target.value, 10);
    $('#beOvRotVal').textContent = deg + '°';
    store.dispatch({ ...act.setOverlayTransform(id, { rotation: deg }), gestureId: 'ovrot-' + id });
  });
  $('#beOvRot').addEventListener('change', () => store.endGesture());

  $('#beZoomIn').addEventListener('click', () => timeline.zoomBy(1.25));
  $('#beZoomOut').addEventListener('click', () => timeline.zoomBy(1 / 1.25));
  $('#beZoomFit').addEventListener('click', () => timeline.zoomFit());
  $('#beAddText').addEventListener('click', addTextAtPlayhead);
  $('#beAddText2').addEventListener('click', addTextAtPlayhead);
  function addTextAtPlayhead() {
    const t = player.getTime();
    store.dispatch(act.addText({ content: 'Seu texto', start_sec: t, end_sec: Math.min(t + 3, Math.max(t + 1, totalDuration(store.getState()))) }));
    openTextPanel(store.getState().texts.at(-1).id);
  }

  // ── painel de texto (inline no painel de propriedades) ──
  let editingTextId = null;
  const isCaption = (t) => !!(t && t.caption);
  const posOf = (y) => Math.abs(y - 0.15) < 0.15 ? '0.15' : Math.abs(y - 0.5) < 0.2 ? '0.5' : '0.82';
  function fillTextPanel(state) {
    const txt = state.texts.find(x => x.id === state.selected_text_id);
    if (!txt) return;
    // caixa "Aplicar a todas as legendas" só faz sentido em legenda
    $('#beCapApplyAllRow').style.display = isCaption(txt) ? 'flex' : 'none';
    // sub-aba Legendas (transcrição) só quando há legendas
    const temCaptions = state.texts.some(t => t.caption);
    $('#beTextTabCap').style.display = temCaptions ? '' : 'none';
    if (temCaptions) renderTranscript(state);
    // MAIÚSCULAS/minúsculas só faz sentido em escrita que tem caixa: em CJK,
    // árabe, hebraico e tailandês os botões não fariam nada
    const comCaixa = podeMudarCaixa(txt.content);
    $('#beTextPanel').querySelectorAll('[data-case]').forEach((b) => {
      b.disabled = !comCaixa;
      b.title = comCaixa ? b.title.replace(/ \(.*\)$/, '') : 'Esta escrita não tem maiúscula/minúscula';
    });
    if (editingTextId === txt.id) return; // nao sobrescreve enquanto digita
    editingTextId = txt.id;
    $('#beTextContent').value = txt.content;
    if ($('#beTextAnim')) $('#beTextAnim').value = txt.anim || 'nenhuma';
    $('#beTextFont').value = txt.font;
    $('#beTextSize').value = txt.size;
    $('#beTextColor').value = txt.color;
    $('#beTextStroke').value = /^#[0-9a-fA-F]{6}$/.test(txt.stroke || '') ? txt.stroke : '#000000';
    $('#beTextPos').value = posOf(txt.y_pct ?? 0.82);
    $('#beTextStart').value = txt.start_sec.toFixed(1);
    $('#beTextEnd').value = txt.end_sec.toFixed(1);
  }
  function openTextPanel(textId) {
    editingTextId = null; // forca refill
    store.dispatch(act.selectText(textId));
    setTimeout(() => $('#beTextContent').focus(), 60);
  }
  $('#beTextClose').addEventListener('click', () => {
    editingTextId = null;
    store.dispatch(act.selectText(null));
  });
  $('#beTextDelete').addEventListener('click', () => {
    const s = store.getState();
    if (s.selected_text_id != null) store.dispatch(act.deleteText(s.selected_text_id));
    editingTextId = null;
  });
  // sub-abas Texto | Legendas
  $('#beTextTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.be-cfg-tab'); if (!btn) return;
    const tab = btn.dataset.ttab;
    $('#beTextTabs').querySelectorAll('.be-cfg-tab').forEach(b => b.classList.toggle('active', b === btn));
    $('#beTextPanel').querySelectorAll('.be-text-tab').forEach(p =>
      p.style.display = p.dataset.ttab === tab ? 'flex' : 'none');
    if (tab === 'legendas') renderTranscript(store.getState());
  });

  // aplica um patch de ESTILO respeitando "Aplicar a todas as legendas"
  function applyTextStyle(patch) {
    const s = store.getState();
    const txt = s.texts.find(x => x.id === s.selected_text_id);
    if (!txt) return;
    const all = isCaption(txt) && $('#beCapApplyAll').checked;
    const targets = all ? s.texts.filter(t => t.caption) : [txt];
    for (const t of targets) store.dispatch({ ...act.updateText(t.id, patch), gestureId: 'textstyle' });
    store.endGesture();
  }
  // content/start/end são SEMPRE por-faixa (cada legenda tem seu texto/tempo)
  for (const [sel, field, parse] of [
    ['#beTextContent', 'content', v => v],
    ['#beTextStart', 'start_sec', v => parseFloat(v) || 0],
    ['#beTextEnd', 'end_sec', v => parseFloat(v) || 0],
  ]) {
    $(sel).addEventListener('input', (e) => {
      const s = store.getState();
      if (s.selected_text_id == null) return;
      store.dispatch({ ...act.updateText(s.selected_text_id, { [field]: parse(e.target.value) }), gestureId: 'textpanel-' + s.selected_text_id + '-' + field });
    });
    $(sel).addEventListener('change', () => store.endGesture());
  }
  // fonte/tamanho/cor/posição = ESTILO (respeita "aplicar a todas")
  $('#beTextFont').addEventListener('change', (e) => applyTextStyle({ font: e.target.value }));
  $('#beTextSize').addEventListener('change', (e) => applyTextStyle({ size: e.target.value }));
  $('#beTextColor').addEventListener('input', (e) => applyTextStyle({ color: e.target.value }));
  $('#beTextStroke').addEventListener('input', (e) => applyTextStyle({ stroke: e.target.value }));
  $('#beTextPos').addEventListener('change', (e) => applyTextStyle({ y_pct: parseFloat(e.target.value) }));
  // animação de entrada/saída: estilo (com "aplicar a todas", muda a legenda inteira)
  $('#beTextAnim').addEventListener('change', (e) => applyTextStyle({ anim: e.target.value }));
  // Caixa (TT/tt/Tt): transforma o conteúdo (respeita "aplicar a todas")
  const caseFns = {
    upper: (s) => s.toUpperCase(),
    lower: (s) => s.toLowerCase(),
    title: (s) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()),
  };
  $('#beTextPanel').querySelectorAll('[data-case]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const fn = caseFns[btn.dataset.case];
      const s = store.getState();
      const txt = s.texts.find(x => x.id === s.selected_text_id);
      if (!txt || !fn) return;
      const all = isCaption(txt) && $('#beCapApplyAll').checked;
      const targets = all ? s.texts.filter(t => t.caption) : [txt];
      for (const t of targets) store.dispatch({ ...act.updateText(t.id, { content: fn(t.content) }), gestureId: 'textcase' });
      store.endGesture();
      editingTextId = null; // força refill do textarea
    });
  });

  // ── transcrição completa (aba Legendas): lista clicável ──
  function renderTranscript(state) {
    const list = $('#beTranscriptList');
    if (!list) return;
    const caps = state.texts.filter(t => t.caption).slice().sort((a, b) => a.start_sec - b.start_sec);
    if (!caps.length) { list.innerHTML = '<div class="be-dim">Gere as legendas primeiro (💬 Legendas).</div>'; return; }
    list.innerHTML = '';
    caps.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'be-transcript-row' + (t.id === state.selected_text_id ? ' active' : '');
      const n = document.createElement('span'); n.className = 'be-transcript-n'; n.textContent = (i + 1);
      const tx = document.createElement('span'); tx.className = 'be-transcript-tx'; tx.textContent = t.content;
      row.appendChild(n); row.appendChild(tx);
      row.addEventListener('click', () => {
        editingTextId = null;
        store.dispatch(act.selectText(t.id));   // seleciona pra editar
        player.seek(t.start_sec + 0.01);          // pula pro ponto da fala
        // volta pra aba Texto pra editar aquele ponto
        $('#beTextTabs').querySelector('[data-ttab="texto"]').click();
      });
      list.appendChild(row);
    });
  }

  // ── audio extra + biblioteca de áudio ──
  const audioInput = $('#beAudioFile');
  const pickAudio = () => audioInput.click();
  // rail "Áudio": abre a BIBLIOTECA (Músicas/Efeitos/Favoritos), não importa direto
  $('#beAddAudio').addEventListener('click', () => {
    audioLibOpen = !audioLibOpen;
    if (audioLibOpen) { captionsPanelOpen = false; store.dispatch(act.selectClip(null)); }
    sync();
  });
  $('#beAddAudio2').addEventListener('click', pickAudio); // botão do painel de projeto = importar
  $('#beAudioLibClose')?.addEventListener('click', () => { audioLibOpen = false; sync(); });
  // Import de áudio próprio removido do painel (usuário baixa e arrasta pra timeline).
  // sub-abas da biblioteca (Músicas / Efeitos / Favoritos)
  $('#beAudioLibTabs')?.addEventListener('click', (e) => {
    const b = e.target.closest('.be-cfg-subtab'); if (!b) return;
    audioLibTab = b.dataset.atab;
    $('#beAudioLibTabs').querySelectorAll('.be-cfg-subtab').forEach(x => x.classList.toggle('active', x === b));
    renderAudioLib();
  });
  $('#beAudioLibSearch')?.addEventListener('input', (e) => { audioLibQuery = e.target.value; renderAudioLibDebounced(); });
  let audioLibDeb = 0;
  function renderAudioLibDebounced() { clearTimeout(audioLibDeb); audioLibDeb = setTimeout(renderAudioLib, 350); }
  async function renderAudioLib() {
    const box = $('#beAudioLibResults'); if (!box) return;
    const q = (audioLibQuery || '').trim();
    if (audioLibTab === 'favoritos') {
      const favs = getAudioFavs();
      box.innerHTML = favs.length ? '' : '<div class="be-dim">Sem favoritos ainda. Salve com a ⭐ nos resultados.</div>';
      favs.forEach(f => box.appendChild(audioResultRow(f, true)));
      return;
    }
    // Sem busca = mostra a biblioteca curada inteira (o backend lista tudo quando
    // query é vazia). Buscar só filtra. O usuário não importa áudio aqui — baixa
    // e arrasta pra timeline (ou usa "＋ Importar mídias").
    box.innerHTML = '<div class="be-dim">' + (q ? 'Buscando…' : 'Carregando biblioteca…') + '</div>';
    try {
      const r = await api.audioSearch(q, audioLibTab === 'efeitos' ? 'sfx' : 'music');
      const items = r.results || [];
      if (!items.length) {
        box.innerHTML = '<div class="be-dim">' + (r.message || 'Nada encontrado.') + '</div>';
        return;
      }
      // ── AGRUPADO POR CATEGORIA (user 2026-07-29: "escolhi as categorias ao
      // adicionar cada faixa, mas no editor não está organizado por
      // categoria"). As categorias saem DOS PRÓPRIOS DADOS — nada cravado no
      // código pra envelhecer quando o admin criar uma categoria nova.
      box.innerHTML = '';
      const porCat = new Map();
      for (const it of items) {
        const cat = (it.category || 'Geral').trim() || 'Geral';
        if (!porCat.has(cat)) porCat.set(cat, []);
        porCat.get(cat).push(it);
      }
      const cats = [...porCat.keys()].sort((a, b) => a.localeCompare(b, 'pt'));
      // filtro de categoria (só aparece quando há mais de uma)
      if (cats.length > 1) {
        const chips = document.createElement('div');
        chips.className = 'be-audiolib-cats';
        const fazChip = (nome, valor) => {
          const b = document.createElement('button');
          b.className = 'be-audiolib-cat' + (audioLibCat === valor ? ' active' : '');
          b.textContent = nome;
          b.addEventListener('click', () => { audioLibCat = valor; renderAudioLib(); });
          return b;
        };
        chips.appendChild(fazChip('Todas', null));
        for (const c of cats) chips.appendChild(fazChip(c, c));
        box.appendChild(chips);
      }
      const visiveis = audioLibCat ? cats.filter(c => c === audioLibCat) : cats;
      if (!visiveis.length) {
        box.appendChild(Object.assign(document.createElement('div'),
          { className: 'be-dim', textContent: 'Nada nesta categoria.' }));
      }
      for (const cat of visiveis) {
        const h = document.createElement('div');
        h.className = 'be-audiolib-catnome';
        h.textContent = cat + ' · ' + porCat.get(cat).length;
        box.appendChild(h);
        for (const it of porCat.get(cat)) box.appendChild(audioResultRow(it, false));
      }
    } catch (e) {
      box.innerHTML = '<div class="be-dim">Biblioteca ainda não conectada. Use ＋ Importar por enquanto.</div>';
    }
  }
  function audioResultRow(it, isFav) {
    const row = document.createElement('div');
    row.className = 'be-audio-lib-row';
    // favorito RECORTADO mostra o tamanho do TRECHO, não do arquivo
    const temRecorte = it.source_out > (it.source_in || 0) && (it.source_in > 0 || it.source_out < it.duration);
    const segs = temRecorte ? (it.source_out - (it.source_in || 0)) : it.duration;
    const meta = [it.category, segs ? Math.round(segs) + 's' : '', temRecorte ? '✂' : ''].filter(Boolean).join(' · ');
    row.innerHTML = `<button class="be-audiolib-play" title="Ouvir">▶</button>
      <span class="be-audiolib-name" title="${it.name || ''}">${it.name || 'áudio'}</span>
      <span class="be-dim">${meta}</span>`;
    let audio = null;
    row.querySelector('.be-audiolib-play').addEventListener('click', () => {
      if (!it.preview) return;
      if (audio && !audio.paused) { audio.pause(); return; }
      audio = new Audio(it.preview);
      // prévia do TRECHO salvo: começa no in e para no out
      if (temRecorte) {
        audio.currentTime = it.source_in || 0;
        audio.addEventListener('timeupdate', () => { if (audio && audio.currentTime >= it.source_out) audio.pause(); });
      }
      audio.play().catch(() => {});
    });
    if (isFav) {
      // na aba Favoritos a ação é EXPLÍCITA: apagar (user 14/08 — a estrela
      // ambígua não comunicava remoção)
      const del = document.createElement('button');
      del.className = 'be-audiolib-star'; del.textContent = '🗑'; del.title = 'Remover dos favoritos';
      del.addEventListener('click', () => { removerAudioFav(it); renderAudioLib(); toast('Removido dos favoritos'); });
      row.appendChild(del);
    } else {
      const star = document.createElement('button');
      star.className = 'be-audiolib-star'; star.textContent = '☆'; star.title = 'Favoritar';
      star.addEventListener('click', () => { toggleAudioFav(it); renderAudioLib(); });
      row.appendChild(star);
    }
    const use = document.createElement('button');
    use.className = 'be-tool-btn'; use.style.cssText = 'padding:2px 8px;font-size:11px'; use.textContent = '＋';
    use.title = 'Adicionar na timeline';
    use.addEventListener('click', () => {
      // o RECORTE salvo viaja pro clipe novo (a razão de existir do favorito ✂)
      store.dispatch(act.addAudioClip({
        url: it.url, filename: it.name, duration: it.duration || 10,
        ...(temRecorte ? { source_in: it.source_in || 0, source_out: it.source_out } : {}),
        ...(it.speed ? { speed: it.speed } : {}),
      }));
      syncWaveRegistry(store.getState());
      toast('Áudio adicionado ✓' + (temRecorte ? ' (trecho de ' + Math.round(segs) + 's)' : ''));
    });
    row.appendChild(use);
    return row;
  }
  const AUDIO_FAV_KEY = 'be_v1_audio_favs';
  function getAudioFavs() { try { return JSON.parse(localStorage.getItem(AUDIO_FAV_KEY)) || []; } catch { return []; } }
  const mesmaFav = (f, it) => f.url === it.url
    && (f.source_in || 0) === (it.source_in || 0)
    && (f.source_out || f.duration || 0) === (it.source_out || it.duration || 0);
  function toggleAudioFav(it) {
    const favs = getAudioFavs();
    const i = favs.findIndex((f) => mesmaFav(f, it));
    if (i >= 0) favs.splice(i, 1); else favs.push(it);
    try { localStorage.setItem(AUDIO_FAV_KEY, JSON.stringify(favs)); } catch {}
  }
  function removerAudioFav(it) {
    const favs = getAudioFavs().filter((f) => !mesmaFav(f, it));
    try { localStorage.setItem(AUDIO_FAV_KEY, JSON.stringify(favs)); } catch {}
  }
  audioInput.addEventListener('change', async () => {
    const f = audioInput.files?.[0];
    audioInput.value = '';
    if (!f) return;
    try {
      toast('Enviando áudio…');
      const media = await uploadMedia(f, 'audio', () => {});
      store.dispatch(act.addAudioClip(media));
      syncWaveRegistry(store.getState());
      toast('Áudio adicionado ✓ — arraste na timeline pra posicionar');
    } catch (e) { toast(e.message, true); }
  });

  $('#beVolVideo').addEventListener('input', (e) => {
    store.dispatch({ ...act.setVolume('video', parseFloat(e.target.value)), gestureId: 'vol-v' });
  });
  $('#beVolVideo').addEventListener('change', () => store.endGesture());

  $('#beAspect').addEventListener('change', (e) => store.dispatch(act.setAspect(e.target.value)));

  // ── CORTAR RESPIROS (2026-07-29) ─────────────────────────────────────────
  // Analisa o áudio DE VERDADE (decodifica → RMS → piso adaptativo →
  // histerese, tudo em core/silencio.js), remove os trechos sem fala e entrega
  // um CLIPE COMPOSTO já sem respiros — que o usuário abre com 2 cliques pra
  // ajustar. Serve pro áudio solto E pro vídeo com áudio (aí o vídeo acompanha
  // o corte, "trazendo a próxima fala pra mais perto").
  let respAbort = null;
  function respirosMostrar(msg, pct, t0) {
    $('#beRespirosPop').style.display = 'flex';
    $('#beRespirosMsg').textContent = msg;
    const p = Math.round(Math.max(0, Math.min(1, pct)) * 100);
    $('#beRespirosBar').style.width = p + '%';
    $('#beRespirosPct').textContent = p + '%';
    if (t0) $('#beRespirosTempo').textContent = Math.round((Date.now() - t0) / 1000) + 's';
  }
  async function cortarRespiros() {
    if (respAbort) return;                       // já rodando
    const st = store.getState();
    // alvo: áudio selecionado > cena selecionada > cena sob a agulha
    let alvo = null;
    if (st.selected_audio_id != null) {
      const a = st.audio_clips.find(x => x.id === st.selected_audio_id);
      if (a) alvo = { tipo: 'audio', id: a.id, url: a.kind === 'video' ? st.video?.url : a.url, item: a };
    }
    if (!alvo) {
      const c = st.selected_clip_id != null
        ? st.clips.find(x => x.id === st.selected_clip_id)
        : (mainTrackItems(st).find(x => player.getTime() >= x.tStart && player.getTime() < x.tEnd)?.clip);
      if (c && c.compound_id == null) {
        alvo = { tipo: 'clip', id: c.id, url: c.media_id != null ? mediaUrlFor(st, c) : st.video?.url, item: c };
      } else if (c) {
        return toast('Este bloco já é um clipe composto — abra com 2 cliques pra ajustar dentro dele', true);
      }
    }
    if (!alvo || !alvo.url) return toast('Selecione o áudio ou a cena que você quer limpar', true);

    const t0 = Date.now();
    respAbort = new AbortController();
    const relogio = setInterval(() => {
      $('#beRespirosTempo').textContent = Math.round((Date.now() - t0) / 1000) + 's';
    }, 500);
    try {
      respirosMostrar('Analisando o áudio…', 0.02, t0);
      const { samples, sr } = await scanAudio(alvo.url, {
        signal: respAbort.signal,
        onProgress: (p) => respirosMostrar('Analisando o áudio…', p * 0.9, t0),
      });
      respirosMostrar('Procurando as pausas…', 0.94, t0);
      // deixa o navegador pintar antes da conta pesada
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const faixaIni = alvo.item.source_in ?? 0;
      const faixaFim = alvo.item.source_out ?? (samples.length / sr);
      const r = detectarFala(samples, sr);
      const falas = r.falas
        .map(f => ({ in: Math.max(faixaIni, f.in), out: Math.min(faixaFim, f.out) }))
        .filter(f => f.out - f.in > 0.05);
      const res = resumoDoCorte({ ...r, duracao: faixaFim - faixaIni,
        removido: Math.max(0, (faixaFim - faixaIni) - falas.reduce((s, f) => s + (f.out - f.in), 0)) });
      if (!falas.length) { toast('Não encontrei fala nesta mídia — nada foi cortado', true); return; }
      if (res.respiros === 0 || res.removidoSeg < 0.2) {
        // ⚠️ HONESTIDADE: esta mensagem dizia "o áudio já está justo ✓" e o
        // usuário lia como sucesso — enquanto o detector tinha falhado e não
        // cortado nada (teste de 2026-08-05). Agora ela diz o que foi MEDIDO,
        // e não dá parabéns por um trabalho que não aconteceu.
        toast(`Nada foi cortado: não encontrei pausa acima de 0,2s nos ${
          Math.round(faixaFim - faixaIni)}s analisados`, true);
        return;
      }
      respirosMostrar('Montando o clipe…', 0.99, t0);
      store.dispatch(act.cutSilence(alvo.tipo, alvo.id, falas));
      syncWaveRegistry(store.getState());
      requestAnimationFrame(() => timeline.draw());
      toast(`✂ ${res.respiros} respiros cortados · ${res.removidoSeg}s a menos (${res.ganhoPct}%) — 2 cliques no bloco pra ajustar`);
    } catch (e) {
      if (e.name !== 'AbortError') toast('Não consegui analisar o áudio: ' + e.message, true);
    } finally {
      clearInterval(relogio);
      respAbort = null;
      $('#beRespirosPop').style.display = 'none';
    }
  }
  $('#beCutSilence').addEventListener('click', cortarRespiros);
  $('#beRespirosCancel').addEventListener('click', () => { respAbort?.abort(); });

  // ── LOCUÇÃO (2026-07-29): grava o microfone direto na timeline ────────────
  // Ao clicar, a faixa já COMEÇA a nascer (fantasma vermelho crescendo em
  // tempo real na área de áudio) e o vídeo toca junto pra narrar em sincronia.
  // Parar = sobe a gravação e vira um clipe de áudio exatamente onde o
  // fantasma estava. O fantasma é desenho puro: o projeto só muda no fim
  // (1 undo), e cancelar no meio não deixa rastro.
  let rec = null;   // { mr, stream, chunks, t0, lane, elapsed, lastTick, pausado, timer }
  const fmtRec = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

  async function iniciarLocucao() {
    if (rec) return pararLocucao();
    // grava COM ou SEM mídia no projeto (user 2026-07-29): dá pra começar um
    // projeto pela narração e montar o vídeo por cima depois
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return toast('Sem acesso ao microfone — libere a permissão no navegador', true);
    }
    let mr;
    try {
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      mr = new MediaRecorder(stream, { mimeType: mime });
    } catch (e) {
      stream.getTracks().forEach(t => t.stop());
      return toast('Este navegador não suporta gravação de áudio', true);
    }
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const lay = timeline.getLayout?.();
    // faixa NOVA embaixo das existentes; sem áudio nenhum, usa a primeira.
    // Teto = MAX_AUDIO_LANE (o mesmo clamp do reducer — senão o fantasma
    // desenhava numa faixa que o clipe final não podia ocupar).
    const temAudio = store.getState().audio_clips.some(a => a.active !== false);
    // ⚠️ play() ANTES de ler o t0: com a agulha parada no FIM, o play rebobina
    // pra 0 — ler o t0 antes fazia a narração da cena inicial cair no fim da
    // timeline (revisão adversarial: "assistiu até o fim e clicou 🎙")
    player.play?.();
    rec = {
      mr, stream, chunks,
      t0: player.getTime(),
      lane: temAudio && lay ? Math.min(MAX_AUDIO_LANE, lay.audioLanes) : 0,
      elapsed: 0, lastTick: performance.now(), pausado: false, timer: 0,
    };
    mr.start(250);
    $('#beRecPill').style.display = 'flex';
    $('#beRecPause').textContent = '⏸';
    $('#beRecVoice')?.classList.add('gravando');
    rec.timer = setInterval(() => {
      if (!rec || rec.pausado) return;
      const agora = performance.now();
      rec.elapsed += (agora - rec.lastTick) / 1000;
      rec.lastTick = agora;
      const el = $('#beRecTime'); if (el) el.textContent = fmtRec(rec.elapsed);
      timeline.setRecGhost?.({ t0: rec.t0, dur: rec.elapsed, lane: rec.lane });
    }, 200);
  }

  function pausarLocucao() {
    if (!rec) return;
    rec.pausado = !rec.pausado;
    try { rec.pausado ? rec.mr.pause() : rec.mr.resume(); } catch {}
    if (rec.pausado) { player.pause?.(); }
    else { rec.lastTick = performance.now(); player.play?.(); }
    $('#beRecPause').textContent = rec.pausado ? '▶' : '⏸';
    $('#beRecPill').classList.toggle('pausada', rec.pausado);
  }

  async function pararLocucao() {
    if (!rec) return;
    const r = rec; rec = null;
    clearInterval(r.timer);
    player.pause?.();
    $('#beRecPill').style.display = 'none';
    $('#beRecPill').classList.remove('pausada');
    $('#beRecVoice')?.classList.remove('gravando');
    timeline.setRecGhost?.(null);
    const blob = await new Promise((res) => {
      const junta = () => res(new Blob(r.chunks, { type: 'audio/webm' }));
      r.mr.onstop = junta;
      try { r.mr.state === 'inactive' ? junta() : r.mr.stop(); } catch { junta(); }
    });
    r.stream.getTracks().forEach(t => t.stop());
    if (!blob.size || r.elapsed < 0.4) return toast('Gravação vazia — nada foi adicionado', true);
    const file = new File([blob], 'locucao-' + Date.now() + '.webm', { type: 'audio/webm' });
    // upload com UMA retentativa; se falhar de vez, a gravação NÃO se perde:
    // baixa o .webm no computador do usuário (narrou 5 minutos num take bom =
    // não pode evaporar por um soluço de rede)
    let media = null;
    for (let tentativa = 1; tentativa <= 2 && !media; tentativa++) {
      try {
        importShow('locução (' + fmtRec(r.elapsed) + ')', 1, 1);
        media = await uploadMedia(file, 'audio', importProg);
      } catch (e) {
        if (tentativa === 2) {
          importModal().style.display = 'none';
          try {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = file.name;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 30000);
            toast('Upload falhou — a gravação foi BAIXADA no seu computador. Importe o arquivo pra usar na timeline.', true);
          } catch {
            toast('Não consegui salvar a locução: ' + e.message, true);
          }
          return;
        }
      }
    }
    try {
      // webm de gravação pode reportar duração ruim mesmo com o hack — o
      // relógio da gravação é a verdade de fallback
      if (!isFinite(media.duration) || media.duration <= 0) media.duration = r.elapsed;
      store.dispatch(act.addAudioClip({ ...media, filename: 'Locução', start: r.t0, lane: r.lane }));
      syncWaveRegistry(store.getState());
      toast('🎙 Locução adicionada na timeline ✓');
    } finally {
      importModal().style.display = 'none';
    }
  }

  $('#beRecVoice').addEventListener('click', iniciarLocucao);
  $('#beRecPause').addEventListener('click', pausarLocucao);
  $('#beRecStop').addEventListener('click', pararLocucao);

  // ── APRIMORAR ÁUDIO (botão da toolbar; popover no hover; motor no player) ──
  // O ALVO é "o áudio da seleção atual", venha ele de onde vier: clipe de
  // áudio solto, cena de vídeo com áudio embutido, ou clipe composto. Sem
  // esse alvo genérico a feature ficava só pro áudio solto — foi exatamente o
  // que o usuário pegou ("tem que funcionar em vídeo com áudio" / "no composto
  // o editor acha que não tem áudio").
  function alvoDoFx(state) {
    if (state.selected_audio_id != null) {
      const a = state.audio_clips.find(x => x.id === state.selected_audio_id);
      if (a) return { alvo: 'audio', id: a.id, item: a, rotulo: a.filename || 'áudio' };
    }
    if (state.selected_clip_id != null) {
      const c = state.clips.find(x => x.id === state.selected_clip_id);
      if (c) {
        // composto: as flags moram no stub e cascateiam pro áudio de dentro
        if (c.compound_id != null) {
          if (!compoundTemAudio(state, c.compound_id)) return null;
          return { alvo: 'clip', id: c.id, item: c, rotulo: 'clipe composto' };
        }
        // cena de vídeo: só faz sentido se ela ainda tem áudio
        if (!c.muted && !state.audio_detached) return { alvo: 'clip', id: c.id, item: c, rotulo: 'áudio da cena' };
      }
    }
    return null;
  }

  function syncAudioFxPanel(alvo) {
    const ac = alvo?.item || null;
    const semAlvo = !ac;
    $('#beFxSemAlvo').style.display = semAlvo ? 'block' : 'none';
    for (const cb of $('#beAudioFxPop').querySelectorAll('[data-fx]')) {
      cb.checked = !semAlvo && ac[cb.dataset.fx] === true;
      cb.disabled = semAlvo;
    }
    $('#beFxVozIntRow').style.display = (!semAlvo && ac.fx_voz) ? 'flex' : 'none';
    const int = Math.round(ac?.fx_voz_int ?? 75);
    if (document.activeElement !== $('#beFxVozInt')) $('#beFxVozInt').value = int;
    $('#beFxVozIntVal').textContent = int;
    const algum = !semAlvo && (ac.fx_ruido || ac.fx_voz || ac.fx_norm);
    $('#beAudioFxBtn').classList.toggle('ativo', !!algum);
  }
  // hover abre as opções (com folga pra atravessar do botão pro popover).
  // No TOUCH não existe hover: o clique no botão também abre o popover (além
  // de ligar tudo), e tocar fora fecha.
  {
    const wrap = $('#beFxWrap'); const pop = $('#beAudioFxPop');
    let fecha = 0;
    wrap.addEventListener('mouseenter', () => { clearTimeout(fecha); pop.style.display = 'flex'; });
    wrap.addEventListener('mouseleave', () => {
      clearTimeout(fecha);
      fecha = setTimeout(() => { pop.style.display = 'none'; }, 250);
    });
    document.addEventListener('pointerdown', (e) => {
      if (pop.style.display !== 'none' && !wrap.contains(e.target)) pop.style.display = 'none';
    });
  }
  // botão geral: liga TUDO; se já está tudo ligado, desliga tudo (pedido do user)
  $('#beAudioFxBtn').addEventListener('click', () => {
    const alvo = alvoDoFx(store.getState());
    if (!alvo) return toast('Selecione na timeline um áudio, uma cena com som ou um clipe composto', true);
    const a = alvo.item;
    const todos = a.fx_ruido && a.fx_voz && a.fx_norm;
    store.dispatch(act.setAudioFx(alvo.alvo, alvo.id, todos
      ? { fx_ruido: false, fx_voz: false, fx_norm: false }
      : { fx_ruido: true, fx_voz: true, fx_norm: true }));
    $('#beAudioFxPop').style.display = 'flex';   // touch não tem hover: mostra o resultado
    toast(todos ? 'Efeitos de áudio desligados' : `Efeitos ligados no ${alvo.rotulo} ✓`);
  });
  $('#beAudioFxPop').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-fx]'); if (!cb) return;
    const alvo = alvoDoFx(store.getState()); if (!alvo) return;
    store.dispatch(act.setAudioFx(alvo.alvo, alvo.id, { [cb.dataset.fx]: cb.checked }));
  });
  $('#beFxVozInt').addEventListener('input', (e) => {
    const alvo = alvoDoFx(store.getState()); if (!alvo) return;
    $('#beFxVozIntVal').textContent = e.target.value;
    store.dispatch({ ...act.setAudioFx(alvo.alvo, alvo.id, { fx_voz_int: parseInt(e.target.value, 10) }), gestureId: 'fxint-' + alvo.alvo + alvo.id });
  });
  $('#beFxVozInt').addEventListener('change', () => store.endGesture());

  // ── audio destacado (Ctrl+Shift+S) ──
  $('#beDetachAudio').addEventListener('click', () => {
    store.dispatch(act.detachAudio());
    toast('Áudio separado do vídeo ✓ (track própria)');
  });
  $('#beVolSelected').addEventListener('input', (e) => {
    const id = store.getState().selected_audio_id;
    if (id == null) return;
    store.dispatch({ ...act.setAudioVolume(id, parseFloat(e.target.value)), gestureId: 'vol-sel' });
  });
  $('#beVolSelected').addEventListener('change', () => store.endGesture());
  $('#beOverlayDelete').addEventListener('click', () => {
    const id = store.getState().selected_overlay_id;
    if (id != null) store.dispatch(act.deleteOverlay(id));
  });
  $('#beOvMute').addEventListener('click', () => {
    const id = store.getState().selected_overlay_id;
    if (id != null) store.dispatch(act.toggleOverlayMuted(id));
  });
  $('#beAudioItemDelete').addEventListener('click', () => {
    const id = store.getState().selected_audio_id;
    if (id != null) store.dispatch(act.deleteAudioClip(id));
  });

  // registry de waveforms por URL (multiplos arquivos de audio)
  const waveRegistry = new Map();
  function syncWaveRegistry(state) {
    for (const a of state.audio_clips) {
      if (a.kind === 'extra' && a.url && !waveRegistry.has(a.url)) {
        waveRegistry.set(a.url, createWaveform(a.url, () => timeline.draw()));
      }
    }
    timeline.setWave({ get: (url) => waveRegistry.get(url) });
  }

  // ── transicoes ──
  function renderTransitionsRow(state) {
    const row = $('#beTransitions');
    const segs = timelineSegments(state);
    if (segs.length < 2) { row.innerHTML = '<span class="be-dim">Divida o vídeo em 2+ cenas pra ter transições</span>'; row.dataset.rendered = ''; return; }
    let html = '';
    for (let i = 0; i < segs.length - 1; i++) {
      const tr = (state.transitions || []).find(x => x.between === i);
      html += `<label class="be-trans-item">Corte ${i + 1}→${i + 2}
        <select data-between="${i}">
          <option value="cut" ${!tr ? 'selected' : ''}>Corte seco</option>
          <option value="fade" ${tr?.type === 'fade' ? 'selected' : ''}>Fade</option>
        </select></label>`;
    }
    if (row.dataset.rendered !== html) {
      row.dataset.rendered = html;
      row.innerHTML = html;
      row.querySelectorAll('select').forEach(sel => {
        sel.addEventListener('change', () => {
          store.dispatch(act.setTransition(parseInt(sel.dataset.between, 10), sel.value, 0.3));
        });
      });
    }
  }

  // ── export ──
  const exportModal = $('#beExportModal');
  // mostra UM dos passos do modal: opções | progresso | pronto | erro
  const showExportStep = (which) => {
    for (const id of ['beExportOptions', 'beExportProgress', 'beExportDone', 'beExportError']) {
      const el = $('#' + id); if (el) el.style.display = (id === which) ? 'block' : 'none';
    }
    // modal largo (2 colunas) só no passo de opções
    exportModal.querySelector('.be-modal-box')?.classList.toggle('be-modal-wide', which === 'beExportOptions');
  };
  // baixa direto pra pasta de Downloads com o nome escolhido (blob = força o
  // nome mesmo cross-origin; se CORS bloquear, o link manual do passo "Pronto"
  // continua valendo)
  async function downloadAs(url, filename) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('fetch ' + resp.status);
      const blob = await resp.blob();
      const obj = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = obj; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(obj), 15000);
    } catch { /* fallback = link visível "⬇ Baixar vídeo" */ }
  }
  // 1) clicar em Exportar abre as OPÇÕES (nome/resolução/formato) — CapCut
  // Dimensões da EXPORTAÇÃO a partir do formato do projeto: o tier (480p…4K)
  // escala a proporção inteira (fator res/1080); tudo par, h264 yuv420p exige.
  // Acima de 1080 é upscale quando a fonte é menor — igual CapCut permite.
  function dimsDoExport(fp, res) {
    const fator = (res > 0 ? res : 1080) / 1080;
    const par = (n) => Math.max(128, Math.round(n * fator / 2) * 2);
    return { w: par(fp.w), h: par(fp.h) };
  }
  $('#beExportBtn').addEventListener('click', () => {
    const st = store.getState();
    if (!canExport(st)) { toast('Adicione um vídeo com pelo menos 0,5s pra exportar.', true); return; }
    $('#beExportName').value = (st.nome_projeto || '').trim() || 'meu-video';
    const prev = $('#beExportOptPreview');
    if (prev && st.video?.url) {
      prev.src = (localPreview.for === st.video.url && localPreview.url) ? localPreview.url : (st.video.url + '#t=0.5');
    }
    const dur = totalDuration(st);
    $('#beExportEst').textContent = `Duração: ${Math.floor(dur / 60)}m ${Math.round(dur % 60)}s`;
    // resoluções REAIS deste projeto (o formato manda; cada tier escala junto)
    const fp = formatoDoProjeto(st);
    // a prévia do modal segue o formato do projeto (era 9:16 cravado)
    document.querySelector('.be-export-optthumb-wrap')?.style.setProperty('--be-export-ar', fp.w + ' / ' + fp.h);
    const NOMES_RES = { 2160: '4K (2160p)', 1440: '2K (1440p)', 1080: '1080p (Full HD)', 720: '720p', 480: '480p' };
    for (const opt of $('#beExportRes').options) {
      const d = dimsDoExport(fp, parseInt(opt.value, 10));
      opt.textContent = `${NOMES_RES[opt.value] || opt.value + 'p'} · ${d.w}×${d.h}`;
    }
    showExportStep('beExportOptions');
    exportModal.classList.add('open');
  });
  // 2) confirmar dispara a exportação com as opções + baixa ao terminar
  $('#beExportStart').addEventListener('click', () => {
    const res = parseInt($('#beExportRes').value, 10) || 1080;
    const dims = dimsDoExport(formatoDoProjeto(store.getState()), res);
    const fname = (($('#beExportName').value || 'meu-video').trim() || 'meu-video')
      .replace(/[\/\\:*?"<>|]+/g, '_').slice(0, 80);
    showExportStep('beExportProgress');
    $('#beExportBar').style.width = '0%';
    $('#beExportLabel').textContent = 'Preparando…';
    const soAudio = !!$('#beExportAudioOnly')?.checked;
    const ext = soAudio ? '.m4a' : '.mp4';
    exporter.start({
      output_width: dims.w, output_height: dims.h, audio_only: soAudio,
      onProgress: (pct, label) => {
        $('#beExportBar').style.width = pct + '%';
        $('#beExportLabel').textContent = `${label} ${pct}%`;
      },
      onDone: (url) => {
        showExportStep('beExportDone');
        // só-áudio não tem o que mostrar em vídeo: o <video> vira player de som
        $('#beExportPreview').src = url;
        const link = $('#beExportLink');
        link.href = url; link.setAttribute('download', fname + ext);
        downloadAs(url, fname + ext); // já cai na pasta de Downloads
      },
      onError: (msg) => {
        showExportStep('beExportError');
        $('#beExportErrorMsg').textContent = msg;
      },
    });
  });
  $('#beExportOptCancel').addEventListener('click', () => exportModal.classList.remove('open'));
  $('#beExportCancel').addEventListener('click', async () => {
    await exporter.cancel();
    exportModal.classList.remove('open');
  });
  $('#beExportClose').addEventListener('click', () => exportModal.classList.remove('open'));

  // (a lista de projetos "Continuar de onde parou" saiu daqui: agora é a TELA
  //  INICIAL estilo CapCut — public/editor-v1/ui/home.js, orquestrada no main.js)

  // ── clipe composto: entrar/sair (CapCut) ──
  // Ao ENTRAR: o editor passa a mostrar SO o conteudo interno do composto.
  // Ao SAIR: o doc interno volta pro composto e o principal e restaurado.
  let compoundCtx = null; // { compoundId, savedDoc }
  function enterCompound(compoundId) {
    const state = store.getState();
    const comp = state.compounds.find(k => k.id === compoundId);
    if (!comp || compoundCtx) return;
    compoundCtx = { compoundId, savedDoc: state };
    const inner = {
      ...state,
      nome_projeto: comp.name,
      clips: comp.clips.map(c => ({ ...c })),
      texts: comp.texts.map(t => ({ ...t })),
      audio_clips: comp.audio_clips.map(a => ({ ...a })),
      overlays: comp.overlays.map(o => ({ ...o })),
      compounds: [], multi_selected: [],
      selected_clip_id: null, selected_text_id: null,
      selected_audio_id: null, selected_overlay_id: null,
    };
    store.replaceState(inner);
    $('#beCompoundBar').style.display = 'flex';
    $('#beCompoundName').textContent = '⧉ ' + comp.name;
    requestAnimationFrame(() => requestAnimationFrame(() => timeline.zoomFit()));
    toast('Editando clipe composto — clique em Sair pra voltar');
  }
  function exitCompound() {
    if (!compoundCtx) return;
    const inner = store.getState();
    const doc = {
      clips: inner.clips, texts: inner.texts,
      audio_clips: inner.audio_clips, overlays: inner.overlays,
    };
    const { compoundId, savedDoc } = compoundCtx;
    compoundCtx = null;
    store.replaceState(savedDoc);
    store.dispatch(act.updateCompound(compoundId, doc));
    $('#beCompoundBar').style.display = 'none';
    requestAnimationFrame(() => requestAnimationFrame(() => timeline.zoomFit()));
    toast('Alterações salvas no clipe composto ✓');
  }
  $('#beCompoundExit').addEventListener('click', exitCompound);

  // ── legendas automaticas (CapCut auto captions) ──
  // words da ultima transcricao + o PLANO de audio usado (qual fonte e como
  // mapear file-time -> timeline) ficam em memoria: trocar o MODO nao paga
  // nova transcricao.
  let lastCaptionWords = null;
  let lastCaptionPhrases = null;
  let lastCaptionPlan = null;   // { url, segments:[{tStart,fileIn,fileOut}] }
  let lastCaptionKey = null;    // url transcrita (invalidar quando a fonte muda)
  let lastCaptionLang = '';     // idioma detectado pelo Whisper (regras de escrita)

  // file-time -> tempo VIRTUAL da timeline. O mapa mora em core/caption-sync.js
  // (mesmo usado pela re-sincronia do reducer): tinha DUAS cópias da conta e a
  // daqui ignorava velocidade — clipe em 2x jogava a legenda pro dobro do tempo.
  const fileToTimeline = arquivoParaTimeline;

  function aplicarLegendas(mode) {
    const words = lastCaptionWords || [];
    const segments = lastCaptionPlan?.segments || [];
    if (!segments.length) return 0;
    const brutos = mode === 'palavra'
      // PALAVRA POR PALAVRA: cada palavra com o timestamp REAL da fala —
      // a legenda acompanha a narração exatamente (pedido do user)
      ? words.map((w, i) => ({
          text: w.word,
          start: w.start,
          // fica na tela ate a proxima palavra (sem buraco), min 0.25s
          end: Math.max(w.end, (words[i + 1]?.start ?? w.end + 0.4) - 0.02, w.start + 0.25),
        }))
      : (lastCaptionPhrases || []);
    if (!brutos.length) return 0;

    // Whisper devolve tempos DO ARQUIVO transcrito; mapeia pra timeline pelo
    // plano (funciona pra audio proprio do editor OU audio do video, e
    // respeita cortes — fala num trecho removido some).
    const caps = [];
    for (const c of brutos) {
      const ts = fileToTimeline(c.start, segments);
      if (ts == null) continue;
      const te = fileToTimeline(c.end, segments);
      const dur = te != null && te > ts ? te - ts : Math.max(0.25, c.end - c.start);
      // src_* = ÂNCORA: onde a fala está dentro do arquivo. Guardar isso é o que
      // permite re-sincronizar a legenda quando o user edita o vídeo depois.
      caps.push({ text: c.text, start: ts, end: ts + dur, src_in: c.start, src_out: c.end });
    }
    if (!caps.length) return 0;

    // usa o TEMPLATE escolhido na galeria — cor/tarja POR PALAVRA (estilo CapCut)
    const atual = store.getState().texts.find(t => t.caption);
    const tpl = modeloPorId(capChosenPreset);
    const y_pct = atual?.y_pct ?? 0.82;
    // UM dispatch: nao rouba a selecao (painel fica), 1 undo, sem freeze
    // com videos longos (300+ palavras = 300 dispatches na versao antiga)
    store.dispatch(act.setCaptions(caps.map((c, i) => ({
      content: c.text, start_sec: c.start, end_sec: c.end,
      src_in: c.src_in, src_out: c.src_out, src_url: lastCaptionPlan.url,
      x_pct: 0.5, y_pct, ...estiloDaPalavra(tpl, i),
    }))));
    return caps.length;
  }

  async function generateCaptions() {
    const state = store.getState();
    const mode = $('#beCapMode')?.value || 'frase';
    // escolhe a fonte de audio REAL (voz do editor > audio do video; nunca
    // o audio fantasma de um video mudo) — user 2026-07-20
    const plan = captionAudioPlan(state);
    if (!plan) {
      return toast('Nenhum áudio com voz pra transcrever. Adicione seu áudio (aba Áudio) ou reative o áudio do vídeo.', true);
    }
    try {
      // re-transcreve se a FONTE mudou (trocou/adicionou áudio próprio etc)
      if (!lastCaptionWords || lastCaptionKey !== plan.url) {
        toast('Transcrevendo áudio… (pode levar ~1min)');
        const r = await api.autoCaptions(plan.url);
        lastCaptionWords = r.words || [];
        // IDIOMA: o Whisper devolve qual é, e agora a gente USA. O agrupamento
        // em frases passou a ser feito aqui (e não no endpoint) justamente
        // porque depende do idioma — japonês não leva espaço entre palavras,
        // ideograma ocupa o dobro da linha, e o fim de frase muda de escrita.
        lastCaptionLang = normalizarIdioma(r.language);
        lastCaptionPhrases = lastCaptionWords.length
          ? agruparFrases(lastCaptionWords, lastCaptionLang)
          : (r.captions || []);
        lastCaptionKey = plan.url;
        if (!lastCaptionPhrases.length && !lastCaptionWords.length) {
          return toast('Nenhuma fala detectada no áudio', true);
        }
      }
      lastCaptionPlan = plan; // mapa file->timeline atual (cortes podem ter mudado)
      const n = aplicarLegendas(mode);
      if (!n) return toast('Nenhuma fala detectada no trecho ativo', true);
      $('#beCapStyleRow').style.display = 'flex';
      toast(n + (mode === 'palavra' ? ' palavras' : ' legendas') + ' geradas ✓ — sincronizadas com a fala');
    } catch (e) {
      const msg = (e.status === 504 || /timeout|timed out|HTTP 50/i.test(e.message || ''))
        ? 'A transcrição demorou demais — tente um áudio mais curto'
        : e.message;
      toast('Legendas: ' + msg, true);
    }
  }
  // rail "Legendas": ABRE o painel dedicado (escolher estilo ANTES de gerar)
  $('#beAutoCaptions').addEventListener('click', () => {
    captionsPanelOpen = !captionsPanelOpen;
    if (captionsPanelOpen) { store.dispatch(act.selectClip(null)); }
    sync();
  });
  $('#beCapClose').addEventListener('click', () => { captionsPanelOpen = false; sync(); });
  $('#beAutoCaptions2').addEventListener('click', generateCaptions);
  // cards de MODO (Multilinha / Palavra por palavra) com preview animado
  $('#beCapModeCards').addEventListener('click', (e) => {
    const card = e.target.closest('.be-cap-card'); if (!card) return;
    const mode = card.dataset.mode;
    $('#beCapModeCards').querySelectorAll('.be-cap-card').forEach(c => c.classList.toggle('active', c === card));
    $('#beCapMode').value = mode;
    $('#beCapMode').dispatchEvent(new Event('change'));
  });
  // trocar o modo REGENERA na hora (sem nova transcricao) se ja ha legendas
  $('#beCapMode').addEventListener('change', () => {
    if (lastCaptionWords && lastCaptionPlan && store.getState().texts.some(t => t.caption)) {
      const n = aplicarLegendas($('#beCapMode').value);
      if (n) toast('Legendas regeneradas: ' + n + ' blocos');
    }
  });

  // ── GALERIA DE ESTILOS DE LEGENDA (estilo CapCut: várias opções) ──
  // Todas POR PALAVRA (uma palavra por vez no tempo real da fala). colorMode:
  //  'single'   = cor fixa
  //  'rotate'   = a cor troca a cada palavra (paleta)
  //  'highlight'= tarja colorida atrás (box=1 do drawtext)
  // Limitado ao que o render REAL faz (fontes TTF no Railway + cor + tarja) —
  // WYSIWYG honesto: o que se vê no preview é o que exporta.
  // Os modelos viraram DADO em core/caption-styles.js (com categoria, busca,
  // favoritos e a animação de cada um) — o painel novo precisa deles como
  // catálogo, não como markup montado aqui dentro.
  // galeria de modelos: categorias na lateral, busca, favoritos e prévia no
  // hover (mesmo desenho do painel de Transições)
  const capPanel = createCaptionsPanel($('#bePropsCaptions'), {
    onEscolher: (id) => selectCapTemplate(id),
    getEscolhido: () => capChosenPreset,
  });
  // re-estiliza as legendas EXISTENTES pelo template (por índice = por palavra)
  function applyCapTemplate(tpl) {
    const caps = store.getState().texts.filter(t => t.caption)
      .slice().sort((a, b) => a.start_sec - b.start_sec);
    caps.forEach((t, i) => {
      store.dispatch({ ...act.updateText(t.id, estiloDaPalavra(tpl, i)), gestureId: 'capstyle' });
    });
    store.endGesture();
  }
  function selectCapTemplate(key) {
    const tpl = modeloPorId(key); if (!tpl) return;
    capChosenPreset = tpl.id;
    capPanel.render();
    // reflete nos inputs manuais (tamanho/cor base)
    if ($('#beCapSize')) $('#beCapSize').value = tpl.size;
    if ($('#beCapColor') && tpl.colorMode !== 'rotate') $('#beCapColor').value = tpl.color || '#ffffff';
    if (!store.getState().texts.some(t => t.caption)) return; // sem legendas ainda: só guarda a escolha
    // com as palavras em cache dá pra regenerar (respeita o modo atual);
    // senão re-estiliza os blocos existentes por índice
    if (lastCaptionWords && lastCaptionPlan) {
      const mode = $('#beCapMode')?.value || 'palavra';
      const n = aplicarLegendas(mode);
      if (!n) applyCapTemplate(tpl);
    } else {
      applyCapTemplate(tpl);
    }
    toast('Estilo aplicado ✓');
  }

  // estilo GLOBAL das legendas: muda uma vez, aplica em todas (CapCut)
  function applyCapStyle(patchObj) {
    for (const t of store.getState().texts.filter(t => t.caption)) {
      store.dispatch({ ...act.updateText(t.id, patchObj), gestureId: 'capstyle' });
    }
    store.endGesture();
  }
  $('#beCapSize').addEventListener('change', (e) => applyCapStyle({ size: e.target.value }));
  $('#beCapColor').addEventListener('change', (e) => applyCapStyle({ color: e.target.value }));
  $('#beCapPos').addEventListener('change', (e) => applyCapStyle({ y_pct: parseFloat(e.target.value) }));
  $('#beCapDeleteAll').addEventListener('click', () => {
    for (const t of store.getState().texts.filter(t => t.caption)) {
      store.dispatch({ ...act.deleteText(t.id), gestureId: 'capdel' });
    }
    store.endGesture();
    $('#beCapStyleRow').style.display = 'none';
  });
  $('#beGroupBtn').addEventListener('click', () => {
    if ((store.getState().compounds || []).length >= 4) {
      return toast('Máximo de 4 clipes compostos — desfaça um (botão direito nele) pra criar outro', true);
    }
    const antes = (store.getState().compounds || []).length;
    store.dispatch(act.createCompound());
    if ((store.getState().compounds || []).length > antes) toast('Clipe composto criado ✓');
  });

  // ── toast ──
  function toast(msg, isError) {
    const el = $('#beToast');
    el.textContent = msg;
    el.className = 'be-toast show' + (isError ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 3500);
  }

  // flush do autosave ao esconder/fechar a aba (debounce de 2s podia perder
  // a ultima edicao). pagehide cobre iOS Safari.
  const flushOnHide = () => { if (document.visibilityState === 'hidden') autosave.flush(); };
  document.addEventListener('visibilitychange', flushOnHide);
  window.addEventListener('pagehide', () => autosave.flush());

  // ── headers das faixas com OLHINHO por camada (CapCut, user 2026-07-22) ──
  // Reconstruídos do layout REAL (rows dinâmicas de camada/áudio). Olhinho
  // esconde a camada do preview/export; áudio escondido = mudo.
  // ⚠️ Este bloco fica ANTES do attachResizers: o resizer chama
  // syncTrackHeaders() SINCRONAMENTE no mount — com o `let` depois dava TDZ
  // ("Cannot access before initialization") e ABORTAVA o mountEditor inteiro
  // (sem divisores, sem olhinho — bug pego pela sonda 2026-07-23).
  let _headersSig = null;
  // trava o rebuild enquanto o olhinho esta sendo arrastado: syncTrackHeaders
  // faz innerHTML='' e destruiria o proprio elemento que esta no gesto
  let _arrastandoCamada = false;
  function syncTrackHeaders() {
    syncBarraRolagem();
    if (_arrastandoCamada) return;
    const box = $('#beTrackHeaders');
    if (!box) return;
    const lay = timeline.getLayout?.();
    if (!lay) return;
    const rows = [];
    for (const r of (lay.laneRows || [])) {
      rows.push({ y: r.y, h: r.h, icon: '🎬', title: 'Camada ' + r.lane, kind: 'overlay', lane: r.lane, hidden: r.hidden, eye: true });
    }
    rows.push({ y: lay.yVideo, h: lay.videoTrackH, icon: '🎞', title: 'Vídeo principal', eye: false });
    for (const r of (lay.audioLaneRows || [])) {
      rows.push({ y: r.y, h: r.h, icon: '♪', title: 'Áudio ' + (r.lane + 1), kind: 'audio', lane: r.lane, hidden: r.hidden, eye: true });
    }
    // ⚠️ kind+lane PRECISAM entrar na assinatura: reordenar camadas troca os
    // NUMEROS sem mexer em y/h — sem isso o sync saia cedo e o olhinho ficava
    // com a camada antiga presa no closure (escondia a camada errada).
    const sig = rows.map(r => `${r.y}|${r.h}|${r.icon}|${r.hidden ? 1 : 0}|${r.kind || ''}|${r.lane ?? ''}`).join(';');
    if (sig === _headersSig) return;
    _headersSig = sig;
    box.innerHTML = '';
    for (const r of rows) {
      const el = document.createElement('div');
      el.className = 'be-track-h' + (r.hidden ? ' be-track-hidden' : '');
      el.style.top = r.y + 'px';
      el.style.height = r.h + 'px';
      el.title = r.title;
      if (r.kind) { el.dataset.kind = r.kind; el.dataset.lane = String(r.lane); }
      const ic = document.createElement('span');
      ic.className = 'be-track-ic';
      ic.textContent = r.icon;
      el.appendChild(ic);
      if (r.eye) {
        const eye = document.createElement('button');
        eye.className = 'be-track-eye';
        eye.textContent = r.hidden ? '🚫' : '👁';
        eye.title = r.hidden
          ? 'Mostrar camada (arraste pra reordenar)'
          : 'Ocultar camada (some do vídeo; áudio fica mudo) — arraste pra reordenar';
        eye.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (eye._pulouClique) return;   // o gesto foi arrasto, nao clique
          store.dispatch(act.toggleLaneVisibility(r.kind, r.lane));
        });
        ligarArrastoDeCamada(eye, r, box);
        el.appendChild(eye);
      }
      box.appendChild(el);
    }
  }

  /** ARRASTAR O OLHINHO REORDENA AS CAMADAS (user 2026-07-29).
   *  Clique parado continua ligando/desligando a camada; so vira reordenacao
   *  depois de 5px de movimento vertical. So troca com camada do MESMO tipo
   *  (video com video, audio com audio) — audio nunca sobe pra cima do video. */
  function ligarArrastoDeCamada(eye, r, box) {
    eye.addEventListener('pointerdown', (ev) => {
      if (!r.kind || ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const y0 = ev.clientY;
      let arrastou = false;
      try { eye.setPointerCapture(ev.pointerId); } catch {}

      const alvoEmY = (clientY) => {
        for (const el of box.children) {
          if (el.dataset?.kind !== r.kind) continue;
          const b = el.getBoundingClientRect();
          if (clientY >= b.top && clientY <= b.bottom) return Number(el.dataset.lane);
        }
        return null;
      };
      const marcar = (clientY) => {
        for (const el of box.children) el.classList.remove('be-track-alvo');
        const lane = alvoEmY(clientY);
        if (lane == null || lane === r.lane) return;
        for (const el of box.children) {
          if (el.dataset?.kind === r.kind && Number(el.dataset.lane) === lane) el.classList.add('be-track-alvo');
        }
      };
      const mover = (e2) => {
        if (!arrastou) {
          if (Math.abs(e2.clientY - y0) < 5) return;
          arrastou = true;
          _arrastandoCamada = true;
          eye.classList.add('be-track-eye-drag');
        }
        marcar(e2.clientY);
      };
      const soltar = (e2) => {
        window.removeEventListener('pointermove', mover);
        window.removeEventListener('pointerup', soltar);
        window.removeEventListener('pointercancel', soltar);
        eye.classList.remove('be-track-eye-drag');
        _arrastandoCamada = false;   // destrava SEMPRE, mesmo se nao houve arrasto
        for (const el of box.children) el.classList.remove('be-track-alvo');
        if (!arrastou) return;
        const destino = alvoEmY(e2.clientY);
        if (destino != null && destino !== r.lane) {
          store.dispatch(act.reorderLanes(r.kind, r.lane, destino));
        }
        _headersSig = null;      // numeracao mudou: forca o rebuild
        syncTrackHeaders();
        eye._pulouClique = true; // segura o click que vem logo depois do up
        setTimeout(() => { eye._pulouClique = false; }, 0);
      };
      // listeners na JANELA (nao no botao): se o setPointerCapture falhar, o
      // pointerup pode nao chegar no olhinho — e ai _arrastandoCamada ficaria
      // preso em true e os cabecalhos parariam de se redesenhar pra sempre.
      window.addEventListener('pointermove', mover);
      window.addEventListener('pointerup', soltar);
      window.addEventListener('pointercancel', soltar);
    });
  }
  // ── ROLAGEM VERTICAL DAS FAIXAS (2026-07-29) ────────────────────────────
  // Com ate 9 camadas de video, 9 de texto e 9 de audio, o conteudo nao cabe
  // mais na altura da timeline. A barra existe pra isso ser DESCOBRIVEL — sem
  // ela o usuario criaria a camada 9 e acharia que sumiu.
  let barraY = null, polegar = null;
  function montarBarraRolagem() {
    const wrap = $('#beTimeline')?.parentElement;
    if (!wrap || barraY) return;
    barraY = document.createElement('div');
    barraY.className = 'be-vscroll';
    polegar = document.createElement('div');
    polegar.className = 'be-vscroll-thumb';
    barraY.appendChild(polegar);
    wrap.appendChild(barraY);

    polegar.addEventListener('pointerdown', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const y0 = ev.clientY;
      const s0 = timeline.getScrollY();
      const max = timeline.getMaxScrollY();
      const alturaBarra = barraY.getBoundingClientRect().height;
      const alturaPolegar = polegar.getBoundingClientRect().height;
      const curso = Math.max(1, alturaBarra - alturaPolegar);
      const mover = (e2) => timeline.setScrollY(s0 + ((e2.clientY - y0) / curso) * max);
      const soltar = () => {
        window.removeEventListener('pointermove', mover);
        window.removeEventListener('pointerup', soltar);
        window.removeEventListener('pointercancel', soltar);
        polegar.classList.remove('be-vscroll-drag');
      };
      polegar.classList.add('be-vscroll-drag');
      window.addEventListener('pointermove', mover);
      window.addEventListener('pointerup', soltar);
      window.addEventListener('pointercancel', soltar);
    });

    // roda do mouse sobre a COLUNA DOS CABECALHOS rola as faixas (a roda sobre
    // o canvas continua sendo zoom; la a rolagem e Alt+roda)
    $('#beTrackHeaders')?.addEventListener('wheel', (e) => {
      e.preventDefault();
      timeline.rolarY(e.deltaY);
    }, { passive: false });
  }
  function syncBarraRolagem() {
    montarBarraRolagem();
    if (!barraY || !timeline.getMaxScrollY) return;
    const max = timeline.getMaxScrollY();
    const h = $('#beTimeline')?.getBoundingClientRect().height || 0;
    if (max <= 1 || h <= 0) { barraY.style.display = 'none'; return; }
    barraY.style.display = 'block';
    const alt = Math.max(30, Math.round(h * (h / (max + h))));
    const topo = Math.round((timeline.getScrollY() / max) * (h - alt));
    polegar.style.height = alt + 'px';
    polegar.style.top = topo + 'px';
  }

  store.subscribe(syncTrackHeaders);
  requestAnimationFrame(() => requestAnimationFrame(syncTrackHeaders));

  const detachResizers = attachResizers(root, () => { timeline.draw(); syncTrackHeaders(); });

  sync();
  // modo inicial do preview: a sub-aba padrão é "Básico", então quem aparece é
  // a moldura do vídeo (a máscara só entra quando a aba dela abre)
  aplicarModoPreview($('#beCfgSubtabs .be-cfg-subtab.active')?.dataset.sub || 'basico');

  // Desmonte de verdade. Sair pra home NUNCA chamava isto: o autosave seguia
  // assinado depois do DOM ser apagado. Idempotente porque agora existem dois
  // caminhos de saída (botão ← e destroy() de fora).
  let desmontado = false;
  function desmontar() {
    if (desmontado) return;
    desmontado = true;
    // gravação em curso não pode sobreviver ao desmonte (mic ficaria aberto)
    if (rec) {
      clearInterval(rec.timer);
      try { rec.mr.stop(); } catch {}
      rec.stream.getTracks().forEach(t => t.stop());
      rec = null;
    }
    detachResizers();
    detachShortcuts();
    document.removeEventListener('visibilitychange', flushOnHide);
    guardiao.destroy();
    player.destroy(); overlay.destroy(); pip.destroy(); maskUI.destroy(); frameUI.destroy(); fxTransicao.destroy(); transPanel.destroy(); clearTimeout(previewTimer); timeline.destroy();
    autosave.destroy(); exporter.destroy();
    for (const t of thumbsRegistry.values()) t.destroy();
    for (const w of videoWaveRegistry.values()) w.destroy();
    for (const w of waveRegistry.values()) w.destroy();
    if (localPreview.url) URL.revokeObjectURL(localPreview.url);
  }

  return { destroy: desmontar };
}

// Track headers agora são DINÂMICOS (syncTrackHeaders lê o layout real)
function buildTemplate() {
  return `
<header class="be-header">
  <button type="button" id="beBackHome" class="be-back" title="Voltar aos projetos">←</button>
  <span class="be-logo">Blue<b>Editor</b></span>
  <input id="beProjectName" class="be-project-name" maxlength="120" placeholder="Nome do projeto"/>
  <span id="beSaveStatus" class="be-save-status"></span>
  <div class="be-header-right">
    <button id="beUndo" class="be-icon-btn" title="Desfazer (Ctrl+Z)">↩</button>
    <button id="beRedo" class="be-icon-btn" title="Refazer (Ctrl+Shift+Z)">↪</button>
    <button id="beExportBtn" class="be-export-btn">⬆ Exportar</button>
  </div>
</header>

<div id="beDrop" class="be-drop">
  <div class="be-drop-inner">
    <div class="be-drop-icon">🎬</div>
    <div id="beDropMsg">Arraste um vídeo ou clique pra escolher</div>
    <div class="be-dim">MP4, MOV ou WebM · máx 500MB</div>
    <div id="beDropProgress" class="be-progress" style="display:none"><i></i></div>
  </div>
  <input type="file" id="beFile" multiple accept="video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,audio/mp4,image/png,image/jpeg,image/webp,image/gif,.mp4,.mov,.webm,.mp3,.wav,.m4a,.aac,.png,.jpg,.jpeg,.webp,.gif" hidden/>
</div>

<div id="beWorkspace" class="be-workspace" style="display:none">

  <!-- BIBLIOTECA DE MÍDIA (coluna 1, esquerda — o "vermelho" do CapCut) -->
  <div class="be-library">
    <div class="be-rail">
      <button id="beAddMedia" class="be-rail-btn" title="Importar mídias (Ctrl+O)"><span>🎞</span>Mídia</button>
      <button id="beAddText" class="be-rail-btn" title="Adicionar texto"><span>T</span>Texto</button>
      <button id="beAddAudio" class="be-rail-btn" title="Adicionar música/narração"><span>♪</span>Áudio</button>
      <button id="beAutoCaptions" class="be-rail-btn" title="Gerar legendas automáticas (IA)"><span>💬</span>Legendas</button>
      <button id="beAbrirTransicoes" class="be-rail-btn" title="Transições entre cenas"><span>⧓</span>Transições</button>
    </div>

    <!-- BIBLIOTECA DE TRANSIÇÕES (2026-07-29) — layout do CapCut: categorias
         à esquerda, grade com prévia à direita, busca em cima.
         Clicar 1x = PRÉVIA no player (não aplica).
         Aplicar = ARRASTAR o card até a junção de duas cenas na timeline. -->
    <div id="beTransPanel" class="be-trans-panel" style="display:none">
      <div class="be-trans-busca">
        <input id="beTransBusca" type="search" placeholder="Buscar transição…" autocomplete="off"/>
        <button id="beTransFechar" class="be-tool-btn" title="Fechar">✕</button>
      </div>
      <div class="be-trans-corpo">
        <div id="beTransCats" class="be-trans-cats"></div>
        <div id="beTransGrade" class="be-trans-grade"></div>
      </div>
      <div class="be-trans-dica">Clique pra ver a prévia · arraste até a emenda de duas cenas pra aplicar</div>
    </div>
    <div class="be-library-body">
      <button id="beMediaImport" class="be-tool-btn">＋ Importar mídias</button>
      <div class="be-dim">Vídeos viram takes · áudios entram na faixa · imagens (PNG) viram camada. Arraste aqui ou selecione vários.</div>
      <div id="beMediaList" class="be-library-list"></div>
    </div>
  </div>

  <!-- preview central -->
  <div class="be-preview-area">
    <div class="be-preview-frame" id="beFrame">
      <!-- palco 9:16: mantém vídeo + camadas juntos e no formato certo,
           inclusive em tela cheia (centralizado, resto da tela preto) -->
      <div class="be-stage" id="beStage">
        <video id="beVideo" playsinline preload="auto"></video>
        <video id="beVideo2" playsinline preload="auto" muted class="be-buffering"></video>
        <div id="beOverlay"></div>
      </div>
      <!-- Convite de importação DENTRO do palco (2026-07-29): substitui a
           antiga tela cheia que barrava a entrada no editor. Some assim que
           entra qualquer mídia. -->
      <div id="beVazio" class="be-vazio">
        <div class="be-vazio-ico">🎬</div>
        <div class="be-vazio-tit">Seu projeto está vazio</div>
        <div class="be-vazio-sub">Arraste um arquivo aqui, ou use <b>🎞 Mídia</b> na barra lateral</div>
        <button id="beVazioBtn" class="be-vazio-btn">Escolher arquivo</button>
        <div class="be-vazio-dim">vídeo, áudio ou imagem · máx 500MB</div>
      </div>

      <!-- ZOOM DO PREVIEW (2026-07-29): roda do mouse sobre o vídeo aproxima;
           a janelinha no canto controla e volta ao enquadramento. Só VISUAL —
           não muda nada no projeto nem no arquivo exportado. -->
      <div id="bePvZoom" class="be-pvzoom" title="Zoom do preview (roda do mouse sobre o vídeo)">
        <button type="button" id="bePvZoomOut" title="Afastar">−</button>
        <span id="bePvZoomVal">100%</span>
        <button type="button" id="bePvZoomIn" title="Aproximar">＋</button>
        <button type="button" id="bePvZoomFit" title="Ajustar à moldura">⤢</button>
      </div>

      <!-- barra de controle no FULLSCREEN (tecla F) -->
      <div id="beFsBar" class="be-fs-bar">
        <button id="beFsPlay" class="be-fs-play">▶</button>
        <div id="beFsProgress" class="be-fs-progress"><div id="beFsFill"></div></div>
        <span id="beFsTime" class="be-fs-time">0:00 / 0:00</span>
        <button id="beFsExit" class="be-fs-exit" title="Sair (Esc / F)">⤢</button>
      </div>
    </div>
    <audio id="beAudio" preload="auto"></audio>
    <div class="be-transport">
      <button id="bePlayBtn" class="be-play-btn">▶</button>
      <span id="beTimeLabel" class="be-time">0:00 / 0:00</span>
      <!-- PROPORÇÃO do projeto (user 14/08): ajusta o preview E o arquivo
           exportado — vídeo horizontal/"longo" deixa de ser gambiarra em 9:16 -->
      <div class="be-formato-wrap">
        <button id="beFormatoBtn" class="be-formato-btn" title="Proporção do vídeo (muda o preview e a exportação)">▯ 9:16</button>
        <div id="beFormatoMenu" class="be-formato-menu" style="display:none"></div>
      </div>
    </div>
  </div>

  <!-- CONFIGURAÇÕES DAS FAIXAS (coluna 2, meio — o "amarelo" do CapCut) -->
  <div class="be-props">

    <!-- PARÂMETROS DA TRANSIÇÃO (2026-07-29) — abre ao selecionar a emenda,
         como no print: nome, duração e intensidade. -->
    <div id="bePropsTrans" class="be-props-stack" style="display:none">
      <div class="be-side-title">Transição</div>
      <div class="be-trans-param-nome">Nome <b id="beTransNome">—</b></div>
      <label class="be-slider-label">Duração <b id="beTransDurVal">0,5s</b>
        <input id="beTransDur" type="range" min="10" max="300" step="5" value="50"/>
      </label>
      <label class="be-slider-label">Intensidade <b id="beTransIntVal">50%</b>
        <input id="beTransInt" type="range" min="0" max="100" step="1" value="50"/>
      </label>
      <button id="beTransRemover" class="be-tool-btn">🗑 Remover transição</button>
    </div>

    <div id="bePropsProject" class="be-props-stack">
      <div class="be-side-title">Projeto</div>
      <label class="be-field">Formato de saída
        <select id="beAspect" class="be-select">
          <option value="crop_center">Preencher o quadro (corta bordas)</option>
          <option value="letterbox">Caber inteiro (barras)</option>
        </select>
      </label>
      <div class="be-dim" id="beProjSaida">Saída: 1080×1920 vertical</div>
      <div class="be-sep"></div>
      <div class="be-side-title">Áudio</div>
      <button id="beAddAudio2" class="be-tool-btn">🎵 Adicionar música/narração</button>
      <input type="file" id="beAudioFile" accept="audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a,.aac" hidden/>
      <div id="beAudioCount" class="be-dim">Nenhum áudio adicional</div>
      <label class="be-slider-label">Volume do vídeo <input id="beVolVideo" type="range" min="0" max="2" step="0.05" value="1"/></label>
      <button id="beDetachAudio" class="be-tool-btn" title="Ctrl+Shift+S">🔀 Separar áudio do vídeo</button>
      <div class="be-sep"></div>
      <div class="be-side-title">Legendas</div>
      <div class="be-dim">Abra <b>💬 Legendas</b> na barra lateral pra escolher o estilo e gerar.</div>
      <div class="be-sep"></div>
      <div class="be-side-title">Transições</div>
      <div id="beTransitions" class="be-transitions"></div>
    </div>

    <!-- BIBLIOTECA DE ÁUDIO (Músicas / Efeitos / Favoritos) -->
    <div id="bePropsAudioLib" class="be-props-stack" style="display:none">
      <div class="be-side-title">♪ Áudio <button id="beAudioLibClose" class="be-tool-btn" style="float:right;padding:1px 8px">✕</button></div>
      <div class="be-cfg-subtabs" id="beAudioLibTabs">
        <button data-atab="musicas" class="be-cfg-subtab active">Músicas</button>
        <button data-atab="efeitos" class="be-cfg-subtab">Efeitos</button>
        <button data-atab="favoritos" class="be-cfg-subtab">Favoritos</button>
      </div>
      <input id="beAudioLibSearch" class="be-select" placeholder="🔎 Buscar…" style="width:100%"/>
      <div id="beAudioLibResults" class="be-audio-lib"></div>
    </div>

    <!-- PAINEL DEDICADO DE LEGENDAS (escolhe estilo ANTES de transcrever) -->
    <div id="bePropsCaptions" class="be-props-stack" style="display:none">
      <div class="be-side-title">💬 Legendas <button id="beCapClose" class="be-tool-btn" style="float:right;padding:1px 8px">✕</button></div>
      <div class="be-dim">Escolha o modelo, depois gere. A legenda acompanha a fala do seu áudio (o áudio que você gravou tem prioridade).</div>

      <div class="be-side-sub">Modo</div>
      <div class="be-cap-modes" id="beCapModeCards">
        <button class="be-cap-card" data-mode="frase">
          <div class="be-cap-demo demo-multi"><span>sua fala</span><span>em multilinha</span></div>
          <div class="be-cap-name">Multilinha</div>
        </button>
        <button class="be-cap-card active" data-mode="palavra">
          <div class="be-cap-demo demo-word"><i>palavra</i><i>por</i><i>palavra</i></div>
          <div class="be-cap-name">Palavra por palavra</div>
        </button>
      </div>
      <select id="beCapMode" style="display:none"><option value="frase">frase</option><option value="palavra" selected>palavra</option></select>

      <div class="be-side-sub">Modelo</div>
      <input id="beCapBusca" class="be-cap-busca" type="search" placeholder="Buscar modelo…" autocomplete="off"/>
      <div class="be-cap-galeria">
        <div class="be-cap-cats" id="beCapCats"></div>
        <div class="be-cap-grade" id="beCapGrade"></div>
      </div>
      <div class="be-dim be-cap-hint">Passe o mouse num modelo pra ver a animação · ★ guarda nos favoritos</div>

      <button id="beAutoCaptions2" class="be-tool-btn be-cap-generate">✨ Gerar legendas automáticas</button>

      <div id="beCapStyleRow" style="display:none;flex-direction:column;gap:8px">
        <div class="be-sep"></div>
        <div class="be-side-sub">Ajuste fino</div>
        <select id="beCapPreset" style="display:none"><option value=""></option></select>
        <div class="be-panel-row">
          <label>Tamanho <select id="beCapSize">
            <option value="small">Pequeno</option>
            <option value="medium" selected>Médio</option>
            <option value="large">Grande</option>
          </select></label>
          <label>Cor <input id="beCapColor" type="color" value="#ffffff"/></label>
          <label>Posição <select id="beCapPos">
            <option value="0.82" selected>Embaixo</option>
            <option value="0.5">Centro</option>
            <option value="0.15">Em cima</option>
          </select></label>
        </div>
        <button id="beCapDeleteAll" class="be-danger-btn">🗑 Remover todas as legendas</button>
      </div>
    </div>

    <div id="bePropsClip" class="be-props-stack" style="display:none">
      <div class="be-side-title">Cena selecionada <span class="be-dim" style="font-weight:400">· <span id="beClipDur">–</span></span></div>
      <!-- ABAS estilo CapCut -->
      <div class="be-cfg-tabs" id="beCfgTabs">
        <button data-tab="video" class="be-cfg-tab active">Vídeo</button>
        <button data-tab="audio" class="be-cfg-tab">Áudio</button>
        <button data-tab="velocidade" class="be-cfg-tab">Velocidade</button>
        <button data-tab="animacao" class="be-cfg-tab">Animação</button>
        <button data-tab="ajuste" class="be-cfg-tab">Ajuste</button>
      </div>

      <!-- ABA VÍDEO -->
      <div class="be-cfg-panel" data-panel="video">
        <div class="be-cfg-subtabs" id="beCfgSubtabs">
          <button data-sub="basico" class="be-cfg-subtab active">Básico</button>
          <button data-sub="fundo" class="be-cfg-subtab">Remover fundo</button>
          <button data-sub="mascarar" class="be-cfg-subtab">Mascarar</button>
        </div>
        <div class="be-cfg-sub" data-sub="basico">
          <label class="be-slider-label">Escala <b id="beClipScaleVal">100%</b>
            <input id="beClipScale" type="range" min="10" max="200" step="1" value="100"/>
          </label>
          <label class="be-slider-label">Opacidade <b id="beClipOpacityVal">100%</b>
            <input id="beClipOpacity" type="range" min="0" max="100" step="1" value="100"/>
          </label>
          <div class="be-sep"></div>
          <button id="beToggleClip2" class="be-tool-btn">◌ Desativar cena</button>
          <button id="beDelClip2" class="be-danger-btn">🗑 Excluir cena</button>
          <div class="be-dim">Arraste as bordas azuis na timeline pra cortar · V liga/desliga · Ctrl+B divide</div>
        </div>
        <div class="be-cfg-sub" data-sub="fundo" style="display:none">
          <div class="be-dim">🪄 Remoção de plano de fundo por IA — <b>em breve</b>.</div>
        </div>
        <div class="be-cfg-sub" data-sub="mascarar" style="display:none">
          <div class="be-btn-group" id="beMaskShapes">
            <button type="button" data-mask="none" class="active">Nenhuma</button>
            <button type="button" data-mask="rect">▭ Retângulo</button>
            <button type="button" data-mask="circle">◯ Círculo</button>
          </div>
          <div id="beMaskCtrls" style="display:none;flex-direction:column;gap:8px">
            <label class="be-slider-label">Posição X <input id="beMaskX" type="range" min="0" max="100" step="1" value="50"/></label>
            <label class="be-slider-label">Posição Y <input id="beMaskY" type="range" min="0" max="100" step="1" value="50"/></label>
            <label class="be-slider-label">Largura <input id="beMaskW" type="range" min="5" max="100" step="1" value="60"/></label>
            <label class="be-slider-label" data-mask-campo="h">Altura <input id="beMaskH" type="range" min="5" max="100" step="1" value="60"/></label>
            <label class="be-slider-label">Suavizar <input id="beMaskFeather" type="range" min="0" max="100" step="1" value="0"/></label>
            <label class="be-slider-label" id="beMaskRadiusRow">Cantos arredondados <input id="beMaskRadius" type="range" min="0" max="100" step="1" value="0"/></label>
          </div>
          <div class="be-dim">A máscara recorta a cena na forma escolhida. Suavizar mescla a borda; cantos só valem pro retângulo.</div>
        </div>
      </div>

      <!-- demais abas (placeholder até implementarmos) -->
      <div class="be-cfg-panel" data-panel="audio" style="display:none">
        <button id="beClipMute" class="be-tool-btn">🔇 Remover áudio desta cena</button>
        <div class="be-dim">Vale SÓ pra cena selecionada — as outras faixas continuam com o áudio delas. Pra editar o áudio na faixa própria, use Separar áudio (Ctrl+Shift+S).</div>
      </div>
      <div class="be-cfg-panel" data-panel="velocidade" style="display:none">
        <label class="be-slider-label">Velocidade <b id="beClipSpeedVal">1.00x</b>
          <input id="beClipSpeed" type="range" min="-100" max="200" step="1" value="0"/>
        </label>
        <div class="be-dim">Arraste pra desacelerar (até 0.10x) ou acelerar (até 100x). Afeta só esta cena — a duração na timeline muda junto.</div>
        <button id="beClipSpeedReset" class="be-tool-btn">↺ Voltar pra 1.00x</button>
      </div>
      <!-- ANIMAÇÃO da cena (user 14/08): Entrada / Saída / Combinação.
           Clique APLICA na cena selecionada (nada de arrastar): entrada no
           comecinho, saída no fim, combinação a cena inteira. Catálogo
           fechado em core/animacoes-cena.js — cada uma testada por pixel. -->
      <div class="be-cfg-panel" data-panel="animacao" style="display:none">
        <div class="be-cfg-subtabs" id="beAnimCats">
          <button type="button" data-acat="in" class="be-cfg-subtab active">Entrada</button>
          <button type="button" data-acat="out" class="be-cfg-subtab">Saída</button>
          <button type="button" data-acat="loop" class="be-cfg-subtab">Combinação</button>
        </div>
        <div id="beAnimCards" class="be-anim-cards"></div>
        <div class="be-dim">Clique aplica na cena selecionada. Entrada anima o começo, saída o fim, combinação dura a cena inteira.</div>
      </div>
      <!-- AJUSTE = o Retoque (correção de cor). Morava como sub-aba de Vídeo
           e a aba Ajuste ficou com "em breve" — o user clicava aqui e achava
           que a feature tinha sumido (print 14/08). Uma casa só, a natural. -->
      <div class="be-cfg-panel" data-panel="ajuste" style="display:none">
        <div class="be-grade-topo">
          <span class="be-dim">Ajustes desta cena</span>
          <button type="button" id="beGradeReset" class="be-tool-btn" title="Voltar tudo ao neutro">↺ Redefinir</button>
        </div>
        <!-- as 4 abas do print: Básico | HSL | Curvas | Roda de cores.
             Todos os controles usam data-grade="<chave plana>", então o
             listener e o preenchimento já existentes valem pros novos. -->
        <div class="be-cfg-subtabs be-grade-abas" id="beGradeAbas">
          <button type="button" data-gaba="basico" class="be-cfg-subtab active">Básico</button>
          <button type="button" data-gaba="hsl" class="be-cfg-subtab">HSL</button>
          <button type="button" data-gaba="curvas" class="be-cfg-subtab">Curvas</button>
          <button type="button" data-gaba="roda" class="be-cfg-subtab">Roda de cores</button>
        </div>
        <div id="beGradeCampos" class="be-grade-campos" data-gaba-painel="basico"></div>
        <div id="beGradeHsl" class="be-grade-campos" data-gaba-painel="hsl" style="display:none"></div>
        <div id="beGradeCurvas" class="be-grade-campos" data-gaba-painel="curvas" style="display:none"></div>
        <div id="beGradeRoda" class="be-grade-campos" data-gaba-painel="roda" style="display:none"></div>
      </div>
    </div>

    <div id="bePropsOverlay" class="be-props-stack" style="display:none">
      <div class="be-side-title">⧉ Camada</div>
      <div class="be-dim">Arraste no preview pra posicionar · scroll = tamanho · ⟳ acima = girar · bordas na timeline = cortar.</div>
      <label class="be-slider-label">Velocidade <b id="beOvSpeedVal">1.00x</b>
        <input id="beOvSpeed" type="range" min="-100" max="200" step="1" value="0"/>
      </label>
      <label class="be-slider-label">Girar <b id="beOvRotVal">0°</b>
        <input id="beOvRot" type="range" min="0" max="359" step="1" value="0"/>
      </label>
      <div class="be-dim">Botão direito na camada = Copiar/Cortar/frente-trás. Q/W cortam no cursor.</div>
      <!-- som embutido da camada (user 14/08): permanece a menos que remova -->
      <button id="beOvMute" class="be-tool-btn">🔇 Remover o som da camada</button>
      <!-- ANIMAÇÃO DA CAMADA (user 14/08): só as anims com par REAL na
           composição do arquivo (fades, deslizes, balanço) — zoom/pulso
           ficam na cena principal até terem par confiável no render -->
      <div id="beOvAnimSec" class="be-ov-anim">
        <div class="be-side-title">Animação da camada</div>
        <div class="be-cfg-subtabs" id="beOvAnimCats">
          <button type="button" data-oacat="in" class="be-cfg-subtab active">Entrada</button>
          <button type="button" data-oacat="out" class="be-cfg-subtab">Saída</button>
          <button type="button" data-oacat="loop" class="be-cfg-subtab">Combinação</button>
        </div>
        <div id="beOvAnimCards" class="be-anim-cards"></div>
      </div>
      <button id="beOverlayDelete" class="be-danger-btn">🗑 Excluir camada</button>
    </div>

    <div id="bePropsAudio" class="be-props-stack" style="display:none">
      <div class="be-side-title" id="beAudioPanelTitle">♪ Áudio</div>
      <div class="be-dim">Duração: <span id="beAudioClipDur">–</span> · corte com ✂, arraste pra mover · efeitos no botão 🎚 da barra</div>
      <label class="be-slider-label">Volume <input id="beVolSelected" type="range" min="0" max="2" step="0.05" value="1"/></label>
      <label class="be-slider-label">Velocidade <b id="beAudioSpeedVal">1.00x</b>
        <input id="beAudioSpeed" type="range" min="-100" max="200" step="1" value="0"/>
      </label>
      <button id="beAudioItemDelete" class="be-danger-btn">🗑 Excluir áudio</button>
      <div class="be-dim">Delete/Backspace também exclui o item selecionado</div>
    </div>

    <div id="beTextPanel" class="be-props-stack" style="display:none">
      <div class="be-panel-head">Texto <button id="beTextClose" class="be-icon-btn">✕</button></div>
      <!-- sub-abas: Legendas (transcrição) | Texto (formatação) -->
      <div class="be-cfg-tabs" id="beTextTabs">
        <button data-ttab="texto" class="be-cfg-tab active">Texto</button>
        <button data-ttab="legendas" class="be-cfg-tab" id="beTextTabCap">Legendas</button>
      </div>

      <!-- ABA TEXTO: formatação -->
      <div class="be-text-tab" data-ttab="texto">
        <label class="be-cap-applyall" id="beCapApplyAllRow" style="display:none">
          <input type="checkbox" id="beCapApplyAll" checked/> Aplicar a todas as legendas
        </label>
        <textarea id="beTextContent" rows="2" maxlength="200" placeholder="Digite o texto…"></textarea>
        <div class="be-panel-row">
          <label>Fonte <select id="beTextFont">${TEXT_FONTS.map(f => `<option>${f}</option>`).join('')}</select></label>
          <label>Tamanho <select id="beTextSize">${TEXT_SIZES.map(s => `<option value="${s}">${({ small: 'Pequeno', medium: 'Médio', large: 'Grande', xlarge: 'Gigante' })[s]}</option>`).join('')}</select></label>
        </div>
        <div class="be-panel-row">
          <label>Cor <input id="beTextColor" type="color" value="#ffffff"/></label>
          <label>Traçado <input id="beTextStroke" type="color" value="#000000" title="Borda em volta da letra"/></label>
          <label>Caixa
            <span class="be-btn-group">
              <button type="button" data-case="upper" title="MAIÚSCULAS">TT</button>
              <button type="button" data-case="lower" title="minúsculas">tt</button>
              <button type="button" data-case="title" title="Primeira Maiúscula">Tt</button>
            </span>
          </label>
        </div>
        <div class="be-panel-row">
          <label>Animação <select id="beTextAnim" title="Entrada e saída — vale no preview E no vídeo exportado">
            ${ANIMACOES.map(a => `<option value="${a.id}" title="${a.dica}">${a.nome}</option>`).join('')}
          </select></label>
        </div>
        <div class="be-panel-row">
          <label>Posição <select id="beTextPos">
            <option value="0.82">Embaixo</option>
            <option value="0.5">Centro</option>
            <option value="0.15">Em cima</option>
          </select></label>
          <label>Início (s) <input id="beTextStart" type="number" min="0" step="0.1"/></label>
          <label>Fim (s) <input id="beTextEnd" type="number" min="0" step="0.1"/></label>
        </div>
        <button id="beTextDelete" class="be-danger-btn">Excluir texto</button>
        <div class="be-dim">Arraste o texto direto no preview pra posicionar</div>
      </div>

      <!-- ABA LEGENDAS: transcrição completa clicável -->
      <div class="be-text-tab" data-ttab="legendas" style="display:none">
        <div class="be-dim">Transcrição completa — clique numa linha pra editar aquele ponto.</div>
        <div id="beTranscriptList" class="be-transcript"></div>
      </div>
    </div>

  </div>

  <!-- toolbar + timeline multi-track -->
  <div class="be-timeline-area">
    <div id="beCompoundBar" style="display:none;align-items:center;gap:10px;padding:4px 2px">
      <button id="beCompoundExit" class="be-tool-btn">← Sair do clipe</button>
      <span id="beCompoundName" class="be-dim"></span>
    </div>

    <!-- CORTAR RESPIROS: painel de processamento (liquid glass) com progresso
         REAL e tempo decorrido — o user pediu pra ver o tempo se demorar -->
    <div id="beRespirosPop" class="be-glass be-respiros-pop" style="display:none">
      <div class="be-respiros-tit"><span class="be-respiros-ia">🤖</span> <span id="beRespirosMsg">Analisando o áudio…</span></div>
      <div class="be-progress"><i id="beRespirosBar"></i></div>
      <div class="be-respiros-info"><span id="beRespirosPct">0%</span> · <span id="beRespirosTempo">0s</span></div>
      <button type="button" id="beRespirosCancel" class="be-tool-btn">Cancelar</button>
    </div>

    <!-- pill de GRAVAÇÃO (liquid glass): aparece flutuando sobre a timeline
         enquanto a locução grava; a faixa vai nascendo em tempo real -->
    <div id="beRecPill" class="be-glass be-rec-pill" style="display:none">
      <span class="be-rec-dot"></span>
      <span id="beRecTime" class="be-rec-time">0:00</span>
      <button type="button" id="beRecPause" title="Pausar gravação">⏸</button>
      <button type="button" id="beRecStop" title="Parar e colocar na timeline">⏹</button>
    </div>
    <div class="be-toolbar">
      <button id="beSplit" class="be-tool-btn" title="Dividir no cursor (Ctrl+B)">✂ Dividir</button>
      <button id="beDelLeft" class="be-tool-btn" title="Apagar antes do cursor (Q)">⇤ Apagar antes</button>
      <button id="beDelRight" class="be-tool-btn" title="Apagar depois do cursor (W)">⇥ Apagar depois</button>
      <button id="beToggleClip" class="be-tool-btn" title="Ativar/desativar cena (V)">◫ Liga/desliga</button>
      <button id="beDelClip" class="be-tool-btn" title="Excluir cena selecionada (Delete)">🗑 Excluir</button>
      <span class="be-toolbar-sep"></span>
      <button id="beAddText2" class="be-tool-btn" title="Adicionar texto no cursor">＋ Texto</button>
      <button id="beRecVoice" class="be-tool-btn" title="Gravar locução — a gravação entra na timeline a partir do cursor">🎙 Locução</button>
      <!-- APRIMORAR ÁUDIO (user 2026-07-29): botão AO LADO do Locução; passar
           o mouse abre as opções; CLICAR liga/desliga todos os efeitos -->
      <span class="be-fx-wrap" id="beFxWrap">
        <!-- ÍCONE EM SVG, não emoji (user 2026-08-07: "tá péssimo, parecendo
             uma cruz"). O 🎚 é desenhado pela fonte do SISTEMA e no Windows
             vira um retângulo/cruz sem sentido. SVG desenha igual em todo
             lugar: alto-falante + o brilho da IA ao lado. A cor vem do próprio
             botão (currentColor), então ele acende junto com a borda quando
             algum efeito está ligado.
             ⚠️ NADA de crase aqui dentro: este bloco é um template literal e
             uma crase no comentário fecha a string (foi o que quebrou o mount). -->
        <button id="beAudioFxBtn" class="be-tool-btn be-fx-btn" title="Aprimorar áudio com IA — clique liga/desliga tudo, passe o mouse pra escolher">
          <svg viewBox='0 0 24 24' width='18' height='18' fill='none' aria-hidden='true'>
            <path d='M3.5 9.5h2.6L10 6.2v11.6l-3.9-3.3H3.5V9.5Z' fill='currentColor'/>
            <path d='M12.6 9.4a3.6 3.6 0 0 1 0 5.2' stroke='currentColor' stroke-width='1.7' stroke-linecap='round'/>
            <path d='M15.1 7.1a7 7 0 0 1 0 9.8' stroke='currentColor' stroke-width='1.7' stroke-linecap='round' opacity='.55'/>
            <path d='M19.6 3.6l.75 2.05 2.05.75-2.05.75-.75 2.05-.75-2.05-2.05-.75 2.05-.75.75-2.05Z' fill='currentColor'/>
          </svg>
        </button>
        <div id="beAudioFxPop" class="be-glass be-audiofx-pop" style="display:none">
          <div class="be-audiofx-tit">Aprimorar áudio</div>
          <div id="beFxSemAlvo" class="be-dim" style="display:none">Selecione um clipe de áudio na timeline.</div>
          <label class="be-audiofx-row"><input type="checkbox" id="beFxRuido" data-fx="fx_ruido"/> Reduzir ruído <span class="be-fx-gema">💎</span></label>
          <label class="be-audiofx-row"><input type="checkbox" id="beFxVoz" data-fx="fx_voz"/> Aprimorar voz <span class="be-fx-gema">💎</span></label>
          <div id="beFxVozIntRow" class="be-audiofx-int" style="display:none">
            <span>Intensidade</span>
            <input id="beFxVozInt" type="range" min="0" max="100" step="1" value="75"/>
            <output id="beFxVozIntVal">75</output>
          </div>
          <label class="be-audiofx-row"><input type="checkbox" id="beFxNorm" data-fx="fx_norm"/> Normalizar nível de volume <span class="be-fx-gema">💎</span></label>
          <div class="be-dim">Normaliza o volume do clipe selecionado para um nível-alvo.</div>
        </div>
      </span>
      <button id="beCutSilence" class="be-tool-btn" title="Cortar respiros com IA — remove as pausas sem fala e aproxima a próxima frase">✂🤖 Respiros</button>
      <button id="beGroupBtn" class="be-tool-btn" title="Agrupar selecionados em clipe composto (Alt+G)">⧉ Agrupar</button>
      <span class="be-toolbar-spacer"></span>
      <button id="beZoomOut" class="be-icon-btn" title="Zoom - (Ctrl -)">−</button>
      <button id="beZoomFit" class="be-icon-btn" title="Caber (Shift+Z)">⤢</button>
      <button id="beZoomIn" class="be-icon-btn" title="Zoom + (Ctrl +)">＋</button>
    </div>
    <div class="be-timeline-row">
      <div class="be-track-headers" id="beTrackHeaders"></div>
      <div class="be-timeline-wrap">
        <canvas id="beTimeline"></canvas>
      </div>
    </div>
    <div class="be-hint be-dim">Espaço reproduz · Ctrl+B divide · Q/W apagam antes/depois · arraste as cenas pra reordenar · toque longo (celular) move</div>
  </div>
</div>

<div id="beExportModal" class="be-modal">
  <div class="be-modal-box">
    <div id="beExportOptions">
      <div class="be-modal-title">Exportar vídeo</div>
      <div class="be-export-opts">
        <div class="be-export-optthumb-wrap">
          <video id="beExportOptPreview" class="be-export-optthumb" muted playsinline preload="metadata"></video>
        </div>
        <div class="be-export-fields">
          <label class="be-export-field">Nome
            <input id="beExportName" type="text" maxlength="80" placeholder="Nome do arquivo"/>
          </label>
          <label class="be-export-field">Resolução
            <select id="beExportRes">
              <option value="2160">4K (2160p)</option>
              <option value="1440">2K (1440p)</option>
              <option value="1080" selected>1080p (Full HD)</option>
              <option value="720">720p</option>
              <option value="480">480p</option>
            </select>
          </label>
          <label class="be-export-field">Formato
            <select disabled><option>MP4 · H.264</option></select>
          </label>
          <label class="be-export-field">Taxa de quadros
            <select disabled><option>30 fps</option></select>
          </label>
          <!-- exportar SÓ O ÁUDIO (pedido do user): entrega .m4a com a mixagem
               e os efeitos aplicados, sem vídeo -->
          <label class="be-export-somaudio">
            <input type="checkbox" id="beExportAudioOnly"/>
            <span>Exportar <b>só o áudio</b> (.m4a)</span>
          </label>
          <div class="be-dim" id="beExportEst"></div>
          <div class="be-dim">O arquivo baixa direto pra sua pasta de Downloads.</div>
        </div>
      </div>
      <div class="be-export-actions">
        <button id="beExportStart" class="be-export-btn">⬇ Exportar e baixar</button>
        <button id="beExportOptCancel" class="be-tool-btn">Cancelar</button>
      </div>
    </div>
    <div id="beExportProgress" style="display:none">
      <div class="be-modal-title">Exportando seu vídeo…</div>
      <div class="be-progress"><i id="beExportBar"></i></div>
      <div id="beExportLabel" class="be-dim">Preparando…</div>
      <button id="beExportCancel" class="be-tool-btn">Cancelar</button>
    </div>
    <div id="beExportDone" style="display:none">
      <div class="be-modal-title">✅ Pronto!</div>
      <video id="beExportPreview" controls playsinline class="be-export-video"></video>
      <a id="beExportLink" class="be-export-btn" download target="_blank" rel="noopener">⬇ Baixar vídeo</a>
      <button id="beExportClose" class="be-tool-btn">Fechar</button>
    </div>
    <div id="beExportError" style="display:none">
      <div class="be-modal-title">⚠ Algo deu errado</div>
      <div id="beExportErrorMsg" class="be-dim"></div>
      <button class="be-tool-btn" onclick="this.closest('.be-modal').classList.remove('open')">Fechar</button>
    </div>
  </div>
</div>

<div id="beImportModal" class="be-import-modal" style="display:none">
  <div class="be-import-card">
    <div class="be-import-spin"></div>
    <div class="be-import-title" id="beImportTitle">Enviando mídia…</div>
    <div class="be-import-name" id="beImportName"></div>
    <div class="be-progress"><i id="beImportBar"></i></div>
    <div class="be-import-pct" id="beImportPct">0%</div>
  </div>
</div>
<div id="beToast" class="be-toast"></div>
`;
}
