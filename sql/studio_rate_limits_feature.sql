-- ============================================================================
-- sql/studio_rate_limits_feature.sql
-- Migration: adiciona coluna `feature` em studio_rate_limits pra diferenciar
-- limites por tipo de analise (iniciar-analise, analisar-video, dissecar).
--
-- Janela passou de 24h fixed pra 15h rolling (sliding window) — so muda no
-- codigo (api/bluetendencias.js), nao precisa mudar schema.
--
-- Limites atuais (codigo):
--   iniciar-analise  -> 2 usos / 15h
--   analisar-video   -> 2 usos / 15h
--   dissecar         -> 4 usos / 15h (analise completa)
--
-- Idempotente: pode rodar multiplas vezes sem quebrar.
-- ============================================================================

-- Adiciona coluna feature. Default 'dissecar' mantem compatibilidade com
-- linhas antigas (que nao tinham feature — eram todas dissecacoes).
ALTER TABLE studio_rate_limits
  ADD COLUMN IF NOT EXISTS feature TEXT NOT NULL DEFAULT 'dissecar';

-- Indice composto otimiza a query de verificacao (user+feature+tempo).
CREATE INDEX IF NOT EXISTS idx_studio_rate_feature
  ON studio_rate_limits(user_id, feature, usado_em DESC);

-- Verificacao rapida: lista distinct features registrados (deve mostrar
-- 'dissecar' pra linhas antigas e novos valores conforme o uso).
-- SELECT feature, COUNT(*) FROM studio_rate_limits GROUP BY feature;
