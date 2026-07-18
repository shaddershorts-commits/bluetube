-- Blublu Chat: perfil + memória por usuário (2026-07-18)
-- apelido: como a pessoa quer ser chamada (Blublu pergunta no 1º contato)
-- memoria: contexto que o Blublu acumula (temas recentes, nº de buscas, flags)
create table if not exists blublu_perfil (
  user_id uuid primary key,
  apelido text,
  memoria jsonb not null default '{}'::jsonb,
  primeiro_contato timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
alter table blublu_perfil enable row level security;
