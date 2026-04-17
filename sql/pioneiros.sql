-- sql/pioneiros.sql — Programa Pioneiros
-- Rodar no SQL Editor do Supabase (app.supabase.com/project/<id>/sql).

CREATE TABLE IF NOT EXISTS pioneiros_programa (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'bloqueado' CHECK (status IN ('bloqueado','ativo','pendente_pagamento','concluido')),
  link_ref TEXT UNIQUE,
  assinantes_indicados INTEGER NOT NULL DEFAULT 0,
  assinantes_qualificados INTEGER NOT NULL DEFAULT 0,
  premio_liberado BOOLEAN NOT NULL DEFAULT FALSE,
  premio_pago_em TIMESTAMPTZ,
  stripe_payout_id TEXT,
  desbloqueado_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pioneiros_user ON pioneiros_programa (user_id);
CREATE INDEX IF NOT EXISTS idx_pioneiros_ref ON pioneiros_programa (link_ref);
CREATE INDEX IF NOT EXISTS idx_pioneiros_status ON pioneiros_programa (status) WHERE status <> 'bloqueado';

CREATE TABLE IF NOT EXISTS pioneiros_indicacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pioneiro_id UUID REFERENCES pioneiros_programa(id) ON DELETE CASCADE,
  link_ref TEXT,
  assinante_user_id UUID,
  assinante_email TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT UNIQUE,
  plano TEXT,
  valor_mensal DECIMAL(10,2),
  meses_ativos INTEGER NOT NULL DEFAULT 0,
  qualificado BOOLEAN NOT NULL DEFAULT FALSE,
  cancelado BOOLEAN NOT NULL DEFAULT FALSE,
  primeira_cobranca_em TIMESTAMPTZ,
  ultima_cobranca_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_indicacoes_pioneiro ON pioneiros_indicacoes (pioneiro_id);
CREATE INDEX IF NOT EXISTS idx_indicacoes_assinante ON pioneiros_indicacoes (assinante_user_id);
CREATE INDEX IF NOT EXISTS idx_indicacoes_subscription ON pioneiros_indicacoes (stripe_subscription_id);

CREATE TABLE IF NOT EXISTS pioneiros_pagamentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pioneiro_id UUID REFERENCES pioneiros_programa(id) ON DELETE SET NULL,
  user_id UUID NOT NULL,
  valor DECIMAL(10,2) NOT NULL DEFAULT 1000.00,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','processando','pago','falhou')),
  stripe_transfer_id TEXT,
  stripe_account_id TEXT,
  erro TEXT,
  processado_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pagamentos_user ON pioneiros_pagamentos (user_id);
CREATE INDEX IF NOT EXISTS idx_pagamentos_status ON pioneiros_pagamentos (status);

-- RLS: incidentes são públicos; registros são só via service_key
ALTER TABLE pioneiros_programa    ENABLE ROW LEVEL SECURITY;
ALTER TABLE pioneiros_indicacoes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pioneiros_pagamentos  ENABLE ROW LEVEL SECURITY;
