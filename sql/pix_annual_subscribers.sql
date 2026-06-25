-- pix_annual_subscribers.sql — Suporte Pix anual (2026-06-25)
-- =====================================================================
-- Adiciona 3 colunas na tabela subscribers pra suportar assinatura via Pix
-- one-time (mode=payment) com bonus de 13 meses pelo preço de 12.
--
-- billing_method: 'card' (default) ou 'pix_annual'
-- pix_reminder_30d_sent_at: marca quando o lembrete 30d antes do venc foi enviado
-- pix_reminder_15d_sent_at: marca quando o lembrete 15d antes do venc foi enviado
--
-- Cron `pix-renewal-reminder` (GitHub Actions, 10h UTC diario) usa essas
-- duas flags pra idempotencia — nunca reenvia.
--
-- RODAR NO SUPABASE SQL Editor uma vez. IF NOT EXISTS garante idempotente.

ALTER TABLE subscribers
  ADD COLUMN IF NOT EXISTS billing_method TEXT DEFAULT 'card',
  ADD COLUMN IF NOT EXISTS pix_reminder_30d_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pix_reminder_15d_sent_at TIMESTAMPTZ;

-- Index pra acelerar busca do cron (billing_method='pix_annual' + plan_expires_at janela)
CREATE INDEX IF NOT EXISTS idx_subscribers_pix_annual_expires
  ON subscribers (plan_expires_at)
  WHERE billing_method = 'pix_annual';

-- Verificação rápida
-- SELECT email, plan, billing_method, plan_expires_at, pix_reminder_30d_sent_at, pix_reminder_15d_sent_at
-- FROM subscribers
-- WHERE billing_method = 'pix_annual'
-- ORDER BY plan_expires_at;
