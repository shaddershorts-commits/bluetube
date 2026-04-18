-- ============================================================================
-- sql/ai_gateway_cache.sql — Cache de respostas de IA (Claude/OpenAI/Gemini)
-- Economia estimada: 60-80% das chamadas repetidas evitadas
-- Rodar no Supabase SQL Editor. Idempotente.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ai_cache (
  cache_key TEXT PRIMARY KEY,            -- sha256(provider + model + system + prompt)
  provider TEXT NOT NULL,                -- 'claude' | 'openai' | 'gemini'
  model TEXT,                            -- ex: 'claude-haiku-4-5'
  prompt_sample TEXT,                    -- primeiros 200 chars do prompt (debug)
  system_sample TEXT,                    -- primeiros 100 chars do system (debug)
  response TEXT NOT NULL,
  resposta_tokens INT,                   -- estimativa de tokens retornados
  tipo TEXT,                             -- 'roteiro' | 'analise' | 'titulo' | etc (opcional)
  acessos INT DEFAULT 0,                 -- quantas vezes esse cache foi reusado
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,       -- quando o cache expira
  ultimo_acesso TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_cache_expires
  ON ai_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_ai_cache_tipo
  ON ai_cache(tipo, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_cache_provider_model
  ON ai_cache(provider, model);

-- Limpeza automatica de caches expirados (idempotente, pode rodar no cron)
CREATE OR REPLACE FUNCTION ai_cache_gc() RETURNS INT AS $$
DECLARE
  deleted INT;
BEGIN
  DELETE FROM ai_cache WHERE expires_at < NOW();
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END
$$ LANGUAGE plpgsql;

-- Stats do cache (usado pelo admin pra ver economia)
CREATE OR REPLACE FUNCTION ai_cache_stats() RETURNS TABLE (
  total_entries BIGINT,
  total_acessos BIGINT,
  hits_economizados BIGINT,
  por_tipo JSONB,
  por_provider JSONB
) LANGUAGE sql STABLE AS $$
  SELECT
    COUNT(*)::BIGINT AS total_entries,
    COALESCE(SUM(acessos), 0)::BIGINT AS total_acessos,
    -- hits_economizados = cada reuso a partir do 2º é uma economia
    COALESCE(SUM(GREATEST(acessos - 1, 0)), 0)::BIGINT AS hits_economizados,
    (SELECT jsonb_object_agg(tipo_key, cnt) FROM (
       SELECT COALESCE(tipo, 'nao_categorizado') AS tipo_key, COUNT(*)::INT AS cnt
       FROM ai_cache GROUP BY tipo
     ) t) AS por_tipo,
    (SELECT jsonb_object_agg(provider, cnt) FROM (
       SELECT provider, COUNT(*)::INT AS cnt
       FROM ai_cache GROUP BY provider
     ) p) AS por_provider
  FROM ai_cache;
$$;

GRANT EXECUTE ON FUNCTION ai_cache_gc() TO service_role;
GRANT EXECUTE ON FUNCTION ai_cache_stats() TO service_role, anon;
