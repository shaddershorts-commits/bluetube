// Lipy — Webhook Meta (comentários, mensagens de páginas)
const { ok, fail, readJson, cors } = require('./_lipy/http');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'GET') {
    const verify_token = process.env.LIPY_META_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN || 'lipy_verify';
    if (req.query?.['hub.verify_token'] === verify_token) {
      return res.status(200).send(req.query['hub.challenge']);
    }
    return res.status(403).send('forbidden');
  }
  try {
    const body = await readJson(req);
    console.log('[lipy-webhook-meta]', JSON.stringify(body).slice(0, 400));
    // TODO: roteamento de eventos (comentário → agente-postagem responder-comentario)
    return ok(res, { received: true });
  } catch (err) {
    return fail(res, 500, err.message);
  }
};
