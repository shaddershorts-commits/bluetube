// Lipy — Agente Postagem (publica e interage nas redes)
const { getSupabase } = require('./_lipy/supabase');
const { askClaude } = require('./_lipy/claude');
const { ok, fail, readJson, cors } = require('./_lipy/http');
const { publicarInstagram, publicarFacebook, responderComentario } = require('./lipy-meta');
const { enviarWhatsApp } = require('./lipy-whatsapp');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const action = req.query?.action;
    if (action === 'verificar-agendados') return verificarAgendados(res);
    if (action === 'responder-comentario') return responderComentarioHandler(req, res);

    const body = await readJson(req);
    const { conteudo_id, agendar_para } = body;
    if (!conteudo_id) return fail(res, 400, 'conteudo_id obrigatório');

    const sb = getSupabase();
    if (agendar_para) {
      await sb.from('lipy_conteudos').update({ status: 'agendado', agendado_para: agendar_para }).eq('id', conteudo_id);
      return ok(res, { agendado: true });
    }

    const result = await publicarAgora(conteudo_id);
    return ok(res, result);
  } catch (err) {
    console.error('[lipy-postagem]', err);
    return fail(res, 500, err.message);
  }
};

async function publicarAgora(conteudo_id) {
  const sb = getSupabase();
  const { data: conteudo } = await sb.from('lipy_conteudos').select('*').eq('id', conteudo_id).maybeSingle();
  if (!conteudo) return { ok: false, motivo: 'conteudo não encontrado' };
  const { data: cliente } = await sb.from('lipy_clientes').select('*').eq('id', conteudo.cliente_id).maybeSingle();

  let meta_post_id = null;
  const full = `${conteudo.legenda || ''}\n\n${(conteudo.hashtags || []).join(' ')}`.trim();

  if (conteudo.plataforma === 'instagram') {
    meta_post_id = await publicarInstagram({
      instagram_id: cliente?.meta_instagram_id,
      access_token: cliente?.meta_access_token,
      image_url: conteudo.imagem_url,
      caption: full
    });
  } else if (conteudo.plataforma === 'facebook') {
    meta_post_id = await publicarFacebook({
      page_id: cliente?.meta_page_id,
      access_token: cliente?.meta_access_token,
      message: full,
      image_url: conteudo.imagem_url
    });
  }

  await sb.from('lipy_conteudos').update({
    status: 'publicado',
    publicado_em: new Date().toISOString(),
    meta_post_id
  }).eq('id', conteudo_id);

  if (cliente?.whatsapp_group_id) {
    await enviarWhatsApp(cliente.whatsapp_group_id, `✅ Post publicado com sucesso!\n\n*${conteudo.titulo}*\nPlataforma: ${conteudo.plataforma}\nID: ${meta_post_id || 'n/d'}`);
  }

  return { ok: true, meta_post_id };
}

async function verificarAgendados(res) {
  const sb = getSupabase();
  const agora = new Date().toISOString();
  const { data: pendentes } = await sb.from('lipy_conteudos')
    .select('*')
    .eq('status', 'agendado')
    .lte('agendado_para', agora);

  const resultados = [];
  for (const c of (pendentes || [])) {
    try {
      resultados.push({ id: c.id, ...(await publicarAgora(c.id)) });
    } catch (err) {
      resultados.push({ id: c.id, ok: false, erro: err.message });
    }
  }
  return ok(res, { total: resultados.length, resultados });
}

async function responderComentarioHandler(req, res) {
  const body = await readJson(req);
  const { comment_id, comment_text, post_id, access_token, marca } = body;
  const resposta = await askClaude({
    system: 'Você responde comentários nas redes sociais em nome da marca. Tom conforme briefing. Máximo 2 frases.',
    max_tokens: 200,
    messages: [{ role: 'user', content: `Marca: ${marca}\nPost: ${post_id}\nComentário: ${comment_text}\n\nResponda adequadamente.` }]
  });
  await responderComentario({ comment_id, access_token, message: resposta });
  return ok(res, { resposta });
}
