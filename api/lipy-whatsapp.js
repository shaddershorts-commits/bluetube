// Lipy WhatsApp — helper + endpoint de envio manual
// (webhook do Evolution API está em lipy-webhook-whatsapp.js)
const { ok, fail, readJson, cors } = require('./_lipy/http');

async function enviarWhatsApp(destino, mensagem) {
  const url = process.env.EVOLUTION_API_URL;
  const key = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE || 'lipy';
  if (!url || !key || !destino) {
    console.log('[lipy/wa-mock]', destino, String(mensagem).slice(0, 80));
    return { mock: true };
  }
  try {
    const r = await fetch(`${url}/message/sendText/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': key },
      body: JSON.stringify({ number: destino, text: mensagem })
    });
    return await r.json();
  } catch (e) {
    console.error('[lipy/wa]', e);
    return { erro: e.message };
  }
}

async function criarGrupoWhatsApp({ subject, participants }) {
  const url = process.env.EVOLUTION_API_URL;
  const key = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE || 'lipy';
  if (!url || !key) return `mock_group_${Date.now()}`;
  try {
    const r = await fetch(`${url}/group/create/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': key },
      body: JSON.stringify({ subject, participants })
    });
    const j = await r.json();
    return j?.groupJid || j?.id || null;
  } catch (e) {
    console.error('[lipy/wa-grupo]', e);
    return null;
  }
}

// Endpoint: POST /api/lipy-whatsapp { destino, mensagem } — envio manual
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return ok(res, { service: 'lipy-whatsapp' });
  try {
    const { destino, mensagem } = await readJson(req);
    if (!destino || !mensagem) return fail(res, 400, 'destino e mensagem obrigatórios');
    const r = await enviarWhatsApp(destino, mensagem);
    return ok(res, { resultado: r });
  } catch (err) {
    return fail(res, 500, err.message);
  }
};

module.exports.enviarWhatsApp = enviarWhatsApp;
module.exports.criarGrupoWhatsApp = criarGrupoWhatsApp;
