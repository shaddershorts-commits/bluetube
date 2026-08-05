// editor-v1/preview/audio-fx.js
// MOTOR DE VERDADE do "Aprimorar áudio" no PREVIEW (user 2026-07-29: "é só
// fachada, nada realmente funciona, o motor não tem nenhum").
//
// Cada clipe de áudio com efeito ligado ganha uma cadeia Web Audio no elemento
// que o player já usa: highpass → highshelf → peaking → compressor (voz) →
// compressor (normalizar) → ganho. Ligar/desligar não reconecta nada — os nós
// ficam na cadeia com parâmetros NEUTROS quando desligados (reconectar dá
// clique audível; parâmetro neutro é transparente).
//
// Honestidade WYSIWYG: é a APROXIMAÇÃO ao vivo do que o export faz com
// filtros melhores (afftdn / eq+acompressor / loudnorm). O redutor de ruído
// do navegador é corte de graves de cabine + chiado agudo — não é espectral
// como o afftdn, mas é audível e vai na mesma direção.
//
// ⚠️ CORS: rotear um <audio> pelo Web Audio SILENCIA a mídia se ela veio sem
// cabeçalho CORS. Por isso o player marca crossOrigin='anonymous' ANTES do
// src (Supabase público manda o header) e, se o arquivo falhar por causa
// disso, recarrega SEM CORS e o clipe fica com prévia de efeito indisponível
// — som intacto sempre vence prévia de efeito.

/** Parâmetros da cadeia pros flags de um clipe. PURO — é o que os testes
 *  travam. Tudo neutro = cadeia transparente. */
export function paramsDoMotor(a) {
  const ruido = a?.fx_ruido === true;
  const voz = a?.fx_voz === true;
  const norm = a?.fx_norm === true;
  const k = Math.min(1, Math.max(0, (Number(a?.fx_voz_int ?? 75)) / 100));
  let makeup = 1;
  if (voz) makeup *= 1 + k * 1.2;
  if (norm) makeup *= 1.9;
  return {
    // corte de graves: cabine/vento (ruído) pega mais embaixo que o de voz
    hpFreq: ruido ? 120 : voz ? 75 : 10,
    // chiado: prateleira aguda pra baixo só com o redutor ligado
    shelfFreq: 7500,
    shelfGain: ruido ? -12 : 0,
    // presença da voz (sobe com a intensidade)
    peakFreq: 3000,
    peakGain: voz ? k * 5 : 0,
    // compressor da voz
    vozThreshold: voz ? -18 : 0,
    vozRatio: voz ? 2 + k * 2 : 1,
    // normalizador: compressor forte + ganho de compensação
    normThreshold: norm ? -24 : 0,
    normRatio: norm ? 6 : 1,
    ganho: Math.min(4, makeup),
    ativo: ruido || voz || norm,
  };
}

export function criarMotorFx() {
  let ctx = null;
  function contexto() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    return ctx;
  }

  function montar(entry) {
    const c = contexto();
    if (!c) return false;
    // createMediaElementSource só pode existir UMA vez por elemento — depois
    // de montada, a cadeia acompanha o elemento até ele morrer
    const src = c.createMediaElementSource(entry.el);
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 10;
    const shelf = c.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = 7500; shelf.gain.value = 0;
    const peak = c.createBiquadFilter(); peak.type = 'peaking'; peak.frequency.value = 3000; peak.Q.value = 1; peak.gain.value = 0;
    const compVoz = c.createDynamicsCompressor();
    compVoz.threshold.value = 0; compVoz.ratio.value = 1; compVoz.knee.value = 10;
    compVoz.attack.value = 0.02; compVoz.release.value = 0.25;
    const compNorm = c.createDynamicsCompressor();
    compNorm.threshold.value = 0; compNorm.ratio.value = 1; compNorm.knee.value = 12;
    compNorm.attack.value = 0.01; compNorm.release.value = 0.3;
    const ganho = c.createGain(); ganho.gain.value = 1;
    src.connect(hp); hp.connect(shelf); shelf.connect(peak);
    peak.connect(compVoz); compVoz.connect(compNorm); compNorm.connect(ganho);
    ganho.connect(c.destination);
    entry._fx = { src, hp, shelf, peak, compVoz, compNorm, ganho };
    return true;
  }

  return {
    /** Chamado pelo player a cada sync do clipe. Monta a cadeia na primeira
     *  vez que um efeito liga; depois só ajusta parâmetros. */
    sync(entry, a) {
      if (!entry || entry.fxIndisponivel) return;
      const p = paramsDoMotor(a);
      if (!entry._fx) {
        if (!p.ativo) return;              // sem efeito e sem cadeia: não paga nada
        try { if (!montar(entry)) return; } catch { entry.fxIndisponivel = true; return; }
      }
      const f = entry._fx;
      f.hp.frequency.value = p.hpFreq;
      f.shelf.gain.value = p.shelfGain;
      f.peak.frequency.value = p.peakFreq;
      f.peak.gain.value = p.peakGain;
      f.compVoz.threshold.value = p.vozThreshold;
      f.compVoz.ratio.value = p.vozRatio;
      f.compNorm.threshold.value = p.normThreshold;
      f.compNorm.ratio.value = p.normRatio;
      f.ganho.gain.value = p.ganho;
      // contexto nasce suspenso fora de gesto — retomar aqui evita clipe mudo
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    },
    retomar() { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); },
    /** Estado da cadeia de um clipe (pra sonda provar que o motor EXISTE). */
    debug(entry) {
      if (!entry?._fx) return null;
      const f = entry._fx;
      return {
        hpFreq: f.hp.frequency.value, shelfGain: f.shelf.gain.value,
        peakGain: f.peak.gain.value, vozRatio: f.compVoz.ratio.value,
        normRatio: f.compNorm.ratio.value, ganho: f.ganho.gain.value,
        contexto: ctx?.state || 'sem',
      };
    },
    destruir() { try { ctx?.close(); } catch {} ctx = null; },
  };
}
