-- Tabela de log do health check do baixaBlue YouTube.
-- Populada por /api/audit-baixablue (cron diario 9h UTC = 6h BRT).
-- Usado pra detectar providers com 2+ falhas consecutivas e alertar admin.

CREATE TABLE IF NOT EXISTS download_health_log (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('cobalt','railway_ytdlp','ytstream','youtube_media','invidious')),
  status TEXT NOT NULL CHECK (status IN ('ok','fail','skip')),
  duration_ms INT NOT NULL DEFAULT 0,
  error TEXT,
  test_video_id TEXT NOT NULL DEFAULT 'dQw4w9WgXcQ',
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indice pra query 'ultimos N por provider' (usado pra detectar streak de falhas)
CREATE INDEX IF NOT EXISTS idx_dhl_provider_checked ON download_health_log (provider, checked_at DESC);

-- Indice pra query 'falhas recentes em geral'
CREATE INDEX IF NOT EXISTS idx_dhl_status_checked ON download_health_log (status, checked_at DESC) WHERE status = 'fail';

-- RLS desligado (apenas service_role escreve, painel admin le)
ALTER TABLE download_health_log DISABLE ROW LEVEL SECURITY;

-- Limpeza automatica de registros velhos (>90 dias) — 1x por mes via cron Postgres
-- Opcional: requer pg_cron extension. Se nao tiver, ignorar.
-- SELECT cron.schedule('clean-download-health', '0 3 1 * *', $$DELETE FROM download_health_log WHERE checked_at < NOW() - INTERVAL '90 days'$$);
