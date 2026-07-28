// Tags de emoção em português (2026-07-28)
//
// O modelo V3 do ElevenLabs interpreta marcações escritas no meio do texto e
// muda a entrega da fala. Só que as marcações são palavras-chave EM INGLÊS —
// é assim que o modelo foi treinado. Uma marcação inventada em português não
// é reconhecida e vira texto: a voz LÊ "rindo" em voz alta no meio da frase.
//
// Aqui o usuário escreve em português e a tradução acontece num ponto só,
// antes da chamada. Ninguém digita igual — vem [Risada], [ri], [rindo muito],
// [gargalhadas], [sussuro] — então o reconhecimento é em camadas, da mais
// exata pra mais tolerante:
//     1. forma exata            [rindo]
//     2. radical                [risadas] → risad → [laughs]
//     3. pista dentro da frase  [voz de choro] → choro → [crying]
//     4. digitação torta        [sussuro] → [whispers]
//
// Quando nem assim dá, NÃO adivinhamos e NÃO removemos escondido: a geração
// para antes de gastar crédito e devolvemos sugestões pro usuário escolher.
//
// `[1]`, `[2]` e afins passam intactos: sem letras, não são tentativa de tag.

// Catálogo espelhando as tags que o V3 aceita. `rotulo` é o que o usuário vê
// na hora de escolher; `formas` são as maneiras de escrever em português —
// não precisa listar toda flexão, as camadas 2-4 cobrem o resto.
const CATALOGO = [
  // ── reações audíveis ──────────────────────────────────────────────────────
  { en: '[laughs]', rotulo: '😄 rindo', cat: 'reacao', formas: ['ri', 'rindo', 'risada', 'riso', 'rir', 'dando risada'] },
  { en: '[laughs harder]', rotulo: '😂 gargalhando', cat: 'reacao', formas: ['gargalha', 'gargalhada', 'ri muito', 'rindo muito', 'morrendo de rir', 'ri mais forte'] },
  { en: '[starts laughing]', rotulo: '🙂 começa a rir', cat: 'reacao', formas: ['comeca a rir', 'cai na risada', 'começando a rir'] },
  { en: '[chuckles]', rotulo: '😌 risadinha', cat: 'reacao', formas: ['risadinha', 'risinho', 'riso contido', 'ri baixo'] },
  { en: '[wheezing]', rotulo: '😩 sem ar de tanto rir', cat: 'reacao', formas: ['sem folego', 'sem ar', 'chiando', 'ofegante de rir'] },
  { en: '[crying]', rotulo: '😭 chorando', cat: 'reacao', formas: ['chora', 'chorando', 'choro', 'aos prantos', 'em lagrimas', 'solucando'] },
  { en: '[sighs]', rotulo: '😮‍💨 suspiro', cat: 'reacao', formas: ['suspira', 'suspiro', 'suspirando'] },
  { en: '[sigh of relief]', rotulo: '😅 suspiro de alívio', cat: 'reacao', formas: ['suspiro de alivio', 'aliviado', 'alivio'] },
  { en: '[gasps]', rotulo: '😲 arfa de susto', cat: 'reacao', formas: ['arfa', 'ofega', 'susto', 'assustado', 'espantado', 'prende a respiracao'] },
  { en: '[exhales]', rotulo: '🌬️ solta o ar', cat: 'reacao', formas: ['expira', 'solta o ar', 'soltando o ar'] },
  { en: '[exhales sharply]', rotulo: '💨 bufa', cat: 'reacao', formas: ['bufa', 'bufando', 'solta o ar com forca', 'resopra'] },
  { en: '[inhales deeply]', rotulo: '🫁 respira fundo', cat: 'reacao', formas: ['respira fundo', 'inspira', 'puxa o ar', 'respiracao funda'] },
  { en: '[gulps]', rotulo: '😰 engole em seco', cat: 'reacao', formas: ['engole em seco', 'engole seco', 'goles'] },
  { en: '[swallows]', rotulo: '💧 engolindo', cat: 'reacao', formas: ['engole', 'engolindo', 'engolir'] },
  { en: '[snorts]', rotulo: '🐽 bufa de rir', cat: 'reacao', formas: ['funga', 'fungando', 'ri pelo nariz'] },
  { en: '[clears throat]', rotulo: '🗣️ pigarro', cat: 'reacao', formas: ['pigarro', 'pigarreia', 'limpa a garganta', 'tosse leve', 'tossindo'] },
  { en: '[sings]', rotulo: '🎵 cantando', cat: 'reacao', formas: ['canta', 'cantando', 'cantarolando', 'cantarola'] },

  // ── emoções ───────────────────────────────────────────────────────────────
  { en: '[excited]', rotulo: '🤩 animado', cat: 'emocao', formas: ['animado', 'empolgado', 'empolgacao', 'animacao', 'euforico', 'entusiasmado'] },
  { en: '[happy]', rotulo: '😊 feliz', cat: 'emocao', formas: ['feliz', 'alegre', 'contente', 'radiante', 'sorrindo', 'sorriso'] },
  { en: '[sad]', rotulo: '🥺 triste', cat: 'emocao', formas: ['triste', 'tristeza', 'desanimado', 'abatido', 'deprimido', 'cabisbaixo'] },
  { en: '[sorrowful]', rotulo: '💔 pesaroso', cat: 'emocao', formas: ['pesaroso', 'melancolico', 'melancolia', 'sofrido', 'lamentando'] },
  { en: '[angry]', rotulo: '😡 com raiva', cat: 'emocao', formas: ['bravo', 'irritado', 'com raiva', 'furioso', 'puto', 'raiva'] },
  { en: '[annoyed]', rotulo: '😤 incomodado', cat: 'emocao', formas: ['incomodado', 'aborrecido', 'chateado', 'de saco cheio', 'irritadinho'] },
  { en: '[frustrated]', rotulo: '😖 frustrado', cat: 'emocao', formas: ['frustrado', 'frustracao', 'inconformado'] },
  { en: '[nervous]', rotulo: '😬 nervoso', cat: 'emocao', formas: ['nervoso', 'tenso', 'ansioso', 'apreensivo', 'nervosismo'] },
  { en: '[calm]', rotulo: '😌 calmo', cat: 'emocao', formas: ['calmo', 'calma', 'tranquilo', 'sereno', 'relaxado'] },
  { en: '[tired]', rotulo: '🥱 cansado', cat: 'emocao', formas: ['cansado', 'exausto', 'sonolento', 'com sono', 'esgotado'] },
  { en: '[curious]', rotulo: '🤔 curioso', cat: 'emocao', formas: ['curioso', 'curiosidade', 'intrigado', 'desconfiado'] },
  { en: '[surprised]', rotulo: '😯 surpreso', cat: 'emocao', formas: ['surpreso', 'surpresa', 'pasmo', 'boquiaberto', 'chocado'] },
  { en: '[appalled]', rotulo: '😱 horrorizado', cat: 'emocao', formas: ['horrorizado', 'indignado', 'escandalizado', 'revoltado'] },
  { en: '[thoughtful]', rotulo: '🧠 pensativo', cat: 'emocao', formas: ['pensativo', 'refletindo', 'reflexivo', 'ponderando'] },
  { en: '[regretful]', rotulo: '😔 arrependido', cat: 'emocao', formas: ['arrependido', 'arrependimento', 'culpado', 'sentido'] },

  // ── entrega / estilo de fala ──────────────────────────────────────────────
  { en: '[whispers]', rotulo: '🤫 sussurrando', cat: 'entrega', formas: ['sussurra', 'sussurro', 'sussurrando', 'cochicha', 'cochicho', 'baixinho', 'falando baixo'] },
  { en: '[quietly]', rotulo: '🔉 em voz baixa', cat: 'entrega', formas: ['em voz baixa', 'quieto', 'discretamente', 'contido'] },
  { en: '[shouts]', rotulo: '📢 gritando', cat: 'entrega', formas: ['grita', 'gritando', 'grito', 'aos berros', 'berrando', 'berro'] },
  { en: '[cheerfully]', rotulo: '☀️ animadamente', cat: 'entrega', formas: ['alegremente', 'animadamente', 'com alegria', 'bem humorado'] },
  { en: '[playfully]', rotulo: '😜 brincalhão', cat: 'entrega', formas: ['brincalhao', 'de brincadeira', 'brincando', 'zoeiro', 'divertido'] },
  { en: '[mischievously]', rotulo: '😈 malicioso', cat: 'entrega', formas: ['malicioso', 'travesso', 'safado', 'com malicia', 'aprontando'] },
  { en: '[sarcastic]', rotulo: '😏 sarcástico', cat: 'entrega', formas: ['sarcastico', 'sarcasmo', 'ironico', 'ironia', 'debochado', 'deboche', 'zoando'] },
  { en: '[deadpan]', rotulo: '😐 sem expressão', cat: 'entrega', formas: ['sem expressao', 'inexpressivo', 'sem emocao', 'seco'] },
  { en: '[flatly]', rotulo: '➖ tom monótono', cat: 'entrega', formas: ['monotono', 'sem entonacao', 'chapado', 'tom plano'] },
  { en: '[serious]', rotulo: '🧐 sério', cat: 'entrega', formas: ['serio', 'seriedade', 'grave', 'severo'] },
  { en: '[nervously]', rotulo: '😥 nervosamente', cat: 'entrega', formas: ['nervosamente', 'com nervosismo', 'tremendo'] },
  { en: '[resigned tone]', rotulo: '🫠 conformado', cat: 'entrega', formas: ['conformado', 'resignado', 'desistindo', 'sem esperanca'] },
  { en: '[hesitant]', rotulo: '😕 inseguro', cat: 'entrega', formas: ['inseguro', 'receoso', 'indeciso', 'na duvida'] },

  // ── ritmo da fala ─────────────────────────────────────────────────────────
  { en: '[pauses]', rotulo: '⏸️ pausa', cat: 'ritmo', formas: ['pausa', 'pausando', 'silencio', 'faz uma pausa', 'pausadamente'] },
  { en: '[short pause]', rotulo: '⏱️ pausa curta', cat: 'ritmo', formas: ['pausa curta', 'pausa rapida', 'respiro'] },
  { en: '[long pause]', rotulo: '⏳ pausa longa', cat: 'ritmo', formas: ['pausa longa', 'pausa grande', 'silencio longo'] },
  { en: '[hesitates]', rotulo: '🤷 hesitando', cat: 'ritmo', formas: ['hesita', 'hesitando', 'titubeia', 'em duvida', 'hesitacao'] },
  { en: '[stammers]', rotulo: '😳 gaguejando', cat: 'ritmo', formas: ['gagueja', 'gaguejando', 'gaguera', 'engasgando nas palavras'] },

  // ── efeitos sonoros ───────────────────────────────────────────────────────
  { en: '[applause]', rotulo: '👏 aplausos', cat: 'efeito', formas: ['aplausos', 'aplaudindo', 'plateia aplaude'] },
  { en: '[clapping]', rotulo: '👏 palmas', cat: 'efeito', formas: ['palmas', 'batendo palmas'] },
  { en: '[gunshot]', rotulo: '🔫 tiro', cat: 'efeito', formas: ['tiro', 'disparo', 'tiros'] },
  { en: '[explosion]', rotulo: '💥 explosão', cat: 'efeito', formas: ['explosao', 'estouro', 'explodindo'] },
];

const NOME_CATEGORIA = {
  reacao: 'Reações', emocao: 'Emoções', entrega: 'Jeito de falar',
  ritmo: 'Ritmo', efeito: 'Efeitos',
};

function normalizar(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // tira acento
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Radical aproximado: corta terminações de plural e de conjugação pra que
// "risadas", "risada" e "risadinha" caiam no mesmo lugar. Não é morfologia
// séria — é o suficiente pra casar o que uma pessoa digitaria numa marcação.
function radical(p) {
  let r = p;
  for (const suf of ['ndo', 'coes', 'oes', 'mente', 'inha', 'inho', 'adas', 'ados', 'ada', 'ado', 'as', 'os', 'es', 'a', 'o', 'e']) {
    if (r.length - suf.length >= 3 && r.endsWith(suf)) { r = r.slice(0, -suf.length); break; }
  }
  return r;
}

const radicalFrase = (s) => normalizar(s).split(' ').map(radical).join(' ');

// Palavras que não distinguem nada — não servem de pista sozinhas.
const VAZIAS = new Set(['de', 'da', 'do', 'em', 'com', 'sem', 'um', 'uma', 'muito', 'pouco', 'meio',
  'bem', 'mais', 'super', 'bastante', 'voz', 'tom', 'jeito', 'forma', 'modo', 'fala', 'falando',
  'faz', 'fazendo', 'estilo']);

// índices, do mais exato pro mais tolerante
const EXATO = new Map();
const RADICAIS = new Map();
const COMPOSTAS = [];   // formas de 2+ palavras, pra achar dentro de uma frase
const PISTAS = new Map(); // palavra isolada → tag
const POR_TAG = new Map();
for (const item of CATALOGO) {
  POR_TAG.set(item.en, item);
  const todas = [item.en.slice(1, -1), ...item.formas]; // a tag em inglês também vale
  for (const f of todas) {
    const n = normalizar(f);
    if (!EXATO.has(n)) EXATO.set(n, item.en);
    const r = radicalFrase(f);
    if (!RADICAIS.has(r)) RADICAIS.set(r, item.en);

    const tokens = r.split(' ').filter(Boolean);
    if (tokens.length > 1) { COMPOSTAS.push({ tokens, en: item.en }); continue; }

    // PISTAS só recebe forma de UMA palavra. Palavra solta tirada de uma forma
    // composta engana: "ri baixo" ([chuckles]) doava "baixo", e aí qualquer
    // "baixinho" virava risadinha em vez de sussurro.
    const palavra = tokens[0];
    if (!palavra || VAZIAS.has(palavra) || palavra.length < 3) continue;
    if (!PISTAS.has(palavra)) PISTAS.set(palavra, item.en);
  }
}
// frase mais específica primeiro: "rindo muito" ganha de "rindo"
COMPOSTAS.sort((a, b) => b.tokens.length - a.tokens.length);

// os tokens da forma aparecem, na ordem, dentro do que o usuário escreveu
function contida(alvoTokens, formaTokens) {
  let i = 0;
  for (const t of alvoTokens) { if (t === formaTokens[i] && ++i === formaTokens.length) return true; }
  return false;
}

// distância de edição com corte — só pra pegar digitação torta ("sussuro")
function distancia(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return Infinity;
  const linha = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let ant = linha[0]; linha[0] = i; let melhor = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = linha[j];
      linha[j] = Math.min(linha[j] + 1, linha[j - 1] + 1, ant + (a[i - 1] === b[j - 1] ? 0 : 1));
      ant = tmp;
      if (linha[j] < melhor) melhor = linha[j];
    }
    if (melhor > max) return Infinity; // nenhuma chance de fechar
  }
  return linha[b.length];
}

/**
 * Descobre qual tag em inglês o usuário quis dizer. null = não reconhecida.
 * Camadas: exata → radical → pista dentro da frase → erro de digitação.
 */
function resolverTag(conteudo) {
  const n = normalizar(conteudo);
  if (!n) return null;

  if (EXATO.has(n)) return EXATO.get(n);

  const r = radicalFrase(n);
  if (RADICAIS.has(r)) return RADICAIS.get(r);

  // frase escrita à mão em volta de uma forma composta: "rindo muito alto"
  const tokens = r.split(' ').filter(Boolean);
  for (const c of COMPOSTAS) {
    if (contida(tokens, c.tokens)) return c.en;
  }

  // pista: "voz de choro" → uma das palavras entrega a tag
  const palavras = n.split(' ').filter((p) => p.length >= 3 && !VAZIAS.has(p));
  for (const p of palavras) {
    const achou = PISTAS.get(radical(p));
    if (achou) return achou;
  }

  // Digitação torta, e só quando não resta dúvida: uma letra fora do lugar
  // (duas em palavra longa). Tolerância maior começa a inventar match — o
  // "fazendo caretas" virava [sings] —, e chute errado no meio da narração é
  // pior que perguntar. O que não fecha aqui cai no fluxo de sugestão.
  if (palavras.length === 1) {
    const alvo = radical(palavras[0]);
    const max = alvo.length >= 8 ? 2 : 1;
    let melhor = null, melhorD = Infinity;
    for (const [chave, en] of PISTAS) {
      const d = distancia(alvo, chave, max);
      if (d < melhorD) { melhorD = d; melhor = en; }
    }
    if (melhor) return melhor;
  }
  return null;
}

/**
 * Marcação que não deu match: sugere as mais parecidas pro usuário trocar.
 * Ordena por semelhança de escrita; completa com as mais usadas.
 */
function sugerirTags(conteudo, quantas = 4) {
  const alvo = radicalFrase(conteudo);
  const palavras = normalizar(conteudo).split(' ').filter((p) => p.length >= 3 && !VAZIAS.has(p)).map(radical);

  const notas = CATALOGO.map((item) => {
    let melhor = Infinity;
    for (const f of [item.en.slice(1, -1), ...item.formas]) {
      const rf = radicalFrase(f);
      const d = distancia(alvo, rf, 6);
      if (d < melhor) melhor = d;
      for (const p of palavras) {
        const dp = distancia(p, radical(rf.split(' ')[0]), 4);
        if (dp + 1 < melhor) melhor = dp + 1; // match parcial vale um pouco menos
      }
    }
    return { item, nota: melhor };
  }).sort((a, b) => a.nota - b.nota);

  const escolhidas = notas.filter((x) => x.nota <= 6).slice(0, quantas).map((x) => x.item);
  // se nada se pareceu, oferece as mais pedidas em vez de devolver lista vazia
  const PADRAO = ['[laughs]', '[whispers]', '[excited]', '[sad]'];
  for (const en of PADRAO) {
    if (escolhidas.length >= quantas) break;
    const item = POR_TAG.get(en);
    if (item && !escolhidas.includes(item)) escolhidas.push(item);
  }
  return escolhidas.map((i) => ({ tag: i.en, rotulo: i.rotulo, categoria: NOME_CATEGORIA[i.cat] || '' }));
}

// Conteúdo entre colchetes que PARECE tentativa de marcação: tem letra, é
// curto e tem poucas palavras. Números e referências ficam de fora.
function pareceTag(conteudo) {
  const c = conteudo.trim();
  return /[a-zA-ZÀ-ÿ]/.test(c) && c.length <= 40 && c.split(/\s+/).length <= 5;
}

/**
 * Converte marcações em português para as tags que o ElevenLabs entende.
 * @param {string} texto
 * @param {string} modelId  eleven_v3 | eleven_multilingual_v2
 * @returns {{texto:string, traduzidas:number, desconhecidas:Array, removidasV2:string[]}}
 *   desconhecidas → o chamador deve perguntar ao usuário ANTES de gerar
 */
function traduzirTags(texto, modelId) {
  const t = String(texto || '');
  const vazio = { texto: t, traduzidas: 0, desconhecidas: [], removidasV2: [] };
  if (!t.includes('[')) return vazio;

  const v3 = modelId !== 'eleven_multilingual_v2';
  let traduzidas = 0;
  const desconhecidas = [];
  const removidasV2 = [];

  let saida = t.replace(/\[([^\]\n]{1,50})\]/g, (inteiro, conteudo) => {
    if (!pareceTag(conteudo)) return inteiro;
    const en = resolverTag(conteudo);

    // V2 não interpreta marcação nenhuma — ficaria como texto falado.
    if (!v3) {
      if (en) { removidasV2.push(conteudo.trim()); return ''; }
      return inteiro;
    }
    if (en) { traduzidas++; return en; }

    // V3, mas ninguém reconheceu: não adivinha nem apaga escondido — o
    // chamador para e mostra as opções.
    desconhecidas.push({ escrita: conteudo.trim(), sugestoes: sugerirTags(conteudo) });
    return inteiro;
  });

  if (removidasV2.length) saida = saida.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?;:])/g, '$1').trim();

  return { texto: saida, traduzidas, desconhecidas, removidasV2 };
}

module.exports = { traduzirTags, resolverTag, sugerirTags, CATALOGO, NOME_CATEGORIA };
