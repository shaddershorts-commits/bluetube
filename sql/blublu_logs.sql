-- Blublu Chat: log de uso pra análise de produto (2026-07-18)
-- Cada mensagem: o que o usuário pediu, o que a busca entendeu e o que entregou.
-- É com isso que analisamos qualidade das buscas e melhoramos o funil.
create table if not exists blublu_chat_logs (
  id bigint generated always as identity primary key,
  user_id uuid,
  mensagem text,
  tema text,
  termos jsonb,
  qualificadores jsonb,
  filtros jsonb,
  entregues int,
  confirmados_fala int,
  com_relevancia int,
  usou_busca boolean,
  criado_em timestamptz not null default now()
);
alter table blublu_chat_logs enable row level security;
create index if not exists idx_bblogs_criado on blublu_chat_logs (criado_em desc);
