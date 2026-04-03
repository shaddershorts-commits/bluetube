// api/blue-mutation.js — Motor de Mutação BlueHorizon
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.ANTHROPIC_API_KEY;
  if (!SU || !SK || !AK) return res.status(500).json({ error: 'Config missing' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  // Autentica o usuário
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token necessário' });

  const authR = await fetch(`${SU}/auth/v1/user`, {
    headers: { Authorization: 'Bearer ' + token, apikey: process.env.SUPABASE_ANON_KEY }
  });
  const user = await authR.json();
  if (!user?.id) return res.status(401).json({ error: 'Sessão inválida' });

  try {

    // ── POST: Criar novo job e gerar variações ──────────────
    if (req.method === 'POST' && req.body?.action === 'create_job') {
      const { transcript, product_name, product_checkout_url, brand_voice, variations_count } = req.body;
      if (!transcript || !product_name) return res.status(400).json({ error: 'Transcrição e produto são obrigatórios' });

      const count = Math.min(parseInt(variations_count) || 5, 10);

      // 1. Salva o DNA do conteúdo
      const dnaR = await fetch(`${SU}/rest/v1/blue_content_dna`, {
        method: 'POST',
        headers: { ...h, Prefer: 'return=representation' },
        body: JSON.stringify({
          creator_id: user.id,
          title: product_name,
          product_name,
          product_checkout_url: product_checkout_url || '',
          transcript,
          brand_voice: brand_voice || 'profissional e empático'
        })
      });
      if (!dnaR.ok) {
        const err = await dnaR.text();
        console.error('dna insert error:', err);
        return res.status(500).json({ error: 'Erro ao salvar conteúdo. As tabelas foram criadas no Supabase?', detail: err.slice(0, 200) });
      }
      const dnaArr = await dnaR.json();
      const dna = Array.isArray(dnaArr) ? dnaArr[0] : dnaArr;

      // 2. Cria o job
      const jobR = await fetch(`${SU}/rest/v1/blue_mutation_jobs`, {
        method: 'POST',
        headers: { ...h, Prefer: 'return=representation' },
        body: JSON.stringify({
          content_dna_id: dna.id,
          creator_id: user.id,
          variations_requested: count,
          variations_completed: 0,
          status: 'processing'
        })
      });
      if (!jobR.ok) {
        const err = await jobR.text();
        return res.status(500).json({ error: 'Erro ao criar job', detail: err.slice(0, 200) });
      }
      const jobArr = await jobR.json();
      const job = Array.isArray(jobArr) ? jobArr[0] : jobArr;

      // 3. Gera os hooks com Claude
      const hooks = await generateHooks(transcript, product_name, brand_voice, count, AK);

      if (hooks.length === 0) {
        return res.status(500).json({ error: 'Claude não retornou variações. Tente novamente.' });
      }

      // 4. Salva as variações
      const styles = ['white_bold', 'yellow_bold', 'cyan_clean', 'outline', 'white_clean'];
      const variationsToInsert = hooks.map((hook, i) => ({
        job_id: job.id,
        variation_index: i + 1,
        hook_text: hook.hook_text || '',
        hook_type: hook.hook_type || 'emotional',
        cta_text: hook.cta_text || '',
        caption_style: styles[i % styles.length]
      }));

      const varR = await fetch(`${SU}/rest/v1/blue_variations`, {
        method: 'POST',
        headers: { ...h, Prefer: 'return=representation' },
        body: JSON.stringify(variationsToInsert)
      });
      if (!varR.ok) {
        const err = await varR.text();
        return res.status(500).json({ error: 'Erro ao salvar variações', detail: err.slice(0, 200) });
      }

      // 5. Atualiza o job como completo
      await fetch(`${SU}/rest/v1/blue_mutation_jobs?id=eq.${job.id}`, {
        method: 'PATCH',
        headers: h,
        body: JSON.stringify({
          variations_completed: hooks.length,
          progress_pct: 100,
          status: 'completed',
          completed_at: new Date().toISOString()
        })
      });

      return res.status(200).json({
        success: true,
        job_id: job.id,
        dna_id: dna.id,
        variations_generated: hooks.length,
        variations: variationsToInsert
      });
    }

    // ── GET: Busca variações de um job ──────────────────────
    if (req.method === 'GET' && req.query.job_id) {
      const varR = await fetch(
        `${SU}/rest/v1/blue_variations?job_id=eq.${req.query.job_id}&order=variation_index.asc&select=*`,
        { headers: h }
      );
      const variations = await varR.json();

      const jobR = await fetch(
        `${SU}/rest/v1/blue_mutation_jobs?id=eq.${req.query.job_id}&limit=1&select=*`,
        { headers: h }
      );
      const jobs = await jobR.json();
      const job = Array.isArray(jobs) ? jobs[0] : jobs;

      return res.status(200).json({ job, variations: variations || [] });
    }

    // ── GET: Lista jobs do usuário ──────────────────────────
    if (req.method === 'GET' && req.query.action === 'my_jobs') {
      const jobsR = await fetch(
        `${SU}/rest/v1/blue_mutation_jobs?creator_id=eq.${user.id}&order=created_at.desc&limit=20&select=*,blue_content_dna(product_name)`,
        { headers: h }
      );
      const jobs = await jobsR.json();
      return res.status(200).json({ jobs: jobs || [] });
    }

    // ── POST: Marcar variação como vencedora ────────────────
    if (req.method === 'POST' && req.body?.action === 'mark_winner') {
      const { variation_id, job_id } = req.body;
      if (!variation_id || !job_id) return res.status(400).json({ error: 'variation_id e job_id obrigatórios' });

      // Remove winner anterior
      await fetch(`${SU}/rest/v1/blue_variations?job_id=eq.${job_id}`, {
        method: 'PATCH',
        headers: h,
        body: JSON.stringify({ is_winner: false })
      });

      // Marca o novo vencedor
      await fetch(`${SU}/rest/v1/blue_variations?id=eq.${variation_id}`, {
        method: 'PATCH',
        headers: h,
        body: JSON.stringify({ is_winner: true })
      });

      return res.status(200).json({ success: true, message: 'Vencedor marcado!' });
    }

    return res.status(400).json({ error: 'Ação não reconhecida' });

  } catch (err) {
    console.error('blue-mutation fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Geração de hooks com Claude ─────────────────────────────
async function generateHooks(transcript, productName, brandVoice, count, apiKey) {
  const prompt = `Você é especialista em copywriting para vídeos virais de social commerce brasileiro.

ROTEIRO: "${transcript.slice(0, 600)}"
PRODUTO: ${productName}
TOM DA MARCA: ${brandVoice || 'profissional e empático'}

Gere exatamente ${count} variações de gancho para os primeiros 3 segundos do vídeo.

Responda APENAS com JSON válido, sem markdown, sem explicação, só o array:
[
  {
    "hook_text": "gancho de até 12 palavras",
    "hook_type": "emotional",
    "cta_text": "chamada para ação de até 8 palavras"
  }
]

hook_type deve ser um de: emotional, question, shock, social_proof, informative
Cada hook deve ter abordagem psicológica diferente.
Português brasileiro natural. Tom: ${brandVoice || 'profissional e empático'}.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await r.json();
    if (!data?.content?.[0]?.text) {
      console.error('Claude sem resposta:', JSON.stringify(data));
      return [];
    }

    const text = data.content[0].text.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed : [];

  } catch (err) {
    console.error('Erro generateHooks:', err.message);
    return [];
  }
}
