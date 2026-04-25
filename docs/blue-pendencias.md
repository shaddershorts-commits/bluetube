# Pendências da rede social Blue

Lista de otimizações e melhorias propostas porém **despriorizadas** — documentadas aqui pra não perder contexto quando fizer sentido retomar.

Cada item tem **status, prioridade, contexto, proposta técnica, gatilhos de retomada**. Manter a ordem de prioridade (mais importantes no topo).

---

## Feed infinito com fallback em cascata

- **Status:** ✅ **Para Você concluído em 2026-04-24** | ⏸️ cross_feed (Seguindo) ainda pausado
- **Prioridade original:** Média
- **Retomado por:** decisão consciente — feed acabando = retenção quebrada, vaza tudo que entra (independente de aquisição)

### O que foi feito (Para Você)

3 commits push:

| Commit | Repo | O que mudou |
|--------|------|-------------|
| [9fae402](https://github.com/shaddershorts-commits/bluetube/commit/9fae402) | `bluetube` | Backend: cursor tipado (`fresh:` / `recycle:`) + branch novo `seen_recycle` (LRU reverso em `blue_feed_historico`) + transição `fresh→recycle` quando esgota + `has_more: true` sempre em modo logado + payload com `feed_mode` |
| [604ccdb](https://github.com/shaddershorts-commits/bluetube/commit/604ccdb) | `bluetube` | Web: `_backendFeedMode` tracker + `showFeedModeBanner` helper (glassmorphism, fade 3s, pointer-events:none) na transição |
| [29bcabf](https://github.com/shaddershorts-commits/bluetube-app/commit/29bcabf) | `bluetube-app` | App: `feedMode` no store + dedupe defensivo (3 rounds vazios pausam, evita loop sem matar feed) + banner Animated tipo pill no topo |

**Performance:** EXPLAIN ANALYZE confirmou Index Scan Backward em `idx_feed_hist_user_created` em **0.148ms**. Cursor `(created_at, id)` em vez de OFFSET — escala pra 100k+ rows.

### Decisões tomadas (e mantidas)

- Cursor tipado prefixado com fallback retrocompat (legacy sem prefixo = fresh)
- Loop infinito quando recycle esgota (cursor zera, volta ao topo) — TikTok faz igual
- Re-rerank em recycle: NÃO. Vai na ordem temporal natural
- Anônimo (sem token): comportamento INALTERADO. Sem histórico, sem recycle.
- Banner sutil 3s só na transição (não a cada page load)

### O que continua PAUSADO (cross_feed em Seguindo)

Quando feed Seguindo esgota, NÃO delega pra Para Você. Mantém comportamento "acabou os vídeos de quem você segue, fim". Justificativa do user:

> "Seguindo parar quando acabar é semanticamente correto. Adiar até virar problema real."

### Gatilhos pra retomar cross_feed

- Reclamação explícita de user sobre "feed Seguindo acabou"
- OU métrica mostrando >30% das sessões em Seguindo chegam ao fim do feed
- OU base de seguidores médios passar de ~50/user (faz sentido oferecer mais conteúdo)

---

## (HISTÓRICO — pendência original antes da conclusão)

- **Status:** ⏸️ Pausado em 2026-04-23
- **Prioridade:** Média
- **Pausado por:** foco em aquisição — Blue ainda em validação de base, otimizar feed sem massa crítica é sobre-engenharia

### Problema observado

Quando usuário rola o feed até o fim (seja "Para Você" ou "Seguindo"), o scroll simplesmente para. Comportamento desalinhado com padrão de redes sociais modernas (TikTok, Instagram, Reels) onde o feed é percebido como infinito.

**Cenário real que motivou a proposta:** usuário rolou Shorts até o fim na home do BlueTube e não desceu mais.

### Causa raiz (validada no código)

**Backend** em [`api/blue-feed.js`](../api/blue-feed.js):
- **Feed Para Você** (linha 862): `has_more = rawSql.length >= limit * 3`. Quando a query REST devolve menos de 30 vídeos (limit 10 × 3), vira `false`. O frontend para.
- **Feed Seguindo** (linha 597): cronológico puro dos seguidos, sem fallback algum. Se user segue 3 pessoas com 20 vídeos totais, acaba em 20.
- Já existe anti-feed-vazio parcial (linhas 760-770) que mistura não-vistos + vistos, mas só dentro da mesma janela de cursor, não cross-batch.

**Frontend** em [`public/blue.html`](../public/blue.html#L3860):
- `loadMoreFeed()` na linha 3860 para quando `!_feedHasMore || !_feedCursor`. Obediente ao backend.

### Arquitetura proposta — 3 modos em cascata

Princípio: `has_more` só é `false` se a base inteira do BlueTube tem 0 vídeos. Caso contrário, backend sempre serve algo.

| Modo | Quando | O que serve |
|------|--------|-------------|
| **`fresh`** | Padrão (comportamento atual) | Vídeos não vistos, rerank personalizado |
| **`seen_recycle`** | Fresh esgotou pro user | Vídeos já vistos, priorizando os mais antigos na memória (LRU reverso) + shuffle leve. Funciona infinito. |
| **`cross_feed`** | Feed Seguindo esgotou | Cai pro feed Para Você completo, com marker visual opcional |

### Regras

- `has_more` SEMPRE `true` (exceto banco vazio)
- Cursor carrega o modo no encoded: `fresh:TS\|ID`, `recycle:OFFSET`, `cross:TS\|ID`
- Payload inclui `feed_mode: 'fresh' | 'seen_recycle' | 'cross_feed'` pro frontend opcionalmente mostrar badge sutil ("🔄 Revisitando viralizações anteriores")

### Comportamento concreto

**Feed Para Você rolado sem fim:**
1. Vê N vídeos novos (modo fresh)
2. Acabou? → entra `seen_recycle`: serve vistos em ordem LRU reverso (vistos há mais tempo primeiro), shuffle dentro de buckets de 30. Pode repetir vídeo após ~200+ scrolls, TikTok faz igual.

**Feed Seguindo rolado sem fim:**
1. Vê todos vídeos dos seguidos (cronológico)
2. Acabou? → entra `cross_feed`: serve Para Você normal
3. Se Para Você também acabar → `seen_recycle`

### Mudanças estimadas

**Arquivos tocados: 2.**

| Arquivo | Linhas | Detalhe |
|---------|--------|---------|
| [`api/blue-feed.js`](../api/blue-feed.js) — Para Você | +50 | Detectar esgotamento de fresh, emitir cursor `recycle:N`, servir lote de seen-reverso |
| [`api/blue-feed.js`](../api/blue-feed.js) — Seguindo | +30 | Ao esgotar cursor, retornar `cross_feed:1`; próximo call delega pra lógica de Para Você |
| [`public/blue.html`](../public/blue.html) | +10 (opcional) | Banner sutil de 3s ao trocar de modo (puramente visual, não bloqueia) |

**Sem mudanças de schema.** `blue_feed_historico` já tem dados suficientes pra calcular LRU.

**Rollback:** `git revert` limpo, comportamento atual (`has_more=false` no fim) volta sem efeitos colaterais.

### Gatilhos pra retomada

Retomar essa pendência quando qualquer UM dos seguintes acontecer:

1. **50+ usuários ativos diários no Blue** — massa crítica suficiente pra feed vazio virar problema real
2. **Reclamação explícita** de algum usuário sobre "feed acabou" / "não desce mais"
3. **Métrica** mostrando >20% das sessões chegam ao final do feed sem cliclar/interagir em outra coisa

Por enquanto, foco é aquisição geral do produto.

### Variações consideradas (menos agressivas)

Caso queira uma V1 reduzida quando retomar:

- **Mínima:** só implementar `seen_recycle` pro Para Você. Seguindo continua parando se acabar. Simples, cobre 80% dos casos.
- **Visual:** além de implementar backend, mostrar banner explícito "Você viu tudo, aqui vão repeats" quando trocar de modo. Mais honesto, menos "Tiktok-like magic".

---

---

## Auditoria de autorização em todos endpoints `/api/blue-*`

- **Status:** ✅ **CONCLUÍDA em 2026-04-24** (sessão única)
- **Prioridade original:** 🔴 ALTA
- **Originada em:** sessão de fix do chat (2026-04-24)

### Resumo executivo

Audit feito por Explore agent + validação manual (1 falso positivo detectado, 4 verdadeiros positivos confirmados). 30+ endpoints / 120+ actions auditadas. **5 vulnerabilidades reais corrigidas** no total (B1 já tinha sido fixada no chat antes da auditoria + 4 novas).

### Vulnerabilidades corrigidas

| # | Severidade | Endpoint | Action | Bug | Fix | Commit |
|---|-----------|----------|--------|-----|-----|--------|
| B1 | 🔴 CRÍTICA | `blue-chat` | `messages` (GET) | Aceitava `conv_id` arbitrário sem validar participação | Helper `assertParticipant` + log `[SECURITY-BLOCK]` | [5a47064](https://github.com/shaddershorts-commits/bluetube/commit/5a47064) |
| 1 | 🔴 CRÍTICA | `blue-coins` | `confirmar` (POST) | Sem auth — qualquer um creditava saldo arbitrário | **Removida** (era dead code) | [55c3339](https://github.com/shaddershorts-commits/bluetube/commit/55c3339) |
| 2 | 🔴 CRÍTICA | `blue-shop` | `confirmar-compra` (POST) | Sem auth — qualquer um marcava pedido como `pago` | **Removida** (era dead code) | [55c3339](https://github.com/shaddershorts-commits/bluetube/commit/55c3339) |
| 3 | 🟡 MÉDIA | `blue-feed` | `update-trending` (cron) | Sem proteção — qualquer um disparava | `x-vercel-cron` OR `admin_secret` | [9e3e876](https://github.com/shaddershorts-commits/bluetube/commit/9e3e876) |
| 4 | 🟡 MÉDIA | `blue-feed` | `limpar-rate-limits` (cron) | Idem | Mesma proteção | [9e3e876](https://github.com/shaddershorts-commits/bluetube/commit/9e3e876) |

### Falsos positivos do agent (validados manualmente)

| Finding agent | Real? | Razão |
|---------------|-------|-------|
| `blue-profile:edit-video` ownership | ❌ Falso | [Linha 190](../api/blue-profile.js#L190) já tem `&user_id=eq.${userId}` |
| `blue-assinatura:planos-do-canal` info leak | ❌ Falso | Planos de assinatura são públicos por design (igual Patreon) |
| `blue-stories:feed` retorna stories de bloqueados | ❌ Falso | Só lê de `targetIds = [userId, ...followedIds]` — bloqueio = unfollow implícito |

### Helpers criados / sugeridos

- ✅ **`assertParticipant(convId, type)`** — em [`api/blue-chat.js`](../api/blue-chat.js). Reutilizável pra outros endpoints com modelo de "par participantes".
- 🔵 **`assertOwns(userId, resourceType, resourceId)`** — sugerido pra futuro. Centralizar em `api/_helpers/auth.js`. Validaria `resource.user_id === userId` antes de PATCH/DELETE. Reduziria boilerplate em editVideo, deleteVideo, editComment, deleteComment, etc. Não criado nesta sessão porque os endpoints existentes já validam manualmente.

### Patterns estabelecidos

- **"Autenticado != autorizado"** — token válido NUNCA implica permissão sobre recurso. Sempre validar ownership/participação.
- **Cron Vercel** — usar `req.headers['x-vercel-cron']` pra autenticar (header automático, não falsificável). Padrão já em [`payment-monitor.js:15`](../api/payment-monitor.js#L15).
- **Logs de tentativa bloqueada** — sempre `console.error('[SECURITY-BLOCK][<endpoint>]', JSON.stringify({...}))`. Aparece em Vercel Logs, fácil de filtrar/alertar.
- **Dead code vulnerável** — preferir REMOVER em vez de tampar. Quando precisar, reimplementar com auth correta (ex: HMAC do Stripe webhook).

### Outros crons sem `x-vercel-cron` check (pendência futura — prioridade baixa)

A sessão fixou só os 2 do `blue-feed`. Outros crons admin não têm proteção mas têm baixo blast radius (idempotentes ou apenas leitura). Lista pra revisar quando der:

- `/api/blue-maintenance` (a cada 6h)
- `/api/blue-stories?action=limpar`
- `/api/blue-lives?action=limpar-lives-antigas`
- `/api/blue-legendas?action=processar-fila`
- `/api/blue-backup?action=executar`
- `/api/blue-monetizacao?action=distribuir-fundo`
- `/api/blue-ml?action=calcular-features`
- `/api/blue-feed?action=update-metrics`

Aplicar mesmo pattern (`x-vercel-cron` OR `admin_secret`) quando fizer revisão preventiva.

### Pendência ORIGINAL (mantida abaixo pra histórico)

### Contexto

A vulnerabilidade B1 do chat (`/api/blue-chat?action=messages` aceitava `conv_id` arbitrário sem validar que o requester era participante) foi descoberta em diagnóstico técnico. **Padrão similar pode existir em outros endpoints** — backend assume que "autenticado" = "autorizado pra qualquer recurso", o que é falso.

### O que auditar

Pra cada endpoint em `api/blue-*.js` que aceita IDs de recurso vindos do request (query string OU body), verificar se faz autorização real (não só auth):

| Endpoint | Pergunta a fazer |
|----------|------------------|
| [`api/blue-profile.js`](../api/blue-profile.js) | Action `update` valida que userId == profile.user_id? Action `edit-video` / `delete-video` valida ownership? |
| [`api/blue-follow.js`](../api/blue-follow.js) | follow/unfollow checa que follower_id é o requester? |
| [`api/blue-interact.js`](../api/blue-interact.js) | like/save/comment validam que user_id é do token, não do body? Já corrigido bug de like múltiplo (commit c14c9d9) — mas tem mais ações. |
| [`api/blue-comment.js`](../api/blue-comment.js) | delete/edit comment valida ownership? |
| [`api/blue-stories.js`](../api/blue-stories.js) | view/react/reply em story alheia checa qualquer permissão? |
| [`api/blue-feed.js`](../api/blue-feed.js) | actions admin (`update-metrics`, `limpar-rate-limits`) checam admin_secret? |
| [`api/blue-app.js`](../api/blue-app.js) | revisar todas actions |
| Resto (`blue-assinatura`, `blue-monetizacao`, `blue-coins`, `blue-onboarding`, `blue-report`, `blue-voices`, `blue-maintenance`, `blue-embeddings`) | Idem |

### Approach sugerido pra retomar

1. Listar TODAS as actions de cada endpoint (já temos um mapa parcial via Explore agent)
2. Pra cada action que muta/lê dados de um recurso identificado por ID no payload:
   - Se é resource owned by user (perfil, video, comment): validar ownership
   - Se é resource compartilhado (chat conversation, etc): validar participação
   - Se é admin-only (cron, manutenção): validar admin_secret OU IP da Vercel
3. Padronizar com helper compartilhado tipo o `assertParticipant` que criamos no `blue-chat.js` (linha ~27)
4. Adicionar logs `[SECURITY-BLOCK][endpoint]` em todas tentativas bloqueadas

### Gatilhos pra retomar

- Reclamação de user que viu dado de outra pessoa
- OU sessão de hardening de segurança planejada
- OU detecção de tráfego anômalo nos logs Vercel (filtro `[SECURITY-BLOCK]`)

---

## Chat: rate limiting (50 msg/min/user)

- **Status:** ⏸️ Pendente
- **Prioridade:** Média
- **Identificada em:** diagnóstico chat 2026-04-24

`api/blue-chat.js` action `send` não tem rate limit. Spam fácil. `blue_rate_limits` table já existe (usada pelo blue-feed). Aplicar mesmo padrão: 50 msg/min/user, retornar 429 acima.

---

## Chat: read receipts visíveis

- **Status:** ⏸️ Pendente
- **Prioridade:** Baixa (UX)

Backend marca `blue_messages.read=true` quando destinatário abre conversa, mas não retorna esse campo no payload de `messages`. Frontend não consegue mostrar "✓ lido" igual WhatsApp.

Fix: adicionar `read` ao SELECT em `messages` action e renderizar na bubble.

---

## Chat: WebSocket em vez de polling

- **Status:** ⏸️ Pendente
- **Prioridade:** Baixa (escalabilidade)

Hoje app polla a cada 5s, web a cada 3s. Quando passar de ~50 usuários ativos no chat simultâneos, vai bater em rate limit Vercel. Migrar pra Supabase Realtime (que já está no stack) — `supabase.channel('messages').on('postgres_changes', ...)`.

---

## Chat: push notifications

- **Status:** ⏸️ Pendente
- **Prioridade:** Média (engajamento)

Quando mensagem chega, usuário não recebe nada se não estiver com app aberto. Nem badge no ícone do tab "Chat" funciona em background. Implementar via Expo Notifications + cron periódico no backend que verifica `read=false` recentes e dispara push.

---

## Chat: soft-delete de mensagens

- **Status:** ⏸️ Pendente
- **Prioridade:** Baixa

Sem coluna `deleted_at` em `blue_messages`. Hoje delete seria hard delete. Pra "Apagar mensagem só pra mim" (quem mandou) precisa soft-delete + filtro no GET.

---

## Chat: RLS habilitado em `blue_messages` (defesa em profundidade)

- **Status:** ⏸️ Pendente
- **Prioridade:** Baixa (já mitigado)

Backend B1 fix (commit 5a47064) já cobre, mas RLS no Supabase é cinto extra: se backend voltar a ter bug, RLS bloqueia direto no banco. Policy: `USING (auth.uid() IN (SELECT user1_id FROM blue_conversations WHERE id = conversation_id UNION SELECT user2_id FROM blue_conversations WHERE id = conversation_id))`.

---

## `/api/unsubscribe` proxy + tokens legacy — remover apos 2026-05-25

- **Status:** ⏸️ Aguardando deadline (deploy Fix 4 em 2026-04-25 + 30 dias)
- **Prioridade:** Baixa (limpeza pos-migracao)
- **Pausado por:** retrocompat obrigatorio enquanto emails antigos com tokens base64-puros estiverem nas inboxes dos users.

### Contexto

Fix 4 (Gap 6) introduziu HMAC-signed tokens em `/api/v1/unsubscribe`. Mantivemos:
- [api/unsubscribe.js](../api/unsubscribe.js) como proxy que delega pro v1
- `verifyToken` em [_helpers/unsub-token.js](../api/_helpers/unsub-token.js) aceita tokens legacy (sem ponto/HMAC) ate `LEGACY_DEADLINE = 2026-05-25T00:00:00Z`

### O que remover apos 2026-05-25

1. Deletar [api/unsubscribe.js](../api/unsubscribe.js) por completo
2. Em [_helpers/unsub-token.js](../api/_helpers/unsub-token.js): remover branch `if (parts.length === 1)` e a constante `LEGACY_DEADLINE`
3. Documentar a remocao em commit message

### Gatilho

- Data >= 2026-05-25
- Verificar Vercel logs por `[unsubscribe] legacy_path` — se ainda houver hits significativos, estender prazo +15 dias (improvavel: usuarios dificilmente abrem emails de 30 dias depois)

---

## Consolidar `email_marketing` + `subscribers` em modelo unico de preferencias

- **Status:** ⏸️ Pausado em 2026-04-25 (decisão pragmática durante Fix 4)
- **Prioridade:** Baixa
- **Pausado por:** funcional hoje. Refator sem ROI claro ate base passar de ~100 ativos.

### Contexto

Hoje as preferencias de comunicacao do user vivem em 2 tabelas:
- `email_marketing.unsubscribed` (boolean) — gateia 4 dos 7 senders
- `subscribers.milestone_X_sent` (3 colunas) — controle de milestone-emails
- Nao existe coluna unificada `subscribers.communication_prefs jsonb` ou similar

### Proposta

Tabela `user_communication_preferences`:
```sql
CREATE TABLE user_communication_preferences (
  email TEXT PRIMARY KEY,
  marketing BOOLEAN DEFAULT TRUE,
  milestones BOOLEAN DEFAULT TRUE,
  reactivation BOOLEAN DEFAULT TRUE,
  weekly_newsletter BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

Endpoint `/api/v1/preferences` (GET para mostrar UI, POST para atualizar). Substitui o opt-out binario por granularidade.

### Gatilho

- Reclamacao de user pedindo "desligar so newsletter mas manter milestones"
- OU base passar de ~100 usuarios ativos (granularidade vira diferencial)

---

## `reactivation-emails.js` — adicionar filtro `unsubscribed`

- **Status:** ⏸️ Pausado em 2026-04-25 (decisão pragmática durante Fix 4)
- **Prioridade:** Media (compliance borderline)
- **Pausado por:** reactivation-emails so dispara pra usuarios que CANCELARAM assinatura — defensivel como follow-up de transacao. Mas tecnicamente borderline marketing.

### Contexto

[api/reactivation-emails.js](../api/reactivation-emails.js) envia "vem voltar, sua assinatura cancelou". Nao checa `email_marketing.unsubscribed`. Hoje cobertvel como "transacional" (post-cancelamento), mas se user marcar `unsubscribed=true` esperando bloquear TUDO, vai receber mesmo assim.

`/api/v1/unsubscribe?scope=all` ja existe e mostra mensagem ampla pro user, mas a acao concreta no DB hoje e a mesma de scope=marketing. Quando esse fix entrar, scope=all bloqueia reactivation tambem.

### Proposta

Em reactivation-emails.js, antes do loop:
```js
const unsubR = await fetch(`${SU}/rest/v1/email_marketing?unsubscribed=eq.true&select=email`, { headers: H });
const unsubSet = new Set((unsubR.ok ? await unsubR.json() : []).map(r => r.email));
// no loop: if (unsubSet.has(u.email)) { skipped++; continue; }
```

### Gatilho

- Base passar de ~100 cancelamentos/mes (volume real onde reactivation vira ruido)
- OU primeiro pedido formal de "desliga TUDO" via suporte
- OU reclamacao LGPD/ANPD

---

## `/api/v1/user-export` — migrar audit log de exports pra tabela dedicada

- **Status:** ⏸️ Pausado em 2026-04-24 (decisão pragmática durante Fix 3)
- **Prioridade:** Baixa
- **Pausado por:** volume atual baixo (~16 assinantes). Vercel Logs (30 dias) cobre auditoria reativa por enquanto.

### Contexto

Endpoint `/api/v1/user-export` (LGPD Art. 18 / GDPR Art. 20) loga cada export via `console.log` — formato `[user-export] user_id=X ip=Y status=200 bytes=N ms=M`. Aparece em Vercel Logs com retenção de 30 dias.

### Proposta técnica

Criar tabela `user_data_exports`:

```sql
CREATE TABLE user_data_exports (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  email TEXT NOT NULL,
  ip TEXT,
  exported_at TIMESTAMPTZ DEFAULT NOW(),
  bytes_returned BIGINT,
  duration_ms INTEGER,
  status_code SMALLINT
);
CREATE INDEX idx_user_exports_user_at ON user_data_exports(user_id, exported_at DESC);
```

Substituir `console.log` no [api/v1/user-export.js](../api/v1/user-export.js) por INSERT na tabela (fire-and-forget). Manter `console.log` em paralelo até validar a tabela.

### Gatilhos pra retomar

- Volume de exports > 50/mês (sinal de uso real, fora de testes)
- OU primeira solicitação real de auditoria histórica (DPO de empresa cliente, processo trabalhista, etc)
- OU reclamação LGPD/ANPD que peça evidência > 30 dias

---

## `/api/v1/user-export` — fallback assíncrono (job + email) se queries estourarem timeout Vercel

- **Status:** ⏸️ Pausado em 2026-04-24 (decisão pragmática durante Fix 3)
- **Prioridade:** Baixa
- **Pausado por:** export síncrono (51 queries paralelas em ~10 seções) deve resolver em 5-15s pra user típico — bem dentro do limite Vercel (10s Hobby / 60s Pro).

### Contexto

Power users com muito histórico (10k+ vídeos vistos, 100k+ feed_seen) podem se aproximar do timeout. Limites em `blue_feed_historico` (5k) e `blue_feed_seen` (10k) já mitigam, mas não cobrem caso onde MUITAS seções têm volume alto simultaneamente.

### Proposta técnica

Quando export demorar > 8s (ou volume estimado > 5MB):
1. Endpoint retorna `202 Accepted` + `{ job_id }`
2. Worker assíncrono (Vercel cron ou Inngest) processa em background, monta JSON, sobe pra Supabase Storage com URL temporária (signed, 24h)
3. Email Resend pro user com link de download

### Gatilhos pra retomar

- Primeiro timeout real reportado em Vercel Logs com `[user-export] ... ms=>9000`
- OU base passar de ~1000 usuários ativos
- OU reclamação de export que "não termina"

---

<!-- 
  Pra adicionar novas pendências, duplicar o bloco acima mantendo o padrão:
  título curto, status, prioridade, pausado por, causa raiz, arquitetura,
  gatilhos. Mais novas no topo (após as mais prioritárias).
-->
