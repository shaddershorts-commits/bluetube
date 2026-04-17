-- sql/email_marketing.sql — tabela do sistema de email marketing automático
-- Consumida pelo cron /api/email-marketing (terças e sextas 10:00 UTC) e pelo
-- stats endpoint /api/admin?action=email_marketing_stats.

CREATE TABLE IF NOT EXISTS email_marketing (
  email TEXT PRIMARY KEY,
  sequence_position INTEGER NOT NULL DEFAULT 0,
  total_sent INTEGER NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMPTZ,
  unsubscribed BOOLEAN NOT NULL DEFAULT FALSE,
  unsubscribed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices pra acelerar a query principal do cron (eligible users)
CREATE INDEX IF NOT EXISTS idx_em_last_sent
  ON email_marketing (last_sent_at NULLS FIRST)
  WHERE unsubscribed = FALSE;

CREATE INDEX IF NOT EXISTS idx_em_unsub
  ON email_marketing (unsubscribed);

-- RLS: tabela é só escrita via service_key (cron). Usuário não precisa ler.
ALTER TABLE email_marketing ENABLE ROW LEVEL SECURITY;
