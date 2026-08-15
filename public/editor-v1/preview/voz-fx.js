// editor-v1/preview/voz-fx.js
// Prévia AO VIVO do Modificador de voz + Preencher canal da CENA (15/08).
//
// Cadeia Web Audio no elemento de vídeo principal: pitch (worklet granular,
// mesma conta asetrate*f do render) → eco (delay+feedback) → telefone
// (passa-banda) → canal (matriz L/R) → saída. Montada SÓ quando um efeito
// liga E a fonte é desta sessão (blob:): rotear mídia de CDN sem CORS pelo
// Web Audio silencia o elemento PRA SEMPRE (createMediaElementSource não tem
// desmontagem) — fora do caso seguro a prévia fica indisponível (uma vez
// avisada) e o arquivo final sai certo do mesmo jeito.
// Desligar efeito = parâmetro NEUTRO (reconectar dá clique audível).
import { VOZ_POR_ID } from '../core/voz-mod.js';

// worklet de pitch: técnica "jungle" — dois taps de atraso varrendo a janela
// em meia-fase, crossfade triangular esconde o salto. Saída = entrada × pitch.
// Exportado como TEXTO pra sonda rodar a MESMA DSP num OfflineAudioContext.
export const WORKLET_PITCH = `
class BePitch extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'pitch', defaultValue: 1, minValue: 0.5, maxValue: 2 }];
  }
  constructor() {
    super();
    this.N = 8192; this.W = 2048;
    this.bufs = []; this.w = 0; this.f = 0.5;
  }
  ler(b, pos) {
    pos = ((pos % this.N) + this.N) % this.N;
    const i0 = Math.floor(pos), fr = pos - i0;
    return b[i0] * (1 - fr) + b[(i0 + 1) % this.N] * fr;
  }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    if (!out || !out.length) return true;
    const n = out[0].length, CH = out.length;
    while (this.bufs.length < CH) this.bufs.push(new Float32Array(this.N));
    const temIn = inp && inp.length > 0;
    const pv = params.pitch;
    for (let i = 0; i < n; i++) {
      const pitch = pv.length > 1 ? pv[i] : pv[0];
      const wI = this.w;
      for (let c = 0; c < CH; c++) {
        this.bufs[c][wI] = temIn ? (inp[Math.min(c, inp.length - 1)][i] || 0) : 0;
      }
      if (Math.abs(pitch - 1) < 1e-4) {
        for (let c = 0; c < CH; c++) out[c][i] = this.bufs[c][wI];
      } else {
        const fA = this.f, fB = (this.f + 0.5) % 1;
        const gA = 1 - Math.abs(2 * fA - 1), gB = 1 - Math.abs(2 * fB - 1);
        for (let c = 0; c < CH; c++) {
          const b = this.bufs[c];
          out[c][i] = this.ler(b, wI - fA * this.W) * gA + this.ler(b, wI - fB * this.W) * gB;
        }
        this.f = ((this.f - (pitch - 1) / this.W) % 1 + 1) % 1;
      }
      this.w = (wI + 1) % this.N;
    }
    return true;
  }
}
registerProcessor('be-pitch', BePitch);
`;

export function criarVozFx() {
  let ctx = null;
  let workletPronto = null;   // Promise (uma vez por contexto)
  const cadeias = new WeakMap();          // el -> nós
  let avisou = false;

  function contexto() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      const url = URL.createObjectURL(new Blob([WORKLET_PITCH], { type: 'text/javascript' }));
      workletPronto = ctx.audioWorklet?.addModule(url).catch(() => { workletPronto = null; });
    }
    return ctx;
  }

  async function montar(el) {
    const c = contexto();
    if (!c) return null;
    try { await workletPronto; } catch {}
    const src = c.createMediaElementSource(el);
    let pitch = null;
    try { pitch = new AudioWorkletNode(c, 'be-pitch', { outputChannelCount: [2] }); } catch {}
    // eco: dry sempre 1; wet nasce 0 (neutro)
    const dry = c.createGain(); dry.gain.value = 1;
    const delay = c.createDelay(1); delay.delayTime.value = 0.14;
    const fb = c.createGain(); fb.gain.value = 0.35;
    const wet = c.createGain(); wet.gain.value = 0;
    // telefone: neutro = banda toda aberta
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 10;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 20000;
    // canal: matriz L/R com 4 ganhos (identidade = neutro)
    const split = c.createChannelSplitter(2);
    const merge = c.createChannelMerger(2);
    const gLL = c.createGain(), gRL = c.createGain(), gLR = c.createGain(), gRR = c.createGain();
    gLL.gain.value = 1; gRR.gain.value = 1; gRL.gain.value = 0; gLR.gain.value = 0;

    const entradaEco = pitch || src;
    if (pitch) src.connect(pitch);
    entradaEco.connect(dry); entradaEco.connect(delay);
    delay.connect(fb); fb.connect(delay);
    delay.connect(wet);
    const soma = c.createGain();
    dry.connect(soma); wet.connect(soma);
    soma.connect(hp); hp.connect(lp);
    lp.connect(split);
    split.connect(gLL, 0); split.connect(gLR, 0);   // saídas do canal ESQUERDO
    split.connect(gRL, 1); split.connect(gRR, 1);   // saídas do canal DIREITO
    gLL.connect(merge, 0, 0); gRL.connect(merge, 0, 0);
    gLR.connect(merge, 0, 1); gRR.connect(merge, 0, 1);
    merge.connect(c.destination);
    const nos = { pitch, wet, fb, hp, lp, gLL, gLR, gRL, gRR };
    cadeias.set(el, nos);
    return nos;
  }

  return {
    /** por tick, com o clipe da cena em exibição. Devolve false quando a
     *  prévia não pôde montar (fonte fora da sessão). */
    sync(el, clip, onIndisponivel) {
      if (!el) return true;
      const voz = clip?.voz_mod || null;
      const canal = clip?.canal || 'both';
      const ativo = !!voz || canal !== 'both';
      let nos = cadeias.get(el);
      if (!nos) {
        if (!ativo) return true;                    // nada ligado e nada montado
        if (el._vozMontando) return true;
        // só fonte DESTA SESSÃO (blob:) — ver nota de CORS no topo
        if (!(el.currentSrc || el.src || '').startsWith('blob:')) {
          if (!avisou) { avisou = true; onIndisponivel?.(); }
          return false;
        }
        el._vozMontando = true;
        montar(el).finally(() => { el._vozMontando = false; });
        return true;
      }
      const pitchAlvo = VOZ_POR_ID.get(voz)?.pitch ?? 1;
      if (nos.pitch) nos.pitch.parameters.get('pitch').value = pitchAlvo;
      nos.wet.gain.value = voz === 'eco' ? 0.45 : 0;
      nos.hp.frequency.value = voz === 'telefone' ? 300 : 10;
      nos.lp.frequency.value = voz === 'telefone' ? 3400 : 20000;
      nos.gLL.gain.value = canal === 'dir' ? 0 : 1;
      nos.gRL.gain.value = canal === 'esq' ? 1 : 0;
      nos.gLR.gain.value = canal === 'dir' ? 1 : 0;
      nos.gRR.gain.value = canal === 'esq' ? 0 : 1;
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      return true;
    },
    retomar() { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); },
    /** estado da cadeia (sonda) */
    debug(el) {
      const nos = cadeias.get(el);
      if (!nos) return null;
      return {
        pitch: nos.pitch ? nos.pitch.parameters.get('pitch').value : null,
        eco: nos.wet.gain.value, hp: nos.hp.frequency.value, lp: nos.lp.frequency.value,
        matriz: [nos.gLL.gain.value, nos.gRL.gain.value, nos.gLR.gain.value, nos.gRR.gain.value],
        contexto: ctx?.state || 'sem',
      };
    },
    destruir() { try { ctx?.close(); } catch {} ctx = null; },
  };
}
