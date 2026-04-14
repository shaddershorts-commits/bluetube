// Lipy — Agente Conteúdo (criação de posts, legendas e imagens)
const { getSupabase } = require('./_lipy/supabase');
const { askClaude } = require('./_lipy/claude');
const { ok, fail, readJson, cors } = require('./_lipy/http');
const { enviarWhatsApp } = require('./lipy-whatsapp');

const SYSTEM_PROMPT = `Você é o Agente de Conteúdo da Lipy. Cria posts profissionais para Instagram, Facebook, TikTok.
Sempre inclua: legenda envolvente, CTA claro, hashtags estratégicas (8-15), prompt detalhado para imagem.

Retorne JSON:
{
  "titulo": "...",
  "legenda": "texto completo com quebras de linha",
  "hashtags": ["#tag1", ...],
  "prompt_imagem": "descrição visual detalhada",
  "estilo": "REALISTIC|DESIGN|ILLUSTRATION"
}`;

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET' && req.query?.action === 'verificar-fila') {
      return verificarFila(res);
    }

    const body = await readJson(req);
    const { cliente_id, planejamento_id, tipo = 'post', plataforma = 'instagram', brief = {}, aspect = 'ASPECT_1_1' } = body;
    if (!cliente_id) return fail(res, 400, 'cliente_id obrigatório');

    const sb = getSupabase();
    const { data: cliente } = await sb.from('lipy_clientes').select('*').eq('id', cliente_id).maybeSingle();
    const { data: planej } = planejamento_id
      ? await sb.from('lipy_planejamentos').select('*').eq('id', planejamento_id).maybeSingle()
      : { data: null };

    const gerado = await askClaude({
      system: SYSTEM_PROMPT,
      json: true,
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Cliente: ${JSON.stringify(cliente)}\nPlanejamento: ${JSON.stringify(planej)}\nBrief: ${JSON.stringify(brief)}\nTipo: ${tipo}\nPlataforma: ${plataforma}\n\nCrie o conteúdo.`
      }]
    });

    const imagem_url = await gerarImagem(gerado.prompt_imagem, aspect, gerado.estilo);

    const { data: conteudo } = await sb.from('lipy_conteudos').insert({
      cliente_id, planejamento_id, tipo, plataforma,
      titulo: gerado.titulo, legenda: gerado.legenda,
      hashtags: gerado.hashtags || [], imagem_url,
      status: 'aguardando_aprovacao'
    }).select().single();

    if (cliente?.whatsapp_group_id) {
      const preview = `🎨 *Novo conteúdo pronto para aprovação*\n\n*${gerado.titulo}*\n\n${gerado.legenda}\n\n${(gerado.hashtags || []).join(' ')}\n\n🖼️ ${imagem_url}\n\nResponda:\n✅ Aprovar\n✏️ Ajustar: [seu feedback]\n❌ Refazer`;
      await enviarWhatsApp(cliente.whatsapp_group_id, preview);
    }

    return ok(res, { conteudo, gerado });
  } catch (err) {
    console.error('[lipy-conteudo]', err);
    return fail(res, 500, err.message);
  }
};

async function gerarImagem(prompt, aspect_ratio, style_type) {
  const key = process.env.IDEOGRAM_API_KEY;
  if (!key) {
    return `https://placehold.co/1080x1080/7c3aed/ffffff?text=${encodeURIComponent((prompt || 'Lipy').slice(0, 40))}`;
  }
  try {
    const res = await fetch('https://api.ideogram.ai/generate', {
      method: 'POST',
      headers: { 'Api-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_request: { prompt, aspect_ratio, model: 'V_2', style_type: style_type || 'DESIGN' }
      })
    });
    const data = await res.json();
    return data?.data?.[0]?.url || '';
  } catch (err) {
    console.error('[lipy/ideogram]', err);
    return `https://placehold.co/1080x1080/7c3aed/ffffff?text=Lipy`;
  }
}

async function verificarFila(res) {
  const sb = getSupabase();
  const { data: clientes } = await sb.from('lipy_clientes').select('id, empresa').eq('status', 'ativo');
  return ok(res, { clientes_ativos: clientes?.length || 0 });
}

module.exports.gerarImagem = gerarImagem;
