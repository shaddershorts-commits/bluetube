-- ============================================================================
-- sql/solicitacoes_plataforma.sql
-- Log de URLs que usuarios tentaram baixar de plataformas nao suportadas.
-- Admin usa pra decidir quais plataformas priorizar adicionar.
-- Rodar no Supabase SQL Editor. Idempotente.
-- ============================================================================

CREATE TABLE IF NOT EXISTS solicitacoes_plataforma (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url TEXT NOT NULL,
  plataforma_host TEXT,      -- ex: 'vimeo.com'
  plataforma_nome TEXT,       -- ex: 'vimeo'
  motivo TEXT,                -- 'cobalt_falhou' | 'dominio_desconhecido' | etc
  user_email TEXT,
  user_id UUID,
  notificar_quando_pronto BOOLEAN DEFAULT FALSE,
  tentativas INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_solicitacoes_host
  ON solicitacoes_plataforma(plataforma_host, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_solicitacoes_created
  ON solicitacoes_plataforma(created_at DESC);
