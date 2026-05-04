-- subscribers_payment_fields.sql
-- 2026-05-04
-- Motivacao: painel admin mostrava valor hardcoded ("R$29,99" pra todo Full)
-- ignorando moeda real do Stripe (USD/EUR/etc) e cupom aplicado.
-- Caso Manuel/Mocambique: pagou USD 14,99, painel mostrava R$29,99.

ALTER TABLE subscribers
  ADD COLUMN IF NOT EXISTS amount_paid numeric,
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS coupon_applied boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS coupon_discount numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS billing_period text;

COMMENT ON COLUMN subscribers.amount_paid IS 'Valor real cobrado pelo Stripe (session.amount_total / 100). Inclui desconto de cupom.';
COMMENT ON COLUMN subscribers.currency IS 'Moeda Stripe (brl, usd, eur, gbp, cad, aud).';
COMMENT ON COLUMN subscribers.coupon_applied IS 'True se sub usou cupom de desconto.';
COMMENT ON COLUMN subscribers.coupon_discount IS 'Valor do desconto aplicado (em centavos / 100).';
COMMENT ON COLUMN subscribers.billing_period IS 'monthly | annual';

-- Indice opcional pra reports por moeda
CREATE INDEX IF NOT EXISTS idx_subscribers_currency ON subscribers(currency) WHERE currency IS NOT NULL;
