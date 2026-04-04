// api/monitor.js — Auto-fix agent: Vercel Log Drain → Claude API → GitHub commit
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
  const GITHUB_REPO   = process.env.GITHUB_REPO;

  if (!ANTHROPIC_KEY || !GITHUB_TOKEN || !GITHUB_REPO)
    return res.status(500).json({ error: 'Config missing: ANTHROPIC_API_KEY, GITHUB_TOKEN, GITHUB_REPO' });

  let body = '';
  try {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  } catch(e) { return res.status(200).end(); }

  const lines = body.split('\n').filter(Boolean);
  const errorLogs = [];
  for (const line of lines) {
    try {
      const log = JSON.parse(line);
      if (
        log.level === 'error' ||
        (log.message && /error|exception|TypeError|ReferenceError|SyntaxError|500|undefined/i.test(log.message))
      ) {
        errorLogs.push(log);
      }
    } catch(e) {}
  }

  if (!errorLogs.length) return res.status(200).json({ ok: true, message: 'No errors to fix' });

  const errorMsg = errorLogs.map(l => l.message || '').join('\n').slice(0, 3000);
  const affectedPath = detectAffectedFile(errorMsg);
  console.log('[monitor] Errors detected:', errorLogs.length, '| File:', affectedPath);

  let currentContent = '', fileSha = '';
  if (affectedPath) {
    try {
      const ghRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${affectedPath}`, {
        headers: { Authorization: 'Bearer ' + GITHUB_TOKEN, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'BlueTube-Monitor' }
      });
      if (ghRes.ok) {
        const ghData = await ghRes.json();
        fileSha = ghData.sha || '';
        currentContent = Buffer.from(ghData.content || '', 'base64').toString('utf-8');
      }
    } catch(e) { console.error('[monitor] GitHub read error:', e.message); }
  }

  let repoFiles = '';
  try {
    const apiRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/trees/HEAD?recursive=1`, {
      headers: { Authorization: 'Bearer ' + GITHUB_TOKEN, 'User-Agent': 'BlueTube-Monitor' }
    });
    if (apiRes.ok) {
      const tree = await apiRes.json();
      repoFiles = (tree.tree || []).filter(f => f.type === 'blob').map(f => f.path).join('\n').slice(0, 1000);
    }
  } catch(e) {}

  const prompt = `Você é um engenheiro sênior do projeto BlueTube (SaaS de roteiros para YouTube Shorts).

ERRO DETECTADO NO SITE (Vercel logs):
\`\`\`
${errorMsg}
\`\`\`

${affectedPath ? `ARQUIVO AFETADO: ${affectedPath}\n\nCONTEÚDO ATUAL:\n\`\`\`\n${currentContent.slice(0, 8000)}\n\`\`\`\n` : ''}
ARQUIVOS DO REPO:
${repoFiles}

CONTEXTO: Stack Vercel (public/ estático + api/ serverless) + Supabase + OpenAI/Gemini. APIs usam CommonJS exceto auth.js (ESM).

Responda APENAS JSON:
{
  "action": "fix" | "no_fix_needed" | "needs_human",
  "file_path": "caminho/arquivo.js",
  "reason": "causa raiz",
  "fix_description": "o que foi corrigido",
  "fixed_content": "conteúdo completo corrigido"
}`;

  let aiResponse = null;
  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] })
    });
    const aiData = await aiRes.json();
    const rawText = aiData.content?.[0]?.text || '';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) aiResponse = JSON.parse(jsonMatch[0]);
  } catch(e) {
    return res.status(200).json({ ok: false, error: 'Claude API failed: ' + e.message });
  }

  if (!aiResponse || aiResponse.action !== 'fix')
    return res.status(200).json({ ok: true, action: aiResponse?.action, reason: aiResponse?.reason });

  const { file_path, fix_description, fixed_content } = aiResponse;
  if (!file_path || !fixed_content)
    return res.status(200).json({ ok: false, error: 'Incomplete fix from Claude' });

  try {
    let sha = fileSha;
    if (!sha && file_path !== affectedPath) {
      try {
        const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${file_path}`, {
          headers: { Authorization: 'Bearer ' + GITHUB_TOKEN, 'User-Agent': 'BlueTube-Monitor' }
        });
        if (r.ok) { const d = await r.json(); sha = d.sha; }
      } catch(e) {}
    }

    const commitBody = {
      message: `🤖 auto-fix: ${fix_description.slice(0, 72)}\n\nBug: ${errorMsg.slice(0, 200)}\nFile: ${file_path}`,
      content: Buffer.from(fixed_content).toString('base64'),
      branch: 'main'
    };
    if (sha) commitBody.sha = sha;

    const commitRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${file_path}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + GITHUB_TOKEN, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'User-Agent': 'BlueTube-Monitor' },
      body: JSON.stringify(commitBody)
    });

    if (!commitRes.ok) {
      const err = await commitRes.text();
      return res.status(200).json({ ok: false, error: 'GitHub commit failed: ' + err.slice(0, 200) });
    }

    const commitData = await commitRes.json();
    console.log('[monitor] ✅ Fix committed:', commitData.commit?.html_url);
    return res.status(200).json({ ok: true, action: 'fix_committed', file: file_path, commit_url: commitData.commit?.html_url });
  } catch(e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};

function detectAffectedFile(errorMsg) {
  const patterns = [
    /at\s+\S+\s+\(([^)]+\.(?:js|html|ts)):\d+:\d+\)/,
    /([a-zA-Z0-9_\-/]+\.(?:js|html|ts)):\d+/,
    /\/api\/(\w+[\w\-]*)/,
    /(public\/[\w\-]+\.html)/,
    /(api\/[\w\-]+\.js)/,
  ];
  for (const p of patterns) {
    const m = errorMsg.match(p);
    if (m) {
      let path = m[1];
      if (path.includes('/api/')) path = 'api/' + path.split('/api/')[1].split('/')[0] + '.js';
      if (!path.includes('/')) path = 'api/' + path;
      if (!path.endsWith('.js') && !path.endsWith('.html')) return null;
      return path;
    }
  }
  return null;
}
