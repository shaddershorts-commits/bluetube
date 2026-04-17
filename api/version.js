// api/version.js — Retorna o SHA do commit atualmente deployado.
// Consumido pelo blue.html (polling a cada 2min): se o SHA mudou desde a
// carga da pagina, mostra toast "Nova versao disponivel" e auto-reloada.
// Resposta no-cache pra sempre refletir o deploy atual.

module.exports = function handler(req, res) {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || 'dev';
  const deployedAt = process.env.VERCEL_DEPLOYMENT_CREATED || new Date().toISOString();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    version: sha,
    short: sha.slice(0, 7),
    deployed_at: deployedAt,
  });
};
