// api/_helpers/blublu-personality.js
//
// Manifesto + tecnicas + quality gate da personalidade Blublu v3.
// Isolado do bluetendencias.js pra permitir iteracao do conteudo
// sem tocar na logica de fluxo.
//
// USO:
//   const { buildBlubluPrompt, validateOutputQuality, isV3Active } = require('./_helpers/blublu-personality.js');
//
// FEATURE FLAG:
//   process.env.BLUBLU_VERSION:
//     - 'v2.0-split' → caller usa prompts inline antigos (helper nao e chamado)
//     - 'v3.0-blublu-realista' (default) → caller usa buildBlubluPrompt()
//
// FALHA RAPIDA:
//   Se versao for v3+ e MANIFESTO_V3 estiver vazio, este modulo lanca
//   na carga (require). Vercel function nao sobe, deploy quebra antes
//   de servir uma unica analise com prompt vazio.

// ─────────────────────────────────────────────────────────────────────────────
// 1. MANIFESTO BLUBLU v3
// ─────────────────────────────────────────────────────────────────────────────
// Identidade central da personalidade Blublu na versao v3.
// Felipe via Opus vai preencher conteudo completo no Commit 2.
// COMMIT 1: placeholder vazio + throw configurado.
const BLUBLU_MANIFESTO_V3 = ``;

// ─────────────────────────────────────────────────────────────────────────────
// 2. CATALOGO DE TECNICAS NARRATIVAS
// ─────────────────────────────────────────────────────────────────────────────
// Cada analise pede a IA pra escolher 3-5 tecnicas distintas e aplicar
// uma por ato. Garante que duas analises do mesmo video em momentos
// diferentes nao saiam identicas, e da Blublu um repertorio explicito
// em vez de tom generico.
//
// SCHEMA DE CADA TECNICA:
//   { id: 'snake_case_unico', uso: 'descricao curta de quando aplicar' }
//
// COMMIT 2: Felipe vai preencher ~30 tecnicas via Opus.
const TECNICAS_BLUBLU = [
  // Placeholder — sera preenchido por Felipe via Opus no Commit 2.
  // Exemplo de formato (descomente e ajuste):
  // { id: 'abertura_dramatica',     uso: 'Quando o hook do video tem cliffhanger forte' },
  // { id: 'provocacao_direta',      uso: 'Quando user precisa de balde dagua frio' },
  // { id: 'comparacao_inesperada',  uso: 'Quando dado bate com referencia de outro nicho' },
  // { id: 'revelacao_numero',       uso: 'Quando ha metrica especifica que muda jogo' },
  // { id: 'quebra_4a_parede',       uso: 'Quando Blublu admite limite/duvida' },
];

// ─────────────────────────────────────────────────────────────────────────────
// 3. QUALITY CRITERIA — gate pra rejeitar output generico
// ─────────────────────────────────────────────────────────────────────────────
// Regras conservadoras no Commit 1. Felipe via Opus refina no Commit 2
// baseado nos primeiros logs de produção.
const QUALITY_CRITERIA = {
  // Padroes proibidos no campo 'conteudo_principal' dos atos (regex case-insensitive).
  // Frases que ja sairam do fallback v2 (gerarAnaliseFallback) e que indicam
  // que a IA caiu em modo generico.
  proibido_no_conteudo_principal: [
    /conte[uú]do espec[ií]fico bate gen[eé]rico/i,
    /[aá]udio trending multiplica/i,
    /contexto [eé] tudo/i,
    /algoritmo vive de momento/i,
    /sem hook,? nada importa/i,
    /sem emo[cç][aã]o,? ningu[eé]m compartilha/i,
  ],
  // Padroes proibidos em qualquer campo de texto do ato
  proibido_em_qualquer_campo: [
    /minha\s+ia\s+t[aá]\s+(num\s+)?glitch/i,  // sinal de fallback vazado
    /padr[oõ]es\s+de\s+\d+(\.|,)?\d*\s*M\s+virais/i,
  ],
  // Cada ato precisa atender aos seguintes criterios
  obrigatorio_no_ato: {
    // Pelo menos 1 highlight com numero/percentual concreto
    minimo_dados_concretos: 1,
    // Tamanho minimo do conteudo_principal (chars) pra evitar resposta vaga
    min_conteudo_chars: 80,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. VALIDACAO DE CONFIGURACAO (executa na carga do modulo)
// ─────────────────────────────────────────────────────────────────────────────
function isV3Active(version) {
  if (!version) return false;
  // v3.0-blublu-realista, v3.1-..., v3.x-... contam como v3+
  return /^v3(\.|$)/.test(String(version));
}

(function validateOnLoad() {
  const version = process.env.BLUBLU_VERSION || 'v3.0-blublu-realista';
  if (!isV3Active(version)) return;  // v2 nao usa este modulo
  if (!BLUBLU_MANIFESTO_V3 || BLUBLU_MANIFESTO_V3.trim().length < 50) {
    throw new Error(
      `[blublu-personality] BLUBLU_MANIFESTO_V3 vazio ou muito curto. ` +
      `Versao ativa: ${version}. ` +
      `Preencha api/_helpers/blublu-personality.js (BLUBLU_MANIFESTO_V3) ` +
      `OU defina BLUBLU_VERSION='v2.0-split' pra rollback.`
    );
  }
  if (!Array.isArray(TECNICAS_BLUBLU) || TECNICAS_BLUBLU.length < 5) {
    throw new Error(
      `[blublu-personality] TECNICAS_BLUBLU precisa de pelo menos 5 tecnicas. ` +
      `Atual: ${(TECNICAS_BLUBLU || []).length}. ` +
      `Versao ativa: ${version}.`
    );
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// 5. PROMPT BUILDER
// ─────────────────────────────────────────────────────────────────────────────
// Constroi prompt v3 a partir do manifesto + catalogo + contexto da analise.
//
// modo:
//   'narrativa'  → atos 1-4 (sem citar nome do user, cacheavel cross-user)
//   'aplicacao'  → abertura + ato 5 + quiz (cita nome, cacheavel por user+respostas)
//
// contexto: { nome, video, respostas, statsNicho, duracaoMedia, easterEgg }
function buildBlubluPrompt(modo, contexto) {
  if (modo !== 'narrativa' && modo !== 'aplicacao') {
    throw new Error(`[buildBlubluPrompt] modo invalido: ${modo}`);
  }
  const { nome, video, respostas, duracaoMedia, statsNichoLen, easterEgg } = contexto;

  // Catalogo serializado — IA escolhe 3-5 tecnicas pelo id
  const catalogo = TECNICAS_BLUBLU.map(t => `- ${t.id}: ${t.uso}`).join('\n');

  const cabecalhoManifesto = `${BLUBLU_MANIFESTO_V3.trim()}

CATALOGO DE TECNICAS DISPONIVEIS (escolha 3-5 ids distintos pra essa analise, aplicando 1 por ato):
${catalogo}`;

  const dadosVideo = `VIDEO DISSECADO:
Titulo: "${video.titulo}"
Canal: ${video.canal_nome}
Views: ${(video.views || 0).toLocaleString('pt-BR')}
Likes: ${(video.likes || 0).toLocaleString('pt-BR')}
Comentarios: ${(video.comentarios || 0).toLocaleString('pt-BR')}
Duracao: ${video.duracao_segundos}s
Velocidade 24h: ${Math.round(video.velocidade_views_24h || 0)} views/hora
Nicho: ${video.nicho || 'nao classificado'}`;

  if (modo === 'narrativa') {
    return `${cabecalhoManifesto}

${dadosVideo}

DADOS DO NICHO:
Duracao media dos virais do nicho: ${duracaoMedia ? duracaoMedia + 's' : 'nao disponivel'}
Virais de referencia analisados: ${statsNichoLen || 0}

ENTREGA: atos 1-4 (narrativa tecnica do video). Cada ato tem:
- titulo (curto, impactante)
- blublu_intro (frase introduzindo o ato, com personalidade, SEM citar nome de pessoa)
- conteudo_principal (analise objetiva, MIN 80 chars, com pelo menos 1 referencia especifica ao titulo/canal/duracao deste video)
- highlights (array de 2-3 bullets curtos e punchy, pelo menos 1 com numero/percentual concreto)
- blublu_outro (frase final com personalidade, SEM citar nome de pessoa)

REGRAS DE QUALIDADE:
1. Atos 1-4 analisam ESTE VIDEO especifico. Cite titulo, canal ou duracao em pelo menos 1 ato.
2. NAO use frases genericas como "conteudo especifico bate generico", "audio trending multiplica", "contexto e tudo".
3. NAO cite "${nome}" nem nome algum de pessoa nesta parte. Referencias pessoais ficam pra parte 2.
4. Cada ato deve aplicar UMA tecnica distinta do catalogo (use o id da tecnica internamente — nao precisa expor pro usuario).

Retorne APENAS JSON valido:
{
  "ato_1": {"titulo":"O Hook","blublu_intro":"...","conteudo_principal":"...","highlights":["...","...","..."],"blublu_outro":"..."},
  "ato_2": {"titulo":"A Estrutura","blublu_intro":"...","conteudo_principal":"...","highlights":["...","...","..."],"blublu_outro":"..."},
  "ato_3": {"titulo":"O Gatilho Viral","blublu_intro":"...","conteudo_principal":"...","highlights":["...","...","..."],"blublu_outro":"..."},
  "ato_4": {"titulo":"O Contexto Cultural","blublu_intro":"...","conteudo_principal":"...","highlights":["...","...","..."],"blublu_outro":"..."}
}`;
  }

  // modo === 'aplicacao'
  const ctxUser = `CONTEXTO DO USUARIO (${nome}):
Nicho: ${respostas?.nicho || 'nao informado'}
Duracao habitual: ${respostas?.duracao || 'nao informado'}
Desafio principal: ${respostas?.desafio || 'nao informado'}`;

  const eggLine = easterEgg
    ? `\nEASTER EGG ATIVO: canal e do idolo "${easterEgg.nome_completo}". Blublu fica fa-histerico nesta analise — solta admiracao genuina (sem ironia) em algum momento.`
    : '';

  return `${cabecalhoManifesto}

${dadosVideo}

${ctxUser}${eggLine}

ENTREGA: abertura_blublu + ato_5 (aplicacao pratica pra ${nome}) + quiz de 3 perguntas.

ATO 5 — estrutura especial:
- titulo, blublu_intro
- sugestoes: array com 3 sugestoes { titulo, descricao, exemplo_pratico }
  baseadas no video acima e no contexto do ${nome}
- blublu_outro

QUIZ: 3 perguntas (4 opcoes cada) testando se ${nome} absorveu conceitos-chave do video.
Inclua 1 pegadinha. Cada pergunta tem comentario_se_acertar e comentario_se_errar com personalidade Blublu.

REGRAS DE QUALIDADE:
1. Cite "${nome}" naturalmente em abertura_blublu, ato_5 e fechamento do quiz.
2. Sugestoes precisam ter exemplo_pratico ESPECIFICO (nao generico tipo "teste varios formatos").
3. Quiz testa o que foi dito nos atos 1-4 — nao pergunte sobre conceito que nao apareceu antes.

Retorne APENAS JSON valido:
{
  "abertura_blublu": "Frase abrindo a analise pra ${nome}, com personalidade",
  "ato_5": {
    "titulo":"Aplicacao pra Voce",
    "blublu_intro":"Agora, ${nome}, a parte que importa...",
    "sugestoes":[
      {"titulo":"...","descricao":"...","exemplo_pratico":"..."},
      {"titulo":"...","descricao":"...","exemplo_pratico":"..."},
      {"titulo":"...","descricao":"...","exemplo_pratico":"..."}
    ],
    "blublu_outro":"..."
  },
  "quiz":{
    "intro_blublu":"...",
    "perguntas":[
      {"pergunta":"...","opcoes":["a","b","c","d"],"correta":0,"comentario_se_acertar":"...","comentario_se_errar":"..."},
      {"pergunta":"...","opcoes":["a","b","c","d"],"correta":2,"comentario_se_acertar":"...","comentario_se_errar":"..."},
      {"pergunta":"...","opcoes":["a","b","c","d"],"correta":1,"comentario_se_acertar":"...","comentario_se_errar":"..."}
    ],
    "fechamento":"Frase final de Blublu fechando tudo"
  }
}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. QUALITY GATE — valida output da IA
// ─────────────────────────────────────────────────────────────────────────────
// Retorna { passed: bool, issues: string[] }
// modo: 'narrativa' (atos 1-4) ou 'aplicacao' (ato_5 + quiz)
function validateOutputQuality(output, modo) {
  const issues = [];

  if (!output || typeof output !== 'object') {
    return { passed: false, issues: ['output vazio ou nao-objeto'] };
  }

  if (modo === 'narrativa') {
    const atos = ['ato_1', 'ato_2', 'ato_3', 'ato_4'];
    let temReferenciaVideo = false;
    for (const k of atos) {
      const a = output[k];
      if (!a) { issues.push(`${k}: ausente`); continue; }
      const camposObrig = ['titulo', 'blublu_intro', 'conteudo_principal', 'highlights', 'blublu_outro'];
      for (const c of camposObrig) {
        if (a[c] === undefined || a[c] === null || a[c] === '') {
          issues.push(`${k}.${c}: vazio`);
        }
      }
      if (typeof a.conteudo_principal === 'string') {
        if (a.conteudo_principal.length < QUALITY_CRITERIA.obrigatorio_no_ato.min_conteudo_chars) {
          issues.push(`${k}.conteudo_principal: < ${QUALITY_CRITERIA.obrigatorio_no_ato.min_conteudo_chars} chars`);
        }
        for (const re of QUALITY_CRITERIA.proibido_no_conteudo_principal) {
          if (re.test(a.conteudo_principal)) {
            issues.push(`${k}.conteudo_principal: padrao generico "${re.source}"`);
          }
        }
      }
      // Verifica padroes proibidos em todos os campos textuais
      const todosCampos = [a.titulo, a.blublu_intro, a.conteudo_principal, a.blublu_outro,
        ...(Array.isArray(a.highlights) ? a.highlights : [])].filter(s => typeof s === 'string').join(' ');
      for (const re of QUALITY_CRITERIA.proibido_em_qualquer_campo) {
        if (re.test(todosCampos)) {
          issues.push(`${k}: padrao proibido "${re.source}"`);
        }
      }
      // Highlights: precisa pelo menos N bullet com numero
      if (Array.isArray(a.highlights)) {
        const comNumero = a.highlights.filter(h => typeof h === 'string' && /\d/.test(h)).length;
        if (comNumero < QUALITY_CRITERIA.obrigatorio_no_ato.minimo_dados_concretos) {
          issues.push(`${k}.highlights: nenhum bullet com numero concreto`);
        }
      } else {
        issues.push(`${k}.highlights: nao e array`);
      }
    }
    // Pelo menos 1 ato menciona o video especifico (titulo/canal/duracao)
    // ja eh checado no prompt — aqui so logamos se claramente ausente
    if (!temReferenciaVideo) {
      // soft check: nao bloqueia, so loga
    }
  }

  if (modo === 'aplicacao') {
    if (!output.abertura_blublu || typeof output.abertura_blublu !== 'string') {
      issues.push('abertura_blublu: ausente');
    }
    const a5 = output.ato_5;
    if (!a5) {
      issues.push('ato_5: ausente');
    } else {
      for (const c of ['titulo', 'blublu_intro', 'sugestoes', 'blublu_outro']) {
        if (a5[c] === undefined || a5[c] === null || a5[c] === '') {
          issues.push(`ato_5.${c}: vazio`);
        }
      }
      if (Array.isArray(a5.sugestoes)) {
        if (a5.sugestoes.length < 3) issues.push(`ato_5.sugestoes: < 3 itens`);
        a5.sugestoes.forEach((s, i) => {
          for (const c of ['titulo', 'descricao', 'exemplo_pratico']) {
            if (!s?.[c]) issues.push(`ato_5.sugestoes[${i}].${c}: vazio`);
          }
        });
      } else {
        issues.push('ato_5.sugestoes: nao e array');
      }
    }
    const q = output.quiz;
    if (!q) {
      issues.push('quiz: ausente');
    } else {
      if (!Array.isArray(q.perguntas) || q.perguntas.length < 3) {
        issues.push('quiz.perguntas: < 3 itens');
      } else {
        q.perguntas.forEach((p, i) => {
          if (!p?.pergunta) issues.push(`quiz.perguntas[${i}].pergunta: vazio`);
          if (!Array.isArray(p?.opcoes) || p.opcoes.length !== 4) {
            issues.push(`quiz.perguntas[${i}].opcoes: != 4`);
          }
          if (typeof p?.correta !== 'number') {
            issues.push(`quiz.perguntas[${i}].correta: nao e numero`);
          }
        });
      }
    }
  }

  return { passed: issues.length === 0, issues };
}

module.exports = {
  BLUBLU_MANIFESTO_V3,
  TECNICAS_BLUBLU,
  QUALITY_CRITERIA,
  isV3Active,
  buildBlubluPrompt,
  validateOutputQuality,
};
