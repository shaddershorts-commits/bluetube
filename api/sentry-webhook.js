// api/sentry-webhook.js — recebe webhook do Sentry e dispara GitHub Actions
// repository_dispatch no repo do app (bluetube-app) para o pipeline de auto-fix.
// CommonJS (padrão dos endpoints do site, exceto auth.js que é ESM).
const crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Sentry-Hook-Signature, Sentry-Hook-Resource');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const GH_TOKEN = process.env.GH_TOKEN;
  const GH_REPO = process.env.GH_REPO || 'shaddershorts-commits/bluetube-app';
  if (!GH_TOKEN) return res.status(500).json({ error: 'GH_TOKEN não configurado' });

  // Opcional: validar assinatura do Sentry (Settings → Developer Settings → Client Secret)
  const SENTRY_CLIENT_SECRET = process.env.SENTRY_CLIENT_SECRET;
  if (SENTRY_CLIENT_SECRET) {
    const sig = req.headers['sentry-hook-signature'];
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    const expected = crypto.createHmac('sha256', SENTRY_CLIENT_SECRET).update(raw).digest('hex');
    if (sig !== expected) return res.status(401).json({ error: 'assinatura invalida' });
  }

  const payload = req.body || {};

  // Suporta dois formatos: "Internal Integration" (data.issue) e "Alert Rules" (event/issue)
  const issue = payload.data?.issue || payload.issue || null;
  const event = payload.data?.event || payload.event || null;

  if (!issue && !event) {
    console.log('sentry-webhook: payload sem issue/event');
    return res.status(200).json({ ok: true, action: 'no_data' });
  }

  const errorMessage = (issue?.title || event?.title || event?.message || 'Erro desconhecido').toString().slice(0, 500);
  const culprit = issue?.culprit || event?.culprit || '';
  const level = (issue?.level || event?.level || 'error').toString().toLowerCase();
  const count = parseInt(issue?.count || 1, 10);

  // Severidade: fatal → critical, error+count>10 → high, error → medium, resto → low
  let severity = 'low';
  if (level === 'fatal') severity = 'critical';
  else if (level === 'error' && count > 10) severity = 'high';
  else if (level === 'error') severity = 'medium';

  // Tenta extrair file_path do primeiro frame com filename relativo do app (in_app=true).
  // Sentry manda stacktrace no event/issue.entries — formatos variam, cobrimos múltiplos.
  let filePath = null;
  const frames = extractFrames(payload);
  for (const f of frames) {
    const p = (f.filename || f.abs_path || '').toString();
    const m = p.match(/(src\/[^\s:?"']+\.(?:js|jsx|ts|tsx))/);
    if (m && f.in_app !== false) { filePath = m[1]; break; }
  }
  if (!filePath && culprit) {
    const m = culprit.match(/(src\/[^\s:?"']+\.(?:js|jsx|ts|tsx))/);
    if (m) filePath = m[1];
  }

  // Monta stack trace compacto (últimos 10 frames)
  const stackTrace = frames.slice(-10).map((f) => {
    const file = f.filename || f.abs_path || '?';
    const line = f.lineno ? `:${f.lineno}` : '';
    const fn = f.function || 'anon';
    return `  at ${fn} (${file}${line})`;
  }).join('\n') || culprit;

  if (!filePath) {
    console.log('sentry-webhook: file_path não identificado — ignorando');
    return res.status(200).json({ ok: true, action: 'ignored', reason: 'no_file_path' });
  }

  // Dispara repository_dispatch no GitHub
  try {
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GH_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'bluetube-sentry-webhook',
      },
      body: JSON.stringify({
        event_type: 'sentry-alert',
        client_payload: {
          error_message: errorMessage,
          stack_trace: stackTrace,
          file_path: filePath,
          severity,
          sentry_issue_id: issue?.id || event?.event_id || null,
          count,
          sentry_url: issue?.permalink || issue?.url || null,
        },
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      console.error('sentry-webhook: github dispatch falhou', r.status, body);
      return res.status(502).json({ ok: false, gh_status: r.status, gh_body: body.slice(0, 400) });
    }
    console.log(`sentry-webhook: disparou GH Actions → ${filePath} [${severity}]`);
    return res.status(200).json({ ok: true, action: 'triggered', file_path: filePath, severity });
  } catch (e) {
    console.error('sentry-webhook: erro', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// Extrai frames de stacktrace de payloads do Sentry (formatos variam conforme SDK/versão)
function extractFrames(payload) {
  const frames = [];
  const hay = [payload?.data?.event, payload?.event, payload?.data?.issue, payload?.issue].filter(Boolean);
  for (const node of hay) {
    const entries = node.entries || [];
    for (const e of entries) {
      if (e.type === 'exception' && e.data?.values) {
        for (const v of e.data.values) {
          if (v.stacktrace?.frames) frames.push(...v.stacktrace.frames);
        }
      }
    }
    if (node.exception?.values) {
      for (const v of node.exception.values) {
        if (v.stacktrace?.frames) frames.push(...v.stacktrace.frames);
      }
    }
    if (node.stacktrace?.frames) frames.push(...node.stacktrace.frames);
  }
  return frames;
}
