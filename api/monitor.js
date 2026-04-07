// api/monitor.js — Auto-fix agent: Vercel Log Drain → Claude API → GitHub commit
// Sends email notification via Resend when auto-fix fails or needs human attention.

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
        github_repo: process.env.GITHUB_REPO || 'NOT SET',
        resend: !!process.env.RESEND_API_KEY,
        admin_email: !!process.env.ADMIN_EMAIL
      }
    });
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
  const GITHUB_REPO   = process.env.GITHUB_REPO;
  const RESEND_KEY    = process.env.RESEND_API_KEY;
  const ADMIN_EMAIL   = process.env.ADMIN_EMAIL;

  if (!ANTHROPIC_KEY || !GITHUB_TOKEN || !GITHUB_REPO) {
    console.warn('[monitor] Missing env vars:', { anthropic: !!ANTHROPIC_KEY, github_token: !!GITHUB_TOKEN, github_repo: !!GITHUB_REPO });
    return res.status(200).json({ ok: false, message: 'Monitor online but missing env vars',
      missing: [!ANTHROPIC_KEY && 'ANTHROPIC_API_KEY', !GITHUB_TOKEN && 'GITHUB_TOKEN', !GITHUB_REPO && 'GITHUB_REPO'].filter(Boolean)
    });
  }

  // ── PARSE BODY ─────────────────────────────────────────────────────────────
  const errorLogs = [];
  try {
    let entries = [];
    if (Array.isArray(req.body)) entries = req.body;
    else if (typeof req.body === 'object' && req.body !== null) entries = [req.body];
    else if (typeof req.body === 'string') {
      for (const line of req.body.split('\n').filter(Boolean)) {
        try { const p = JSON.parse(line); Array.isArray(p) ? entries.push(...p) : entries.push(p); } catch(e) {}
      }
    }
    for (const log of entries) {
      if (!log || typeof log !== 'object') continue;
      if (log.level === 'error' || (log.message && /error|exception|TypeError|ReferenceError|SyntaxError|Cannot read prop/i.test(log.message)))
        errorLogs.push(log);
    }
  } catch(e) {
    return res.status(200).json({ ok: true, message: 'Parse error: ' + e.message });
  }

  if (!errorLogs.length) return res.status(200).json({ ok: true, message: 'No errors to fix', received: Array.isArray(req.body) ? req.body.length : 1 });

  const errorMsg = errorLogs.map(l => l.message || '').join('\n').slice(0, 3000);
  const affectedPath = detectAffectedFile(errorMsg);
  console.log('[monitor] Errors:', errorLogs.length, '| File:', affectedPath);

  // ── READ AFFECTED FILE ─────────────────────────────────────────────────────
  let currentContent = '', fileSha = '';
  if (affectedPath) {
    try {
      const ghRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${affectedPath}`, {
        headers: { Authorization: 'Bearer ' + GITHUB_TOKEN, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'BlueTube-Monitor' }
      });
      if (ghRes.ok) { const d = await ghRes.json(); fileSha = d.sha || ''; currentContent = Buffer.from(d.content || '', 'base64').toString('utf-8'); }
    } catch(e) { console.error('[monitor] GitHub read error:', e.message); }
  }

  // No file detected — notify and bail
  if (!affectedPath) {
    await notifyAdmin('unidentified_error', {
      errorMsg,
      reason: 'Não foi possível identificar o arquivo afetado a partir do stack trace. Requer análise manual dos logs.',
      suggestion: 'Acesse os logs do Vercel e procure pelo erro acima. Verifique se é um problema de runtime, configuração ou dependência externa.'
    });
    return res.status(200).json({ ok: true, action: 'notified_admin', reason: 'File not detected', errors_found: errorLogs.length });
  }

  // ── REPO FILES ─────────────────────────────────────────────────────────────
  let repoFiles = '';
  try {
    const apiRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/trees/HEAD?recursive=1`, {
      headers: { Authorization: 'Bearer ' + GITHUB_TOKEN, 'User-Agent': 'BlueTube-Monitor' }
    });
    if (apiRes.ok) { const tree = await apiRes.json(); repoFiles = (tree.tree || []).filter(f => f.type === 'blob').map(f => f.path).join('\n').slice(0, 1000); }
  } catch(e) {}

  // ── CLAUDE API ─────────────────────────────────────────────────────────────
  const prompt = `Você é um engenheiro sênior do projeto BlueTube (SaaS de roteiros para YouTube Shorts).

ERRO DETECTADO NO SITE:
\`\`\`
${errorMsg}
\`\`\`

${affectedPath ? `ARQUIVO AFETADO: ${affectedPath}\n\nCONTEÚDO ATUAL:\n\`\`\`\n${currentContent.slice(0, 8000)}\n\`\`\`` : ''}

ARQUIVOS DO REPOSITÓRIO:
${repoFiles}

CONTEXTO TÉCNICO:
- Stack: Vercel static (public/) + Serverless (api/) + Supabase + OpenAI/Gemini
- APIs usam ESM (export default), EXCETO que algumas usam CommonJS
- NUNCA mude o tipo de export (ESM↔CommonJS) de um arquivo
- NUNCA mude o método HTTP (POST↔GET) que um endpoint aceita
- NUNCA adicione dependências externas (npm packages) que não existam no projeto
- NUNCA reescreva a lógica inteira — faça APENAS a correção mínima necessária

REGRAS IMPORTANTES:
1. Se o erro parece ser de dados/input do usuário (não do código), responda "no_fix_needed"
2. Se o erro é em uma feature complexa e você não tem certeza, responda "needs_human"
3. O fixed_content deve ser o arquivo ORIGINAL com APENAS a linha/trecho do bug corrigido
4. Mantenha 100% da estrutura, imports, exports e lógica existente
5. Só corrija o que causou o erro específico — NADA MAIS

Responda APENAS com JSON:
{"action":"fix"|"no_fix_needed"|"needs_human","file_path":"caminho/arquivo.js","reason":"causa do bug","fix_description":"o que foi corrigido","fixed_content":"conteúdo completo do arquivo com a correção mínima"}`;

  let aiResponse = null;
  let aiRawText = '';
  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] })
    });
    if (!aiRes.ok) {
      const errBody = await aiRes.text();
      console.error('[monitor] Claude API HTTP error:', aiRes.status, errBody.slice(0, 300));
      await notifyAdmin('claude_api_failed', {
        errorMsg,
        file: affectedPath,
        reason: `Claude API retornou HTTP ${aiRes.status}. ${aiRes.status === 400 ? 'Possível problema de créditos.' : 'API pode estar fora do ar.'}`,
        detail: errBody.slice(0, 300),
        suggestion: aiRes.status === 400
          ? 'Verifique os créditos em console.anthropic.com/settings/billing e adicione saldo.'
          : 'Aguarde alguns minutos e verifique o status da API em status.anthropic.com'
      });
      return res.status(200).json({ ok: false, error: 'Claude API HTTP ' + aiRes.status, notified: true });
    }
    const aiData = await aiRes.json();
    aiRawText = aiData.content?.[0]?.text || '';
    const jsonMatch = aiRawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) aiResponse = JSON.parse(jsonMatch[0]);
  } catch(e) {
    console.error('[monitor] Claude API error:', e.message);
    await notifyAdmin('claude_api_failed', {
      errorMsg,
      file: affectedPath,
      reason: 'Falha na chamada ao Claude API: ' + e.message,
      suggestion: 'Verifique se a ANTHROPIC_API_KEY está válida e se a API está acessível.'
    });
    return res.status(200).json({ ok: false, error: 'Claude API failed: ' + e.message, notified: true });
  }

  // ── AI DECIDED NOT TO FIX ─────────────────────────────────────────────────
  if (!aiResponse || aiResponse.action !== 'fix') {
    const action = aiResponse?.action || 'no_response';
    const reason = aiResponse?.reason || 'AI não retornou uma sugestão válida';

    if (action === 'needs_human') {
      await notifyAdmin('needs_human', {
        errorMsg,
        file: affectedPath,
        reason,
        suggestion: 'O Claude analisou o erro mas não tem certeza de como corrigir. Revise o código manualmente no arquivo indicado.'
      });
    } else if (action === 'no_fix_needed') {
      await notifyAdmin('no_fix_needed', {
        errorMsg,
        file: affectedPath,
        reason,
        suggestion: 'O erro não é de código — pode ser de configuração, input do usuário ou serviço externo. Verifique se Supabase/Stripe/OpenAI estão funcionando.'
      });
    }

    return res.status(200).json({ ok: true, action, reason, errors_found: errorLogs.length, file_detected: affectedPath, notified: action !== 'no_response' });
  }

  // ── SAFETY CHECKS ──────────────────────────────────────────────────────────
  const { file_path, fix_description, fixed_content } = aiResponse;
  if (!file_path || !fixed_content) return res.status(200).json({ ok: false, error: 'Incomplete fix' });

  if (currentContent && fixed_content) {
    const origLines = currentContent.split('\n').length;
    const fixedLines = fixed_content.split('\n').length;
    const lineDiff = Math.abs(origLines - fixedLines);
    if (lineDiff > origLines * 0.4) {
      console.warn('[monitor] Fix rejected: too many changes', { origLines, fixedLines, lineDiff });
      await notifyAdmin('fix_rejected', {
        errorMsg,
        file: file_path,
        reason: `Auto-fix rejeitado: mudaria ${lineDiff} de ${origLines} linhas (${Math.round(lineDiff/origLines*100)}%). Muito destrutivo.`,
        fixDescription: fix_description,
        suggestion: 'O Claude sugeriu uma correção mas ela altera demais o arquivo. Revise manualmente.'
      });
      return res.status(200).json({ ok: false, action: 'fix_rejected', reason: 'Too many changes', notified: true });
    }
    const origHasESM = /export\s+default/.test(currentContent);
    const fixHasESM = /export\s+default/.test(fixed_content);
    const origHasCJS = /module\.exports/.test(currentContent);
    const fixHasCJS = /module\.exports/.test(fixed_content);
    if ((origHasESM && !fixHasESM) || (origHasCJS && !fixHasCJS)) {
      console.warn('[monitor] Fix rejected: export type changed');
      await notifyAdmin('fix_rejected', {
        errorMsg,
        file: file_path,
        reason: 'Auto-fix rejeitado: a correção trocaria o tipo de export do módulo (ESM↔CJS), o que quebraria o deploy.',
        fixDescription: fix_description,
        suggestion: 'Corrija manualmente mantendo o tipo de export original do arquivo.'
      });
      return res.status(200).json({ ok: false, action: 'fix_rejected', reason: 'Export type changed', notified: true });
    }
  }

  // ── COMMIT FIX ─────────────────────────────────────────────────────────────
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
      await notifyAdmin('github_commit_failed', {
        errorMsg,
        file: file_path,
        reason: 'Falha ao fazer commit no GitHub: ' + err.slice(0, 200),
        fixDescription: fix_description,
        suggestion: 'Verifique se o GITHUB_TOKEN tem permissão de escrita no repositório e não está expirado.'
      });
      return res.status(200).json({ ok: false, error: 'GitHub commit failed', notified: true });
    }

    const commitData = await commitRes.json();
    console.log('[monitor] ✅ Fix committed:', commitData.commit?.html_url);
    return res.status(200).json({
      ok: true, action: 'fix_committed', file: file_path,
      description: fix_description, commit_url: commitData.commit?.html_url
    });
  } catch(e) {
    await notifyAdmin('github_commit_failed', {
      errorMsg,
      file: file_path,
      reason: 'Exceção ao commitar no GitHub: ' + e.message,
      suggestion: 'Verifique o GITHUB_TOKEN e a conectividade com api.github.com'
    });
    return res.status(200).json({ ok: false, error: e.message, notified: true });
  }

  // ── NOTIFICATION HELPER ────────────────────────────────────────────────────
  async function notifyAdmin(type, data) {
    if (!RESEND_KEY || !ADMIN_EMAIL) {
      console.warn('[monitor] Cannot notify: missing RESEND_API_KEY or ADMIN_EMAIL');
      return;
    }

    const typeLabels = {
      needs_human: '🧑‍💻 Requer intervenção humana',
      no_fix_needed: 'ℹ️ Erro detectado (não é de código)',
      claude_api_failed: '🔴 Falha na API do Claude',
      github_commit_failed: '🔴 Falha no commit GitHub',
      fix_rejected: '⚠️ Auto-fix rejeitado (muito destrutivo)',
      unidentified_error: '❓ Erro sem arquivo identificado',
    };

    const subject = `⚠️ BlueTube Monitor — ${typeLabels[type] || 'Erro precisa de atenção'}`;
    const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;background:#0a1628;color:#e8f4ff;border-radius:16px;overflow:hidden;border:1px solid rgba(0,170,255,0.2)">
  <div style="background:linear-gradient(135deg,#1a6bff,#00aaff);padding:20px 28px">
    <div style="font-size:20px;font-weight:800;color:#fff">BlueTube Monitor</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.7);margin-top:4px">${now} — Notificação automática</div>
  </div>
  <div style="padding:28px">
    <div style="background:rgba(255,80,80,0.08);border:1px solid rgba(255,80,80,0.2);border-radius:10px;padding:14px 18px;margin-bottom:20px">
      <div style="font-size:14px;font-weight:700;color:#ff7a5a;margin-bottom:6px">${typeLabels[type] || type}</div>
      <div style="font-size:12px;color:rgba(200,225,255,0.7)">${data.reason || '—'}</div>
    </div>

    <div style="margin-bottom:18px">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:rgba(150,190,230,0.5);margin-bottom:6px">Erro original</div>
      <div style="background:rgba(2,8,23,0.8);border:1px solid rgba(0,170,255,0.1);border-radius:8px;padding:12px;font-family:'DM Mono',monospace;font-size:12px;color:#ff7a5a;word-break:break-all;max-height:200px;overflow:auto">${escHtml((data.errorMsg || '').slice(0, 800))}</div>
    </div>

    ${data.file ? `<div style="margin-bottom:18px">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:rgba(150,190,230,0.5);margin-bottom:6px">Arquivo afetado</div>
      <div style="font-family:'DM Mono',monospace;font-size:13px;color:#00aaff">${escHtml(data.file)}</div>
    </div>` : ''}

    ${data.fixDescription ? `<div style="margin-bottom:18px">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:rgba(150,190,230,0.5);margin-bottom:6px">Fix sugerido (rejeitado)</div>
      <div style="font-size:12px;color:rgba(200,225,255,0.7)">${escHtml(data.fixDescription)}</div>
    </div>` : ''}

    <div style="background:rgba(0,170,255,0.06);border:1px solid rgba(0,170,255,0.15);border-radius:10px;padding:14px 18px;margin-bottom:20px">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#00aaff;margin-bottom:6px">💡 O que fazer</div>
      <div style="font-size:13px;color:rgba(200,225,255,0.85)">${escHtml(data.suggestion || 'Verifique os logs do Vercel.')}</div>
    </div>

    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <a href="https://vercel.com/dashboard" style="display:inline-block;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:700">Ver logs no Vercel →</a>
      <a href="https://github.com/${GITHUB_REPO}" style="display:inline-block;background:rgba(0,170,255,0.08);border:1px solid rgba(0,170,255,0.2);color:#00aaff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600">Abrir repositório</a>
    </div>
  </div>
  <div style="padding:16px 28px;border-top:1px solid rgba(0,170,255,0.08);font-size:11px;color:rgba(150,190,230,0.35)">
    Enviado automaticamente por BlueTube Monitor · api/monitor.js
  </div>
</div>`;

    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({
          from: 'BlueTube Monitor <noreply@bluetubeviral.com>',
          to: [ADMIN_EMAIL],
          subject,
          html
        })
      });
      if (!r.ok) {
        const errText = await r.text();
        console.error('[monitor] Resend error:', r.status, errText.slice(0, 200));
      } else {
        console.log('[monitor] 📧 Admin notified:', type);
      }
    } catch(e) {
      console.error('[monitor] Resend failed:', e.message);
    }
  }
};

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '<br>');
}

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
      if (path.includes('/api/')) {
        const afterApi = path.split('/api/')[1].split('/')[0].split(':')[0];
        path = 'api/' + afterApi;
        if (!path.endsWith('.js') && !path.endsWith('.html')) path += '.js';
      } else if (!path.includes('/')) {
        path = 'api/' + path;
        if (!path.endsWith('.js') && !path.endsWith('.html')) path += '.js';
      }
      if (!path.endsWith('.js') && !path.endsWith('.html')) return null;
      return path;
    }
  }
  return null;
}
