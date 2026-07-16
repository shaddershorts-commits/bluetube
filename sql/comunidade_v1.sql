-- Comunidade BlueTube v1 — feed estilo X exclusivo de pagantes (2026-07-15)
-- Rodar no Supabase SQL Editor.

create table if not exists community_profiles (
  user_id uuid primary key,
  email text,
  display_name text unique,
  avatar_url text,
  is_moderator boolean default false,
  banned boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists community_posts (
  id uuid primary key,
  user_id uuid not null,
  tab text not null default 'comunidade', -- 'dicas' (só moderador) | 'comunidade'
  content text default '',
  media jsonb default '[]'::jsonb,        -- [{type:'image'|'video'|'audio', url, thumb}]
  pinned boolean default false,
  likes_count int default 0,
  comments_count int default 0,
  deleted boolean default false,
  edited_at timestamptz,
  created_at timestamptz default now()
);
create index if not exists idx_cposts_feed on community_posts (tab, pinned desc, created_at desc);
create index if not exists idx_cposts_user on community_posts (user_id, created_at desc);

create table if not exists community_comments (
  id uuid primary key,
  post_id uuid not null,
  user_id uuid not null,
  content text not null,
  deleted boolean default false,
  edited_at timestamptz,
  created_at timestamptz default now()
);
create index if not exists idx_ccomments_post on community_comments (post_id, created_at);

create table if not exists community_likes (
  post_id uuid not null,
  user_id uuid not null,
  created_at timestamptz default now(),
  primary key (post_id, user_id)
);

-- Acesso só via service key da API (RLS ligado sem policies bloqueia anon).
alter table community_profiles enable row level security;
alter table community_posts enable row level security;
alter table community_comments enable row level security;
alter table community_likes enable row level security;

-- Moderador: shaddershorts (anel + selo dourado, editar/apagar/fixar/banir).
insert into community_profiles (user_id, email, display_name, is_moderator)
select id, email, 'BlueTube', true from auth.users where email = 'shaddershorts@gmail.com'
on conflict (user_id) do update set is_moderator = true;
