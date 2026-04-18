-- sql/studio_blindagem_v2.sql
-- Migrations pra blindagem v2 da BlueTendencias.
-- Rode TUDO de uma vez no SQL Editor do Supabase (e idempotente).

-- 1) Versioning de prompt em studio_analises
ALTER TABLE studio_analises
  ADD COLUMN IF NOT EXISTS prompt_version TEXT DEFAULT 'v1.0';

CREATE INDEX IF NOT EXISTS idx_studio_analises_prompt_version
  ON studio_analises(prompt_version);

-- 2) Quality score + details do self-critique Haiku
ALTER TABLE studio_analises
  ADD COLUMN IF NOT EXISTS quality_score INT,
  ADD COLUMN IF NOT EXISTS quality_details JSONB;

CREATE INDEX IF NOT EXISTS idx_studio_analises_quality_low
  ON studio_analises(quality_score)
  WHERE quality_score IS NOT NULL AND quality_score < 5;

-- 3) Alertas progressivos de budget — precisa coluna pra idempotencia
ALTER TABLE studio_budget_diario
  ADD COLUMN IF NOT EXISTS alertas_enviados JSONB DEFAULT '[]'::jsonb;

-- Verificacao rapida — rode depois de aplicar:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name IN ('studio_analises','studio_budget_diario')
--     AND column_name IN ('prompt_version','quality_score','quality_details','alertas_enviados');
