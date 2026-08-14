// editor-v1/preview/player.js
// Transporte com TEMPO VIRTUAL + mixer multi-audio + DOUBLE BUFFER de vídeo.
// - dois <video> empilhados: o ativo mostra a cena atual, o buffer PRÉ-CARREGA
//   a próxima fonte (take). Ao cruzar a fronteira entre fontes diferentes, faz
//   um swap instantâneo — sem a tela preta de load() (user 2026-07-20).
// - cada audio_clip ganha um Audio() próprio, agendado por start/source_in/out.

import { timelineToSource, totalDuration, playableDuration, segmentAt, timelineSegments, effectiveAudioClips, mediaUrlFor, clipSpeed, segSpeed, audioTimelineDur } from '../core/selectors.js';
import { criarMotorFx } from './audio-fx.js';

// opts.primaryUrl(): url preferida do video PRINCIPAL. opts.bufferEl: 2º <video>.
export function createPlayer(videoEl, opts, store) {
  let virtualTime = 0;
  let playing = false;
  let rafId = 0;
  let lastTick = 0;
  const listeners = new Set();
  const pool = new Map(); // audio_clip.id -> { el, url }
  // motor do "Aprimorar áudio": cadeia Web Audio por clipe (preview REAL)
  const fxMotor = criarMotorFx();

  // double buffer: els[active] mostra, els[1-active] pré-carrega
  const els = [videoEl, opts?.bufferEl].filter(Boolean);
  let active = 0;
  // ── TRANSIÇÃO EM CURSO (2026-08-07) ──────────────────────────────────────
  // Antes a transição e o double-buffer disputavam os MESMOS dois elementos:
  // no meio do efeito o swap de fronteira trocava os papéis (ativo↔buffer),
  // as classes CSS ficavam presas nos elementos antigos e o resultado era a
  // tela preta + os dois vídeos duplicados que o user viu. Agora a transição
  // SEGURA a fronteira: o ativo continua tocando a cena que SAI (material
  // emprestado além do corte, igual ao xfade do render) e o swap acontece UMA
  // vez, no fim do efeito, dentro de concluirTransicao().
  // { jun, dur, fim, sailId, entraId, urlEntra } — jun = t da emenda.
  let trans = null;
  const disp = () => els[active];
  const buf = () => (els.length > 1 ? els[1 - active] : null);

  function emit() { for (const fn of listeners) fn(); }
  function primaryUrl() { return opts?.primaryUrl?.() || store.getState().video?.url || null; }
  function urlForClip(state, clip) {
    return clip.media_id != null ? mediaUrlFor(state, clip) : primaryUrl();
  }
  function applyVisibility() {
    els.forEach((el, i) => el.classList.toggle('be-buffering', i !== active));
  }

  // cada elemento aplica seu próprio seek pendente quando a mídia carrega
  els.forEach((el) => {
    el.addEventListener('loadedmetadata', () => {
      if (el._pendingSeek == null) return;
      try { el.currentTime = el._pendingSeek; } catch {}
      el._pendingSeek = null;
      if (playing && el === disp()) el.play().catch(() => {});
    });
    // mídia que FALHA não pode prender o relógio: o tick segura o tempo
    // enquanto houver _pendingSeek — um load com erro deixava tudo travado
    // pra sempre (o frame fica preto, mas a timeline segue)
    el.addEventListener('error', () => {
      el._pendingSeek = null;
      el._swapTo = null;
      el.dataset.loadedUrl = '';
    });
  });

  // tempo no arquivo pro instante virtual, considerando velocidade/reverso/frozen
  function srcForSeg(seg, tv) {
    const c = seg.clip;
    if (c.frozen) return c.freeze_src || 0;
    const off = (tv - seg.tStart) * segSpeed(seg);
    return c.reversed ? Math.max(c.source_in, c.source_out - off) : c.source_in + off;
  }

  // Mudo do <video>: audio_detached vale SÓ pro vídeo PRINCIPAL (a trilha
  // destacada dele toca pelo pool). Takes importados depois têm áudio PRÓPRIO
  // — nunca herdam o mudo (user 2026-07-22: "importo mais videos e vem sem
  // audio"; o flag global mutava o elemento pra TODAS as fontes).
  function vidMuted(state, seg) {
    if (seg?.clip?.muted) return true; // "remover áudio" SÓ desta cena (user 2026-07-24)
    return !!state.audio_detached && (!seg || seg.clip.media_id == null);
  }

  function syncVideoToVirtual(seekVideo = true) {
    // transição segurando a fronteira: o display está tocando a cena que SAI
    // (possivelmente além do source_out dela) e o buffer mostra a que ENTRA.
    // Mexer em qualquer um aqui desfaria o efeito no meio — quem encerra é
    // concluirTransicao()/abortarTransicao().
    if (trans) return;
    const state = store.getState();
    const dur = totalDuration(state);
    // ALÉM DO FIM DO VÍDEO = PRETO (fix 2026-07-29). O clamp abaixo existe pra
    // não piscar no último frame (t == dur), mas ele era aplicado SEMPRE — e aí
    // uma legenda/áudio que passa do fim do vídeo deixava a agulha numa região
    // sem imagem exibindo o último frame congelado, como se ainda houvesse
    // vídeo ali. Dentro do vídeo, clampa; fora dele, deixa passar pra
    // segmentAt devolver null e o quadro apagar.
    const tSeg = virtualTime <= dur ? Math.min(virtualTime, Math.max(0, dur - 0.001)) : virtualTime;
    const seg = segmentAt(state, tSeg);
    const src = seg ? srcForSeg(seg, tSeg) : null;
    const d = disp();
    // Sem clip ativo (faixa excluída/gap): esconde (preto) até voltar conteúdo.
    d.style.visibility = src == null ? 'hidden' : '';
    if (src == null) return;
    d.playbackRate = segSpeed(seg);
    const url = urlForClip(state, seg.clip);
    const atual = d.currentSrc || d.src || '';
    if (url && atual !== url) {
      const b = buf();
      if (b && b.dataset.loadedUrl === url && b.readyState >= 2) {
        // SWAP instantâneo: o buffer já tem esse take decodificado
        d._swapTo = null; // limpa troca pendente do elemento que sai de cena
        active = 1 - active;
        applyVisibility();
        const nd = disp();
        nd._pendingSeek = null;
        nd._swapTo = null;
        nd.style.visibility = '';
        nd.muted = vidMuted(state, seg);
        nd.volume = Math.min(1, state.volumes?.video ?? 1);
        nd.playbackRate = segSpeed(seg);
        try { nd.currentTime = src; } catch {}
        if (playing) nd.play().catch(() => {});
        buf().pause();
        buf().dataset.loadedUrl = '';
        return;
      }
      // SEM buffer pronto. DURANTE PLAYBACK: NUNCA faz load() no display (isso
      // apaga = "tela preta" entre takes) — garante o buffer carregando essa
      // fonte e marca a troca pendente; o tick segura o ÚLTIMO FRAME congelado
      // e troca quando o buffer decodifica. PAUSADO (scrub): não há tick pra
      // dirigir a troca, então load direto (pisca uma vez, aceitável no scrub).
      const bb = buf();
      if (bb && playing) {
        if (bb.dataset.loadedUrl !== url) {
          bb.dataset.loadedUrl = url;
          bb._pendingSeek = src;
          bb.muted = true;
          bb.src = url;
          bb.load();
        }
        d._swapTo = { url, src, t0: (typeof performance !== 'undefined' ? performance.now() : Date.now()) };
        return;
      }
      d._swapTo = null;
      d.src = url; d.load(); d._pendingSeek = src;
      return;
    }
    // fonte atual segue valendo: qualquer troca pendente ficou obsoleta
    // (ex.: seek de volta pro clip atual com swap agendado — não pode disparar)
    if (d._swapTo) d._swapTo = null;
    if (seekVideo && d._pendingSeek == null && Math.abs(d.currentTime - src) > 0.06) {
      d.currentTime = src;
    }
  }

  // próximo segmento CONTÍGUO na mesma fonte (o vídeo pode tocar direto pra
  // dentro dele, sem seek). Ex: um vídeo cortado em 2, ou os sub-clips de um
  // composto que vieram do mesmo arquivo.
  function nextContiguous(state, seg) {
    const segs = timelineSegments(state);
    const nx = segs.find(s => s.tStart >= seg.tEnd - 1e-6);
    if (!nx) return null;
    const c = seg.clip, n = nx.clip;
    if (n.frozen || n.reversed || c.frozen || c.reversed) return null;
    if (urlForClip(state, n) !== urlForClip(state, c)) return null;   // fonte diferente
    if (Math.abs(segSpeed(nx) - segSpeed(seg)) > 1e-3) return null;   // velocidade diferente
    if (Math.abs(n.source_in - c.source_out) > 0.12) return null;    // não colado no arquivo
    return nx;
  }

  // pré-carrega a PRÓXIMA fonte no buffer (só durante playback, só se a fonte
  // muda — clips do mesmo arquivo não precisam de swap)
  function preloadNext(state) {
    if (trans) return;   // buffer ocupado mostrando a cena que ENTRA
    const b = buf();
    if (!b) return;
    const cur = segmentAt(state, virtualTime);
    if (!cur) return;
    const segs = timelineSegments(state);
    const idx = segs.indexOf(cur);
    const nx = idx >= 0 ? segs[idx + 1] : null;
    if (!nx || nx.clip.frozen || nx.clip.reversed) return;
    const nurl = urlForClip(state, nx.clip);
    const curUrl = urlForClip(state, cur.clip);
    if (!nurl || nurl === curUrl) return;        // mesma fonte: sem flash mesmo
    if (b.dataset.loadedUrl === nurl) return;    // já pré-carregado
    b.dataset.loadedUrl = nurl;
    b._pendingSeek = nx.clip.reversed ? nx.clip.source_out : nx.clip.source_in;
    b.muted = true;
    b.src = nurl;
    b.load();
  }

  /** Só quem vai passar pelo Web Audio precisa de CORS: o clipe com algum
   *  "Aprimorar áudio" ligado. Sem efeito, o <audio> toca direto. */
  function precisaCors(a) {
    return a?.fx_ruido === true || a?.fx_voz === true || a?.fx_norm === true;
  }

  function syncPool() {
    const state = store.getState();
    const clips = effectiveAudioClips(state);
    const seen = new Set();
    for (const a of clips) {
      seen.add(a.id);
      const url = a.kind === 'video' ? primaryUrl() : a.url;
      if (!url) continue;
      let entry = pool.get(a.id);
      // ligou um efeito num clipe que nasceu sem CORS: refaz o elemento COM
      // CORS (é o único jeito — crossOrigin depois do src não vale nada)
      const trocarPorCors = entry && !entry.comCors && precisaCors(a) && !entry.corsFalhou;
      if (!entry || entry.url !== url || trocarPorCors) {
        entry?.el.pause?.();
        const el = new Audio();
        el.preload = 'auto';
        // ⚠️ SOM PRIMEIRO, EFEITO DEPOIS (user 2026-08-05: "adicionei uma
        // música e ficou mudo").
        //
        // O Web Audio precisa de CORS pra tocar a mídia sem silenciar, então
        // eu marcava crossOrigin='anonymous' em TODA faixa. Só que arquivo de
        // outra origem SEM o cabeçalho é RECUSADO pelo navegador: a música
        // falhava, falhava de novo e só voltava no recuo — segundos de mudo
        // num arquivo que tocaria de primeira sem CORS nenhum.
        //
        // Agora o CORS só entra quando o clipe REALMENTE precisa (efeito
        // ligado, ver `precisaCors`). Ouvir uma música — o caminho comum — não
        // paga mais o risco de uma feature que a maioria nem usa.
        if (precisaCors(a)) el.crossOrigin = 'anonymous';
        const comCors = precisaCors(a);
        const aoErrar = () => {
          const e = pool.get(a.id);
          if (!e || e.el !== el) return;
          e.fxErros = (e.fxErros || 0) + 1;
          // só faz sentido culpar o CORS se ele foi pedido
          const podeSerCors = comCors && /^https?:/i.test(url) && !url.startsWith(location.origin);
          if (!podeSerCors || e.fxErros === 1) {
            // 1ª falha pode ser soluço de rede: tenta de novo do mesmo jeito
            setTimeout(() => { try { el.load(); } catch {} }, 400);
            return;
          }
          // 2ª falha seguida com CORS pedido: recarrega SEM ele. Som intacto
          // sempre vence prévia de efeito. `corsFalhou` impede o vaivém.
          el.removeEventListener('error', aoErrar);
          const el2 = new Audio();
          el2.preload = 'auto';
          el2.src = url;
          pool.set(a.id, { el: el2, url, fxIndisponivel: true, corsFalhou: true, comCors: false });
          // O elemento novo nasce PARADO. Sem este empurrão ele só tocaria no
          // próximo tick — e se a troca aconteceu com o projeto tocando, o
          // usuário ouve um buraco (ou silêncio pra sempre, se o tick não vier).
          el2.addEventListener('loadeddata', () => syncAudios(virtualTime), { once: true });
          setTimeout(() => syncAudios(virtualTime), 0);
        };
        el.addEventListener('error', aoErrar);
        el.src = url;
        entry = { el, url, comCors, corsFalhou: pool.get(a.id)?.corsFalhou };
        pool.set(a.id, entry);
      }
    }
    for (const [id, entry] of pool) {
      if (!seen.has(id)) { entry.el.pause(); entry.el.removeAttribute('src'); pool.delete(id); }
    }
  }

  function syncAudios(t) {
    const state = store.getState();
    for (const a of effectiveAudioClips(state)) {
      const entry = pool.get(a.id);
      if (!entry) continue;
      const el = entry.el;
      const sp = clipSpeed(a);
      const dur = audioTimelineDur(a);
      const inside = t >= a.start - 0.02 && t < a.start + dur;
      el.volume = Math.min(1, a.volume ?? 1);
      fxMotor.sync(entry, a);   // Aprimorar áudio: cadeia real no preview
      el.playbackRate = sp;
      if (inside) {
        const local = a.source_in + (t - a.start) * sp;
        if (Math.abs(el.currentTime - local) > 0.25 * sp) {
          try { el.currentTime = local; } catch {}
        }
        if (playing && el.paused) el.play().catch(() => {});
        if (!playing && !el.paused) el.pause();
      } else if (!el.paused) {
        el.pause();
      }
    }
  }

  function tick(ts) {
    if (!playing) return;
    const state = store.getState();
    const total = playableDuration(state);
    const dt = lastTick ? (ts - lastTick) / 1000 : 0;
    lastTick = ts;
    const d = disp();

    // ── TRANSIÇÃO SEGURANDO A FRONTEIRA ────────────────────────────────────
    // O display toca a cena que SAI até o FIM do efeito (material emprestado
    // além do corte, espelho do xfade do render); o buffer toca a que ENTRA.
    // Nada de swap no meio — ele acontece uma vez, em concluirTransicao().
    if (trans) {
      const sSai = trans.segSai;
      const c = sSai.clip;
      // relógio: segue o vídeo que SAI. Se a fonte acabou (EOF) ou é um quadro
      // parado, anda por rAF — o efeito nunca congela esperando frame.
      let derivado = null;
      if (!c.frozen && !c.reversed && !d.ended && d.readyState >= 2) {
        derivado = sSai.tStart + Math.max(0, d.currentTime - c.source_in) / segSpeed(sSai);
      }
      if (derivado != null && derivado > virtualTime - 0.001 && derivado < virtualTime + 1.0) {
        virtualTime = Math.max(virtualTime, derivado);
      } else {
        virtualTime += dt;
      }
      if (c.frozen || c.reversed || d.ended) { if (!d.paused) d.pause(); }
      else if (d.paused) d.play().catch(() => {});
      d.playbackRate = segSpeed(sSai);
      // o CORTE DE ÁUDIO fica na emenda (igual ao render): até jun soa a cena
      // que sai; depois, a que entra. O visual atravessa a emenda inteiro.
      const b = buf();
      const depois = virtualTime >= trans.jun;
      d.muted = depois ? true : vidMuted(state, sSai);
      d.volume = Math.min(1, state.volumes?.video ?? 1);
      if (b) {
        b.muted = depois ? vidMuted(state, segmentAt(state, virtualTime)) : true;
        b.volume = Math.min(1, state.volumes?.video ?? 1);
        if (!trans.entraParado && b.paused && b.readyState >= 2 && b._pendingSeek == null) {
          b.play().catch(() => {});
        }
      }
      if (virtualTime >= trans.fim - 0.02 || virtualTime >= total) concluirTransicao();
      if (virtualTime >= total) { pause(); virtualTime = total; emit(); return; }
      syncAudios(virtualTime);
      emit();
      rafId = requestAnimationFrame(tick);
      return;
    }

    // TROCA PENDENTE pra fonte nova (take seguinte): mantém o último frame no
    // lugar do preto e troca assim que o buffer decodifica — playback fluido.
    if (d._swapTo) {
      const bb = buf();
      const ready = bb && bb.dataset.loadedUrl === d._swapTo.url && bb.readyState >= 2;
      if (ready) {
        const tgt = d._swapTo.src;
        d._swapTo = null;          // limpa no elemento ANTIGO (senão re-dispara)
        d.pause();
        active = 1 - active;
        applyVisibility();
        const nd = disp();
        const s2 = segmentAt(state, virtualTime);
        nd._swapTo = null; nd._pendingSeek = null; nd.style.visibility = '';
        nd.muted = vidMuted(state, s2);
        nd.volume = Math.min(1, state.volumes?.video ?? 1);
        nd.playbackRate = s2 ? segSpeed(s2) : 1;
        try { nd.currentTime = tgt; } catch {}
        if (playing) nd.play().catch(() => {});
        buf().dataset.loadedUrl = '';
        // FIM DO FRAME AQUI (fix 2026-07-22): o resto do tick usa `d`, que
        // ainda aponta pro elemento ANTIGO — seguir em frente lia o currentTime
        // dele, pulava o relógio virtual (ponteiro reiniciava, áudio voltava,
        // e se o pulo caía num gap a tela ficava PRETA). Fecha o frame limpo;
        // o próximo tick pega disp() novo e segue normal.
        syncAudios(virtualTime);
        emit();
        rafId = requestAnimationFrame(tick);
        return;
      } else {
        const espera = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - (d._swapTo.t0 || 0);
        if (bb && bb.error) {
          // o buffer FALHOU (rede/arquivo): não adianta esperar os 4s — cai
          // direto no load do display (pisca uma vez, mas não trava)
          const u = d._swapTo.url, s = d._swapTo.src; d._swapTo = null;
          bb.dataset.loadedUrl = '';
          d.src = u; d.load(); d._pendingSeek = s;
        } else if (espera > 4000) {
          // buffer não veio em 4s (rede ruim): aceita o load (pisca uma vez, mas
          // não trava pra sempre)
          const u = d._swapTo.url, s = d._swapTo.src; d._swapTo = null;
          d.src = u; d.load(); d._pendingSeek = s;
        } else {
          // ainda decodificando: congela o último frame (sem preto) e espera.
          // Pausa TAMBÉM os áudios do pool — o relógio está segurado; se eles
          // continuassem, ficariam na frente e no resume o sync os puxava pra
          // trás ("o áudio volta").
          if (!d.paused) d.pause();
          for (const [, entry] of pool) { if (!entry.el.paused) entry.el.pause(); }
        }
        rafId = requestAnimationFrame(tick);
        return;
      }
    }

    const seg = segmentAt(state, virtualTime);
    if (seg && d.error) {
      // vídeo QUEBRADO (fonte inválida, rede): a timeline NÃO congela por
      // causa dele — quadro preto, relógio por rAF, o áudio segue tocando
      virtualTime += dt;
      if (virtualTime >= total) { pause(); virtualTime = total; emit(); return; }
      syncAudios(virtualTime);
      emit();
      rafId = requestAnimationFrame(tick);
      return;
    }
    if (seg && d._pendingSeek != null) {
      // trocando de fonte (load em andamento): segura o relógio
      rafId = requestAnimationFrame(tick);
      return;
    }
    if (seg && (seg.clip.frozen || seg.clip.reversed)) {
      // congelado (1 frame) ou reverso (scrub pra trás): relógio por rAF
      if (!d.paused) d.pause();
      virtualTime += dt;
      if (virtualTime >= total) { pause(); virtualTime = total; emit(); return; }
      if (virtualTime >= seg.tEnd - 1e-3) virtualTime = seg.tEnd + 0.001;
      syncVideoToVirtual();
      syncAudios(virtualTime);
      emit();
      rafId = requestAnimationFrame(tick);
      return;
    }
    if (seg) {
      if (d.paused) d.play().catch(() => {});
      // garante que o elemento EM EXIBIÇÃO nunca fica mudo (o buffer é mutado
      // no preload; sem isso o áudio sumia às vezes após um swap — user #6)
      d.muted = vidMuted(state, seg);
      d.volume = Math.min(1, state.volumes?.video ?? 1);
      d.playbackRate = segSpeed(seg);
      preloadNext(state); // aquece o buffer com a próxima fonte
      const vSrc = d.currentTime;
      // A FONTE PODE ACABAR ANTES do source_out (metadado de duração
      // arredondado pra cima é comum em take usado inteiro). Sem tratar o
      // `ended`, o vSrc congelava abaixo do limiar e o relógio esperava pra
      // sempre um frame que não existe — era o "preto e trava" na troca de
      // mídia (user 2026-08-07).
      const fimDoArquivo = d.ended === true;
      if (!fimDoArquivo && vSrc >= seg.clip.source_in - 0.08 && vSrc <= seg.clip.source_out + 0.2) {
        virtualTime = seg.tStart + Math.max(0, vSrc - seg.clip.source_in) / segSpeed(seg);
        if (vSrc >= seg.clip.source_out - 0.03) {
          // fim do clip: se o próximo é CONTÍGUO na mesma fonte (split simples,
          // inclusive dentro do composto), DEIXA FLUIR — o <video> continua
          // tocando pra dentro do próximo, sem seek. Isso mata a tela preta e o
          // áudio repetindo a palavra (user 2026-07-20).
          if (!nextContiguous(state, seg)) {
            const nextT = seg.tEnd + 0.001;
            if (nextT >= total) { pause(); virtualTime = total; emit(); return; }
            virtualTime = nextT;
            syncVideoToVirtual();
          }
        }
      } else if (fimDoArquivo) {
        // arquivo acabou no meio da cena: pula pra próxima fronteira — mesmo
        // contíguo não há mais material pra "deixar fluir"
        const nextT = seg.tEnd + 0.001;
        if (nextT >= total) { pause(); virtualTime = total; emit(); return; }
        virtualTime = nextT;
        syncVideoToVirtual();
      } else {
        syncVideoToVirtual();
      }
    } else {
      // gap sem video (só-audio / audio além do fim): <video> pausa
      if (!d.paused) d.pause();
      virtualTime += dt;
      if (virtualTime >= total) { pause(); virtualTime = total; emit(); return; }
      syncVideoToVirtual();
    }
    syncAudios(virtualTime);
    emit();
    rafId = requestAnimationFrame(tick);
  }

  // ── TRANSIÇÃO DE VERDADE (reescrita 2026-08-07) ───────────────────────────
  // O contrato antigo (prepararEntrada/liberarEntrada) deixava o swap de
  // fronteira acontecer NO MEIO do efeito: os papéis dos dois <video>
  // invertiam, as classes CSS ficavam presas nos elementos antigos e sobrava
  // tela preta + imagem duplicada. Agora o player é o único dono da mecânica:
  // a transição SEGURA a fronteira e o swap é o ato final dela.

  /** Arma o efeito na emenda `jun` (só faz sentido tocando, antes da emenda).
   *  A cena que entra carrega no buffer começando dur/2 ANTES do corte —
   *  o mesmo material emprestado que o xfade do render usa. */
  function prepararTransicao({ jun, dur }) {
    const b = buf();
    if (!b) return false;
    if (trans) return Math.abs(trans.jun - jun) < 0.01;   // já segurando esta emenda
    const state = store.getState();
    const sSai = segmentAt(state, jun - 1e-3);
    const sEnt = segmentAt(state, jun + 1e-3);
    if (!sSai || !sEnt || sSai === sEnt) return false;
    if (virtualTime >= jun - 0.02) return false;          // tarde demais: corte seco honesto
    const url = urlForClip(state, sEnt.clip);
    if (!url) return false;
    const cE = sEnt.clip;
    const spE = segSpeed(sEnt);
    const src0 = cE.frozen ? (cE.freeze_src || 0)
      : cE.reversed ? (cE.source_out + (dur / 2) * spE)
      : Math.max(0, cE.source_in - (dur / 2) * spE);
    const d = disp();
    d._swapTo = null;                                     // o hold assume a fronteira
    if (b.dataset.loadedUrl !== url) {
      b.dataset.loadedUrl = url;
      b._pendingSeek = src0;
      b.muted = true;
      b.src = url;
      b.load();
    } else if (b._pendingSeek == null) {
      try { if (Math.abs(b.currentTime - src0) > 0.12) b.currentTime = src0; } catch {}
    }
    b.muted = true;                                       // o áudio da entrada só vale após a emenda
    b.playbackRate = spE;
    trans = {
      jun, dur, fim: jun + dur / 2,
      segSai: sSai,
      sailId: sSai.clip.id, entraId: cE.id,
      urlEntra: url,
      // congelado/reverso não "toca" pra frente: fica num frame parado
      entraParado: cE.frozen === true || cE.reversed === true,
    };
    if (!trans.entraParado && playing && b.readyState >= 2) b.play().catch(() => {});
    return true;
  }

  /** O ato final: troca ativo↔buffer UMA vez, com a entrada já no tempo certo
   *  (material emprestado = zero seek na cara do usuário). */
  function concluirTransicao() {
    if (!trans) return;
    const t = trans; trans = null;
    const state = store.getState();
    const b = buf(), d = disp();
    const pronto = b && b.dataset.loadedUrl === t.urlEntra && b.readyState >= 2 && b._pendingSeek == null;
    if (!pronto) {
      // a entrada nunca decodificou (rede/arquivo ruim): piscar uma vez é
      // melhor que segurar o palco — cai no caminho normal de troca
      syncVideoToVirtual();
      return;
    }
    d.pause();
    d._swapTo = null;
    active = 1 - active;
    applyVisibility();
    const nd = disp();
    const seg = segmentAt(state, virtualTime);
    nd._pendingSeek = null; nd._swapTo = null; nd.style.visibility = '';
    nd.muted = vidMuted(state, seg);
    nd.volume = Math.min(1, state.volumes?.video ?? 1);
    nd.playbackRate = seg ? segSpeed(seg) : 1;
    const alvo = seg ? srcForSeg(seg, virtualTime) : null;
    if (alvo != null && Math.abs(nd.currentTime - alvo) > 0.12) { try { nd.currentTime = alvo; } catch {} }
    if (playing && seg && !seg.clip.frozen && !seg.clip.reversed) nd.play().catch(() => {});
    const nb = buf();
    if (nb) { nb.pause(); nb.dataset.loadedUrl = ''; }
  }

  /** Desiste do efeito sem swap (seek pra fora, edição que mudou a emenda). */
  function abortarTransicao() {
    if (!trans) return;
    trans = null;
    const b = buf();
    if (b) b.pause();
    syncVideoToVirtual();
  }

  /** PAUSADO (scrub dentro da janela do efeito): o display mostra o lado sob a
   *  agulha (comportamento normal do seek); aqui o buffer recebe o OUTRO lado,
   *  parado no frame coerente com o instante — o palco compõe os dois. */
  function prepararLadoPausado({ t, jun }) {
    const b = buf();
    if (!b) return null;
    if (trans) return { sai: disp(), entra: b };          // pausou no meio do hold
    const state = store.getState();
    const sSai = segmentAt(state, jun - 1e-3);
    const sEnt = segmentAt(state, jun + 1e-3);
    if (!sSai || !sEnt) return null;
    const d = disp();
    const antes = t < jun;
    const outro = antes ? sEnt : sSai;
    const url = urlForClip(state, outro.clip);
    if (!url) return null;
    const sp = segSpeed(outro);
    const cO = outro.clip;
    const src = cO.frozen ? (cO.freeze_src || 0)
      : cO.reversed
        ? Math.max(0, antes ? cO.source_out + (jun - t) * sp : cO.source_in - (t - jun) * sp)
        : Math.max(0, antes ? cO.source_in - (jun - t) * sp : cO.source_out + (t - jun) * sp);
    if (b.dataset.loadedUrl !== url) {
      b.dataset.loadedUrl = url;
      b._pendingSeek = src;
      b.muted = true;
      b.src = url;
      b.load();
    } else if (b._pendingSeek == null) {
      try { if (Math.abs(b.currentTime - src) > 0.1) b.currentTime = src; } catch {}
    }
    b.muted = true;
    b.pause();
    return antes ? { sai: d, entra: b } : { sai: b, entra: d };
  }

  function play() {
    const state = store.getState();
    const total = playableDuration(state);
    if (total <= 0) return;
    if (virtualTime >= total - 0.01) virtualTime = 0;
    syncPool();
    syncVideoToVirtual();
    const d = disp();
    d.muted = vidMuted(state, segmentAt(state, virtualTime));
    d.volume = Math.min(1, state.volumes?.video ?? 1);
    playing = true;
    lastTick = 0;
    fxMotor.retomar();   // gesto de play destrava o AudioContext suspenso
    if (segmentAt(state, virtualTime)) d.play().catch(() => {});
    preloadNext(state);  // aquece o buffer JÁ no play (fronteira logo à frente)
    syncAudios(virtualTime);
    rafId = requestAnimationFrame(tick);
    emit();
  }

  function pause() {
    playing = false;
    cancelAnimationFrame(rafId);
    els.forEach((el) => el.pause());
    for (const [, entry] of pool) entry.el.pause();
    emit();
  }

  function seek(t) {
    // seek manda: solta o hold da transição (o efeito se rearma sozinho se a
    // agulha cair de novo dentro da janela)
    if (trans) { trans = null; const b = buf(); if (b) b.pause(); }
    const total = playableDuration(store.getState());
    virtualTime = Math.min(Math.max(0, t), total);
    syncVideoToVirtual();
    syncPool();
    syncAudios(virtualTime);
    emit();
  }

  function stepFrame(dir, big = false) {
    const fps = 30;
    seek(virtualTime + (dir * (big ? 10 : 1)) / fps);
  }

  store.subscribe(() => {
    const state = store.getState();
    const total = playableDuration(state);
    if (virtualTime > total) { virtualTime = total; emit(); }
    // edição no meio de uma transição em curso: a emenda ainda existe?
    if (trans) {
      const sSai = segmentAt(state, trans.jun - 1e-3);
      const sEnt = segmentAt(state, trans.jun + 1e-3);
      if (!sSai || !sEnt || sSai.clip.id !== trans.sailId || sEnt.clip.id !== trans.entraId) {
        abortarTransicao();
      } else {
        trans.segSai = sSai;   // referência fresca do estado novo
      }
    }
    // durante o hold o mudo é do ramo de transição do tick (corte na emenda)
    if (!trans) disp().muted = vidMuted(state, segmentAt(state, virtualTime));
    if (!playing) syncVideoToVirtual();
    syncPool();
  });

  return {
    play, pause, seek, stepFrame,
    toggle() { playing ? pause() : play(); },
    isPlaying: () => playing,
    getTime: () => virtualTime,
    getDuration: () => playableDuration(store.getState()),
    getSourceTime: () => timelineToSource(store.getState(), virtualTime),
    getDisplayEl: () => disp(),           // shell aplica transform no elemento ativo
    // sonda/diagnóstico: a cadeia do Aprimorar áudio de um clipe (null = sem)
    fxDebug: (audioId) => fxMotor.debug(pool.get(audioId)),
    // prévia de efeito indisponível (arquivo sem CORS)? A UI avisa em vez de
    // deixar o checkbox mentir com o som inalterado
    fxIndisponivel: (audioId) => !!pool.get(audioId)?.fxIndisponivel,
    // ESTADO REAL de cada faixa de áudio. Os elementos da piscina vivem FORA do
    // DOM, então nenhuma sonda conseguia responder "por que ficou mudo?" —
    // olhar `document.querySelectorAll('audio')` não os enxerga.
    audioDebug: () => [...pool].map(([id, e]) => ({
      id, url: e.url,
      readyState: e.el.readyState,      // 0 = não carregou nada
      networkState: e.el.networkState,  // 3 = NO_SOURCE
      paused: e.el.paused, muted: e.el.muted, volume: e.el.volume,
      currentTime: e.el.currentTime,
      crossOrigin: e.el.crossOrigin,
      erro: e.el.error ? e.el.error.code : null,
      fxErros: e.fxErros || 0,
      fxIndisponivel: !!e.fxIndisponivel,
      comCadeiaFx: !!e._fx,
    })),
    // ── TRANSIÇÃO DE VERDADE ────────────────────────────────────────────────
    // Os DOIS vídeos na tela: o ativo é a cena que SAI, o buffer a que ENTRA.
    // O transition-fx só cuida do VISUAL (classes + --p); a mecânica (hold da
    // fronteira, material emprestado, swap único no fim) vive aqui.
    getBufferEl: () => buf(),
    prepararTransicao,
    prepararLadoPausado,
    abortarTransicao,
    /** Papéis em curso do hold — null fora de transição tocando. */
    transRoles: () => (trans ? { sai: disp(), entra: buf(), jun: trans.jun } : null),
    // Reaplica o mudo no elemento QUE ESTÁ EM EXIBIÇÃO. O player é o único dono
    // dessa decisão (ele conhece o segmento sob o playhead, o mudo por cena e
    // qual dos dois elementos do double-buffer está visível). A shell chama
    // isto quando o estado muda com o vídeo pausado — aí não há tick pra
    // reaplicar sozinho.
    refreshMute() {
      if (trans) return;   // durante o hold o mudo é do ramo de transição do tick
      const state = store.getState();
      disp().muted = vidMuted(state, segmentAt(state, virtualTime));
      disp().volume = Math.min(1, state.volumes?.video ?? 1);
    },
    onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    destroy() {
      pause();
      fxMotor.destruir();
      for (const [, e] of pool) { e.el.pause(); e.el.removeAttribute('src'); }
      pool.clear();
      listeners.clear();
    },
  };
}
