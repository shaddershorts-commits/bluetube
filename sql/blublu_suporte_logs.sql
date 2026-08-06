-- sql/blublu_suporte_logs.sql — logs do "Como usar?" da Comunidade
-- ===========================================================================
-- Guarda pergunta e resposta do agente de suporte. Serve pra auditar QUALIDADE:
-- é lendo conversa real que a gente descobre onde ele ensina errado, onde
-- inventa tela que não existe, e onde a pessoa fica sem resposta.
-- Mesma prática que já usamos no chat da Virais (blublu_chat_logs).
--
-- RODAR NO SQL EDITOR DO SUPABASE.

create table if not exists public.blublu_suporte_logs (
  id          uuid primary key default gen_random_uuid(),
  email       text        not null,
  plano       text,
  pergunta    text        not null,
  resposta    text,
  turnos      int,
  modelo      text,
  -- preenchido depois, na auditoria: 'boa' | 'ruim' | null
  avaliacao   text,
  criado_em   timestamptz not null default now()
);

create index if not exists blublu_suporte_logs_criado_idx
  on public.blublu_suporte_logs (criado_em desc);
create index if not exists blublu_suporte_logs_email_idx
  on public.blublu_suporte_logs (email);

-- Tabela só de leitura de serviço: o endpoint escreve com a service key.
-- Sem policy pra anon = ninguém lê conversa de outro usuário pelo cliente.
alter table public.blublu_suporte_logs enable row level security;
