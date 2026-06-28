# Auto-fix agent (GitHub Actions)

Migração de `api/monitor.js` (Vercel Log Drain) → GH Actions cron pull-based.

## Por que migrei

O monitor antigo dependia de Vercel Log Drain que tinha bug de configuração: drenava 100% dos logs (incluindo "ok") em vez de só erros. Cada chamada de `/api/monitor` virava log, drain mandava o log de volta pro endpoint → **loop infinito**.

Resultado: 1M hits/dia no endpoint, ~24M edge requests/mês no Vercel, ~$68 desperdiçados.

## Como funciona agora

```
[GitHub Actions cron */30] → consulta Vercel Logs API
                              ↓
                            filtra erros únicos (dedup por signature hash)
                              ↓
                            pra cada erro novo:
                              - detecta arquivo afetado no stack trace
                              - lê arquivo do GitHub
                              - chama Claude pra propor fix
                              - safety checks (≤40% linhas, mantém ESM/CJS)
                              - abre PR em branch `auto-fix/<sig>`
                              ↓
                            você revisa PR e mergea (ou fecha)
```

## Vantagens vs sistema antigo

- ✅ **Sem loop possível** (sem drain auto-referente)
- ✅ **PR em vez de commit direto** (revisão humana)
- ✅ **Versionado em git** (workflow + script auditáveis)
- ✅ **Sem custo Vercel function recorrente**
- ✅ **Dedup natural** via nome de branch (se PR `auto-fix/abc123` já existe, skip)
- ⚠️ **Latência maior** (até 30min vs near-real-time) — aceitável

## Setup necessário

### GitHub Secrets

Adicionar em `Settings → Secrets and variables → Actions → Repository secrets`:

| Secret | Como obter | Necessário? |
|---|---|---|
| `VERCEL_TOKEN` | Vercel → Account Settings → Tokens → Create | ✅ |
| `VERCEL_PROJECT_ID` | Vercel → projeto bluetube → Settings → General → ID | ✅ |
| `ANTHROPIC_API_KEY` | Console Anthropic (mesma que já usa no monitor.js antigo) | ✅ |
| `VERCEL_TEAM_ID` | Vercel → Team Settings → ID (se projeto está num team) | ⚠️ Opcional |

⚠️ **Permissões do `VERCEL_TOKEN`:** scope `read` é suficiente (só lê logs, não modifica nada).

⚠️ **GITHUB_TOKEN:** automaticamente fornecido pelo Actions. Precisa permissão `contents: write` + `pull-requests: write` (já configurada no workflow).

### Workflow Permissions (importante!)

Se o repo bloqueia ações de bot, precisa habilitar:
- `Settings → Actions → General → Workflow permissions`
- Marcar **"Read and write permissions"**
- Marcar **"Allow GitHub Actions to create and approve pull requests"**

## Variáveis de ajuste

Editar no `auto-fix.yml`:

| Var | Default | O que faz |
|---|---|---|
| `SINCE_MINUTES` | 35 | Janela de busca (35min cobre os 30min do cron + margem) |
| `MAX_FIXES_PER_RUN` | 3 | Máximo de PRs por execução (evita 50 PRs se houver bug recorrente) |

Pra mudar frequência do cron:
```yaml
schedule:
  - cron: '*/30 * * * *'  # cada 30min (atual)
  - cron: '0 * * * *'     # cada 1h (mais econômico)
  - cron: '*/15 * * * *'  # cada 15min (mais reativo)
```

## Teste manual

Sem esperar o cron, dispara manual:
- `Actions → Auto-fix agent → Run workflow`

Ou local (dev):
```bash
export VERCEL_TOKEN="..."
export VERCEL_PROJECT_ID="..."
export ANTHROPIC_API_KEY="..."
export GITHUB_TOKEN="..."
export GITHUB_REPOSITORY="shaddershorts-commits/bluetube"
node .github/scripts/auto-fix.mjs
```

## O que aconteceu com `api/monitor.js`?

Continua no código mas **dormante** — Vercel não chama mais ele depois que o Log Drain foi deletado. Pode ser deletado em commit separado se quiser limpeza:

```bash
git rm api/monitor.js
```

## Custo estimado

- **GitHub Actions**: workflow leve (~30s/exec × 48/dia = 24min/dia = ~12h/mês) — dentro do free tier de repo público
- **Anthropic API**: 1 fix ~ $0.02-0.05 (50-100k tokens com prompt grande). Estimativa: 5-30 fixes/mês = $1-5/mês
- **Vercel**: zero — não usa mais nenhuma função Vercel recorrente

## Como desativar temporariamente

`Actions → Auto-fix agent → ... (botão 3 pontos) → Disable workflow`
