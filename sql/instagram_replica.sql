-- sql/instagram_replica.sql — RÉPLICA de Reels (2026-08-10)
-- ============================================================================
-- POR QUE ISSO EXISTE
-- A coleta antiga varre o Instagram LOGADA (cookies de conta descartável).
-- Os cookies expiram, a conta é bloqueada e a página fica vazia. Pior: as URLs
-- de imagem da Meta (fbcdn/cdninstagram) são ASSINADAS e EXPIRAM — até o que
-- foi coletado com sucesso quebra visualmente depois de alguns dias.
--
-- A réplica inverte o jogo: o dono cola o link, o sistema captura o que der da
-- página PÚBLICA (sem cookie, sem login), o dono completa/corrige à mão, a
-- imagem é BAIXADA e hospedada no NOSSO storage, e o registro fica CONGELADO —
-- nunca mais consultamos o Instagram por causa dele. O clique no card leva ao
-- post original.
--
-- Consequência honesta: a métrica não é mais "ao vivo". Por isso guardamos a
-- DATA da medição e o card mostra "12,4 mi · medido em 11/08". Número parado
-- fingindo ser ao vivo é mentira.
--
-- Rodar no SQL Editor do Supabase (uma vez). Idempotente — pode rodar de novo.
-- Depende de sql/instagram_virais.sql (tabela base).

-- ── Colunas novas em instagram_virais ───────────────────────────────────────
-- Nenhuma delas é NOT NULL: linhas antigas continuam válidas e o código trata
-- ausência (fallback) — rodar este SQL nunca quebra o que já está no ar.
alter table public.instagram_virais
  -- true = registro CONGELADO. O cron 'atualizar-metricas' PULA essas linhas,
  -- garantindo o requisito "nunca mais consulta o Instagram".
  add column if not exists congelado boolean default false,
  -- Quando o número foi medido de verdade (o dono viu na tela / captura
  -- pública). É ISSO que o card exibe — não confundir com metrics_updated_at,
  -- que o cron carimba mesmo quando a atualização FALHA.
  add column if not exists metrics_measured_at timestamptz,
  -- De onde veio a métrica: 'manual' (dono digitou) | 'og' (meta tags da
  -- página pública) | 'api' (coleta logada antiga) | 'nenhuma'
  add column if not exists metrics_source text,
  -- Classificação livre do dono (ex.: 'humor', 'pets', 'futebol'). Opcional.
  add column if not exists nicho text;

-- 'fonte' ganha um valor novo: 'replica' (além de 'manual' e 'perfil').
-- É text sem constraint, então não há nada a alterar — fica documentado aqui.

-- Índice do cron de métricas: ele agora filtra congelado <> true.
-- O índice antigo (idx_igv_metrics_stale) continua útil; este é o par exato
-- da nova query e evita varredura quando o acervo crescer.
create index if not exists idx_igv_metrics_stale_vivos
  on public.instagram_virais (metrics_updated_at asc nulls first)
  where congelado is not true;

-- Filtro por nicho na vitrine (só linhas que têm nicho).
create index if not exists idx_igv_nicho
  on public.instagram_virais (nicho)
  where nicho is not null;

-- ── Backfill: o que já está no banco veio da coleta logada ──────────────────
-- Marca a procedência das linhas antigas sem mudar nada mais. Só preenche o
-- que está nulo — rodar de novo não sobrescreve.
update public.instagram_virais
   set metrics_source = 'api'
 where metrics_source is null;

-- congelado default false já cobre as linhas antigas (continuam sendo
-- atualizadas pelo cron enquanto os cookies funcionarem).
update public.instagram_virais
   set congelado = false
 where congelado is null;

-- ── Bucket de thumbnails ────────────────────────────────────────────────────
-- Já criado em sql/instagram_virais.sql; repetido aqui porque a réplica NÃO
-- funciona sem ele (a imagem hospedada por nós é o coração da tarefa).
-- Público: o conteúdo é só capa de post que já é público.
insert into storage.buckets (id, name, public)
values ('instagram-thumbs', 'instagram-thumbs', true)
on conflict (id) do nothing;

-- ── Conferência rápida (rode e olhe o resultado) ────────────────────────────
-- select fonte, metrics_source, congelado, count(*)
--   from public.instagram_virais group by 1,2,3 order by 4 desc;
