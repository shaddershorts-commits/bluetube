-- sql/age_confirmation.sql — Migration pra Fix 6 (Gap 5): idade minima 16+
-- Rodar manual no Supabase SQL Editor. Idempotente.

-- 1) Adiciona colunas em subscribers
ALTER TABLE subscribers
  ADD COLUMN IF NOT EXISTS age_confirmed BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS age_confirmed_at TIMESTAMPTZ;

-- 2) Backfill: presuncao de 16+ pra base existente
-- Em 2026-04-25: 16 usuarios early adopters, todos confirmados >16 (Felipe + amigos
-- proximos + early adopters). Termos vigentes ja referenciam LGPD; aceite implicito
-- de elegibilidade. Decisao Fix 6 aprovada com nota explicita no commit.
UPDATE subscribers
SET age_confirmed = TRUE, age_confirmed_at = NOW()
WHERE age_confirmed IS NULL OR age_confirmed = FALSE;

-- 3) Index pra queries de "users sem confirmacao" (alertas futuros)
CREATE INDEX IF NOT EXISTS idx_subscribers_age_pending
  ON subscribers(age_confirmed) WHERE age_confirmed = FALSE;

-- 4) Confirmar contagem (esperado: 16 ou mais)
SELECT
  COUNT(*) FILTER (WHERE age_confirmed = TRUE) AS confirmed,
  COUNT(*) FILTER (WHERE age_confirmed = FALSE OR age_confirmed IS NULL) AS pending,
  COUNT(*) AS total
FROM subscribers;
