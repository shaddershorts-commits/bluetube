-- ============================================================================
-- sql/studio_tables.sql — BlueTendencias Studio (experiencia Blublu)
-- Rodar no Supabase SQL Editor. Idempotente.
-- ============================================================================

-- Tabela principal de analises (substitui studio_dissecacoes antiga)
CREATE TABLE IF NOT EXISTS studio_analises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,

  -- Video analisado
  video_youtube_id TEXT NOT NULL,
  video_titulo TEXT,
  video_thumbnail TEXT,
  video_canal TEXT,
  video_views_inicio BIGINT,
  video_likes_inicio BIGINT,
  video_comentarios_inicio BIGINT,
  video_duracao_segundos INTEGER,
  video_nicho TEXT,
  video_velocidade_24h DECIMAL,

  -- Dashboard calculado (projeções, receita, comparações)
  dashboard_dados JSONB,

  -- Chat interativo com Blublu
  respostas_chat JSONB,

  -- Analise final em 5 atos (inclui quiz)
  analise_atos JSONB,
  quiz_dados JSONB,

  -- Metadados
  nome_usuario TEXT,
  tempo_total_ms INTEGER,
  custo_tokens_input INTEGER,
  custo_tokens_output INTEGER,
  custo_brl DECIMAL,
  modelo_usado TEXT,

  -- Controle
  salva BOOLEAN DEFAULT FALSE,
  visualizada_ultima_vez TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_studio_analises_user
  ON studio_analises(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_studio_analises_salvas
  ON studio_analises(user_id, salva, created_at DESC) WHERE salva = TRUE;
CREATE INDEX IF NOT EXISTS idx_studio_analises_data
  ON studio_analises(created_at DESC);

-- Compatibilidade com tabela antiga (mantida, mas nao mais usada ativamente)
CREATE TABLE IF NOT EXISTS studio_dissecacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  video_youtube_id TEXT NOT NULL,
  video_titulo TEXT,
  video_views_inicio BIGINT,
  video_likes_inicio BIGINT,
  nicho_usuario TEXT,
  duracao_media_videos TEXT,
  desafio_principal TEXT,
  analise_completa JSONB,
  tempo_geracao_ms INTEGER,
  custo_tokens_input INTEGER,
  custo_tokens_output INTEGER,
  custo_brl DECIMAL(10,4),
  modelo_usado TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Rate limiting 24h rolling (3 por usuario)
CREATE TABLE IF NOT EXISTS studio_rate_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  usado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_studio_rate
  ON studio_rate_limits(user_id, usado_em DESC);

-- Budget tracking global (pausa automatica se estourar)
CREATE TABLE IF NOT EXISTS studio_budget_diario (
  data DATE PRIMARY KEY,
  gasto_brl DECIMAL(10,4) DEFAULT 0,
  total_analises INTEGER DEFAULT 0,
  budget_limite DECIMAL(10,2) DEFAULT 200,
  ativo BOOLEAN DEFAULT TRUE,
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_studio_budget_data
  ON studio_budget_diario(data DESC);
