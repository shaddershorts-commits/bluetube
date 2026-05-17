-- sql/migrations/add_checkout_recovery_table.sql
-- Cria tabela checkout_recovery + indices pro sistema de recuperacao
-- de checkout abandonado (api/checkout-recovery.js).
--
-- Rodar no Supabase SQL Editor. Idempotente.
--
-- Fluxo: api/checkout-recovery.js?action=sweep popula a tabela via UPSERT
-- por stripe_session_id. Crons send-1h/24h/72h enviam emails sequenciais.
-- Webhooks Stripe (checkout.session.completed/expired) atualizam status.

CREATE TABLE IF NOT EXISTS checkout_recovery (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificacao da sessao
  email TEXT NOT NULL,
  stripe_session_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT,

  -- Snapshot do plano tentado
  plan TEXT NOT NULL,                       -- 'full' | 'master'
  billing TEXT NOT NULL,                    -- 'monthly' | 'annual'
  currency TEXT NOT NULL DEFAULT 'brl',     -- 'brl'|'usd'|'eur'|'gbp'|'cad'|'aud'
  amount_total INTEGER,                     -- em centavos (Stripe format)

  -- Temporal da sessao Stripe
  session_created_at TIMESTAMPTZ NOT NULL,
  session_expires_at TIMESTAMPTZ,           -- ~24h padrao Stripe

  -- Status de recuperacao
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','recovered','expired','unsubscribed')),

  -- Audit trail dos envios
  email_1h_sent_at TIMESTAMPTZ,
  email_24h_sent_at TIMESTAMPTZ,
  email_72h_sent_at TIMESTAMPTZ,

  -- Quando user pagou (preenchido por webhook checkout.session.completed)
  recovered_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indice principal pro cron de envio (queries por status + tempo)
CREATE INDEX IF NOT EXISTS idx_recovery_status_created
  ON checkout_recovery (status, session_created_at DESC)
  WHERE status = 'pending';

-- Indice pra lookup por email (usado por email-marketing.js filtro)
CREATE INDEX IF NOT EXISTS idx_recovery_email
  ON checkout_recovery (email);

-- Indice unique ja existe via UNIQUE constraint em stripe_session_id,
-- mas explicito por clareza (Postgres cria automatico pra UNIQUE)
-- CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_session ON checkout_recovery(stripe_session_id);

-- Comentarios pra documentacao
COMMENT ON TABLE checkout_recovery IS 'Sistema de recuperacao de checkout Stripe abandonado. Populated by api/checkout-recovery.js?action=sweep cron.';
COMMENT ON COLUMN checkout_recovery.status IS 'pending=aguarda recuperacao, recovered=user pagou, expired=session Stripe expirou ou 72h passaram, unsubscribed=user pediu nao receber';
COMMENT ON COLUMN checkout_recovery.amount_total IS 'Valor em centavos (Stripe format). Ex: 2999 = R$29,99';
