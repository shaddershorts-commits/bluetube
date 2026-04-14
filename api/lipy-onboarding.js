// Lipy — Orquestrador de onboarding
const { getSupabase } = require('./_lipy/supabase');
const { askClaude } = require('./_lipy/claude');
const { ok, fail, readJson, cors } = require('./_lipy/http');
const { criarGrupoWhatsApp, enviarWhatsApp } = require('./lipy-whatsapp');
const { criarBoard } = require('./_lipy/trello');

const PERGUNTAS = [
  'Qual o nome completo da sua empresa?',
  'Descreva em 2-3 frases o que sua empresa faz.',
  'Qual seu público-alvo? (idade, gênero, interesses)',
  'Quais são seus 3 principais concorrentes?',
  'Qual o tom da sua marca? (formal, descontraído, técnico, jovem)',
  'Quais cores usa na sua identidade visual?',
  'Tem logo? Se sim, envie aqui no grupo.',
  'Quais redes sociais já tem? Envie os usuários.',
  'Qual o principal objetivo com as redes sociais?',
  'Tem site? Qual o link?'
];

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const body = await readJson(req);
    const { cliente_id, etapa, respostas } = body;
    if (!cliente_id) return fail(res, 400, 'cliente_id obrigatório');

    const sb = getSupabase();
    const { data: cliente } = await sb.from('lipy_clientes').select('*').eq('id', cliente_id).maybeSingle();
    if (!cliente) return fail(res, 404, 'cliente não encontrado');

    if (etapa === 'inicio') {
      const group_id = await criarGrupoWhatsApp({
        subject: `Lipy × ${cliente.empresa}`,
        participants: [cliente.telefone, process.env.LIPY_WHATSAPP_PHONE].filter(Boolean)
      });
      const board = await criarBoard({ nome: `Lipy — ${cliente.empresa}` });

      await sb.from('lipy_clientes').update({
        whatsapp_group_id: group_id,
        trello_board_id: board?.id
      }).eq('id', cliente_id);

      const boas = `👋 Olá, ${cliente.nome}! Aqui é a *Lipy*, sua nova equipe de marketing digital com IA.\n\nSeja muito bem-vindo(a)! 💜\n\nVou começar seu onboarding agora mesmo. São 10 perguntas rápidas para eu entender sua marca.\n\nBora começar? 👇\n\n*1/10* — ${PERGUNTAS[0]}`;
      await enviarWhatsApp(group_id, boas);

      return ok(res, { grupo: group_id, board: board?.id });
    }

    if (etapa === 'responder') {
      await sb.from('lipy_onboarding_respostas').insert({ cliente_id, etapa: String(respostas?.index || 0), respostas });
      const index = (respostas?.index || 0) + 1;
      if (index < PERGUNTAS.length) {
        await enviarWhatsApp(cliente.whatsapp_group_id, `*${index + 1}/10* — ${PERGUNTAS[index]}`);
        return ok(res, { proxima: index });
      }
      return gerarPlanejamentoInicial(cliente, res);
    }

    return fail(res, 400, 'etapa inválida');
  } catch (err) {
    console.error('[lipy-onboarding]', err);
    return fail(res, 500, err.message);
  }
};

async function gerarPlanejamentoInicial(cliente, res) {
  const sb = getSupabase();
  const { data: respostas } = await sb.from('lipy_onboarding_respostas')
    .select('respostas').eq('cliente_id', cliente.id);

  const plano = await askClaude({
    system: 'Você é estrategista de marketing. Crie um planejamento mensal completo em JSON baseado nas respostas do onboarding.',
    json: true,
    max_tokens: 2500,
    messages: [{
      role: 'user',
      content: `Respostas: ${JSON.stringify(respostas)}\n\nRetorne JSON: { "objetivo": "...", "publico_alvo": "...", "tom_comunicacao": "...", "cores_marca": [...], "temas": [...], "frequencia_posts": 12, "calendario": [...] }`
    }]
  });

  const mes_referencia = new Date().toISOString().slice(0, 7);
  const { data: planej } = await sb.from('lipy_planejamentos').insert({
    cliente_id: cliente.id,
    mes_referencia,
    objetivo: plano.objetivo,
    publico_alvo: plano.publico_alvo,
    tom_comunicacao: plano.tom_comunicacao,
    cores_marca: plano.cores_marca || [],
    temas: plano.temas || [],
    frequencia_posts: plano.frequencia_posts || 12,
    status: 'aguardando_aprovacao'
  }).select().single();

  if (cliente.whatsapp_group_id) {
    const msg = `✨ Seu *planejamento de ${mes_referencia}* está pronto!\n\n🎯 *Objetivo:* ${plano.objetivo}\n👥 *Público:* ${plano.publico_alvo}\n🎨 *Tom:* ${plano.tom_comunicacao}\n📅 *Frequência:* ${plano.frequencia_posts} posts no mês\n\n*Temas:*\n${(plano.temas || []).map(t => `• ${t}`).join('\n')}\n\nResponda *APROVAR* para eu começar a produzir, ou me diga o que ajustar!`;
    await enviarWhatsApp(cliente.whatsapp_group_id, msg);
  }

  return ok(res, { planejamento: planej });
}
