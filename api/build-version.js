// api/build-version.js — id do build atual (2026-07-28)
// =============================================================================
// Usado pelo aviso "Nova versão disponível" do toolbar.js: a aba aberta compara
// este valor com o que carregou. Mudou = saiu deploy = oferece recarregar.
// Sem estado, sem banco — a própria Vercel já expõe o id do deploy.

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const build =
    process.env.VERCEL_DEPLOYMENT_ID ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.VERCEL_URL ||
    'dev';
  return res.status(200).json({ build });
};
