// Lipy — Agente Relatório (gera e envia relatórios automáticos)
const { getSupabase } = require('./_lipy/supabase');
const { askClaude } = require('./_lipy/claude');
const { ok, fail, readJson, cors } = require('./_lipy/http');
const { enviarWhatsApp } = require('./lipy-whatsapp');
const { buscarInsights } = require('./lipy-meta');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const action = req.query?.action;
    if (action === 'diario') return cronDiario(res);
    if (action === 'semanal') return cronSemanal(res);
    if (action === 'list') return listar(req, res);

    const body = await readJson(req);
    const { cliente_id, tipo = 'semanal' } = body;
    if (!cliente_id) return fail(res, 400, 'cliente_id obrigatório');
    const rel = await gerarRelatorio(cliente_id, tipo);
    return ok(res, rel);
  } catch (err) {
    console.error('[lipy-relatorio]', err);
    return fail(res, 500, err.message);
  }
};

async function listar(req, res) {
  const sb = getSupabase();
  let q = sb.from('lipy_relatorios').select('*').order('created_at', { ascending: false });
  if (req.query?.cliente_id) q = q.eq('cliente_id', req.query.cliente_id);
  const { data } = await q;
  return ok(res, { relatorios: data || [] });
}

async function gerarRelatorio(cliente_id, tipo) {
  const sb = getSupabase();
  const { data: cliente } = await sb.from('lipy_clientes').select('*').eq('id', cliente_id).maybeSingle();

  const fim = new Date();
  const inicio = new Date();
  inicio.setDate(fim.getDate() - (tipo === 'mensal' ? 30 : 7));

  const insights = await buscarInsights({
    instagram_id: cliente?.meta_instagram_id,
    access_token: cliente?.meta_access_token,
    since: inicio.toISOString().slice(0, 10),
    until: fim.toISOString().slice(0, 10)
  });

  const { data: publicados } = await sb.from('lipy_conteudos')
    .select('id, titulo, plataforma, publicado_em, metricas')
    .eq('cliente_id', cliente_id)
    .eq('status', 'publicado')
    .gte('publicado_em', inicio.toISOString());

  const analise = await askClaude({
    system: 'Você analisa métricas de redes sociais e gera insights profissionais e acionáveis em português.',
    json: true,
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `Cliente: ${cliente?.empresa}\nPeríodo: ${inicio.toISOString().slice(0,10)} a ${fim.toISOString().slice(0,10)}\nInsights Meta: ${JSON.stringify(insights)}\nPublicações: ${JSON.stringify(publicados)}\n\nRetorne JSON: { "resumo": "...", "destaques": [...], "alertas": [...], "sugestoes": [...], "top_posts": [...] }`
    }]
  });

  const dados = { insights, publicados, analise };

  const { data: rel } = await sb.from('lipy_relatorios').insert({
    cliente_id,
    periodo_inicio: inicio.toISOString().slice(0, 10),
    periodo_fim: fim.toISOString().slice(0, 10),
    tipo, dados
  }).select().single();

  if (cliente?.whatsapp_group_id) {
    const msg = `📊 *Relatório ${tipo}* — ${cliente.empresa}\n\n${analise.resumo || ''}\n\n*Destaques:*\n${(analise.destaques || []).map(d => `• ${d}`).join('\n')}\n\n*Próximos passos:*\n${(analise.sugestoes || []).map(s => `• ${s}`).join('\n')}`;
    await enviarWhatsApp(cliente.whatsapp_group_id, msg);
    await sb.from('lipy_relatorios').update({ enviado_whatsapp: true }).eq('id', rel?.id);
  }

  return { relatorio: rel, analise };
}

async function cronDiario(res) {
  const sb = getSupabase();
  const { data: clientes } = await sb.from('lipy_clientes').select('id, empresa, whatsapp_group_id').eq('status', 'ativo');
  const resultados = [];
  for (const c of (clientes || [])) {
    if (!c.whatsapp_group_id) continue;
    const msg = `☀️ Bom dia, ${c.empresa}! Aqui é a Lipy. Hoje vamos cuidar dos seus conteúdos e métricas. Qualquer coisa, é só chamar!`;
    try { await enviarWhatsApp(c.whatsapp_group_id, msg); resultados.push({ id: c.id, ok: true }); }
    catch (e) { resultados.push({ id: c.id, ok: false, erro: e.message }); }
  }
  return ok(res, { total: resultados.length, resultados });
}

async function cronSemanal(res) {
  const sb = getSupabase();
  const { data: clientes } = await sb.from('lipy_clientes').select('id').eq('status', 'ativo');
  const resultados = [];
  for (const c of (clientes || [])) {
    try { resultados.push({ id: c.id, ...(await gerarRelatorio(c.id, 'semanal')) }); }
    catch (e) { resultados.push({ id: c.id, ok: false, erro: e.message }); }
  }
  return ok(res, { total: resultados.length });
}
