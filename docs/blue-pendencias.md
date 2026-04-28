# Pendências da rede social Blue

Lista de otimizações e melhorias propostas porém **despriorizadas** — documentadas aqui pra não perder contexto quando fizer sentido retomar.

Cada item tem **status, prioridade, contexto, proposta técnica, gatilhos de retomada**. Manter a ordem de prioridade (mais importantes no topo).

---

## BlueTendências v3 — limites de extensão para modo 'aplicação'

- **Status:** ⏸️ Documentado em 2026-04-28 durante Commit 2/3 da refatoração v3
- **Prioridade:** Baixa (validação estrutural cobre o essencial)

### Contexto

`QUALITY_CRITERIA.limites_narrativa` em [api/_helpers/blublu-personality.js](../api/_helpers/blublu-personality.js) define limites de extensão pros campos dos atos 1-4 (`blublu_intro`, `conteudo_principal`, `blublu_outro`). Highlights agora têm validação **semântica adaptativa** (`validateHighlight` + `HIGHLIGHT_QUALITY` no Commit 3) — basta substância (número, comando, termo técnico, comparação ou palavra ≥5 chars) — sem piso/teto de chars.

Modo 'aplicação' (ato_5 + sugestões + quiz) tem schema diferente e ficou sem limites de extensão pra evitar piorar UX com calibração mal-feita.

### Pendência concreta

**Adicionar limites para modo 'aplicação'** — depois de coletar amostras reais, calibrar `blublu_intro/outro` do ato_5 + `sugestoes.descricao/exemplo_pratico` + `quiz.perguntas[].pergunta/comentario_*`. Hoje só validação estrutural (campos presentes), sem extensão.

### Gatilhos pra retomar

- 30+ análises v3 geradas em prod com logs de quality gate disponíveis
- OU primeiro relato de "ato 5 saiu vago" / "quiz superficial demais"
- OU dia 30 após ativação v3 (revisão de calibração de rotina)

---

## Sprint 1 + 1.5 (Stripe Multi-currency) — pendências residuais

- **Status:** ⏸️ Documentado em 2026-04-25 durante Sprint 1.5
- **Prioridade:** variada
- **Contexto:** Sprint 1 introduziu multi-currency no checkout (BRL/USD/EUR/GBP/CAD/AUD). Sprint 1.5 fixou Bug B (commission em moeda original em `affiliate_commissions.currency` + `affiliates.total_earnings_by_currency` JSONB). Ítens abaixo são gaps conhecidos não fixados nesta janela.

### 1. Smoke test real do webhook multi-currency — ALTA (pré-ads)

Webhook `applyCommissionCorrection` foi modificado pra ler `metadata.currency` (checkout) e `invoice.currency` (renewal). Validação por `node --check` + grep, mas zero teste com evento real. **Antes de ligar Meta Ads:** Felipe envia test event via [Stripe Dashboard](https://dashboard.stripe.com/webhooks) → endpoint `bluetubeviral.com/api/webhook` → "Send test event" `checkout.session.completed` com `metadata.currency='usd'` + `amount_total=1499`. Confirma via Vercel Logs e SELECT em `affiliate_commissions WHERE currency='USD'`.

### 2. Bug A — pioneiros_indicacoes.valor_mensal hardcoded BRL — BAIXA

[webhook.js:549](../api/webhook.js#L549) grava `valor_mensal: plan === 'master' ? 89.99 : 29.99` (BRL fixo). Pioneiro indicando user USD vai distorcer relatório de Pioneiros. Hoje programa Pioneiros é BR-only (todos pioneiros são afiliados BR), risco baixo. Fixar quando volume internacional indicar — usar `paidAmount` que já vem em moeda original do `session.amount_total / 100`.

### 3. Bug C — admin email "R$" em qualquer currency — BAIXA (cosmético)

[webhook.js:273](../api/webhook.js#L273) e [#441](../api/webhook.js#L441) — `notifyStripe` mostra `R$${valor}` sem checar moeda. Email só pra Felipe ver, não chega em user. Fix trivial: map `currencySymbols` por código + concatenar. Adiar até incomodar visualmente.

### 4. affiliate.js handlers órfãos — MÉDIA

[affiliate.js:390-456](../api/affiliate.js#L390) (`?action=conversion`) e [affiliate.js:459-514](../api/affiliate.js#L459) (`?action=renewal`) gravam `total_earnings` (numeric BRL) sem multi-currency. Hoje **zero callers** no código atual (`webhook.js` chama `/api/auth?action=conversion`, não affiliate.js). Se voltar a ser usado (ex: `affiliate-robustness.js` reconcile), precisa mesma adaptação que `applyCommissionCorrection`. Verificar antes de ligar callers.

### 5. affiliate-robustness.js reconcile — MÉDIA

[affiliate-robustness.js:429](../api/affiliate-robustness.js#L429) tem `PLAN_AMOUNTS = { full: 29.99, master: 89.99 }` hardcoded BRL. Reconciliação de comissão perdida (rede falhou no webhook → cron repara depois) vai gravar valor errado se assinatura original era em USD/EUR/etc. Fix: ler `paidAmount` e `currency` do Stripe via `subscription.latest_invoice` em vez de assumir BRL. Fixar antes de programa expandir geograficamente OU se primeiro caso real aparecer.

### 6. Saque internacional pra afiliados — BAIXA

Hoje saque é Pix BR via Asaas ([affiliate-saques.js](../api/affiliate-saques.js)). Comissões em USD/EUR/GBP/CAD/AUD acumulam em `total_earnings_by_currency` mas **não saem** como saque até implementarmos opção internacional. Painel afiliado mostra moedas separadas com label "Saque internacional em breve" pras estrangeiras. Implementar via Wise (custo baixo, mas onboard friction) ou Stripe Connect (caro mas integrado) quando >10 afiliados estrangeiros OU pedido formal de saque chegar.

### Gatilho geral pra retomar

Cada item tem gatilho próprio. Em geral: monitorar Vercel Logs após primeiros checkouts USD/EUR + auditoria mensal de `affiliate_commissions` agrupado por currency.

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

## Privacy v2.0 + Termos v2.0 — pendencias residuais (publicacao 2026-04-25)

- **Status:** ⏸️ Documentado em 2026-04-25 durante publicacao docs v2.0
- **Prioridade:** variada

### 1. Aviso prévio aos usuários sobre v2.0 — MEDIA

Privacy Policy v2.0 publicada SEM aviso prévio aos usuários. LGPD Art. 8 §6º recomenda aviso de 30 dias para alterações materiais. Decisao Felipe: publicar direto, dado que mudancas v2.0 sao melhorias (mais transparencia, novos endpoints LGPD-compliant, melhor seguranca declarada) e nao restringem direitos.

Risco baixo MAS se algum usuario reclamar:
- Disparar email blast retroativo informando "Atualizamos nossa Politica de Privacidade. Principais mudancas: [lista]. Voce pode revisar em /privacidade. Continuar usando o servico apos 30 dias = aceite."
- Documentar email enviado pra defesa em caso de questionamento ANPD

### 2. Atualizar nome fantasia BlueTube na Receita Federal — BAIXA

Apos aprovacao do nome fantasia BlueTube oficial no CNPJ 65.260.227/0001-11 (atualmente "em processo de adicao"), atualizar referencias em ambos docs (privacidade.html + termos.html) removendo a nota "(em processo de adiçao junto à Receita Federal)".

### 3. Migrar email pra dominio proprio — MEDIA

Quando criar email contato@bluetubeviral.com (atualmente nao existe), atualizar references em ambos docs trocando bluetubeoficial@gmail.com pelo email oficial. Mesma logica que ja documentei para Fix 4 (unsubscribe).

### 4. Encoding mojibake na publicacao v2.0 — RESOLVIDO

Conteudo dos 2 HTMLs chegou com mojibake (UTF-8 duplo-decodificado: `Política`, `Última atualização`, `Â·`, `â`, `Â©`). Corrigido em 2026-04-25 via tabela targetada de replacements (10 patterns lowercase + 3 uppercase + 3 special chars + em-dash). Backups dos arquivos pre-conversao em _backups/privacidade.html.bak-20260425 e termos.html.bak-20260425.

### 5. Restore real funcional — JA DOCUMENTADO em Fix 7

Privacy Policy v2.0 menciona "exclusao em ate 15 dias com cascata em todas as tabelas". Restore funcional do backup nao foi implementado (Fix 7 pendencia 4). Se algum incidente exigir restore real, sera trabalho sob demanda.

---

## Fix 7 — pendencias residuais

- **Status:** ⏸️ Documentado em 2026-04-25 durante Fix 7
- **Prioridade:** variada

### 1. Rotacionar `ENCRYPTION_KEY_BACKUPS` em 12 meses (~abril 2027) — BAIXA
Mesma cadencia da `ENCRYPTION_KEY_AFFILIATES`. Procedimento: gerar nova chave, adicionar como `ENCRYPTION_KEY_BACKUPS_NEW`, decrypt-com-velha + encrypt-com-nova num script novo, trocar var, remover ref velha.

### 2. Migrar pra Supabase Pro (snapshots nativos encrypted) — MEDIA
Snapshots Supabase Pro sao automatic encrypted at-rest pelo proprio provider. Quando volume justificar (50+ assinantes pagos), migrar e remover blue-backup.js custom. Mantem nosso backup como redundancia.

### 3. Storage off-platform (S3/R2) pra backup-de-backup — BAIXA
Defesa em profundidade contra falha catastrofica do Supabase. Cron mensal copia ultimo backup encrypted pra bucket externo. Custos: ~$0.02/mes pra ~150MB.

### 4. Implementar restore real funcional — MEDIA
Atual `restaurar` so retorna JSON descriptografado, NAO escreve no DB. Pra recovery real, precisa: parse JSON + UPSERT em cada tabela na ordem certa (FK dependencies) + truncate-e-restore opcional. Trabalho considerável — fazer quando primeira necessidade real aparecer.

### 5. AUDITAR todos os buckets do projeto — ALTA
Fix 7 descobriu que `blue-videos` era publico (esperado pra videos) MAS recebia backups (nao deveria). Verificar TODOS buckets:
```sql
SELECT id, name, public, file_size_limit FROM storage.buckets;
```
Pra cada `public=true`, justificar publicamente OR mover dados sensiveis pra bucket privado. Bucket `blue-videos` deve continuar publico (videos sao publicos) mas NUNCA mais receber dados nao-publicos.

### 6. Considerar criar bucket `blue-creator-uploads` privado — BAIXA
Pra contas Stripe Connect ou docs de verificacao de identidade que possam aparecer no futuro. Hoje nao usado, mas aparecera junto de KYC se BlueTube crescer.

---

## Fix 6 — pendencias residuais

- **Status:** ⏸️ Documentado em 2026-04-25 durante Fix 6
- **Prioridade:** Media (algumas), Baixa (outras)

### 1. Evoluir Op A → Op B (birth_date real) — BAIXA
Caso precisar segmentacao demografica ou compliance especifica (publishers de app de criancas, parceiros B2B). Requer migration adicional + UI date picker + recalculo de idade no Postgres.

### 2. Gate `age_confirmed=true` em endpoints sensiveis — MEDIA
Atualmente persistencia e silenciosa. Ideal: bloquear `/api/affiliate-saques?action=solicitar-saque` e `/api/cancel-subscription` se age_confirmed=false. Quando: volume passar de ~50 signups/mes (sinal de adocao real, possivel risco de fraude por menores).

### 3. Modal pos-OAuth Google pra confirmacao de idade — BAIXA
Hoje 0 usuarios via Google. Se Felipe habilitar OAuth Google como metodo principal: bloqueador. Implementar tela "antes de continuar, confirme idade" no callback OAuth.

### 4a. Reconfirmar idade pra base pre-backfill — MEDIA

Backfill silencioso do Fix 6 (2026-04-25) cobriu **172 subscribers** — bem mais que os ~16 estimados. A justificativa "early adopters todos conhecidos" nao escala 100%. Risco real avaliado como baixo (publico criador de Shorts skew 18+, aquisicao Meta/Google default 18+), mas:

Pra robustez extra, implementar prompt no proximo login pra subscribers com `age_confirmed_at < '2026-04-25'`:
- Modal "Confirme: voce tem 16 anos ou mais?"
- Se nao, soft-block + opcao "Tenho menos, deletar conta"
- Apos confirmar, atualiza age_confirmed_at = NOW

Quando: se aparecer reclamacao real OU campanha de compliance especifica (parceria B2B, app stores).

### 4b. Auditoria periodica — MEDIA
Query SQL semanal: `SELECT COUNT(*) FROM subscribers WHERE age_confirmed=false`. Se > 5% dos novos signups dos ultimos 30 dias estao FALSE → investigar (curl direto, bug no fluxo, etc). Pode virar cron alert.

### 5. Resync background no app launch — BAIXA
Atualmente: signup chama confirm-age (3 retries fail-soft) + cada login chama confirm-age (silent). Faltante: chamada periodica em useAuthStore.init pra cobrir users que nem fizeram login no app desde o deploy. Improvavel necessario com a estrategia atual.

### 6. Auditoria sistematica de TODOS os action names — ALTA
Bugs `verify-otp`/`verify_otp`, `forgot-password`/`reset_password`, `resend-otp`/`send_otp` foram corrigidos no Fix 6. Mas o padrao "hand-rolled fetch chama auth.js sem espelhar contrato" pode ter mais ocorrencias em outros endpoints (blue-*, affiliate*, etc). Auditoria completa: cada `fetch(..., body: { action: ... })` no app vs handler `if (action === '...')` no backend.

### 7. `blueAPI.refresh` dead code — BAIXA
[bluetube-app/src/api/index.js:63](../bluetube-app/src/api/index.js#L63) define `blueAPI.refresh` que chama auth.js com `action: 'refresh'` (nao existe). Comentario inline marca como dead code. Refresh real e via `refreshSession()` standalone (Fix 1, ec680c3). Remover quando confirmado que nenhum codigo futuro tentou usar.

---

## Backfill `affiliates.user_id` pra robustez long-term

- **Status:** ⏸️ Pausado em 2026-04-25 (decisão pragmática durante Fix 3.1)
- **Prioridade:** Baixa (sistema funciona com email hoje)
- **Pausado por:** afiliados sao identificados por email no codigo todo. user_id existe na tabela mas e null pra todos. Refator pra user_id exige migration + update em 4+ arquivos.

### Contexto

[api/affiliate-saques.js:123](../api/affiliate-saques.js#L123), [api/affiliate.js:175 e outros](../api/affiliate.js#L175), [api/v1/user-export.js:200](../api/v1/user-export.js#L200) — todos lookup affiliates por email. Funciona enquanto BlueTube nao expoe UI de troca de email pro user.

### Risco hoje

Zero — Supabase auth permite via API mas nao temos endpoint que troca email do user. Se um dia alguem chamar `/auth/v1/user` direto pra trocar email, dados de afiliacao ficam orfaos.

### Proposta

```sql
-- 1. Backfill user_id matching email
UPDATE affiliates a
SET user_id = u.id
FROM auth.users u
WHERE a.email = u.email AND a.user_id IS NULL;

-- 2. Adicionar NOT NULL constraint depois de validar 100% backfill
-- ALTER TABLE affiliates ALTER COLUMN user_id SET NOT NULL;
```

Atualizar todos lookups pra preferir user_id quando disponivel:
```js
// affiliates?or=(user_id.eq.${uid},email.eq.${email})&select=*&limit=1
```

### Gatilho

- Implementacao de UI de troca de email
- OU refator de schema de affiliates por outro motivo
- OU primeira reclamacao de "perdi meus dados de afiliado depois de trocar email" (improvavel)

---

## Rotacionar `ENCRYPTION_KEY_AFFILIATES` em 12 meses (~2027-04)

- **Status:** ⏸️ Aguardando deadline (deploy Fix 5 em 2026-04-25 + 365 dias)
- **Prioridade:** Baixa (rotina security best-practice)
- **Pausado por:** chave gerada hoje, sem incidente, rotacao preventiva.

### Procedimento de rotacao

1. Gerar nova chave: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Adicionar ao Vercel como `ENCRYPTION_KEY_AFFILIATES_NEW` (sensitive, P+P)
3. Adaptar [_helpers/crypto.js](../api/_helpers/crypto.js) pra suportar 2 chaves: NEW pra escrita, OLD pra leitura legacy
4. Rodar migration que decifra com OLD + cifra com NEW
5. Verificar zero rows com prefix legacy
6. Trocar `ENCRYPTION_KEY_AFFILIATES = NEW`, remover `_NEW` e referencia OLD do codigo
7. Backup pessoal da nova chave (regra do Fix 5)

### Gatilho

- Data >= 2027-04-25
- OU suspeita de comprometimento da chave atual
- OU mudanca de algoritmo (ex: pos-quantum)

---

## Considerar criptografar `tipo_chave_pix` em affiliates

- **Status:** ⏸️ Pausado em 2026-04-25 (decisão pragmática durante Fix 5)
- **Prioridade:** Muito baixa
- **Pausado por:** `tipo_chave_pix` e metadata (cpf|telefone|email|aleatoria), baixo valor pra atacante isoladamente.

### Justificativa pra adiar

Sem o valor da chave, saber so o TIPO nao expoe dado pessoal — e statistica agregada de plataforma (X% dos afiliados usam CPF, Y% telefone). Encriptar adiciona complexidade (decrypt em todo lugar que mostra "Tipo: CPF"). Custo > beneficio hoje.

### Gatilho pra retomar

- Defesa em profundidade exigida por compliance especifica (auditoria SOC2, cliente enterprise)
- Vazamento de tabela onde `tipo_chave_pix` ajude a perfilar usuarios

---

## DROP `affiliates_backup_pre_encrypt` + `affiliate_saques_backup_pre_encrypt` apos 30 dias

- **Status:** ⏸️ Aguardando deadline (Fix 5 deploy em 2026-04-25 + 30 dias)
- **Prioridade:** Baixa (limpeza de tabelas backup com plaintext)

### Contexto

Felipe rodou backup SQL antes da migration Fix 5:

```sql
CREATE TABLE affiliates_backup_pre_encrypt AS SELECT * FROM affiliates;
CREATE TABLE affiliate_saques_backup_pre_encrypt AS SELECT * FROM affiliate_saques;
```

Essas tabelas contem `chave_pix` em **plaintext** — exatamente o que Fix 5 queria eliminar. Manter por 30 dias garante rollback de emergencia, depois sao risco de seguranca.

### Acao

```sql
DROP TABLE IF EXISTS affiliates_backup_pre_encrypt;
DROP TABLE IF EXISTS affiliate_saques_backup_pre_encrypt;
```

### Gatilho

- Data >= 2026-05-25 E migration validada estavel sem necessidade de rollback
- Confirmar 1x via endpoint `/api/v1/migrate-encrypt-affiliate?action=status` que zero rows tem chave_pix legacy plaintext

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
