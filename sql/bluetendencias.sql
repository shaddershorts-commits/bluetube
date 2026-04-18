-- ============================================================================
-- BlueTendências v1 — dashboard de tendências exclusivo do plano Master
-- Rodar no Supabase SQL Editor. Idempotente.
-- ============================================================================

-- 1) Análises diárias de tendências pré-calculadas
CREATE TABLE IF NOT EXISTS tendencias_analise (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo TEXT NOT NULL, -- titulos, emergentes, nichos_top, rpm_estimado
  nicho TEXT,
  pais TEXT DEFAULT 'BR',
  idioma TEXT DEFAULT 'pt',
  dados JSONB NOT NULL,
  valido_ate TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tendencias_tipo_nicho
  ON tendencias_analise(tipo, nicho, valido_ate DESC);

-- 2) Canais conectados dos usuários (1 por user)
CREATE TABLE IF NOT EXISTS tendencias_canais_conectados (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  canal_id TEXT NOT NULL,
  canal_nome TEXT,
  canal_thumbnail TEXT,
  nicho_principal TEXT,
  inscritos INTEGER,
  views_totais BIGINT,
  ultimo_sync TIMESTAMPTZ,
  dados_canal JSONB DEFAULT '{}',
  ativo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_canais_user
  ON tendencias_canais_conectados(user_id);

-- 3) Tabela de RPM estimado por nicho (editável via painel futuro)
CREATE TABLE IF NOT EXISTS tendencias_rpm_nichos (
  nicho TEXT PRIMARY KEY,
  rpm_minimo DECIMAL,
  rpm_medio DECIMAL,
  rpm_maximo DECIMAL,
  moeda TEXT DEFAULT 'BRL',
  fonte TEXT DEFAULT 'manual', -- manual, crowdsource, api
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seeds iniciais baseados em dados públicos de mercado BR
INSERT INTO tendencias_rpm_nichos (nicho, rpm_minimo, rpm_medio, rpm_maximo) VALUES
  ('financas',   15.00, 30.00, 50.00),
  ('tecnologia',  8.00, 14.00, 20.00),
  ('saude',       6.00, 10.00, 15.00),
  ('educacao',    4.00,  8.00, 12.00),
  ('beleza',      3.00,  5.50,  8.00),
  ('lifestyle',   2.50,  4.00,  6.00),
  ('culinaria',   2.00,  3.50,  5.00),
  ('games',       1.50,  3.00,  5.00),
  ('humor',       1.00,  2.00,  3.00),
  ('musica',      1.00,  2.00,  3.50),
  ('esportes',    1.50,  3.00,  5.00),
  ('pets',        1.50,  2.50,  4.00),
  ('viagens',     3.00,  5.00,  8.00),
  ('automotivo',  4.00,  7.00, 12.00)
ON CONFLICT (nicho) DO NOTHING;

-- 4) Notificações de tendências emergentes
CREATE TABLE IF NOT EXISTS tendencias_alertas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  tipo TEXT, -- emergente, saturando, oportunidade
  titulo TEXT,
  descricao TEXT,
  dados JSONB DEFAULT '{}',
  visualizado BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alertas_user_unseen
  ON tendencias_alertas(user_id, visualizado, created_at DESC);
