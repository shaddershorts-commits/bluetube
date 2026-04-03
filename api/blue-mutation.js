// api/blue-mutation.js
// BlueHorizon — Motor de Mutação de Hooks
// Gera N variações de gancho para um vídeo/roteiro

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Roda em lotes para não estourar o timeout do Vercel
const BATCH_SIZE = 5;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Autentica o usuário (igual aos outros endpoints)
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token necessário' });

  const { data: { user }, error: authError } = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/user`,
    { headers: { Authorization: `Bearer ${token}`, apikey: process.env.SUPABASE_ANON_KEY } }
  ).then(r => r.json()).then(d => ({ data: { user: d }, error: null })).catch(e => ({ data: { user: null }, error: e }));

  if (!user?.id) return res.status(401).json({ error: 'Sessão inválida' });

  // ── POST: Criar novo job de mutação ──────────────────────
  if (req.method === 'POST' && req.body?.action === 'create_job') {
    const { transcript, product_name, product_checkout_url, brand_voice, variations_count = 10 } = req.body;

    if (!transcript || !product_name) {
      return res.status(400).json({ error: 'Transcrição e nome do produto são obrigatórios' });
    }

    // 1. Salva o DNA do conteúdo
    const { data: dna, error: dnaError } = await supabase
      .from('blue_content_dna')
      .insert({
        creator_id: user.id,
        title: product_name,
        product_name,
        product_checkout_url,
        transcript,
        brand_voice: brand_voice || 'profissional e empático'
      })
      .select().single();

    if (dnaError) return res.status(500).json({ error: 'Erro ao salvar conteúdo', detail: dnaError.message });

    // 2. Cria o job
    const { data: job, error: jobError } = await supabase
      .from('blue_mutation_jobs')
      .insert({
        content_dna_id: dna.id,
        creator_id: user.id,
        variations_requested: Math.min(variations_count, 20), // máximo 20 na fase 1
        status: 'processing'
      })
      .select().single();

    if (jobError) return res.status(500).json({ error: 'Erro ao criar job', detail: jobError.message });

    // 3. Gera o primeiro lote de variações (dentro do timeout do Vercel)
    const hooks = await generateHooks(transcript, product_name, brand_voice, BATCH_SIZE);
    
    if (hooks.length > 0) {
      const variationsToInsert = hooks.map((hook, i) => ({
        job_id: job.id,
        variation_index: i + 1,
        hook_text: hook.hook_text,
        hook_type: hook.hook_type,
        cta_text: hook.cta_text,
        caption_style: ['white_bold', 'yellow_bold', 'cyan_clean', 'outline', 'white_clean'][i % 5],
      }));

      await supabase.from('blue_variations').insert(variationsToInsert);
      
      await supabase.from('blue_mutation_jobs').update({
        variations_completed: hooks.length,
        progress_pct: (hooks.length / job.variations_requested) * 100,
        status: hooks.length >= job.variations_requested ? 'completed' : 'processing'
      }).eq('id', job.id);
    }

    return res.status(200).json({
      success: true,
      job_id: job.id,
      dna_id: dna.id,
      variations_generated: hooks.length,
      message: `${hooks.length} variações geradas! Peça mais clicando em "Gerar mais".`
    });
  }

  // ── POST: Gerar mais variações para um job existente ─────
  if (req.method === 'POST' && req.body?.action === 'generate_more') {
    const { job_id } = req.body;

    const { data: job } = await supabase
      .from('blue_mutation_jobs')
      .select('*, blue_content_dna(*)')
      .eq('id', job_id)
      .eq('creator_id', user.id)
      .single();

    if (!job) return res.status(404).json({ error: 'Job não encontrado' });

    const { data: existing } = await supabase
      .from('blue_variations')
      .select('variation_index')
      .eq('job_id', job_id)
      .order('variation_index', { ascending: false })
      .limit(1);

    const nextIndex = (existing?.[0]?.variation_index || 0) + 1;
    const remaining = job.variations_requested - job.variations_completed;

    if (remaining <= 0) return res.status(200).json({ message: 'Todas as variações já foram geradas!' });

    const hooks = await generateHooks(
      job.blue_content_dna.transcript,
      job.blue_content_dna.product_name,
      job.blue_content_dna.brand_voice,
      Math.min(BATCH_SIZE, remaining)
    );

    if (hooks.length > 0) {
      await supabase.from('blue_variations').insert(
        hooks.map((hook, i) => ({
          job_id,
          variation_index: nextIndex + i,
          hook_text: hook.hook_text,
          hook_type: hook.hook_type,
          cta_text: hook.cta_text,
          caption_style: ['white_bold', 'yellow_bold', 'cyan_clean', 'outline', 'white_clean'][(nextIndex + i) % 5],
        }))
      );

      const newCompleted = job.variations_completed + hooks.length;
      await supabase.from('blue_mutation_jobs').update({
        variations_completed: newCompleted,
        progress_pct: (newCompleted / job.variations_requested) * 100,
        status: newCompleted >= job.variations_requested ? 'completed' : 'processing'
      }).eq('id', job_id);
    }

    return res.status(200).json({ success: true, new_variations: hooks.length });
  }

  // ── GET: Busca variações de um job ───────────────────────
  if (req.method === 'GET' && req.query.job_id) {
    const { data: variations } = await supabase
      .from('blue_variations')
      .select('*')
      .eq('job_id', req.query.job_id)
      .order('variation_index');

    const { data: job } = await supabase
      .from('blue_mutation_jobs')
      .select('*')
      .eq('id', req.query.job_id)
      .single();

    return res.status(200).json({ job, variations: variations || [] });
  }

  // ── POST: Marcar variação como vencedora ─────────────────
  if (req.method === 'POST' && req.body?.action === 'mark_winner') {
    const { variation_id, job_id } = req.body;

    // Remove winner anterior
    await supabase.from('blue_variations')
      .update({ is_winner: false })
      .eq('job_id', job_id);

    // Marca o novo
    await supabase.from('blue_variations')
      .update({ is_winner: true })
      .eq('id', variation_id);

    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ error: 'Ação não reconhecida' });
};

// ─── Geração de hooks com Claude ───────────────────────────
async function generateHooks(transcript, productName, brandVoice, count) {
  const prompt = `Você é especialista em copywriting para vídeos virais de social commerce brasileiro.

ROTEIRO/TRANSCRIÇÃO: "${transcript.slice(0, 800)}"
PRODUTO: ${productName}
TOM DA MARCA: ${brandVoice || 'profissional e empático'}

Gere exatamente ${count} variações de gancho (hook) para os primeiros 3 segundos deste vídeo.

Responda APENAS com JSON válido, array de ${count} objetos:
[
  {
    "hook_text": "gancho impactante de até 12 palavras",
    "hook_type": "emotional|question|shock|social_proof|informative",
    "cta_text": "chamada para ação de até 8 palavras"
  }
]

REGRAS:
- Cada hook deve ter abordagem psicológica completamente diferente
- Deve funcionar falado em voz alta em 3 segundos
- Tom: ${brandVoice || 'profissional e empático'}
- Sem promessas médicas ou financeiras exageradas
- Português brasileiro natural`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '[]';
    
    // Limpa possível markdown antes de parsear
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('Erro gerando hooks:', err);
    return [];
  }
}
