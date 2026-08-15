// editor-v1/core/silencio.js
// DETECÇÃO DE FALA vs RESPIRO — módulo PURO (zero DOM, zero rede).
//
// Serve o "Cortar respiros": achar os trechos SEM fala pra removê-los e
// aproximar a próxima fala. O usuário foi explícito: "não quero fachada, tem
// que funcionar de verdade". Três decisões é que fazem funcionar:
//
// 1. NÍVEL ABSOLUTO (dBFS), não os picos normalizados do waveform. Os picos da
//    timeline são divididos pelo máximo do arquivo — uma gravação baixinha e
//    uma alta produzem os MESMOS picos normalizados. Limiar em cima disso é
//    chute: corta no meio da palavra num vídeo e não corta nada no outro.
// 2. PISO DE RUÍDO ADAPTATIVO (percentil do próprio áudio). Limiar fixo falha
//    em sala com ar-condicionado, em gravação de celular, em estúdio.
// 3. HISTERESE. Sem ela, uma consoante surda no meio da fala abre e fecha o
//    corte a cada quadro e o resultado sai picotado.

/** Piso numérico do dBFS. Silêncio digital daria -Infinity, e -Infinity não
 *  entra em percentil/média — descartá-lo fazia o "piso de ruído" ser calculado
 *  SÓ com os quadros de fala, e o limiar subia acima da própria voz (o detector
 *  não achava nada). Silêncio digital É o piso, então vale -100 dBFS. */
export const DB_MIN = -100;
function paraDb(x) { return x > 0 ? Math.max(DB_MIN, 20 * Math.log10(x)) : DB_MIN; }

/** percentil simples de um array de níveis */
function percentil(niveis, p) {
  const v = Array.from(niveis).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return DB_MIN;
  return v[Math.min(v.length - 1, Math.floor(v.length * p))];
}

/** RMS por janela deslizante -> níveis em dBFS.
 *  @returns {{niveis:Float32Array, hop:number}} hop em segundos */
export function niveisRms(samples, sr, { janela = 0.02, passo = 0.01 } = {}) {
  const n = Math.max(1, Math.round(janela * sr));
  const h = Math.max(1, Math.round(passo * sr));
  const total = Math.max(0, Math.floor((samples.length - n) / h) + 1);
  const niveis = new Float32Array(Math.max(0, total));
  for (let i = 0; i < total; i++) {
    let soma = 0;
    const ini = i * h;
    for (let j = 0; j < n; j++) { const v = samples[ini + j]; soma += v * v; }
    niveis[i] = paraDb(Math.sqrt(soma / n));
  }
  return { niveis, hop: h / sr };
}

/** Piso de ruído = percentil baixo dos quadros com energia. É o que faz o
 *  detector funcionar tanto em gravação baixinha quanto em estúdio. */
export function pisoDeRuido(niveis, p = 0.10) {
  return percentil(niveis, p);
}

export const PADRAO = {
  // ⚠️ O PARÂMETRO QUE FAZ A FEATURE EXISTIR (user 2026-08-05: "motor amador,
  // fachada"). O limiar tem que cair ENTRE O RESPIRO E A FALA. Ancorado só no
  // piso de ruído, ele ficava ABAIXO do respiro — e aí o respiro contava como
  // fala. Como sobrava menos silêncio contínuo do que `minSilencio` de cada
  // lado dele, o trecho nunca fechava: a gravação inteira virava UM bloco de
  // fala, zero corte, e a tela ainda dizia "o áudio já está justo ✓".
  // Fala varia ~14 dB dentro da frase; respiro fica 20 dB ou mais abaixo do
  // pico. 18 dB é a linha que separa os dois sem picotar a frase.
  quedaFala: 18,
  margemDb: 6,        // e nunca abaixo do chiado da sala
  tetoDb: -50,        // piso absoluto do limiar (gravação muito limpa)
  // Silêncio contínuo que fecha um trecho de fala. Era 0,35s — mais longo que
  // os pedaços de sala em volta de um respiro, que é como o respiro emendava
  // as duas frases numa só. `folga` + `colaSe` devolvem o ritmo depois.
  minSilencio: 0.18,
  minFala: 0.15,      // trecho de fala menor que isso é ruído solto
  folga: 0.06,        // respiro deixado antes/depois pra não comer o fonema
  colaSe: 0.10,       // duas falas separadas por menos que isso viram uma
  // ILHA DE RESPIRO: bloco curto e MUITO mais baixo que a fala de verdade.
  // Existe porque quando respiro e vale de sílaba têm o mesmo nível, nível
  // sozinho não decide — quem decide é o contraste com o resto da gravação.
  quedaMin: 10,       // dB abaixo do pico da voz pra sequer ser candidata a respiro
  modMin: 5,          // dB de sobe-e-desce que separa sílaba de sopro
  ilhaMax: 0.9,       // só descarta ilha CURTA (frase falada baixo não é respiro)
};

/**
 * Onde há fala e onde há respiro.
 * @param {Float32Array|number[]} samples mono
 * @param {number} sr
 * @returns {{falas:{in:number,out:number}[], cortes:{in:number,out:number}[],
 *            piso:number, limiar:number, duracao:number, removido:number}}
 */
export function detectarFala(samples, sr, opts = {}) {
  const o = { ...PADRAO, ...opts };
  const duracao = samples.length / sr;
  const { niveis, hop } = niveisRms(samples, sr);
  const piso = pisoDeRuido(niveis);
  const pico = percentil(niveis, 0.95);
  const faixa = pico - piso;
  let limiar;
  if (faixa < 10) {
    // SEM DINÂMICA: o áudio é uma coisa só — ou fala do começo ao fim, ou
    // silêncio/chiado do começo ao fim. Não há o que separar por contraste,
    // então quem decide é o nível ABSOLUTO. (Sem este ramo, chiado uniforme
    // virava "fala" porque estava 6 dB acima do próprio pico dele.)
    limiar = pico >= -45 ? piso - 1 : pico + 1;
  } else {
    // COM DINÂMICA: o limiar desce a partir da FALA (pico − quedaFala), não
    // sobe a partir do chiado. É o que põe a linha acima do respiro. O piso
    // de ruído só entra como travessão de segurança, pra sala barulhenta não
    // ser confundida com voz.
    limiar = Math.max(pico - o.quedaFala, piso + o.margemDb, o.tetoDb);
  }

  // ── histerese: 2 quadros acima abrem; só fecha após minSilencio abaixo ──
  const falas = [];
  let dentro = false, iniFala = 0, acimaSeguidos = 0, abaixoDesde = 0;
  for (let i = 0; i < niveis.length; i++) {
    const t = i * hop;
    const acima = niveis[i] >= limiar;
    if (!dentro) {
      acimaSeguidos = acima ? acimaSeguidos + 1 : 0;
      if (acimaSeguidos >= 2) { dentro = true; iniFala = Math.max(0, t - hop * 2); }
    } else if (acima) {
      abaixoDesde = 0;
    } else {
      if (!abaixoDesde) abaixoDesde = t;
      if (t - abaixoDesde >= o.minSilencio) {
        falas.push({ in: iniFala, out: abaixoDesde });
        dentro = false; acimaSeguidos = 0; abaixoDesde = 0;
      }
    }
  }
  if (dentro) falas.push({ in: iniFala, out: duracao });

  // ── descarte de fragmento ANTES da folga, cola depois ──
  // A ordem importa: um estalo de 4ms mais 0,16s de folga daria 0,164s e
  // passaria por "fala" de 0,15s. Fragmento se mede pelo que foi DETECTADO,
  // não pelo que a folga inflou.
  const reais = falas.filter(f => f.out - f.in >= o.minFala);

  // ── ILHA DE RESPIRO ─────────────────────────────────────────────────────
  // Quando o respiro tem o mesmo nível de um vale de sílaba, o limiar sozinho
  // não separa os dois — os dois passam. O que os separa é o CONTRASTE com o
  // resto: um respiro é um bloco CURTO e muito mais baixo que a fala de
  // verdade. Frase falada baixinho não cai aqui porque é longa.
  const fatiaDe = (f) => niveis.slice(
    Math.max(0, Math.floor(f.in / hop)),
    Math.min(niveis.length, Math.ceil(f.out / hop)));
  const comNivel = reais.map(f => {
    const fatia = fatiaDe(f);
    return {
      ...f,
      db: percentil(fatia, 0.5),
      // MODULAÇÃO: o quanto o nível sobe e desce DENTRO do bloco. Fala tem
      // sílaba (sobe e desce uns 10 dB); respiro é sopro plano (2-3 dB).
      // É esta medida que salva o caso em que respiro e vale de sílaba estão
      // no mesmo nível — aí o volume não decide nada e a forma decide.
      mod: percentil(fatia, 0.9) - percentil(fatia, 0.15),
      alto: percentil(fatia, 0.9),
    };
  });
  // Referência = o quanto a voz ALCANÇA nesta gravação (não a média dela: a
  // média já fica 7-10 dB abaixo do pico, e medir contra ela tornava o
  // travessão apertado demais pra pegar respiro nenhum).
  const refFala = Math.max(pico, ...comNivel.map(x => x.alto), DB_MIN);
  // Descarta só com AS DUAS provas: baixo E sem sílaba. Uma frase falada
  // baixinho tem sílaba e sobrevive — apagar uma palavra do usuário seria
  // muito pior do que deixar um respiro passar.
  const ehRespiro = (f) =>
    (f.out - f.in) <= o.ilhaMax &&
    f.db < refFala - o.quedaMin &&
    f.mod < o.modMin;
  const semIlha = comNivel.filter(f => !ehRespiro(f));

  const comFolga = (semIlha.length ? semIlha : comNivel).map(f => ({
    in: Math.max(0, f.in - o.folga),
    out: Math.min(duracao, f.out + o.folga),
  }));
  const finais = [];
  for (const f of comFolga) {
    const ult = finais[finais.length - 1];
    if (ult && f.in - ult.out <= o.colaSe) ult.out = Math.max(ult.out, f.out);
    else finais.push({ ...f });
  }

  // ── o que sobra entre as falas é respiro ──
  const cortes = [];
  let cursor = 0;
  for (const f of finais) {
    if (f.in - cursor > 1e-6) cortes.push({ in: cursor, out: f.in });
    cursor = f.out;
  }
  if (duracao - cursor > 1e-6) cortes.push({ in: cursor, out: duracao });

  const removido = cortes.reduce((s, c) => s + (c.out - c.in), 0);
  return { falas: finais, cortes, piso, limiar, duracao, removido };
}

/** Resumo pro painel: quanto encolheu e quantos respiros saíram. */
export function resumoDoCorte(r) {
  const final = r.duracao - r.removido;
  return {
    respiros: r.cortes.length,
    removidoSeg: Math.round(r.removido * 10) / 10,
    duracaoFinal: Math.max(0, Math.round(final * 10) / 10),
    ganhoPct: r.duracao > 0 ? Math.round((r.removido / r.duracao) * 100) : 0,
  };
}
