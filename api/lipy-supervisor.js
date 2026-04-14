// Lipy — Agente Supervisor (orquestrador central)
const { getSupabase } = require('./_lipy/supabase');
const { askClaude } = require('./_lipy/claude');
const { ok, fail, readJson, cors } = require('./_lipy/http');

const SYSTEM_PROMPT = `Você é o Agente Supervisor da Lipy, uma agência de marketing digital 100% IA.
Você orquestra uma equipe de agentes especializados e toma decisões estratégicas.

Agentes disponíveis:
- lipy-atendimento: responde clientes no WhatsApp, coleta informações
- lipy-conteudo: cria posts, stories, legendas e imagens com IA
- lipy-postagem: publica nas redes sociais e responde comentários
- lipy-relatorio: gera relatórios de desempenho e os envia
- lipy-trafego: configura e gerencia campanhas de anúncios

Regras:
- Sempre mantenha o cliente informado
- Qualidade antes de velocidade
- Nunca publique sem aprovação do cliente
- Relatórios sempre com dados reais
- Tom profissional mas próximo

Retorne JSON:
{
  "analise": "...",
  "acoes": [ { "agente": "lipy-conteudo", "tipo": "criar_post", "dados": {} } ],
  "notificar_humano": false
}`;

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET' && req.query?.action === 'health-check') {
      return healthCheck(res);
    }

    const body = await readJson(req);
    const { evento, cliente_id, dados = {} } = body;
    if (!evento) return fail(res, 400, 'evento obrigatório');

    const decisao = await askClaude({
      system: SYSTEM_PROMPT,
      json: true,
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Evento: ${evento}\nCliente: ${cliente_id || 'n/d'}\nDados: ${JSON.stringify(dados)}\n\nRetorne JSON com as ações a executar.`
      }]
    });

    const sb = getSupabase();
    await sb.from('lipy_tarefas_agentes').insert({
      cliente_id, agente: 'supervisor', tipo: evento,
      status: 'concluido', dados_entrada: dados, dados_saida: decisao,
      concluido_em: new Date().toISOString()
    });

    const resultados = [];
    for (const acao of (decisao.acoes || [])) {
      resultados.push(await enfileirar(acao, cliente_id));
    }

    return ok(res, { decisao, resultados });
  } catch (err) {
    console.error('[lipy-supervisor]', err);
    return fail(res, 500, err.message);
  }
};

async function enfileirar(acao, cliente_id) {
  const sb = getSupabase();
  await sb.from('lipy_tarefas_agentes').insert({
    cliente_id, agente: acao.agente, tipo: acao.tipo,
    status: 'pendente', dados_entrada: acao.dados || {}
  });
  return { agente: acao.agente, tipo: acao.tipo, enfileirado: true };
}

async function healthCheck(res) {
  const sb = getSupabase();
  const checks = {
    supabase: !!process.env.SUPABASE_URL,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    stripe: !!process.env.STRIPE_SECRET_KEY,
    evolution: !!process.env.EVOLUTION_API_URL,
    meta: !!process.env.META_ACCESS_TOKEN,
    ideogram: !!process.env.IDEOGRAM_API_KEY,
    trello: !!process.env.TRELLO_API_KEY,
    resend: !!process.env.RESEND_API_KEY
  };
  await sb.from('lipy_tarefas_agentes').insert({
    agente: 'supervisor', tipo: 'health-check', status: 'concluido',
    dados_saida: checks, concluido_em: new Date().toISOString()
  });
  return ok(res, { checks });
}
