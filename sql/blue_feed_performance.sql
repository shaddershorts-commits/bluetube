-- ============================================================================
-- sql/blue_feed_performance.sql — Otimizacoes de performance da rede Blue
-- Usa recursos do Supabase Small (indices compostos + MV pra feed quente).
-- Rodar no Supabase SQL Editor. Idempotente.
-- ============================================================================

-- 1) INDICE COMPOSTO pro feed principal (P0 — maior impacto)
-- Feed query: status=active AND video_url NOT NULL ORDER BY created_at DESC, id DESC
-- Sem esse indice, Postgres faz seq-scan ou usa indice parcial que nao cobre
-- a ordenacao composta.
CREATE INDEX IF NOT EXISTS idx_blue_videos_feed_ordem
  ON blue_videos(created_at DESC, id DESC)
  WHERE status = 'active' AND video_url IS NOT NULL;

-- Indice pra user_id (exclude-self + enrich profiles)
CREATE INDEX IF NOT EXISTS idx_blue_videos_user
  ON blue_videos(user_id, created_at DESC) WHERE status = 'active';

-- Indice pra feed-seguindo (filtro por user_id IN lista)
CREATE INDEX IF NOT EXISTS idx_blue_videos_user_recentes
  ON blue_videos(user_id, status, created_at DESC) WHERE video_url IS NOT NULL;

-- 2) MATERIALIZED VIEW "feed quente" (top 300 videos ativos)
-- Refresh a cada 5min via cron. Queries do feed inicial (sem filtros) leem
-- daqui em vez de fazer full scan. Latencia: 100-300ms -> 5-15ms.
--
-- Nota: feed personalizado (com following/interests) continua lendo direto
-- da tabela, pois MV nao tem filtros por usuario. So o feed "hot generic" usa.
DROP MATERIALIZED VIEW IF EXISTS blue_feed_quente CASCADE;
CREATE MATERIALIZED VIEW blue_feed_quente AS
  SELECT
    id, user_id, title, description, thumbnail_url, video_url,
    duration, views, likes, comments, saves,
    avg_watch_percent, score, nichos, views_24h, created_at
  FROM blue_videos
  WHERE status = 'active'
    AND video_url IS NOT NULL
  ORDER BY score DESC NULLS LAST, created_at DESC
  LIMIT 300;

CREATE UNIQUE INDEX IF NOT EXISTS idx_blue_feed_quente_id
  ON blue_feed_quente(id);
CREATE INDEX IF NOT EXISTS idx_blue_feed_quente_score
  ON blue_feed_quente(score DESC, created_at DESC);

-- Funcao pra refresh (chamada pelo cron)
CREATE OR REPLACE FUNCTION refresh_blue_feed_quente() RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY blue_feed_quente;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION refresh_blue_feed_quente() TO service_role;
GRANT SELECT ON blue_feed_quente TO anon, authenticated, service_role;
