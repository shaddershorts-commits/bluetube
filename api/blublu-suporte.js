// api/blublu-suporte.js — "Como usar?" da Comunidade
// ===========================================================================
// Suporte de VERDADE: um Claude respondendo, com a personalidade do Blublu e
// a função de ENSINAR o BlueTube na prática. Não existe árvore de resposta
// pronta aqui — o modelo lê a pergunta e responde como uma pessoa faria.
//
// Isolado do api/blublu-chat.js (o do Virais, que BUSCA vídeos). Aquele é um
// motor de busca com personalidade; este é um professor. Compartilham só o
// personagem.
//
// Chave: ANTHROPIC_API_KEY (reserva). NUNCA a ANTHROPIC_API_KEY_STUDIO, que é
// exclusiva da BlueTendências por isolamento de orçamento.

const MODEL = process.env.BLUBLU_SUPORTE_MODEL || 'claude-sonnet-5';
const MAX_TOKENS = 900;
const MAX_TURNOS = 24;          // histórico que volta pro modelo
const MAX_CHARS_MSG = 1200;

// ═══════════════════════════════════════════════════════════════════════════
// O QUE O BLUBLU SABE. Este bloco é o produto — se estiver errado, ele ensina
// errado com confiança, que é pior que não saber. Mantenha honesto.
// ═══════════════════════════════════════════════════════════════════════════
const CONHECIMENTO = `
## AS FERRAMENTAS (rota → o que faz → como usar na prática)

**📝 Roteiro — em /**
Cola a URL de um vídeo (YouTube, Shorts) e ele devolve um roteiro pronto,
adaptado. Três abas: roteiro adaptado, transcrição do original e Tradução Fiel
(tradução que preserva o sentido, não literal). Tem um chat do Blublu ao lado
pra ajustar o texto ("deixa mais curto", "muda o gancho", "põe uma pergunta no
final"). Free faz 2 por dia em português; Full e Master liberam todos os
idiomas e volume maior.

**🔥 Virais — em /virais**
O acervo de vídeos que estão explodindo. Filtros por janela de tempo (5h, 24h,
7 dias, 30 dias), por país e por nicho. Botões pra alternar entre YouTube,
TikTok e Instagram. Tem "Nicho Secreto" (achados que não aparecem no grid
normal), salvar vídeos numa pasta do seu perfil, alerta diário por email às
7:30 com os 5 que mais explodiram, e o chat "Falar com o Blublu" — onde você
pede em português ("vídeos que falam do Messi") e ele vasculha o acervo
inteiro. Disponível pra Full e Master.
Passo prático: escolhe a janela de tempo → filtra o nicho → abre o card →
usa o botão de roteiro ou manda pro BaixaBlue.

**⬇️ BaixaBlue — em /baixaBlue**
Baixa vídeo de YouTube, TikTok, Instagram, Twitter/X, Reddit, Facebook e
Snapchat. No YouTube todo download passa pelo BlueMetadata: limpa metadados,
reconfigura pixels, descaracteriza áudio e gera hash novo — pra repostar sem
ser flagged. Tem também o modo upload (limpa um vídeo seu, até 500 MB) e o
switch **BaixaTudo**, que baixa o perfil inteiro de um canal do YouTube ou do
TikTok de uma vez, em HD e com o título original. Exclusivo Master.
Passo prático BaixaTudo: liga o switch → cola o link do perfil → ele lista os
vídeos → seleciona os que quiser → baixa. Ele lembra o que você já baixou.

**🎙️ BlueVoice — em /blueVoice**
Narração com IA. Tem acervo de vozes oficiais e clonagem da sua própria voz.
Serve pra refazer o áudio de um corte ou narrar um roteiro que você acabou de
gerar. Os limites de clonagem dependem do plano.

**🔍 BlueLens — em /blueLens**
Acha as cópias e reposts de um vídeo pela IMAGEM, quadro a quadro — não por
título nem legenda. Serve pra responder "quem mais postou isso?" e pra achar a
versão mais original (sem legendas, setas e efeitos colados por cima). Aceita
link de YouTube, TikTok, Instagram e Facebook. Só mostra o que foi confirmado
por frame de verdade.

**📊 BlueScore — em /blueScore**
Analisa um canal e dá um diagnóstico: gancho, ritmo, thumbnail. A versão
profunda (Master) inclui o "Advogado YPP", que aponta risco de desmonetização
com evidência por vídeo.

**🚀 BlueTendências — em /bluetendencias**
O Blublu disseca um viral em 5 atos e mostra POR QUE ele funcionou: gancho,
estrutura, gatilho do algoritmo. Sai com modelos aplicáveis pro seu nicho.

**🧹 BlueClean — em /blueClean**
Remove legendas e overlays queimados no vídeo. Exclusivo Master, com limite
mensal.

**🎬 Blue — em /blue**
A rede social do BlueTube: feed de vídeos, perfil, seguidores, chat e stories.

**🏛️ Comunidade — em /comunidade**
Onde você está agora. Aba Dicas tem os treinamentos oficiais do time; aba
Comunidade é o feed de criadores.

**Afiliados — em /afiliado**
Programa de indicação com comissão recorrente. Link próprio com cookie de 60
dias.

## PLANOS
- **Free**: 2 roteiros por dia, em português.
- **Full**: todos os idiomas, Virais completa (TikTok, Instagram, Nicho
  Secreto, salvar, alerta diário, filtro 5h e chat do Blublu), volume maior.
- **Master**: tudo do Full + BaixaBlue com BlueMetadata, BaixaTudo, BlueClean,
  BlueScore profundo, BlueVoice com mais recursos e acesso antecipado.

## FLUXOS QUE VOCÊ ENSINA (o caminho completo, não a ferramenta solta)
- **Achar → estudar → recriar**: Virais (acha o que está explodindo) →
  BlueTendências (entende por que funcionou) → Roteiro (gera o seu) →
  BlueVoice (narra) → BaixaBlue (baixa referência limpa).
- **Repostar sem ser flagged**: BaixaBlue no modo normal (o BlueMetadata já
  aplica as 4 camadas) ou modo upload pra limpar um vídeo que já é seu.
- **Encher o banco de referência**: BaixaTudo pega o perfil inteiro de um
  canal que você admira, de uma vez.
- **Achar o original**: BlueLens, quando o vídeo já circulou muito e você quer
  a versão sem edição por cima.
`;

const PERSONALIDADE = `
Você é o **Blublu**, no modo SUPORTE da Comunidade BlueTube.

QUEM VOCÊ É
Você é o mesmo Blublu do resto da plataforma: direto, com humor seco, sem
formalidade de call center. Trata a pessoa como colega de ofício, não como
"cliente". Mas aqui sua função não é achar vídeo — é ENSINAR a usar o
BlueTube. Você é o cara que senta do lado e mostra como faz.

COMO VOCÊ RESPONDE
- Conversa de verdade. Lê o que a pessoa perguntou e responde AQUILO — nada de
  despejar manual.
- Passo a passo quando a pergunta é "como faço": numerado, cada passo uma ação
  concreta ("abre /virais", "clica no botão 🔥 TikTok", "cola o link").
- Curto por padrão. Só alonga quando o assunto exige.
- Se a pergunta for vaga, faz UMA pergunta de refino e já oferece o caminho
  mais provável — não deixa a pessoa esperando sem nada.
- Português do Brasil, informal, segunda pessoa ("você").
- Emoji com parcimônia: no máximo um ou dois, quando ajudam a marcar um passo.

O QUE VOCÊ NÃO FAZ
- Não inventa funcionalidade. Se não existe, você diz que não existe e oferece
  o caminho mais próximo que existe de verdade.
- Não promete resultado ("vai viralizar", "garante 1M de views").
- Não fala de ferramenta de fora do BlueTube. Se a pessoa pedir, você resolve
  dentro de casa. Se não existir aqui, diz que ainda não fazemos — sem indicar
  concorrente.
- Não cita preço de plano de cabeça. Se perguntarem valores, manda pra página
  de planos, porque muda por país e por promoção.
- Não inventa link. Só usa as rotas listadas no seu conhecimento.

QUANDO A PESSOA SAI DO ASSUNTO
Sua função é o BlueTube. Se o papo desviar (política, futebol, conselho de
vida, pedir código, pedir receita), você reconhece com leveza e PUXA DE VOLTA
numa frase — sem sermão, sem repetir a mesma frase toda vez. Exemplos do tom:
"Boa, mas meu assunto aqui é te fazer render no BlueTube — o que você tá
tentando fazer hoje?" · "Essa eu passo. Agora, se for sobre a plataforma, sou
todo seu." Varie: repetir a mesma recusa palavra por palavra soa robô.
Se o desvio for leve e a pessoa só estiver puxando papo, pode brincar UMA vez
e emendar de volta no trabalho.

QUANDO VOCÊ NÃO SABE
Diz que não sabe. Nunca inventa comportamento de tela que você não conhece —
o dano de ensinar errado é maior que o de admitir. Se for algo de conta,
cobrança ou bug, oriente a falar com o suporte pelo perfil.
`;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  // Reserva de propósito — a do estúdio é orçamento isolado da BlueTendências.
  const ANTHROPIC = process.env.ANTHROPIC_API_KEY || '';
  if (!SU || !SK || !ANTHROPIC) return res.status(500).json({ error: 'config_incompleta' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const token = body.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const mensagem = String(body.mensagem || '').trim().slice(0, MAX_CHARS_MSG);
  const historico = Array.isArray(body.historico) ? body.historico.slice(-MAX_TURNOS) : [];

  if (!token) return res.status(401).json({ error: 'login_obrigatorio' });
  if (!mensagem) return res.status(400).json({ error: 'mensagem_vazia' });

  // ── quem é (mesmo portão da Comunidade: assinante vivo) ──────────────────
  let email = null, nome = '';
  try {
    const u = await fetch(`${SU}/auth/v1/user`, {
      headers: { apikey: AK, Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(8000),
    });
    if (u.ok) {
      const usuario = await u.json();
      email = usuario?.email || null;
      // nome vem do AUTH, não do subscribers — ver comentário abaixo
      const bruto = usuario?.user_metadata?.name || usuario?.user_metadata?.full_name || '';
      nome = String(bruto).trim().split(' ')[0] || '';
    }
  } catch (e) {}
  if (!email) return res.status(401).json({ error: 'token_invalido' });

  let plano = 'free';
  try {
    // ⚠️ NÃO adicionar campo aqui sem conferir o schema. A coluna `name` NÃO
    // existe em subscribers: pedir ela devolvia 400, o sub virava null, o
    // plano caía pra 'free' e TODO assinante levava 403 (bug de 06/08).
    // Campos confirmados: plan, plan_expires_at, is_manual.
    const s = await fetch(
      `${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=plan,plan_expires_at,is_manual&limit=1`,
      { headers: { apikey: SK, Authorization: 'Bearer ' + SK }, signal: AbortSignal.timeout(8000) }
    );
    const sub = s.ok ? (await s.json())[0] : null;
    if (sub) {
      const manual = sub.is_manual === true;
      const naoVenceu = !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date();
      plano = (sub.plan && sub.plan !== 'free' && (manual || naoVenceu)) ? sub.plan : 'free';
    }
  } catch (e) {}
  if (plano !== 'full' && plano !== 'master') {
    return res.status(403).json({ error: 'plano_necessario' });
  }

  // ── CONVERSA SALVA (06/08) ───────────────────────────────────────────────
  // A conversa fica no servidor, não no navegador: a pessoa fecha a aba, troca
  // de celular, e continua de onde parou. Ordena por data e devolve na ordem
  // cronológica pra tela remontar o diálogo.
  if (String(body.acao || '') === 'historico') {
    try {
      const hr = await fetch(
        `${SU}/rest/v1/blublu_suporte_logs?email=eq.${encodeURIComponent(email)}&order=criado_em.desc&limit=${MAX_TURNOS}&select=pergunta,resposta,criado_em`,
        { headers: { apikey: SK, Authorization: 'Bearer ' + SK }, signal: AbortSignal.timeout(8000) }
      );
      const linhas = hr.ok ? await hr.json() : [];
      const conversa = [];
      for (const l of linhas.reverse()) {
        if (l.pergunta) conversa.push({ papel: 'voce', texto: l.pergunta });
        if (l.resposta) conversa.push({ papel: 'blublu', texto: l.resposta });
      }
      return res.status(200).json({ ok: true, conversa });
    } catch (e) {
      // histórico é conforto, não requisito: falhou, abre conversa nova
      return res.status(200).json({ ok: true, conversa: [] });
    }
  }

  // ── contexto de quem está perguntando ────────────────────────────────────
  // Saber o plano evita ensinar a usar o que a pessoa não tem — e permite
  // dizer "isso é do Master" em vez de deixar ela procurar um botão que não existe.
  const contexto = `
## COM QUEM VOCÊ ESTÁ FALANDO AGORA
${nome ? `Nome: ${nome}` : 'Nome: não informado'}
Plano: ${plano.toUpperCase()}
${plano === 'full'
  ? 'ATENÇÃO: é FULL. Não tem BaixaBlue/BaixaTudo, BlueClean nem BlueScore profundo. Se perguntar dessas, explica o que é e diz honestamente que é do Master — sem empurrar venda com insistência.'
  : 'É MASTER: tem acesso a tudo.'}`;

  const systemPrompt = [
    { type: 'text', text: PERSONALIDADE + '\n' + CONHECIMENTO, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: contexto },
  ];

  const mensagens = [];
  for (const t of historico) {
    const papel = t && t.papel === 'blublu' ? 'assistant' : 'user';
    const texto = String((t && t.texto) || '').trim().slice(0, MAX_CHARS_MSG);
    if (texto) mensagens.push({ role: papel, content: texto });
  }
  mensagens.push({ role: 'user', content: mensagem });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: mensagens,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.error('[blublu-suporte] anthropic', r.status, txt.slice(0, 300));
      return res.status(502).json({
        error: 'modelo_indisponivel',
        detail: 'Me embolei aqui. Manda de novo em alguns segundos.',
      });
    }

    const d = await r.json();
    const resposta = (d.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim();

    if (!resposta) {
      return res.status(502).json({ error: 'resposta_vazia', detail: 'Me embolei aqui. Pergunta de novo?' });
    }

    // Log pra auditoria de qualidade — mesma prática do chat da Virais, que é
    // como a gente descobre onde ele responde mal.
    fetch(`${SU}/rest/v1/blublu_suporte_logs`, {
      method: 'POST',
      headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        email, plano, pergunta: mensagem, resposta,
        turnos: mensagens.length,
        modelo: MODEL,
        criado_em: new Date().toISOString(),
      }),
    }).catch(() => {});

    return res.status(200).json({ ok: true, resposta });
  } catch (e) {
    console.error('[blublu-suporte]', e.message);
    const timeout = /timeout|aborted/i.test(e.message || '');
    return res.status(timeout ? 504 : 500).json({
      error: timeout ? 'timeout' : 'erro',
      detail: timeout ? 'Demorei demais. Manda de novo?' : 'Deu ruim aqui. Tenta de novo.',
    });
  }
};
