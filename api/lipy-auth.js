// Lipy Auth — JWT HS256 stateless (CommonJS)
// IMPORTANTE: bluetube/api/auth.js é ESM e NÃO deve ser modificado.
// Este lipy-auth.js é um arquivo separado em CommonJS, como os demais api/lipy-*.js.
const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { ok, fail, readJson, cors } = require('./_lipy/http');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJwt(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = b64url(createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

function verifyJwt(token, secret) {
  try {
    const [h, p, s] = token.split('.');
    const expected = b64url(createHmac('sha256', secret).update(`${h}.${p}`).digest());
    const a = Buffer.from(s);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const secret = process.env.LIPY_JWT_SECRET || process.env.JWT_SECRET || 'lipy-dev-secret-change-me';

  try {
    if (req.method === 'POST') {
      const { email, nome, tipo = 'cliente' } = await readJson(req);
      if (!email) return fail(res, 400, 'email obrigatório');
      const token = signJwt({
        email, nome, tipo, scope: 'lipy',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
        jti: randomBytes(8).toString('hex')
      }, secret);
      return ok(res, { token });
    }

    if (req.method === 'GET') {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) return fail(res, 401, 'sem token');
      const payload = verifyJwt(token, secret);
      if (!payload) return fail(res, 401, 'token inválido');
      return ok(res, { user: payload });
    }

    return fail(res, 405, 'método não suportado');
  } catch (err) {
    return fail(res, 500, err.message);
  }
};

module.exports.verifyJwt = verifyJwt;
module.exports.signJwt = signJwt;
