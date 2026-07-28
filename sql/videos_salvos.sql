-- sql/videos_salvos.sql — Vídeos salvos na Virais (2026-07-28)
-- ============================================================================
-- O usuário marca o vídeo (ícone dourado no card) em qualquer plataforma
-- (YouTube / TikTok / Instagram) e consulta depois no perfil → "Vídeos Salvos".
--
-- Guarda um retrato do vídeo (título, thumb, autor, views) para a lista não
-- depender de re-buscar cada item — e continuar funcionando mesmo que o vídeo
-- saia do acervo de virais.
--
-- Rodar no SQL Editor do Supabase (uma vez). Idempotente.

create table if not exists public.videos_salvos (
  user_id     text not null,
  video_id    text not null,          -- youtube_id | tiktok_video_id | shortcode
  plataforma  text not null,          -- youtube | tiktok | instagram
  titulo      text,
  thumbnail   text,
  canal       text,
  url         text,
  views       bigint,
  salvo_em    timestamptz default now(),
  primary key (user_id, plataforma, video_id)
);

create index if not exists idx_salvos_user on public.videos_salvos (user_id, salvo_em desc);

alter table public.videos_salvos enable row level security;
