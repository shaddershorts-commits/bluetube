-- Comunidade v2 — comentários com curtidas, respostas e fixado (2026-07-16)
-- Rodar no Supabase SQL Editor (delta sobre comunidade_v1.sql).

alter table community_comments add column if not exists parent_id uuid;
alter table community_comments add column if not exists likes_count int default 0;
alter table community_comments add column if not exists pinned boolean default false;
create index if not exists idx_ccomments_parent on community_comments (parent_id);

create table if not exists community_comment_likes (
  comment_id uuid not null,
  user_id uuid not null,
  created_at timestamptz default now(),
  primary key (comment_id, user_id)
);
alter table community_comment_likes enable row level security;
