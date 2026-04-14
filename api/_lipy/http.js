// Helpers HTTP para handlers serverless (Lipy)

function ok(res, data) {
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify({ ok: true, ...data }));
}

function fail(res, status, msg, extra = {}) {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).send(JSON.stringify({ ok: false, error: msg, ...extra }));
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function baseUrl(req) {
  const envUrl = process.env.APP_URL;
  if (envUrl) return envUrl.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

module.exports = { ok, fail, readJson, cors, baseUrl };
