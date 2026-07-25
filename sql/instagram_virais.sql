-- sql/instagram_virais.sql — Instagram Virais (2026-07-25)
-- ============================================================================
-- Ferramenta Virais: seção Instagram (botão rosa ao lado do TikTok).
-- Coleta via conta descartável (cookies) — o BANCO é a fonte da verdade:
-- se a conta cair, tudo que está aqui continua sendo exibido normalmente.
--
-- Rodar no SQL Editor do Supabase (uma vez). Idempotente.

-- ── Vídeos coletados ────────────────────────────────────────────────────────
create table if not exists public.instagram_virais (
  shortcode          text primary key,          -- código do post (DXz.../C_j...)
  media_pk           text,                      -- id numérico interno do IG
  video_url          text not null,             -- https://www.instagram.com/reel/<code>/
  thumbnail_url      text,                      -- URL cacheada no NOSSO storage (blindagem)
  caption            text,
  author_handle      text,
  author_name        text,
  author_pk          text,
  views_count        bigint default 0,
  likes_count        bigint default 0,
  comments_count     bigint default 0,
  duration_sec       numeric,
  ig_created_at      timestamptz,               -- data de postagem no Instagram
  fonte              text default 'manual',     -- 'manual' (URL colada) | 'perfil' (coletor)
  source_profile     text,                      -- username do perfil monitorado (se fonte=perfil)
  status             text default 'active',
  last_error         text,                      -- último erro de refresh (diagnóstico; NUNCA esconde o vídeo)
  metrics_updated_at timestamptz,               -- última atualização de views/likes
  collected_at       timestamptz default now(),
  last_seen_at       timestamptz default now()
);

create index if not exists idx_igv_status_collected on public.instagram_virais (status, collected_at desc);
create index if not exists idx_igv_views  on public.instagram_virais (views_count desc);
create index if not exists idx_igv_likes  on public.instagram_virais (likes_count desc);
create index if not exists idx_igv_metrics_stale on public.instagram_virais (metrics_updated_at asc nulls first);

-- ── Perfis monitorados (coleta automática dos Reels recentes) ───────────────
create table if not exists public.instagram_perfis (
  username          text primary key,
  user_pk           text,                       -- id numérico (resolvido na hora de adicionar)
  full_name         text,
  active            boolean default true,
  last_collected_at timestamptz,
  last_error        text,
  added_at          timestamptz default now()
);

-- ── RLS: NENHUMA policy = só service_role acessa (leitura vai via API) ──────
alter table public.instagram_virais enable row level security;
alter table public.instagram_perfis enable row level security;

-- ── Bucket de thumbnails (público; conteúdo é só imagem de capa) ────────────
-- Thumbs do fbcdn EXPIRAM (URL assinada) — por isso cacheamos no nosso storage.
insert into storage.buckets (id, name, public)
values ('instagram-thumbs', 'instagram-thumbs', true)
on conflict (id) do nothing;
