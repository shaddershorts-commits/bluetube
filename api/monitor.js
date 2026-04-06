// api/monitor.js — Auto-fix agent: Vercel Log Drain → Claude API → GitHub commit
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  // GET para teste manual no browser
  if (req.method === 'GET') {
    return res.status(200).json({ 
      ok: true, 
      status: 'BlueTube Monitor online',
      env: {
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        github_token: !!process.env.GITHUB_TOKEN,
        github_repo: process.env.GITHUB_REPO || 'NOT SET'
      }
    });
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
  const GITHUB_REPO   = process.env.GITHUB_REPO;

  // Retorna 200 mesmo sem config (para o teste do Vercel passar)
  if (!ANTHROPIC_KEY || !GITHUB_TOKEN || !GITHUB_REPO) {
    console.warn('[monitor] Missing env vars:', { 
      anthropic: !!ANTHROPIC_KEY, 
      github_token: !!GITHUB_TOKEN, 
      github_repo: !!GITHUB_REPO 
    });
    return res.status(200).json({ 
      ok: false, 
      message: 'Monitor online but missing env vars',
      missing: [
        !ANTHROPIC_KEY && 'ANTHROPIC_API_KEY',
        !GITHUB_TOKEN && 'GITHUB_TOKEN',
        !GITHUB_REPO && 'GITHUB_REPO'
      ].filter(Boolean)
    });
  }

  // Parse Vercel log drain — handles NDJSON, JSON array, or single object
  const errorLogs = [];
  try {
    let entries = [];
    if (Array.isArray(req.body)) {
      // Vercel Log Drain sends JSON array
      entries = req.body;
    } else if (typeof req.body === 'object' && req.body !== null) {
      // Single log object
      entries = [req.body];
    } else if (typeof req.body === 'string') {
      // NDJSON (newline-delimited JSON)
      const lines = req.body.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (Array.isArray(parsed)) entries.push(...parsed);
          else entries.push(parsed);
        } catch(e) {}
      }
    }

    for (const log of entries) {
      if (!log || typeof log !== 'object') continue;
      if (log.level === 'error' || (log.message && /error|exception|TypeError|ReferenceError|SyntaxError|Cannot read prop/i.test(log.message))) {
        errorLogs.push(log);
      }
    }
  } catch(e) {
    return res.status(200).json({ ok: true, message: 'Parse error: ' + e.message });
  }

  if (!errorLogs.length) return res.status(200).json({ ok: true, message: 'No errors to fix', received: Array.isArray(req.body) ? req.body.length : 1 });

  const errorMsg = errorLogs.map(l => l.message || '').join('\n').slice(0, 3000);
  const affectedPath = detectAffectedFile(errorMsg);
  console.log('[monitor] Errors:', errorLogs.length, '| File:', affectedPath);

  let currentContent = '', fileSha = '';
  if (affectedPath) {
    try {
      const ghRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${affectedPath}`, {
        headers: { Authorization: 'Bearer ' + GITHUB_TOKEN, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'BlueTube-Monitor' }
      });
      if (ghRes.ok) { const d = await ghRes.json(); fileSha = d.sha || ''; currentContent = Buffer.from(d.content || '', 'base64').toString('utf-8'); }
    } catch(e) { console.error('[monitor] GitHub read error:', e.message); }
  }

  let repoFiles = '';
  try {
    const apiRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/trees/HEAD?recursive=1`, {
      headers: { Authorization: 'Bearer ' + GITHUB_TOKEN, 'User-Agent': 'BlueTube-Monitor' }
    });
    if (apiRes.ok) { const tree = await apiRes.json(); repoFiles = (tree.tree || []).filter(f => f.type === 'blob').map(f => f.path).join('\n').slice(0, 1000); }
  } catch(e) {}

  const prompt = `Você é um engenheiro sênior do projeto BlueTube (SaaS de roteiros para YouTube Shorts).

ERRO DETECTADO NO SITE:
\`\`\`
${errorMsg}
\`\`\`

${affectedPath ? `ARQUIVO AFETADO: ${affectedPath}\n\nCONTEÚDO ATUAL:\n\`\`\`\n${currentContent.slice(0, 8000)}\n\`\`\`` : ''}

ARQUIVOS DO REPOSITÓRIO:
${repoFiles}

CONTEXTO: Stack Vercel static (public/) + Serverless (api/) + Supabase + OpenAI/Gemini. APIs usam CommonJS (module.exports), EXCETO auth.js que é ESM.

Analise o erro, identifique a causa raiz e gere o arquivo corrigido COMPLETO.

Responda APENAS com JSON:
{"action":"fix"|"no_fix_needed"|"needs_human","file_path":"caminho/arquivo.js","reason":"causa do bug","fix_description":"o que foi corrigido","fixed_content":"conteúdo completo corrigido"}`;

  let aiResponse = null;
  let aiRawText = '';
  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-3-haiku-20240307', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] })
    });
    if (!aiRes.ok) {
      const errBody = await aiRes.text();
      console.error('[monitor] Claude API HTTP error:', aiRes.status, errBody.slice(0, 300));
      return res.status(200).json({ ok: false, error: 'Claude API HTTP ' + aiRes.status, detail: errBody.slice(0, 200) });
    }
    const aiData = await aiRes.json();
    aiRawText = aiData.content?.[0]?.text || '';
    const jsonMatch = aiRawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) aiResponse = JSON.parse(jsonMatch[0]);
  } catch(e) {
    console.error('[monitor] Claude API error:', e.message);
    return res.status(200).json({ ok: false, error: 'Claude API failed: ' + e.message, raw: aiRawText.slice(0, 200) });
  }

  if (!aiResponse || aiResponse.action !== 'fix')
    return res.status(200).json({ ok: true, action: aiResponse?.action || 'no_response', reason: aiResponse?.reason || 'AI did not suggest a fix', errors_found: errorLogs.length, file_detected: affectedPath });

  const { file_path, fix_description, fixed_content } = aiResponse;
  if (!file_path || !fixed_content) return res.status(200).json({ ok: false, error: 'Incomplete fix' });

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
      message: `🤖 auto-fix: ${fix_description.slice(0, 72)}\n\n${errorMsg.slice(0, 200)}`, 
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
    return res.status(200).json({ 
      ok: true, action: 'fix_committed', file: file_path, 
      description: fix_description, commit_url: commitData.commit?.html_url 
    });
  } catch(e) { 
    return res.status(200).json({ ok: false, error: e.message }); 
  }
};

function detectAffectedFile(errorMsg) {
  const patterns = [
    /at\s+\S+\s+\(([^)]+\.(?:js|html|ts)):\d+:\d+\)/,
    /([a-zA-Z0-9_\-/]+\.(?:js|html|ts)):\d+/,
    /\/api\/([\w\-]+)/,
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
