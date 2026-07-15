// api/blueclean-test.js — endpoint ISOLADO de teste do motor BlueClean.
// NÃO toca no BlueClean de produção. Guardado por admin_secret.
// Usa o REPLICATE_API_TOKEN que já existe no Vercel (sem expor token).
//
// POST ?action=run&admin_secret=X  body: { model, version?, input }
//   input pode conter data: URIs (Replicate aceita) — sem upload separado.
//   → cria prediction, retorna { id }
// GET  ?action=status&id=X&admin_secret=X → { status, output, error, logs }
module.exports = async function handler(req, res) {
  const ADMIN = process.env.ADMIN_SECRET;
  const REPLICATE = process.env.REPLICATE_API_TOKEN;
  const secret = req.query.admin_secret || req.body?.admin_secret;
  if (!ADMIN || secret !== ADMIN) return res.status(401).json({ error: 'unauthorized' });
  if (!REPLICATE) return res.status(500).json({ error: 'REPLICATE_API_TOKEN ausente' });
  const H = { Authorization: 'Token ' + REPLICATE, 'Content-Type': 'application/json' };
  const action = req.query.action || req.body?.action;

  try {
    if (action === 'run') {
      const { model, version, input } = req.body || {};
      if (!input) return res.status(400).json({ error: 'input obrigatório' });
      let ver = version;
      // Resolve última versão a partir do nome do modelo se version não vier
      if (!ver && model) {
        const vr = await fetch(`https://api.replicate.com/v1/models/${model}/versions`, { headers: H });
        if (vr.ok) ver = (await vr.json()).results?.[0]?.id;
      }
      if (!ver) return res.status(400).json({ error: 'não resolvi a version do modelo', model });
      const rr = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST', headers: H,
        body: JSON.stringify({ version: ver, input }),
      });
      const pred = await rr.json();
      if (!rr.ok) return res.status(rr.status).json({ error: pred.detail || 'replicate erro', pred });
      return res.status(200).json({ id: pred.id, status: pred.status });
    }

    if (action === 'status') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id obrigatório' });
      const rr = await fetch(`https://api.replicate.com/v1/predictions/${id}`, { headers: H });
      const p = await rr.json();
      return res.status(200).json({
        status: p.status, output: p.output, error: p.error,
        metrics: p.metrics, logs: (p.logs || '').slice(-500),
      });
    }

    return res.status(400).json({ error: 'action inválida (run|status)' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
