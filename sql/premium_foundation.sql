-- ============================================================================
-- sql/premium_foundation.sql — Features premium com Supabase Small
-- Habilita extensoes + indices full-text + preparacao pra pgvector (ML feed)
-- Rodar no Supabase SQL Editor. Idempotente.
-- ============================================================================

-- 1) EXTENSOES NECESSARIAS -----------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- busca fuzzy (typo tolerant)
CREATE EXTENSION IF NOT EXISTS unaccent;  -- ignora acentos na busca
CREATE EXTENSION IF NOT EXISTS vector;    -- embeddings + similarity search

-- 2) FULL-TEXT SEARCH em blue_videos -----------------------------------------
ALTER TABLE blue_videos
  ADD COLUMN IF NOT EXISTS search_tsv tsvector;

-- Funcao que gera tsvector combinando title + description + tags
CREATE OR REPLACE FUNCTION blue_videos_search_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('portuguese', unaccent(coalesce(NEW.title, ''))), 'A') ||
    setweight(to_tsvector('portuguese', unaccent(coalesce(NEW.description, ''))), 'B') ||
    setweight(to_tsvector('portuguese', unaccent(array_to_string(coalesce(NEW.tags, ARRAY[]::text[]), ' '))), 'C');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS blue_videos_tsv_trigger ON blue_videos;
CREATE TRIGGER blue_videos_tsv_trigger
  BEFORE INSERT OR UPDATE OF title, description, tags ON blue_videos
  FOR EACH ROW EXECUTE FUNCTION blue_videos_search_tsv_update();

-- Backfill dos existentes
UPDATE blue_videos SET updated_at = updated_at WHERE search_tsv IS NULL;

-- Indices pra full-text + trigram (fuzzy)
CREATE INDEX IF NOT EXISTS idx_blue_videos_search_tsv
  ON blue_videos USING gin(search_tsv);
CREATE INDEX IF NOT EXISTS idx_blue_videos_title_trgm
  ON blue_videos USING gin(title gin_trgm_ops);

-- 3) FULL-TEXT em virais_banco -----------------------------------------------
ALTER TABLE virais_banco
  ADD COLUMN IF NOT EXISTS search_tsv tsvector;

CREATE OR REPLACE FUNCTION virais_banco_search_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('portuguese', unaccent(coalesce(NEW.titulo, ''))), 'A') ||
    setweight(to_tsvector('portuguese', unaccent(coalesce(NEW.canal_nome, ''))), 'B') ||
    setweight(to_tsvector('portuguese', unaccent(coalesce(NEW.nicho, ''))), 'C');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS virais_banco_tsv_trigger ON virais_banco;
CREATE TRIGGER virais_banco_tsv_trigger
  BEFORE INSERT OR UPDATE OF titulo, canal_nome, nicho ON virais_banco
  FOR EACH ROW EXECUTE FUNCTION virais_banco_search_tsv_update();

UPDATE virais_banco SET atualizado_em = atualizado_em WHERE search_tsv IS NULL;

CREATE INDEX IF NOT EXISTS idx_virais_search_tsv
  ON virais_banco USING gin(search_tsv);
CREATE INDEX IF NOT EXISTS idx_virais_titulo_trgm
  ON virais_banco USING gin(titulo gin_trgm_ops);

-- 4) FULL-TEXT em blue_profiles ----------------------------------------------
ALTER TABLE blue_profiles
  ADD COLUMN IF NOT EXISTS search_tsv tsvector;

CREATE OR REPLACE FUNCTION blue_profiles_search_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('simple', unaccent(coalesce(NEW.username, ''))), 'A') ||
    setweight(to_tsvector('portuguese', unaccent(coalesce(NEW.display_name, ''))), 'A') ||
    setweight(to_tsvector('portuguese', unaccent(coalesce(NEW.bio, ''))), 'B');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS blue_profiles_tsv_trigger ON blue_profiles;
CREATE TRIGGER blue_profiles_tsv_trigger
  BEFORE INSERT OR UPDATE OF username, display_name, bio ON blue_profiles
  FOR EACH ROW EXECUTE FUNCTION blue_profiles_search_tsv_update();

UPDATE blue_profiles SET updated_at = updated_at WHERE search_tsv IS NULL;

CREATE INDEX IF NOT EXISTS idx_blue_profiles_search_tsv
  ON blue_profiles USING gin(search_tsv);
CREATE INDEX IF NOT EXISTS idx_blue_profiles_username_trgm
  ON blue_profiles USING gin(username gin_trgm_ops);

-- 5) PREPARACAO PRA EMBEDDINGS ML FEED ---------------------------------------
-- Cada video vira um vetor 1536-dim (OpenAI embedding ou pseudo-hash fallback)
ALTER TABLE blue_videos
  ADD COLUMN IF NOT EXISTS embedding vector(1536),
  ADD COLUMN IF NOT EXISTS embedding_generated_at TIMESTAMPTZ;

ALTER TABLE virais_banco
  ADD COLUMN IF NOT EXISTS embedding vector(1536),
  ADD COLUMN IF NOT EXISTS embedding_generated_at TIMESTAMPTZ;

-- Indice vector (ivfflat) pra similarity search rapida
-- Nota: ivfflat precisa de ANALYZE antes de funcionar bem
CREATE INDEX IF NOT EXISTS idx_blue_videos_embedding
  ON blue_videos USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
CREATE INDEX IF NOT EXISTS idx_virais_embedding
  ON virais_banco USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

-- Indice de controle: videos sem embedding (pro cron processar)
CREATE INDEX IF NOT EXISTS idx_blue_videos_sem_embedding
  ON blue_videos(created_at DESC) WHERE embedding IS NULL;
CREATE INDEX IF NOT EXISTS idx_virais_sem_embedding
  ON virais_banco(coletado_em DESC) WHERE embedding IS NULL;

-- 6) USER PROFILE EMBEDDINGS (pra feed personalizado) ------------------------
-- Perfil do usuario = media ponderada dos embeddings dos videos que curtiu/salvou
CREATE TABLE IF NOT EXISTS blue_user_profile_embeddings (
  user_id UUID PRIMARY KEY,
  embedding vector(1536) NOT NULL,
  baseado_em INT DEFAULT 0, -- quantos videos entraram na media
  ultima_atualizacao TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_embeddings_update
  ON blue_user_profile_embeddings(ultima_atualizacao DESC);
