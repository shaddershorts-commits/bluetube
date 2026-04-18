-- ============================================================================
-- sql/tendencias_cinematografico.sql
-- Suporte a experiencia narrativa de 6 atos do BlueTendencias
-- Rodar no Supabase SQL Editor. Idempotente.
-- ============================================================================

-- 1) SESSOES de descoberta — uma por vez que o usuario percorre os 6 atos
-- Guarda o raciocinio completo pra depois mostrar "continuacao"
CREATE TABLE IF NOT EXISTS tendencias_sessoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  canal_youtube_id TEXT,
  padrao_detectado TEXT,
  forca_padrao DECIMAL,
  oportunidade_principal JSONB DEFAULT '{}'::jsonb,
  oportunidades_secundarias JSONB DEFAULT '[]'::jsonb,
  roteiro_gerado JSONB DEFAULT '{}'::jsonb,
  analise_completa JSONB DEFAULT '{}'::jsonb,
  ato_atual INTEGER DEFAULT 1,         -- 1 a 6 — onde o user parou
  finalizada BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  finalizada_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessoes_user
  ON tendencias_sessoes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessoes_user_atual
  ON tendencias_sessoes(user_id, created_at DESC) WHERE finalizada = false;

-- 2) CACHE do canal — evita re-chamar Opus a cada visita
CREATE TABLE IF NOT EXISTS tendencias_cache_canais (
  user_id UUID PRIMARY KEY,
  canal_data JSONB DEFAULT '{}'::jsonb,           -- snapshot do canal (stats, avatar, etc)
  videos_analisados JSONB DEFAULT '[]'::jsonb,    -- top 20 videos + metricas
  padroes_identificados JSONB DEFAULT '{}'::jsonb, -- resultado do analise-canal (Opus)
  analise_mercado JSONB DEFAULT '{}'::jsonb,      -- cache de mostrar-mercado
  oportunidade_do_dia JSONB DEFAULT '{}'::jsonb,  -- cache de identificar-oportunidade (6h)
  ultima_analise TIMESTAMPTZ,
  valido_ate TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cache_canais_valido
  ON tendencias_cache_canais(valido_ate);

-- 3) ROTEIROS salvos pelo usuario pra depois
CREATE TABLE IF NOT EXISTS tendencias_roteiros_salvos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  sessao_id UUID REFERENCES tendencias_sessoes(id) ON DELETE SET NULL,
  titulo_sugerido TEXT,
  roteiro JSONB NOT NULL,
  status TEXT DEFAULT 'salvo',  -- 'salvo' | 'usado' | 'descartado'
  usado_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_roteiros_user_status
  ON tendencias_roteiros_salvos(user_id, status, created_at DESC);
