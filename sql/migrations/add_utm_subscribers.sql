-- Migration: add_utm_subscribers
-- Data: 2026-04-29
-- Proposito: capturar atribuicao de marketing (UTM/fbclid/gclid) em subscribers
--            pra rastrear ROI por campanha de Meta Ads, Google Ads, etc.
--
-- Modelo: LAST-TOUCH attribution (sobrescreve a cada visita com novos params).
-- TTL no client: 60 dias.
--
-- Como rodar: cole no Supabase SQL Editor e execute.
-- Idempotente: usa IF NOT EXISTS, pode rodar varias vezes sem erro.
--
-- Rollback: remove colunas se precisar (cuidado: perde dados gravados):
--   ALTER TABLE subscribers
--     DROP COLUMN IF EXISTS utm_source, DROP COLUMN IF EXISTS utm_medium,
--     DROP COLUMN IF EXISTS utm_campaign, DROP COLUMN IF EXISTS utm_content,
--     DROP COLUMN IF EXISTS utm_term, DROP COLUMN IF EXISTS fbclid,
--     DROP COLUMN IF EXISTS gclid, DROP COLUMN IF EXISTS landing_page,
--     DROP COLUMN IF EXISTS referrer, DROP COLUMN IF EXISTS first_visit_at,
--     DROP COLUMN IF EXISTS attribution_set_at;

ALTER TABLE subscribers
  ADD COLUMN IF NOT EXISTS utm_source         VARCHAR(100),
  ADD COLUMN IF NOT EXISTS utm_medium         VARCHAR(100),
  ADD COLUMN IF NOT EXISTS utm_campaign       VARCHAR(200),
  ADD COLUMN IF NOT EXISTS utm_content        VARCHAR(200),
  ADD COLUMN IF NOT EXISTS utm_term           VARCHAR(200),
  ADD COLUMN IF NOT EXISTS fbclid             VARCHAR(500),
  ADD COLUMN IF NOT EXISTS gclid              VARCHAR(500),
  ADD COLUMN IF NOT EXISTS landing_page       VARCHAR(500),
  ADD COLUMN IF NOT EXISTS referrer           TEXT,
  ADD COLUMN IF NOT EXISTS first_visit_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attribution_set_at TIMESTAMPTZ;

-- Indices pra queries de ROI/atribuicao (filtros mais usados)
CREATE INDEX IF NOT EXISTS idx_subs_utm_source   ON subscribers(utm_source)   WHERE utm_source   IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subs_utm_campaign ON subscribers(utm_campaign) WHERE utm_campaign IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subs_fbclid       ON subscribers(fbclid)       WHERE fbclid       IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subs_gclid        ON subscribers(gclid)        WHERE gclid        IS NOT NULL;

-- Comentarios pra documentacao no Supabase
COMMENT ON COLUMN subscribers.utm_source         IS 'UTM source (ex: facebook, google, instagram). Capturado via _utm-tracker.js';
COMMENT ON COLUMN subscribers.utm_medium         IS 'UTM medium (ex: cpc, social, email)';
COMMENT ON COLUMN subscribers.utm_campaign       IS 'UTM campaign (ex: lancamento_2026)';
COMMENT ON COLUMN subscribers.utm_content        IS 'UTM content — variante de criativo/anuncio';
COMMENT ON COLUMN subscribers.utm_term           IS 'UTM term — palavra-chave (Google Ads)';
COMMENT ON COLUMN subscribers.fbclid             IS 'Facebook Click ID — atribuicao Meta Ads';
COMMENT ON COLUMN subscribers.gclid              IS 'Google Click ID — atribuicao Google Ads';
COMMENT ON COLUMN subscribers.landing_page       IS 'Path da pagina de chegada na primeira visita';
COMMENT ON COLUMN subscribers.referrer           IS 'document.referrer da primeira visita';
COMMENT ON COLUMN subscribers.first_visit_at     IS 'Timestamp da primeira visita do user (antes do signup)';
COMMENT ON COLUMN subscribers.attribution_set_at IS 'Quando o backend gravou os UTMs (apos signup OK)';

-- Query exemplo pra analise de ROI por campanha (cole no SQL Editor):
-- SELECT utm_source, utm_campaign,
--        COUNT(*)                                           AS signups,
--        COUNT(*) FILTER (WHERE plan IN ('full','master'))  AS pagantes,
--        ROUND(100.0 * COUNT(*) FILTER (WHERE plan IN ('full','master')) / NULLIF(COUNT(*),0), 2) AS taxa_conv_pct
-- FROM subscribers
-- WHERE utm_source IS NOT NULL
--   AND created_at >= NOW() - INTERVAL '30 days'
-- GROUP BY utm_source, utm_campaign
-- ORDER BY pagantes DESC, signups DESC;
