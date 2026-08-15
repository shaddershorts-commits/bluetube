// editor-v1/core/text-anim.js
// ANIMACAO DE ENTRADA/SAIDA DO TEXTO — modulo puro.
//
// Ate aqui `capfade`/`cappop` existiam SO como @keyframes das miniaturas do
// painel: no player a legenda aparecia de estalo e no arquivo exportado
// tambem (user 2026-07-29: "animacao travada"). Nao era feature, era enfeite.
//
// A conta da animacao mora AQUI e sai em dois formatos:
//   - numeros, pro preview desenhar quadro a quadro (e obedecer o scrub);
//   - expressoes de ffmpeg, pro `drawtext` fazer o MESMO no arquivo final.
// O ffmpeg aceita expressao com `t` em alpha e fontsize (medido no proprio
// ffmpeg antes de escrever isto), entao as duas pontas fazem de verdade a
// mesma coisa — nao ha efeito que viva so na tela.

export const ANIM_PADRAO = 'nenhuma';

export const ANIMACOES = [
  { id: 'nenhuma', nome: 'Sem animação', dica: 'A legenda aparece e some seca' },
  { id: 'fade',    nome: 'Suave',        dica: 'Aparece e some em desvanecido' },
  { id: 'pop',     nome: 'Pop',          dica: 'Salta ao entrar (estilo CapCut)' },
  { id: 'subir',   nome: 'Subir',        dica: 'Entra deslizando de baixo' },
];

export const IDS_ANIM = ANIMACOES.map(a => a.id);
export function animValida(v) { return IDS_ANIM.includes(v) ? v : ANIM_PADRAO; }

/** Quanto dura a entrada/saida, em segundos. Nunca passa de um quarto do
 *  tempo do bloco — senao legenda curta (uma palavra) nunca ficaria cheia. */
export function duracaoAnim(durBloco) {
  return Math.min(0.35, Math.max(0.06, (durBloco || 0) * 0.25));
}

const OVERSHOOT = 1.08;   // o "salto" do pop passa um pouco de 1 e volta

/** Estado visual num instante. `u` = segundos desde o inicio do bloco.
 *  @returns {{opacidade:number, escala:number, deslocY:number}}
 *  deslocY em FRACAO da altura da linha (o preview e o render usam igual). */
export function estadoAnim(anim, u, durBloco) {
  const d = duracaoAnim(durBloco);
  const fim = Math.max(0, (durBloco || 0) - u);      // quanto falta pro fim
  const ent = d > 0 ? Math.min(1, Math.max(0, u / d)) : 1;
  const sai = d > 0 ? Math.min(1, Math.max(0, fim / d)) : 1;
  switch (animValida(anim)) {
    case 'fade':
      return { opacidade: Math.min(ent, sai), escala: 1, deslocY: 0 };
    case 'pop': {
      // sobe ate o overshoot na primeira metade da entrada e assenta em 1
      let escala;
      if (ent >= 1) escala = 1;
      else if (ent < 0.6) escala = 0.6 + (ent / 0.6) * (OVERSHOOT - 0.6);
      else escala = OVERSHOOT - ((ent - 0.6) / 0.4) * (OVERSHOOT - 1);
      return { opacidade: Math.min(ent, sai), escala, deslocY: 0 };
    }
    case 'subir':
      return { opacidade: Math.min(ent, sai), escala: 1, deslocY: (1 - ent) * 0.7 };
    default:
      return { opacidade: 1, escala: 1, deslocY: 0 };
  }
}

/** As MESMAS contas como expressoes do ffmpeg (variavel `t` = tempo do video).
 *  Devolve null quando a animacao nao mexe naquele parametro — assim o filtro
 *  sai limpo pra quem escolheu "sem animacao".
 *  @returns {{alpha:string|null, escala:string|null, deslocY:string|null}} */
export function exprFfmpeg(anim, startSec, endSec) {
  const dur = Math.max(0, (endSec || 0) - (startSec || 0));
  const d = duracaoAnim(dur);
  const S = startSec.toFixed(3), E = endSec.toFixed(3), D = d.toFixed(3);
  // entrada e saida em 0..1, iguais ao estadoAnim
  const ent = `min(1\\,max(0\\,(t-${S})/${D}))`;
  const sai = `min(1\\,max(0\\,(${E}-t)/${D}))`;
  const alpha = `min(${ent}\\,${sai})`;
  switch (animValida(anim)) {
    case 'fade':
      return { alpha, escala: null, deslocY: null };
    case 'pop': {
      const e = ent;
      const escala =
        `if(gte(${e}\\,1)\\,1\\,` +
        `if(lt(${e}\\,0.6)\\,0.6+(${e}/0.6)*${(OVERSHOOT - 0.6).toFixed(3)}\\,` +
        `${OVERSHOOT}-((${e}-0.6)/0.4)*${(OVERSHOOT - 1).toFixed(3)}))`;
      return { alpha, escala, deslocY: null };
    }
    case 'subir':
      return { alpha, escala: null, deslocY: `(1-${ent})*0.7` };
    default:
      return { alpha: null, escala: null, deslocY: null };
  }
}
