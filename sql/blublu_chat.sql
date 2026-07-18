-- ═══════════════════════════════════════════════════════════════════════════
-- BLUBLU CHAT (Falar com o Blublu na Virais) — 2026-07-18
-- Rodar no SQL Editor do Supabase. Idempotente (pode rodar 2x sem quebrar).
-- 3 tabelas novas + extensão vector + função de busca. RLS: negado pra anon
-- (acesso só via service key nas APIs), seguindo o lockdown de 2026-07-17.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Uso diário do chat (limite 60 msgs/dia por usuário)
create table if not exists blublu_chat_usage (
  user_id uuid not null,
  dia date not null default current_date,
  count int not null default 0,
  primary key (user_id, dia)
);
alter table blublu_chat_usage enable row level security;

-- 2) Cache PERMANENTE de transcrições (camada de confirmação do Blublu).
--    Preenchida sob demanda pelas buscas; cada tema pesquisado enriquece o
--    banco pra sempre. segments = [{t: segundos, x: "texto"}] pro "citado aos X:XX".
create table if not exists virais_transcricoes (
  youtube_id text primary key,
  transcript text,
  segments jsonb,
  lang text,
  fonte text,
  sem_legenda boolean not null default false,
  criado_em timestamptz not null default now()
);
alter table virais_transcricoes enable row level security;
create index if not exists idx_vtransc_criado on virais_transcricoes (criado_em desc);
-- Busca por texto dentro da fala (acento-insensível via unaccent se disponível)
create extension if not exists pg_trgm;
create index if not exists idx_vtransc_trgm on virais_transcricoes using gin (transcript gin_trgm_ops);

-- 3) Embeddings dos títulos (busca semântica — camada opcional, ativa quando
--    OPENAI_API_KEY existir; a busca funciona sem ela via termos exatos)
create extension if not exists vector;
create table if not exists virais_embeddings (
  youtube_id text primary key,
  titulo text,
  embedding vector(1536),
  atualizado_em timestamptz not null default now()
);
alter table virais_embeddings enable row level security;
create index if not exists idx_vemb_ivf on virais_embeddings
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- 4) Função de busca semântica com filtros (chamada via RPC pela API)
create or replace function blublu_match_videos(
  query_embedding vector(1536),
  match_count int default 40,
  min_views bigint default 0,
  desde timestamptz default null
)
returns table (youtube_id text, similarity float)
language sql stable
as $$
  select e.youtube_id, 1 - (e.embedding <=> query_embedding) as similarity
  from virais_embeddings e
  join virais_banco b on b.youtube_id = e.youtube_id
  where (min_views = 0 or b.views >= min_views)
    and (desde is null or b.publicado_em >= desde)
  order by e.embedding <=> query_embedding
  limit match_count;
$$;
