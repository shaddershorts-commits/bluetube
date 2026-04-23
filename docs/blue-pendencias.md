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

<!-- 
  Pra adicionar novas pendências, duplicar o bloco acima mantendo o padrão:
  título curto, status, prioridade, pausado por, causa raiz, arquitetura,
  gatilhos. Mais novas no topo (após as mais prioritárias).
-->
