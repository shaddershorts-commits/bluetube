-- sql/activation_offers.sql — Oferta de Ativação Master 50% x2 meses (2026-07-27)
-- ============================================================================
-- Fonte da verdade da oferta única pós-cadastro. O banco decide tudo:
-- limpar cookie/localStorage NÃO ressuscita a oferta (anti-burla).
--
-- Ciclo de vida: shown → accepted → converted (pagou)
--                shown → declined (fechou/recusou — definitivo)
--                shown → expired  (15min passaram)
--
-- Rodar no SQL Editor do Supabase (uma vez). Idempotente.

create table if not exists public.activation_offers (
  email       text primary key,
  user_id     text,
  status      text default 'shown',
  shown_at    timestamptz default now(),
  expires_at  timestamptz not null,
  decided_at  timestamptz,
  checkout_session_id text
);

create index if not exists idx_actoffer_status on public.activation_offers (status);

-- RLS: NENHUMA policy = só service_role (toda leitura/escrita via API)
alter table public.activation_offers enable row level security;
