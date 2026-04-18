-- ============================================================================
-- sql/affiliate_robustness.sql
-- Robustez do sistema de afiliados: audit trail, refund tracking, retry queue
-- Rodar no Supabase SQL Editor. E idempotente (pode rodar de novo sem quebrar).
-- ============================================================================

-- 1) AUDIT TRAIL + REFUND FIELDS em affiliate_commissions ---------------------
-- commission_history: array jsonb com cada PATCH {prev, new, rate, source, at}
-- refunded_at: timestamp de quando o Stripe reembolsou
-- coupon_applied / coupon_discount: metadata do cupom (ja usado pelo webhook)
ALTER TABLE affiliate_commissions
  ADD COLUMN IF NOT EXISTS commission_history jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS coupon_applied boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS coupon_discount numeric(10,2) DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_status
  ON affiliate_commissions(status);
CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_email_plan
  ON affiliate_commissions(subscriber_email, plan);

-- 2) FILA DE RETRY pro PATCH do webhook ---------------------------------------
-- Se o PATCH pos-checkout/renovacao falhar, insere aqui. Cron consome a cada
-- 15min. Evita comissao ficar com valor errado quando Supabase esta lento.
CREATE TABLE IF NOT EXISTS commission_patch_queue (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  affiliate_id uuid NOT NULL,
  subscriber_email text NOT NULL,
  plan text NOT NULL,
  paid_amount numeric(10,2) NOT NULL,
  rate numeric(5,4) NOT NULL,
  coupon_applied boolean DEFAULT false,
  coupon_discount numeric(10,2) DEFAULT 0,
  source text NOT NULL, -- 'checkout' | 'renewal'
  tentativas int DEFAULT 0,
  last_error text,
  status text DEFAULT 'pending', -- pending | success | failed
  created_at timestamptz DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_cpq_status_created
  ON commission_patch_queue(status, created_at);

-- 3) ANTIFRAUDE — self-referral detection ------------------------------------
-- Colunas em affiliate_commissions pra flag + motivo + trilha de revisao admin
ALTER TABLE affiliate_commissions
  ADD COLUMN IF NOT EXISTS flagged boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS flagged_reason text,
  ADD COLUMN IF NOT EXISTS flagged_at timestamptz,
  ADD COLUMN IF NOT EXISTS admin_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS admin_review_note text,
  ADD COLUMN IF NOT EXISTS admin_decision text; -- 'approved' | 'rejected'

CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_flagged
  ON affiliate_commissions(flagged) WHERE flagged = true;

-- Tabela de fingerprints do afiliado — capturada quando o afiliado visita o
-- dashboard. Usada pra cruzar com affiliate_clicks e detectar auto-indicacao.
CREATE TABLE IF NOT EXISTS affiliate_fingerprints (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  affiliate_id uuid NOT NULL,
  ip_hash text,
  visitor_fingerprint text,
  cookie_id text,
  ua_snippet text,
  first_seen timestamptz DEFAULT now(),
  last_seen timestamptz DEFAULT now(),
  seen_count int DEFAULT 1,
  UNIQUE(affiliate_id, ip_hash, visitor_fingerprint, cookie_id)
);

CREATE INDEX IF NOT EXISTS idx_aff_fp_affiliate
  ON affiliate_fingerprints(affiliate_id);
CREATE INDEX IF NOT EXISTS idx_aff_fp_cookie
  ON affiliate_fingerprints(cookie_id) WHERE cookie_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aff_fp_ip
  ON affiliate_fingerprints(ip_hash) WHERE ip_hash IS NOT NULL;

-- 4) LOG de reconciliacao -----------------------------------------------------
-- Registra execucoes do cron de reconciliacao diaria pra trail de auditoria.
CREATE TABLE IF NOT EXISTS affiliate_reconcile_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  executado_em timestamptz DEFAULT now(),
  afiliados_checados int DEFAULT 0,
  drifts_detectados int DEFAULT 0,
  ajustes_aplicados int DEFAULT 0,
  detalhes jsonb DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_reconcile_log_data
  ON affiliate_reconcile_log(executado_em DESC);
