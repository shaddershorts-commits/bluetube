-- sql/email_campanhas.sql
-- Tabela de log das campanhas de email marketing one-shot (ex: lancamento
-- da BlueTendencias). Diferente do email_marketing que e sequencia automatica.
-- Rode no Supabase SQL Editor. E idempotente.

CREATE TABLE IF NOT EXISTS email_campanhas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT,
  total_free INTEGER DEFAULT 0,
  total_full INTEGER DEFAULT 0,
  total_master INTEGER DEFAULT 0,
  enviados INTEGER DEFAULT 0,
  falhas INTEGER DEFAULT 0,
  status TEXT DEFAULT 'preparando',
  iniciada_em TIMESTAMPTZ,
  concluida_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_campanhas_created
  ON email_campanhas(created_at DESC);
