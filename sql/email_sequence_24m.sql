-- EMAIL SEQUENCE 24m — Free→Full + Full→Master + Trial 30d (2026-06-23)
-- ========================================================================
-- Idempotente: rodar 2x não causa erro.

-- 1. Subscribers ganha 2 campos pra rastrear o trial 30d via email
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS trial_origin text;
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS trial_started_at timestamptz;
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS trial_warning_sent_at timestamptz;

COMMENT ON COLUMN subscribers.trial_origin IS 'Origem do plano gratis: NULL=normal, "email_30d"=trial via email-sequence';
COMMENT ON COLUMN subscribers.trial_started_at IS 'Quando o trial via email comecou (pra cron warning aos 20d)';

CREATE INDEX IF NOT EXISTS idx_subscribers_trial_expiry
  ON subscribers(plan_expires_at)
  WHERE trial_origin = 'email_30d' AND plan = 'full';

-- 2. email_marketing ganha campos pra sequencias separadas (free vs full)
--    + flag pra trial offer (1x por user max)
ALTER TABLE email_marketing ADD COLUMN IF NOT EXISTS full_position int NOT NULL DEFAULT 0;
ALTER TABLE email_marketing ADD COLUMN IF NOT EXISTS trial_offered_at timestamptz;
ALTER TABLE email_marketing ADD COLUMN IF NOT EXISTS audience text DEFAULT 'free';

COMMENT ON COLUMN email_marketing.full_position IS 'Posicao na sequencia FULL->MASTER (sequence_position legacy fica pra FREE->FULL)';
COMMENT ON COLUMN email_marketing.trial_offered_at IS 'Quando recebeu oferta trial 30d (1x por user max)';
COMMENT ON COLUMN email_marketing.audience IS 'free|full — qual sequencia esta no momento (atualizada a cada send)';

-- 3. Sanity check (deve retornar 0 ou poucos rows)
SELECT 'subscribers_em_trial' AS metric, COUNT(*) AS count
FROM subscribers
WHERE trial_origin = 'email_30d' AND plan = 'full' AND plan_expires_at > NOW()
UNION ALL
SELECT 'email_marketing_total', COUNT(*) FROM email_marketing
UNION ALL
SELECT 'subscribers_free', COUNT(*) FROM subscribers WHERE plan = 'free' OR plan IS NULL
UNION ALL
SELECT 'subscribers_full_ativos', COUNT(*) FROM subscribers
WHERE plan = 'full' AND (plan_expires_at IS NULL OR plan_expires_at > NOW());
