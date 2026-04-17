-- sql/system_health.sql — tabelas de monitoramento de saúde do sistema.
-- Rodar no SQL editor do Supabase (https://app.supabase.com/project/<id>/sql).

CREATE TABLE IF NOT EXISTS system_health_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL CHECK (status IN ('ok','partial','degraded','critical')),
  services JSONB NOT NULL,
  summary JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_health_log_created
  ON system_health_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_health_log_status
  ON system_health_log (status, created_at DESC)
  WHERE status <> 'ok';

CREATE TABLE IF NOT EXISTS system_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo TEXT NOT NULL,
  descricao TEXT,
  servicos_afetados TEXT[] NOT NULL DEFAULT '{}',
  severidade TEXT DEFAULT 'medium' CHECK (severidade IN ('low','medium','high','critical')),
  status TEXT DEFAULT 'investigando' CHECK (status IN ('investigando','identificado','monitorando','resolvido')),
  resolvido_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incidents_created
  ON system_incidents (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_incidents_ativos
  ON system_incidents (status)
  WHERE status <> 'resolvido';

-- Função de GC: apaga entradas > 30 dias (chamada pelo cron monitor-health
-- ou manualmente). Retorna quantidade removida.
CREATE OR REPLACE FUNCTION cleanup_health_log()
RETURNS INTEGER AS $$
DECLARE
  deleted INTEGER;
BEGIN
  DELETE FROM system_health_log WHERE created_at < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql;

-- (Opcional) Row-Level Security: torna a tabela visível só via service key
ALTER TABLE system_health_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_incidents   ENABLE ROW LEVEL SECURITY;

-- Incidents são públicos (pra status.html ler sem auth)
DROP POLICY IF EXISTS "incidents_public_read" ON system_incidents;
CREATE POLICY "incidents_public_read" ON system_incidents FOR SELECT USING (true);
