-- ============================================================================
-- sql/affiliate_attribution_log.sql — auditoria de decisoes de atribuicao
-- Rodar no Supabase SQL Editor. Idempotente.
-- ============================================================================

CREATE TABLE IF NOT EXISTS affiliate_attribution_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  ref_code TEXT,
  affiliate_id UUID,
  -- Fonte da atribuicao: cookie / stripe_metadata / fingerprint / signup_ref
  source TEXT NOT NULL,
  -- Decisao tomada: attributed / already_attributed / no_match / skipped_self_ref
  decisao TEXT NOT NULL,
  detalhes JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attrib_log_email ON affiliate_attribution_log(email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attrib_log_affiliate ON affiliate_attribution_log(affiliate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attrib_log_source ON affiliate_attribution_log(source, created_at DESC);
