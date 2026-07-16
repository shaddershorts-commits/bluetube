-- Figurinhas salvas do app Blue (GIFs favoritos pra reenviar) — 2026-07-16
create table if not exists blue_stickers (
  user_id uuid not null,
  url text not null,
  created_at timestamptz default now(),
  primary key (user_id, url)
);
create index if not exists idx_blue_stickers_user on blue_stickers (user_id, created_at desc);
alter table blue_stickers enable row level security;
