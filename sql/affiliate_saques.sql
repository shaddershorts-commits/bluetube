-- sql/affiliate_saques.sql — Sistema de saques de afiliados via ASAAS (Pix)
-- Rodar no Supabase SQL Editor. Idempotente.

-- 1) Colunas extras em affiliates pra guardar chave Pix + saldo
ALTER TABLE affiliates
  ADD COLUMN IF NOT EXISTS chave_pix         TEXT,
  ADD COLUMN IF NOT EXISTS tipo_chave_pix    TEXT,
  ADD COLUMN IF NOT EXISTS saldo_disponivel  DECIMAL(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_sacado      DECIMAL(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ultimo_saque_em   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS asaas_customer_id TEXT;

-- 2) Tabela de saques (fila + historico)
CREATE TABLE IF NOT EXISTS affiliate_saques (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id       UUID REFERENCES affiliates(id) ON DELETE CASCADE,
  valor              DECIMAL(10,2) NOT NULL CHECK (valor > 0),
  chave_pix          TEXT NOT NULL,
  tipo_chave_pix     TEXT NOT NULL,
  -- status: pendente_manual | processando | pago | falhou
  status             TEXT NOT NULL DEFAULT 'pendente_manual',
  asaas_transfer_id  TEXT,
  asaas_pix_id       TEXT,
  erro_mensagem      TEXT,
  solicitado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pago_em            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_saques_affiliate
  ON affiliate_saques(affiliate_id, solicitado_em DESC);
CREATE INDEX IF NOT EXISTS idx_saques_status
  ON affiliate_saques(status, solicitado_em DESC);

COMMENT ON TABLE affiliate_saques IS 'Fila + historico de saques via ASAAS Pix. Saques liberados dia 22 de cada mes.';
COMMENT ON COLUMN affiliate_saques.status IS 'pendente_manual (sem API key, admin processa) | processando | pago | falhou';
