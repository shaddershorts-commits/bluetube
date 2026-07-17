// api/blublu-index.js — indexador de embeddings dos títulos do virais_banco.
// Camada SEMÂNTICA do Blublu Chat: sem ela a busca funciona (termos exatos);
// com ela o Blublu acha vídeo cujo título não cita o termo mas o assunto bate.
//
// Cron: GitHub Actions (hourly, catch-up nativo — processa lote por execução
// até zerar o backlog, depois só mantém os novos). Guard: se OPENAI_API_KEY
// não existir, sai limpo sem erro (camada opcional).
//
// GET ?secret=ADMIN_SECRET&batch=300

module.exports = async function handler(req, res) {
  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const OPENAI = process.env.OPENAI_API_KEY || '';
  if (!SU || !SK) return res.status(500).json({ error: 'config' });
  if ((req.query.secret || '') !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'unauthorized' });
  if (!OPENAI) return res.status(200).json({ ok: true, skipped: 'sem OPENAI_API_KEY — camada semântica desativada' });

  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const batch = Math.max(50, Math.min(500, parseInt(req.query.batch) || 300));

  try {
    // vídeos do banco ainda sem embedding (mais views primeiro = valor primeiro)
    const idsR = await fetch(`${SU}/rest/v1/virais_embeddings?select=youtube_id&limit=100000`, { headers: H });
    const done = new Set(idsR.ok ? (await idsR.json()).map((r) => r.youtube_id) : []);
    const bR = await fetch(`${SU}/rest/v1/virais_banco?select=youtube_id,titulo,canal_nome,nicho&order=views.desc&limit=${batch + done.size}`, { headers: H });
    if (!bR.ok) return res.status(502).json({ error: 'banco: ' + bR.status });
    const pend = (await bR.json()).filter((v) => !done.has(v.youtube_id) && v.titulo).slice(0, batch);
    if (!pend.length) return res.status(200).json({ ok: true, indexados: 0, backlog_zerado: true });

    // OpenAI aceita array de inputs — 1 chamada por lote de 100
    let indexados = 0;
    for (let i = 0; i < pend.length; i += 100) {
      const lote = pend.slice(i, i + 100);
      const er = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST', headers: { Authorization: 'Bearer ' + OPENAI, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: lote.map((v) => `${v.titulo} | ${v.canal_nome || ''} | ${v.nicho || ''}`.slice(0, 500)) }),
      });
      const ed = await er.json();
      if (!er.ok || !ed.data) { console.error('[blublu-index] openai:', JSON.stringify(ed).slice(0, 150)); break; }
      const rows = lote.map((v, j) => ({ youtube_id: v.youtube_id, titulo: v.titulo, embedding: ed.data[j].embedding }));
      const ir = await fetch(`${SU}/rest/v1/virais_embeddings`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
      if (ir.ok || ir.status === 201) indexados += rows.length;
      else console.error('[blublu-index] upsert:', ir.status, (await ir.text()).slice(0, 120));
    }
    return res.status(200).json({ ok: true, indexados, restam_estimado: Math.max(0, pend.length - indexados) });
  } catch (e) {
    console.error('[blublu-index]', e.message);
    return res.status(500).json({ error: e.message.slice(0, 150) });
  }
};
