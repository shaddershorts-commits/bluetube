-- sql/bluescore_pedidos.sql — BlueScore feito por gente (2026-08-06)
-- ===========================================================================
-- O BlueScore deixou de ser nota calculada por fórmula: agora o usuário pede,
-- entra numa fila, e QUEM ANALISA É O DONO — ex-suporte do YouTube. Esta
-- tabela é a fila e o laudo ao mesmo tempo.
--
-- Uma linha por pedido. O `laudo` guarda tudo que o admin preencheu, em JSON,
-- porque o formulário vai mudar com o tempo e migração de coluna a cada ajuste
-- de campo seria um pé no saco — o que não pode mudar (dono, status, datas)
-- tem coluna de verdade.
--
-- RODAR NO SQL EDITOR DO SUPABASE.

create table if not exists public.bluescore_pedidos (
  id            uuid primary key default gen_random_uuid(),
  -- dono do pedido: user_id é o que o sininho usa (blue_notificacoes.user_id)
  user_id       uuid        not null,
  email         text        not null,
  nome          text,
  plano         text,
  -- youtube | tiktok | instagram
  rede          text        not null default 'youtube',
  perfil_url    text        not null,
  perfil_handle text,
  -- na_fila → em_analise → entregue   (ou recusado, quando o link não presta)
  status        text        not null default 'na_fila',
  motivo_recusa text,
  -- laudo completo preenchido no admin (ver formato em api/bluescore.js)
  laudo         jsonb,
  -- o usuário marcou pra guardar na coleção dele
  salvo         boolean     not null default false,
  criado_em     timestamptz not null default now(),
  entregue_em   timestamptz,
  atualizado_em timestamptz not null default now()
);

-- histórico do usuário (a tela dele ordena por data desc)
create index if not exists bluescore_pedidos_user_idx
  on public.bluescore_pedidos (user_id, criado_em desc);

-- fila do admin: os que ainda precisam de trabalho vêm primeiro
create index if not exists bluescore_pedidos_fila_idx
  on public.bluescore_pedidos (status, criado_em)
  where status in ('na_fila', 'em_analise');

-- contagem do limite diário — sempre filtra por email + data
create index if not exists bluescore_pedidos_cota_idx
  on public.bluescore_pedidos (email, criado_em desc);

-- Só o backend (service key) escreve e lê. Sem policy pra anon = ninguém
-- enxerga o laudo de outra pessoa pelo cliente.
alter table public.bluescore_pedidos enable row level security;
