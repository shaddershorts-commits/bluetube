-- Comentários com respostas aninhadas + curtidas (2026-07-15)
-- Rodar no Supabase SQL Editor.

-- Respostas: parent_id aponta pro comentário-pai (null = comentário raiz)
alter table blue_comments add column if not exists parent_id uuid references blue_comments(id) on delete cascade;
-- Contador de curtidas do comentário (mantido pelo backend)
alter table blue_comments add column if not exists likes int default 0;
create index if not exists idx_blue_comments_parent on blue_comments(parent_id);

-- Curtidas por comentário (idempotência via unique)
create table if not exists blue_comment_likes (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references blue_comments(id) on delete cascade,
  user_id uuid not null,
  created_at timestamptz default now(),
  unique(comment_id, user_id)
);
create index if not exists idx_blue_comment_likes_user on blue_comment_likes(user_id);
