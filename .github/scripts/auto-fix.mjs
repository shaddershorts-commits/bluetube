#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * auto-fix.mjs — Agente de auto-fix rodando em GitHub Actions
 *
 * Substitui o api/monitor.js que era alimentado por Vercel Log Drain
 * (loop self-referential causando 1M hits/dia e $68/mês). Aqui:
 *   1. Consulta Vercel API pra pegar erros recentes
 *   2. Pra cada erro único (dedup por hash): chama Claude pra propor fix
 *   3. Cria branch + abre Pull Request (em vez de commit direto)
 *   4. Você revisa o PR antes de mergear → segurança extra
 *
 * Diferenças vs monitor.js antigo:
 *   - Pull-based (cron 30min) em vez de push-based (drain real-time)
 *   - Latência: até 30min em vez de near-real-time (aceitável)
 *   - PR em vez de commit direto (camada de revisão humana)
 *   - Dedup via nome da branch (sem precisar state externo)
 *   - Sem custo Vercel function recorrente
 *
 * Env obrigatórios (configurar em GitHub Secrets):
 *   VERCEL_TOKEN          Token pessoal Vercel (read scope)
 *   VERCEL_PROJECT_ID     ID do projeto bluetube
 *   ANTHROPIC_API_KEY     Mesma do monitor.js antigo
 *   GITHUB_TOKEN          Token automático do workflow (precisa contents:write + pull-requests:write)
 *   GITHUB_REPOSITORY     owner/repo (automático no Actions)
 *
 * Env opcionais:
 *   VERCEL_TEAM_ID        Se o projeto está num team
 *   SINCE_MINUTES         Janela de busca (default 35)
 *   MAX_FIXES_PER_RUN     Limite de PRs por execução (default 3)
 */

import crypto from 'node:crypto';

const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || '';
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const SINCE_MINUTES = parseInt(process.env.SINCE_MINUTES || '35', 10);
const MAX_FIXES = parseInt(process.env.MAX_FIXES_PER_RUN || '3', 10);

// ────────────────────────────────────────────────────────────────────────────
// Validação de env
// ────────────────────────────────────────────────────────────────────────────
const required = { VERCEL_TOKEN, VERCEL_PROJECT_ID, ANTHROPIC_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY };
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error('❌ Missing required env:', missing.join(', '));
  process.exit(1);
}
const [GH_OWNER, GH_REPO] = GITHUB_REPOSITORY.split('/');

const teamQuery = VERCEL_TEAM_ID ? `&teamId=${encodeURIComponent(VERCEL_TEAM_ID)}` : '';

// ────────────────────────────────────────────────────────────────────────────
// Helpers HTTP
// ────────────────────────────────────────────────────────────────────────────
async function vercelGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://api.vercel.com${path}${sep}${teamQuery.slice(1)}`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + VERCEL_TOKEN } });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Vercel ${path}: HTTP ${r.status} — ${t.slice(0, 300)}`);
  }
  return r.json();
}

async function ghFetch(path, init = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + GITHUB_TOKEN,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'BlueTube-AutoFix',
      ...(init.headers || {}),
    },
  });
  return r;
}

async function ghGetJson(path) {
  const r = await ghFetch(path);
  if (!r.ok) {
    if (r.status === 404) return null;
    throw new Error(`GitHub ${path}: HTTP ${r.status}`);
  }
  return r.json();
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Buscar erros recentes do Vercel
// ────────────────────────────────────────────────────────────────────────────
async function getRecentErrors() {
  // Pega último deployment READY
  const deps = await vercelGet(`/v6/deployments?projectId=${encodeURIComponent(VERCEL_PROJECT_ID)}&limit=3&state=READY,ERROR`);
  const deployment = deps.deployments?.[0];
  if (!deployment) {
    console.log('No recent deployment found');
    return [];
  }
  console.log(`Inspecting deployment: ${deployment.uid} (${deployment.url})`);

  // Eventos do deployment (logs/build/runtime errors)
  const since = Date.now() - SINCE_MINUTES * 60 * 1000;
  const events = await vercelGet(
    `/v3/deployments/${deployment.uid}/events?builds=0&direction=backward&follow=0&limit=200&since=${since}`
  );

  // Vercel API às vezes retorna array, às vezes { events: [] }
  const eventArr = Array.isArray(events) ? events : (events.events || events.runtimeLogs || []);
  const errors = [];
  for (const ev of eventArr) {
    const text = ev.text || ev.message || ev.payload?.text || '';
    const level = (ev.level || ev.type || '').toLowerCase();
    if (!text) continue;
    if (level === 'error' || level === 'stderr' || /error|exception|TypeError|ReferenceError|SyntaxError|Cannot read prop/i.test(text)) {
      errors.push({ text: text.slice(0, 3000), timestamp: ev.created || ev.date || Date.now() });
    }
  }
  return errors;
}

// ────────────────────────────────────────────────────────────────────────────
// 2. Dedup + signature por hash
// ────────────────────────────────────────────────────────────────────────────
function signature(text) {
  // Normaliza: remove timestamps, paths variáveis, IDs UUID
  const normalized = text
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g, '')
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, '<uuid>')
    .replace(/at .+:\d+:\d+/g, (m) => m.replace(/:\d+/g, ''))
    .slice(0, 500);
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 10);
}

// ────────────────────────────────────────────────────────────────────────────
// 3. Detectar arquivo afetado (regex no stack trace)
// ────────────────────────────────────────────────────────────────────────────
function detectAffectedFile(errorMsg) {
  // Padrões comuns: "at handler (/var/task/api/auth.js:123:45)" ou "api/auth.js:42"
  const patterns = [
    /(?:\/var\/task\/|\/vercel\/path0\/)([\w\-./]+\.(?:m?js|ts|tsx|jsx))/,
    /([\w-]+\/[\w\-./]+\.(?:m?js|ts|tsx|jsx))(?::\d+|\s)/,
  ];
  for (const re of patterns) {
    const m = errorMsg.match(re);
    if (m && m[1]) {
      // Limpa prefixos e exclui node_modules
      const path = m[1].replace(/^\.\//, '');
      if (path.startsWith('node_modules/') || path.startsWith('.next/')) continue;
      return path;
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// 4. Chamar Claude pra propor fix
// ────────────────────────────────────────────────────────────────────────────
async function askClaude({ errorMsg, affectedPath, currentContent, repoFiles }) {
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

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Claude HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
  const data = await r.json();
  const text = data.content?.[0]?.text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ────────────────────────────────────────────────────────────────────────────
// 5. Safety checks (igual ao monitor.js antigo)
// ────────────────────────────────────────────────────────────────────────────
function passesSafetyChecks(original, fixed) {
  if (!original || !fixed) return { ok: false, reason: 'Missing content' };
  const origLines = original.split('\n').length;
  const fixedLines = fixed.split('\n').length;
  const diff = Math.abs(origLines - fixedLines);
  if (diff > origLines * 0.4) {
    return { ok: false, reason: `Mudaria ${diff}/${origLines} linhas (${Math.round(diff/origLines*100)}%)` };
  }
  const origESM = /export\s+default/.test(original);
  const fixESM = /export\s+default/.test(fixed);
  const origCJS = /module\.exports/.test(original);
  const fixCJS = /module\.exports/.test(fixed);
  if ((origESM && !fixESM) || (origCJS && !fixCJS)) {
    return { ok: false, reason: 'Tipo de export mudaria (ESM↔CJS)' };
  }
  return { ok: true };
}

// ────────────────────────────────────────────────────────────────────────────
// 6. Criar branch + commit + PR
// ────────────────────────────────────────────────────────────────────────────
async function createPullRequest({ sig, filePath, fixedContent, fileSha, fixDescription, errorMsg }) {
  const branchName = `auto-fix/${sig}`;

  // Verifica se branch já existe (dedup natural)
  const existing = await ghGetJson(`/repos/${GH_OWNER}/${GH_REPO}/git/refs/heads/${encodeURIComponent(branchName)}`);
  if (existing) {
    console.log(`  ⏭️  Branch ${branchName} já existe — skip`);
    return { skipped: true, reason: 'branch_exists' };
  }

  // Pega SHA do main
  const mainRef = await ghGetJson(`/repos/${GH_OWNER}/${GH_REPO}/git/refs/heads/main`);
  if (!mainRef) throw new Error('Main branch não encontrada');

  // Cria branch
  const createRef = await ghFetch(`/repos/${GH_OWNER}/${GH_REPO}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: mainRef.object.sha }),
  });
  if (!createRef.ok) {
    const t = await createRef.text();
    throw new Error(`Create branch: HTTP ${createRef.status} — ${t.slice(0, 200)}`);
  }

  // Commit do fix
  const commitMsg = `🤖 auto-fix: ${fixDescription.slice(0, 72)}\n\n${errorMsg.slice(0, 200)}`;
  const commitRes = await ghFetch(`/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(filePath)}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: commitMsg,
      content: Buffer.from(fixedContent, 'utf-8').toString('base64'),
      sha: fileSha,
      branch: branchName,
    }),
  });
  if (!commitRes.ok) {
    const t = await commitRes.text();
    throw new Error(`Commit: HTTP ${commitRes.status} — ${t.slice(0, 200)}`);
  }

  // Cria PR
  const prRes = await ghFetch(`/repos/${GH_OWNER}/${GH_REPO}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: `🤖 auto-fix: ${fixDescription.slice(0, 72)}`,
      head: branchName,
      base: 'main',
      body: `**Auto-fix proposto pelo agente Claude.**

**Erro detectado:**
\`\`\`
${errorMsg.slice(0, 1000)}
\`\`\`

**Arquivo:** \`${filePath}\`

**Correção:**
${fixDescription}

---
⚠️ Revise antes de mergear. Esse PR foi gerado automaticamente.
🔍 Signature: \`${sig}\`
🤖 Agent: \`.github/scripts/auto-fix.mjs\``,
    }),
  });
  if (!prRes.ok) {
    const t = await prRes.text();
    throw new Error(`PR: HTTP ${prRes.status} — ${t.slice(0, 200)}`);
  }
  const pr = await prRes.json();
  return { url: pr.html_url, number: pr.number, branchName };
}

// ────────────────────────────────────────────────────────────────────────────
// 7. Main
// ────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🤖 BlueTube Auto-Fix (GitHub Actions) — start');
  console.log(`Window: últimos ${SINCE_MINUTES} min · Max fixes: ${MAX_FIXES}`);

  const errors = await getRecentErrors();
  if (!errors.length) {
    console.log('✅ Nenhum erro recente encontrado');
    return;
  }
  console.log(`Found ${errors.length} error entries`);

  // Dedup por signature
  const grouped = new Map();
  for (const e of errors) {
    const sig = signature(e.text);
    if (!grouped.has(sig)) grouped.set(sig, e);
  }
  console.log(`Unique signatures: ${grouped.size}`);

  // Carrega lista de arquivos do repo (1x só)
  let repoFiles = '';
  try {
    const tree = await ghGetJson(`/repos/${GH_OWNER}/${GH_REPO}/git/trees/HEAD?recursive=1`);
    repoFiles = (tree?.tree || []).filter(f => f.type === 'blob').map(f => f.path).join('\n').slice(0, 1000);
  } catch (e) { console.warn('repoFiles fetch failed:', e.message); }

  let attempted = 0;
  let prsCreated = 0;
  const results = [];

  for (const [sig, err] of grouped) {
    if (attempted >= MAX_FIXES) {
      console.log(`Reached MAX_FIXES (${MAX_FIXES}), stopping`);
      break;
    }
    attempted++;

    console.log(`\n──── Processing sig=${sig} ────`);
    console.log(`Error: ${err.text.slice(0, 200)}`);

    // Pré-check: branch já existe (PR aberta ou tentado antes)?
    const existing = await ghGetJson(`/repos/${GH_OWNER}/${GH_REPO}/git/refs/heads/auto-fix/${sig}`);
    if (existing) {
      console.log(`  ⏭️  PR já existe pra essa signature — skip`);
      results.push({ sig, action: 'skipped_duplicate' });
      continue;
    }

    // Detecta arquivo afetado
    const affectedPath = detectAffectedFile(err.text);
    if (!affectedPath) {
      console.log('  ⚠️  Arquivo não detectado no stack trace — skip');
      results.push({ sig, action: 'skipped_no_file' });
      continue;
    }
    console.log(`  File: ${affectedPath}`);

    // Lê arquivo
    const fileData = await ghGetJson(`/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(affectedPath)}`);
    if (!fileData) {
      console.log('  ⚠️  Arquivo não existe no repo — skip');
      results.push({ sig, action: 'skipped_file_not_in_repo', affectedPath });
      continue;
    }
    const currentContent = Buffer.from(fileData.content || '', 'base64').toString('utf-8');

    // Chama Claude
    let claudeResp;
    try {
      claudeResp = await askClaude({ errorMsg: err.text, affectedPath, currentContent, repoFiles });
    } catch (e) {
      console.error('  ❌ Claude failed:', e.message);
      results.push({ sig, action: 'claude_failed', error: e.message });
      continue;
    }
    if (!claudeResp) {
      console.log('  ⚠️  Claude não retornou JSON válido');
      results.push({ sig, action: 'claude_no_json' });
      continue;
    }
    if (claudeResp.action !== 'fix') {
      console.log(`  ℹ️  Claude action: ${claudeResp.action} — ${claudeResp.reason || ''}`);
      results.push({ sig, action: claudeResp.action, reason: claudeResp.reason });
      continue;
    }

    // Safety
    const safety = passesSafetyChecks(currentContent, claudeResp.fixed_content);
    if (!safety.ok) {
      console.log(`  ⚠️  Safety check falhou: ${safety.reason}`);
      results.push({ sig, action: 'safety_rejected', reason: safety.reason });
      continue;
    }

    // Cria PR
    try {
      const pr = await createPullRequest({
        sig,
        filePath: claudeResp.file_path || affectedPath,
        fixedContent: claudeResp.fixed_content,
        fileSha: fileData.sha,
        fixDescription: claudeResp.fix_description || 'fix',
        errorMsg: err.text,
      });
      if (pr.skipped) {
        results.push({ sig, action: 'skipped_branch_exists' });
      } else {
        console.log(`  ✅ PR #${pr.number} criado: ${pr.url}`);
        results.push({ sig, action: 'pr_created', url: pr.url });
        prsCreated++;
      }
    } catch (e) {
      console.error('  ❌ PR creation failed:', e.message);
      results.push({ sig, action: 'pr_failed', error: e.message });
    }
  }

  console.log(`\n🤖 Done. Attempted: ${attempted} · PRs created: ${prsCreated}`);
  console.log('Results:', JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
