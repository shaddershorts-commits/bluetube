// Lipy — Webhook Evolution API (mensagens recebidas do WhatsApp)
const { getSupabase } = require('./_lipy/supabase');
const { ok, fail, readJson, cors, baseUrl } = require('./_lipy/http');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') return ok(res, { service: 'lipy-webhook-whatsapp' });

  try {
    const body = await readJson(req);
    const msg = body?.data?.message?.conversation
            || body?.data?.message?.extendedTextMessage?.text
            || body?.message;
    const group_id = body?.data?.key?.remoteJid || body?.group_id;
    const from_me = body?.data?.key?.fromMe;

    if (from_me || !msg || !group_id) return ok(res, { ignored: true });

    const sb = getSupabase();
    const { data: cliente } = await sb.from('lipy_clientes')
      .select('id').eq('whatsapp_group_id', group_id).maybeSingle();

    const url = baseUrl(req);
    fetch(`${url}/api/lipy-atendimento`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cliente_id: cliente?.id, mensagem: msg, group_id })
    }).catch(() => {});

    return ok(res, { encaminhado: true });
  } catch (err) {
    return fail(res, 500, err.message);
  }
};
