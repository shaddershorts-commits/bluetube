-- Chat v3 — grupos com ADM, fixar/apagar conversa, novos contatos,
-- apagar/editar mensagem (2026-07-16). Rodar no Supabase SQL Editor.

-- ── Grupos: personalização + sistema de admin + só-admins ──────────────────
alter table blue_grupos add column if not exists descricao text;
alter table blue_grupos add column if not exists only_admins boolean default false;
alter table blue_grupo_membros add column if not exists role text default 'membro';
-- criador vira admin (retroativo)
update blue_grupo_membros m set role = 'admin'
  from blue_grupos g
 where g.id = m.grupo_id and g.criador_id = m.user_id and m.role is distinct from 'admin';

-- ── Mensagens 1:1: apagar pra todos / pra mim / edição ──────────────────────
alter table blue_messages add column if not exists deleted_for_all boolean default false;
alter table blue_messages add column if not exists deleted_for jsonb default '[]'::jsonb;
alter table blue_messages add column if not exists edited_count int default 0;
alter table blue_messages add column if not exists edited_at timestamptz;

-- ── Mensagens de grupo: idem ────────────────────────────────────────────────
alter table blue_grupo_mensagens add column if not exists deleted_for_all boolean default false;
alter table blue_grupo_mensagens add column if not exists deleted_for jsonb default '[]'::jsonb;
alter table blue_grupo_mensagens add column if not exists edited_count int default 0;
alter table blue_grupo_mensagens add column if not exists edited_at timestamptz;

-- ── Conversas: quem iniciou (pra aba Novos contatos) ────────────────────────
alter table blue_conversations add column if not exists initiator_id uuid;

-- ── Preferências por usuário: fixar e apagar conversa ───────────────────────
create table if not exists blue_conv_prefs (
  user_id uuid not null,
  conv_id uuid not null,
  pinned boolean default false,
  cleared_at timestamptz,
  primary key (user_id, conv_id)
);
alter table blue_conv_prefs enable row level security;

-- ── Contatos (quem eu "adicionei" — request aceita) ─────────────────────────
create table if not exists blue_contatos (
  user_id uuid not null,
  contato_id uuid not null,
  created_at timestamptz default now(),
  primary key (user_id, contato_id)
);
alter table blue_contatos enable row level security;

-- Conversas EXISTENTES viram contatos mútuos (ninguém cai em "Novos contatos"
-- retroativamente — o fluxo de request vale só pra conversas novas)
insert into blue_contatos (user_id, contato_id)
select user1_id, user2_id from blue_conversations where user2_id is not null
on conflict do nothing;
insert into blue_contatos (user_id, contato_id)
select user2_id, user1_id from blue_conversations where user1_id is not null
on conflict do nothing;
