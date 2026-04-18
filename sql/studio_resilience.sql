-- ============================================================================
-- sql/studio_resilience.sql — blindagem de fallbacks da BlueTendencias
-- Rodar no Supabase SQL Editor. Idempotente.
-- ============================================================================

-- CACHE DE ANALISES (30 dias TTL)
-- Evita gerar analise 2x pro mesmo video+contexto. Economiza custo e garante
-- resposta instantanea mesmo se Anthropic estiver fora.
CREATE TABLE IF NOT EXISTS studio_cache_analises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key TEXT UNIQUE NOT NULL,        -- sha256(youtube_id + tipo + contexto_relevante)
  tipo TEXT NOT NULL,                     -- 'dissect' | 'meu_video'
  video_youtube_id TEXT NOT NULL,
  analise_data JSONB NOT NULL,
  video_snapshot JSONB,                   -- views/likes/etc na hora do cache
  hits INTEGER DEFAULT 1,                 -- quantos usuarios reusaram
  custo_original_brl DECIMAL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
  ultima_hit_em TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_studio_cache_key ON studio_cache_analises(cache_key);
CREATE INDEX IF NOT EXISTS idx_studio_cache_expires ON studio_cache_analises(expires_at);
CREATE INDEX IF NOT EXISTS idx_studio_cache_tipo ON studio_cache_analises(tipo, created_at DESC);

-- HEALTH / CIRCUIT BREAKER
-- Rastreia falhas de componentes externos. Se estourar threshold, abre
-- circuito por X minutos — durante esse tempo usa template fallback.
CREATE TABLE IF NOT EXISTS studio_health (
  componente TEXT PRIMARY KEY,            -- 'anthropic_sonnet' | 'anthropic_haiku' | 'youtube_api'
  falhas_5min INTEGER DEFAULT 0,
  ultima_falha TIMESTAMPTZ,
  ultimo_sucesso TIMESTAMPTZ,
  circuito_aberto_ate TIMESTAMPTZ,        -- se > NOW(), usa fallback
  total_chamadas BIGINT DEFAULT 0,
  total_falhas BIGINT DEFAULT 0,
  total_cache_hits BIGINT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed dos componentes
INSERT INTO studio_health (componente) VALUES
  ('anthropic_sonnet'),
  ('anthropic_haiku'),
  ('youtube_api')
ON CONFLICT (componente) DO NOTHING;

-- Fila de retry (pra analises que falharam e vao ser retentadas em background)
CREATE TABLE IF NOT EXISTS studio_retry_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  user_email TEXT,
  tipo TEXT NOT NULL,
  video_youtube_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  tentativas INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',          -- pending | done | abandoned
  ultimo_erro TEXT,
  proxima_tentativa_em TIMESTAMPTZ DEFAULT NOW() + INTERVAL '2 minutes',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_studio_retry_status ON studio_retry_queue(status, proxima_tentativa_em);
