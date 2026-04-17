-- sql/stripe_webhook_log.sql — log de eventos Stripe pra idempotencia e retry
-- Rodar no SQL Editor do Supabase.

CREATE TABLE IF NOT EXISTS stripe_webhook_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id TEXT UNIQUE NOT NULL,
  tipo TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente','processando','concluido','erro','falha_permanente','ignorado')),
  payload JSONB NOT NULL,
  tentativas INTEGER NOT NULL DEFAULT 0,
  ultimo_erro TEXT,
  processado_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_status
  ON stripe_webhook_log (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_event
  ON stripe_webhook_log (stripe_event_id);

CREATE INDEX IF NOT EXISTS idx_webhook_tipo_created
  ON stripe_webhook_log (tipo, created_at DESC);

ALTER TABLE stripe_webhook_log ENABLE ROW LEVEL SECURITY;
-- Sem policies — acesso somente via service_key
