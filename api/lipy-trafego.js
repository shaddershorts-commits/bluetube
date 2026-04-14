// Lipy — Agente Tráfego (Meta Ads)
const { getSupabase } = require('./_lipy/supabase');
const { askClaude } = require('./_lipy/claude');
const { ok, fail, readJson, cors } = require('./_lipy/http');

const SYSTEM_PROMPT = `Você é o Agente de Tráfego Pago da Lipy. Cria estratégias de Meta Ads e Google Ads.
Retorne JSON:
{
  "nome_campanha": "...",
  "objetivo": "CONVERSIONS|LEAD_GENERATION|REACH|TRAFFIC|MESSAGES",
  "publico": { "idade_min": 18, "idade_max": 65, "interesses": [...], "localizacoes": [...] },
  "criativo": { "headline": "...", "texto": "...", "cta": "..." },
  "orcamento_diario": 50,
  "duracao_dias": 30,
  "justificativa": "..."
}`;

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const action = req.query?.action;
    if (action === 'otimizar') return cronOtimizar(res);

    const body = await readJson(req);
    const { cliente_id, brief } = body;
    if (!cliente_id) return fail(res, 400, 'cliente_id obrigatório');

    const sb = getSupabase();
    const { data: cliente } = await sb.from('lipy_clientes').select('*').eq('id', cliente_id).maybeSingle();

    const estrategia = await askClaude({
      system: SYSTEM_PROMPT,
      json: true,
      max_tokens: 1500,
      messages: [{ role: 'user', content: `Cliente: ${JSON.stringify(cliente)}\nBrief: ${JSON.stringify(brief)}` }]
    });

    const meta_campaign_id = await criarCampanhaMeta(estrategia, cliente);

    const { data: campanha } = await sb.from('lipy_campanhas_trafego').insert({
      cliente_id,
      plataforma: 'meta_ads',
      nome: estrategia.nome_campanha,
      objetivo: estrategia.objetivo,
      orcamento_diario: estrategia.orcamento_diario,
      orcamento_total: (estrategia.orcamento_diario || 0) * (estrategia.duracao_dias || 30),
      status: 'rascunho',
      meta_campaign_id
    }).select().single();

    return ok(res, { estrategia, campanha });
  } catch (err) {
    console.error('[lipy-trafego]', err);
    return fail(res, 500, err.message);
  }
};

async function criarCampanhaMeta(estrategia, cliente) {
  const token = cliente?.meta_access_token || process.env.META_ACCESS_TOKEN;
  const ad_account = process.env.META_AD_ACCOUNT_ID;
  if (!token || !ad_account) return `mock_camp_${Date.now()}`;

  try {
    const r = await fetch(`https://graph.facebook.com/v18.0/act_${ad_account}/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: estrategia.nome_campanha,
        objective: estrategia.objetivo,
        status: 'PAUSED',
        special_ad_categories: [],
        access_token: token
      })
    });
    const j = await r.json();
    return j.id || null;
  } catch (e) {
    console.error('[lipy/meta-ads]', e);
    return null;
  }
}

async function cronOtimizar(res) {
  const sb = getSupabase();
  const { data: ativas } = await sb.from('lipy_campanhas_trafego').select('*').eq('status', 'ativa');
  return ok(res, { verificadas: ativas?.length || 0 });
}
