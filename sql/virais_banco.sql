-- sql/virais_banco.sql — Banco acumulativo de Shorts virais do YouTube.
-- Crons (api/virais-coletor) alimentam esta tabela periodicamente.
-- A pagina /virais le daqui (nao chama YouTube em tempo real).
-- Rodar no Supabase SQL Editor. Idempotente.

CREATE TABLE IF NOT EXISTS virais_banco (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificacao
  youtube_id TEXT UNIQUE NOT NULL,
  titulo TEXT NOT NULL,
  thumbnail_url TEXT,
  url TEXT NOT NULL,

  -- Criador
  canal_id TEXT,
  canal_nome TEXT,
  canal_thumbnail TEXT,
  canal_inscritos BIGINT DEFAULT 0,
  canal_verificado BOOLEAN DEFAULT FALSE,

  -- Metricas no momento da coleta
  views BIGINT DEFAULT 0,
  likes BIGINT DEFAULT 0,
  comentarios BIGINT DEFAULT 0,
  duracao_segundos INTEGER DEFAULT 0,

  -- Metricas de viralidade calculadas
  taxa_engajamento DECIMAL(10,4) DEFAULT 0,
  velocidade_views DECIMAL(12,2) DEFAULT 0,
  viral_score DECIMAL(5,2) DEFAULT 0,

  -- Categorizacao
  nicho TEXT,
  idioma TEXT DEFAULT 'pt',
  pais TEXT DEFAULT 'BR',
  hashtags TEXT[] DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',

  -- Temporal
  publicado_em TIMESTAMPTZ,
  coletado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW(),

  -- Controle
  vezes_atualizado INTEGER DEFAULT 0,
  ativo BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_virais_coletado   ON virais_banco(coletado_em DESC);
CREATE INDEX IF NOT EXISTS idx_virais_score      ON virais_banco(viral_score DESC);
CREATE INDEX IF NOT EXISTS idx_virais_nicho      ON virais_banco(nicho, viral_score DESC);
CREATE INDEX IF NOT EXISTS idx_virais_idioma     ON virais_banco(idioma, coletado_em DESC);
CREATE INDEX IF NOT EXISTS idx_virais_youtube_id ON virais_banco(youtube_id);
CREATE INDEX IF NOT EXISTS idx_virais_views      ON virais_banco(views DESC);
CREATE INDEX IF NOT EXISTS idx_virais_publicado  ON virais_banco(publicado_em DESC);
CREATE INDEX IF NOT EXISTS idx_virais_pais       ON virais_banco(pais, viral_score DESC);

-- Log de coletas para monitoramento no painel admin
CREATE TABLE IF NOT EXISTS virais_coletas_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo_busca TEXT NOT NULL,
  parametros JSONB,
  videos_encontrados INTEGER DEFAULT 0,
  videos_novos INTEGER DEFAULT 0,
  videos_atualizados INTEGER DEFAULT 0,
  cota_gasta INTEGER DEFAULT 0,
  duracao_ms INTEGER DEFAULT 0,
  erro TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coletas_log_created ON virais_coletas_log(created_at DESC);
