// editor-v1/core/caption-sync.js
// A LEGENDA É ANCORADA NA FALA, NÃO NO RELÓGIO DA TIMELINE.
//
// Por que este módulo existe (teste do user, 2026-08-05 — "a legenda fica
// desalinhada na timeline"): a legenda nascia com um tempo FIXO de timeline.
// Bastava o user cortar um pedaço do vídeo depois de gerar — ou pôr o clipe em
// câmera rápida — pra fala andar e a legenda ficar pra trás. Em editor
// profissional isso é fatal: o usuário legenda primeiro e edita depois.
//
// Aqui cada legenda guarda ONDE ELA FOI FALADA dentro do arquivo de áudio
// (src_url + src_in/src_out, em tempo de ARQUIVO). O tempo de timeline vira
// coisa DERIVADA: sempre que o mapa arquivo→timeline muda (corte, trim,
// reordenação, velocidade, agrupamento), as legendas são recalculadas.
//
// As duas direções vivem juntas de propósito: `arquivoParaTimeline` desenha a
// legenda e `timelineParaArquivo` a re-ancora quando o USER a arrasta na mão.
// É essa dupla que deixa o arrasto manual conviver com a re-sincronia
// automática sem uma anular a outra.

const EPS = 1e-6;

/** Um plano é { url, segments:[{ tStart, fileIn, fileOut, speed }] }.
 *  tStart = tempo de TIMELINE onde o trecho começa;
 *  fileIn/fileOut = recorte dentro do ARQUIVO;
 *  speed = velocidade efetiva (2x = o arquivo passa no dobro da pressa). */

/** Tempo de arquivo -> tempo de timeline. null se a fala caiu num trecho
 *  que o user removeu (aí a legenda some junto — CapCut faz igual). */
export function arquivoParaTimeline(ft, segments) {
  for (const s of segments || []) {
    if (ft >= s.fileIn - EPS && ft <= s.fileOut + EPS) {
      return s.tStart + (ft - s.fileIn) / velocidade(s);
    }
  }
  return null;
}

/** Tempo de timeline -> tempo de arquivo (a volta, pra re-ancorar arrasto). */
export function timelineParaArquivo(t, segments) {
  for (const s of segments || []) {
    const dur = (s.fileOut - s.fileIn) / velocidade(s);
    if (t >= s.tStart - EPS && t <= s.tStart + dur + EPS) {
      return s.fileIn + (t - s.tStart) * velocidade(s);
    }
  }
  return null;
}

function velocidade(s) {
  const v = Number(s?.speed);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/** Assinatura do mapa. Muda quando (e só quando) o tempo da fala na timeline
 *  muda de lugar — é ela que diferencia "o user cortou o vídeo" de "o user
 *  arrastou a legenda com a mão". */
export function assinaturaDoPlano(plano) {
  if (!plano || !plano.segments?.length) return '';
  return plano.url + '|' + plano.segments
    .map(s => `${round(s.tStart)}:${round(s.fileIn)}:${round(s.fileOut)}:${round(velocidade(s))}`)
    .join(';');
}

const round = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/** Grava a âncora (onde a fala está DENTRO do arquivo) num bloco de legenda. */
export function ancorar(texto, plano) {
  const segs = plano?.segments || [];
  const fi = timelineParaArquivo(texto.start_sec, segs);
  const fo = timelineParaArquivo(texto.end_sec, segs);
  if (fi == null) return texto;
  return {
    ...texto,
    src_url: plano.url,
    src_in: fi,
    src_out: fo != null && fo > fi ? fo : fi + (texto.end_sec - texto.start_sec),
  };
}

/**
 * Núcleo da re-sincronia. Uma passada só sobre as legendas, com duas leis:
 *
 *   1. o mapa MUDOU (o user editou o vídeo)  -> a âncora manda: recalcula o
 *      tempo de timeline. Fala que sumiu no corte -> legenda desativada (não
 *      apagada: desfazer o corte traz ela de volta inteira).
 *   2. o mapa está IGUAL mas o bloco saiu do lugar previsto -> foi a MÃO do
 *      user (arrastou/dividiu/trimou) -> re-ancora, e a âncora passa a ser a
 *      nova posição.
 *
 * Devolve o MESMO array quando nada mudou (barato de chamar a cada ação).
 *
 * @param {Array} texts state.texts
 * @param {object} plano captionAudioPlan(state)
 * @param {string} sigAnterior assinatura guardada no state
 * @returns {{texts:Array, sig:string, mudou:boolean}}
 */
export function ressincronizar(texts, plano, sigAnterior) {
  const sig = assinaturaDoPlano(plano);
  const lista = texts || [];
  // sem plano de áudio (nenhuma fonte transcrivível agora): não mexe em nada.
  // Apagar/mover legenda porque o áudio sumiu momentaneamente seria destrutivo.
  if (!sig) return { texts: lista, sig: sigAnterior ?? '', mudou: false };

  const planoMudou = sig !== sigAnterior;
  const segs = plano.segments;
  let mudou = false;
  const out = lista.map((t) => {
    if (t.caption !== true || t.src_in == null) return t;
    // âncora de OUTRA fonte de áudio: não é nossa pra sincronizar
    if (t.src_url && plano.url && t.src_url !== plano.url) return t;

    const ini = arquivoParaTimeline(t.src_in, segs);

    if (planoMudou) {
      if (ini == null) {
        // ⚠️ A FALA SUMIU DO CORTE — E A LEGENDA FICA ONDE ESTÁ.
        // Antes ela era desativada (some da tela). Ficava parecendo que o
        // editor tinha quebrado: o user cortava o vídeo e as legendas depois
        // do corte evaporavam sem aviso (relato de 2026-08-05). Esconder o
        // trabalho de alguém por conta própria é sempre a pior opção — ela
        // continua visível, e quem apaga é o dono dela.
        return t;
      }
      const fim = arquivoParaTimeline(t.src_out, segs);
      const dur = fim != null && fim > ini
        ? fim - ini
        : Math.max(0.05, (t.end_sec - t.start_sec));
      const igual = Math.abs(ini - t.start_sec) < 1e-4 &&
                    Math.abs((ini + dur) - t.end_sec) < 1e-4 &&
                    t.active !== false;
      if (igual) return t;
      mudou = true;
      return { ...t, start_sec: ini, end_sec: ini + dur, active: true };
    }

    // mapa igual: o bloco só sai do previsto se a MÃO do user o moveu.
    // Compara as DUAS pontas — dividir (Ctrl+B) e trimar mexem só no fim, e
    // sem olhar o fim a âncora velha ressuscitaria a duração original no
    // próximo corte de vídeo, desfazendo a edição do user.
    const fimPrev = arquivoParaTimeline(t.src_out, segs);
    if (ini == null) return t;
    const comecoIgual = Math.abs(ini - t.start_sec) < 1e-4;
    const fimIgual = fimPrev != null && Math.abs(fimPrev - t.end_sec) < 1e-4;
    if (comecoIgual && fimIgual) return t;
    const re = ancorar(t, plano);
    if (re === t || (re.src_in === t.src_in && re.src_out === t.src_out)) return t;
    mudou = true;
    return re;
  });

  return { texts: mudou ? out : lista, sig, mudou };
}
