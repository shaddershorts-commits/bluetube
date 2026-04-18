-- ============================================================================
-- sql/studio_tables.sql — Suporte a dissecacao cinematografica BlueTendencias
-- Rodar no Supabase SQL Editor. Idempotente.
-- ============================================================================

-- Historico de dissecacoes (pra admin auditar e usuario ver historico)
CREATE TABLE IF NOT EXISTS studio_dissecacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  video_youtube_id TEXT NOT NULL,
  video_titulo TEXT,
  video_views_inicio BIGINT,
  video_likes_inicio BIGINT,
  -- Contexto do usuario (respostas do chat)
  nicho_usuario TEXT,
  duracao_media_videos TEXT,
  desafio_principal TEXT,
  -- Analise gerada (5 atos em JSONB)
  analise_completa JSONB,
  tempo_geracao_ms INTEGER,
  -- Custos (auditoria)
  custo_tokens_input INTEGER,
  custo_tokens_output INTEGER,
  custo_brl DECIMAL(10,4),
  modelo_usado TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dissecacoes_user
  ON studio_dissecacoes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dissecacoes_data
  ON studio_dissecacoes(created_at DESC);

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
