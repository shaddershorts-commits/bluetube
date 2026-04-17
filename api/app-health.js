// api/app-health.js — agrega Sentry issues + GitHub Actions runs + versão do app
// Consumido pelo dashboard admin.html → loadAppHealth().
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const {
    SENTRY_AUTH_TOKEN,
    SENTRY_ORG = 'bluetube-viral',
    SENTRY_PROJECT = 'react-native',
    GH_TOKEN,
    GH_REPO = 'shaddershorts-commits/bluetube-app',
  } = process.env;

  const out = {
    sentry: { issues_24h: null, users_affected: null, top_issues: [] },
    github: { auto_fixes_7d: null, success_rate: null, last_fix_at: null },
    app: { version: null },
  };

  // SENTRY — issues não resolvidas nas últimas 24h
  if (SENTRY_AUTH_TOKEN) {
    try {
      const r = await fetch(
        `https://sentry.io/api/0/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/issues/?query=is:unresolved&statsPeriod=24h&limit=20`,
        { headers: { Authorization: `Bearer ${SENTRY_AUTH_TOKEN}` } }
      );
      if (r.ok) {
        const issues = await r.json();
        out.sentry.issues_24h = issues.length;
        out.sentry.users_affected = issues.reduce((a, i) => a + (i.userCount || 0), 0);
        out.sentry.top_issues = issues.map((i) => ({
          id: i.id,
          title: i.title,
          level: i.level,
          count: i.count,
          userCount: i.userCount,
          permalink: i.permalink,
        }));
      }
    } catch (e) { console.error('app-health sentry:', e.message); }
  }

  // GITHUB — runs do workflow auto-fix nos últimos 7 dias
  if (GH_TOKEN) {
    try {
      const since = new Date(Date.now() - 7 * 86400000).toISOString();
      const r = await fetch(
        `https://api.github.com/repos/${GH_REPO}/actions/workflows/auto-fix.yml/runs?created=>=${since}&per_page=100`,
        {
          headers: {
            Authorization: `Bearer ${GH_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'bluetube-admin',
          },
        }
      );
      if (r.ok) {
        const d = await r.json();
        const runs = d.workflow_runs || [];
        const completed = runs.filter((x) => x.status === 'completed');
        const successes = completed.filter((x) => x.conclusion === 'success');
        out.github.auto_fixes_7d = runs.length;
        out.github.success_rate = completed.length ? successes.length / completed.length : null;
        const lastSuccess = successes[0];
        if (lastSuccess) out.github.last_fix_at = lastSuccess.updated_at;
      }
    } catch (e) { console.error('app-health github:', e.message); }

    // Versão do app — lê package.json do repo
    try {
      const r = await fetch(
        `https://api.github.com/repos/${GH_REPO}/contents/package.json`,
        {
          headers: {
            Authorization: `Bearer ${GH_TOKEN}`,
            Accept: 'application/vnd.github.raw',
            'User-Agent': 'bluetube-admin',
          },
        }
      );
      if (r.ok) {
        const pkg = await r.json();
        out.app.version = pkg.version || null;
      }
    } catch (e) {}
  }

  return res.status(200).json(out);
};
