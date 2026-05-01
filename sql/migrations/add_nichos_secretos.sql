-- Migration: add_nichos_secretos
-- Data: 2026-05-01
-- Proposito: feature MASTER-only "Nichos Secretos" — sistema TOTALMENTE
--            isolado da ferramenta Virais normal. Tabelas separadas
--            garantem que conteudo de uma nunca vaza pra outra.
--
-- Threshold filtro publico: views >= 10M, publicado_em >= NOW - 45d
-- Cron: 3x/dia (6h, 14h, 22h UTC), profundidade 100 videos/canal
-- Quota YouTube: keys exclusivas YOUTUBE_API_KEY_SECRETOS_1..3
--
-- Como rodar: cole no Supabase SQL Editor.
-- Idempotente: usa IF NOT EXISTS.
--
-- Rollback (cuidado: perde lista de canais secretos):
--   DROP TABLE IF EXISTS virais_banco_secretos CASCADE;
--   DROP TABLE IF EXISTS virais_canais_secretos CASCADE;

-- ── 1. Tabela de canais Nichos Secretos (separada de virais_canais_curados) ──
CREATE TABLE IF NOT EXISTS virais_canais_secretos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      TEXT UNIQUE NOT NULL,        -- UC... resolvido da URL
  channel_handle  TEXT,                        -- @handle (display)
  channel_name    TEXT,
  channel_url     TEXT,                        -- URL original colada
  thumbnail_url   TEXT,
  total_inscritos BIGINT,
  ativo           BOOLEAN DEFAULT TRUE,
  added_at        TIMESTAMPTZ DEFAULT NOW(),
  ultimo_check    TIMESTAMPTZ,
  videos_coletados INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_canais_secretos_ativo
  ON virais_canais_secretos(ativo) WHERE ativo = true;

COMMENT ON TABLE  virais_canais_secretos IS
  'Canais YouTube monitorados pela feature Nichos Secretos. Isolado de virais_canais_curados.';

-- ── 2. Tabela de videos Nichos Secretos (separada de virais_banco) ──────────
CREATE TABLE IF NOT EXISTS virais_banco_secretos (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  youtube_id           TEXT UNIQUE NOT NULL,
  titulo               TEXT,
  thumbnail_url        TEXT,
  url                  TEXT,
  canal_id             TEXT,
  canal_nome           TEXT,
  canal_secreto_id     UUID REFERENCES virais_canais_secretos(id) ON DELETE SET NULL,
  views                BIGINT DEFAULT 0,
  likes                BIGINT DEFAULT 0,
  comentarios          BIGINT DEFAULT 0,
  duracao_segundos     INTEGER,
  taxa_engajamento     NUMERIC(10,4),
  publicado_em         TIMESTAMPTZ,
  coletado_em          TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em        TIMESTAMPTZ DEFAULT NOW(),
  ativo                BOOLEAN DEFAULT TRUE
);

-- Indices criticos pra queries do filtro publico
CREATE INDEX IF NOT EXISTS idx_banco_secretos_views
  ON virais_banco_secretos(views DESC) WHERE ativo = true;
CREATE INDEX IF NOT EXISTS idx_banco_secretos_publicado
  ON virais_banco_secretos(publicado_em DESC) WHERE ativo = true;
CREATE INDEX IF NOT EXISTS idx_banco_secretos_canal
  ON virais_banco_secretos(canal_secreto_id) WHERE canal_secreto_id IS NOT NULL;

COMMENT ON TABLE  virais_banco_secretos IS
  'Banco de Shorts coletados dos canais Nichos Secretos. Independente de virais_banco.';
COMMENT ON COLUMN virais_banco_secretos.canal_secreto_id IS
  'FK pro canal monitorado (ON DELETE SET NULL pra preservar historico se canal for removido)';

-- Query exemplo pra Felipe rodar (audit):
-- SELECT cs.channel_handle, cs.videos_coletados, cs.ultimo_check, cs.ativo
-- FROM virais_canais_secretos cs ORDER BY cs.added_at DESC;
--
-- Top 20 do filtro publico (views >= 10M, ultimos 45d):
-- SELECT titulo, canal_nome, views, publicado_em
-- FROM virais_banco_secretos
-- WHERE ativo = true AND views >= 10000000
--   AND publicado_em >= NOW() - INTERVAL '45 days'
--   AND duracao_segundos <= 90
-- ORDER BY views DESC LIMIT 20;
