// Lipy — Agente Atendimento (WhatsApp + chat do portal)
const { getSupabase } = require('./_lipy/supabase');
const { askClaude } = require('./_lipy/claude');
const { ok, fail, readJson, cors } = require('./_lipy/http');
const { enviarWhatsApp } = require('./lipy-whatsapp');

const SYSTEM_PROMPT = `Você é a Lipy, assistente de marketing digital da Assessoria Lipy.
Você atende clientes pelo WhatsApp com profissionalismo e simpatia.
Você tem acesso ao histórico do cliente, planejamento atual e status dos conteúdos.

Você pode:
- Responder dúvidas sobre o andamento da gestão
- Receber aprovações ou feedbacks de conteúdos
- Coletar informações para novos conteúdos
- Agendar reuniões
- Enviar relatórios quando solicitado
- Escalar para humano quando necessário

Responda de forma natural. Emojis com moderação. Seja objetiva.

Retorne JSON:
{
  "resposta": "texto para enviar ao cliente",
  "intencao": "duvida|aprovar_conteudo|ajustar_conteudo|solicitar_trafego|pedir_relatorio|outro",
  "conteudo_id": "uuid ou null",
  "feedback": "texto ou null",
  "escalar_humano": false
}`;

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const body = await readJson(req);
    const { cliente_id, mensagem, group_id } = body;
    if (!mensagem) return fail(res, 400, 'mensagem obrigatória');

    const sb = getSupabase();
    await sb.from('lipy_conversas_whatsapp').insert({
      cliente_id, group_id, mensagem, remetente: 'cliente', processado: false
    });

    const historico = await carregarHistorico(cliente_id);
    const contexto = await carregarContextoCliente(cliente_id);

    const decisao = await askClaude({
      system: SYSTEM_PROMPT,
      json: true,
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Contexto do cliente:\n${JSON.stringify(contexto)}\n\nHistórico recente:\n${historico}\n\nNova mensagem:\n${mensagem}`
      }]
    });

    const resposta = decisao.resposta || 'Recebi! Já te retorno.';
    if (group_id) await enviarWhatsApp(group_id, resposta);

    await sb.from('lipy_conversas_whatsapp').insert({
      cliente_id, group_id, mensagem: resposta,
      remetente: 'agente', processado: true, resposta_agente: resposta
    });

    if (decisao.intencao === 'aprovar_conteudo' && decisao.conteudo_id) {
      await sb.from('lipy_conteudos').update({ status: 'aprovado' }).eq('id', decisao.conteudo_id);
    }
    if (decisao.intencao === 'ajustar_conteudo' && decisao.conteudo_id) {
      await sb.from('lipy_conteudos').update({
        status: 'rascunho', feedback_cliente: decisao.feedback
      }).eq('id', decisao.conteudo_id);
    }

    return ok(res, { decisao });
  } catch (err) {
    console.error('[lipy-atendimento]', err);
    return fail(res, 500, err.message);
  }
};

async function carregarHistorico(cliente_id) {
  if (!cliente_id) return '(sem histórico)';
  const sb = getSupabase();
  const { data } = await sb.from('lipy_conversas_whatsapp')
    .select('remetente, mensagem, created_at')
    .eq('cliente_id', cliente_id)
    .order('created_at', { ascending: false })
    .limit(20);
  if (!data?.length) return '(sem histórico)';
  return data.reverse().map(m => `[${m.remetente}] ${m.mensagem}`).join('\n');
}

async function carregarContextoCliente(cliente_id) {
  if (!cliente_id) return {};
  const sb = getSupabase();
  const { data: cliente } = await sb.from('lipy_clientes').select('*').eq('id', cliente_id).maybeSingle();
  const { data: pendentes } = await sb.from('lipy_conteudos')
    .select('id, titulo, status')
    .eq('cliente_id', cliente_id)
    .eq('status', 'aguardando_aprovacao');
  return { cliente, conteudos_pendentes: pendentes || [] };
}
