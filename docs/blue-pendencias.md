# Pendências da rede social Blue

Lista de otimizações e melhorias propostas porém **despriorizadas** — documentadas aqui pra não perder contexto quando fizer sentido retomar.

Cada item tem **status, prioridade, contexto, proposta técnica, gatilhos de retomada**. Manter a ordem de prioridade (mais importantes no topo).

---

## Feed infinito com fallback em cascata

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

<!-- 
  Pra adicionar novas pendências, duplicar o bloco acima mantendo o padrão:
  título curto, status, prioridade, pausado por, causa raiz, arquitetura,
  gatilhos. Mais novas no topo (após as mais prioritárias).
-->
