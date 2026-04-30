-- Migration: add_virais_canais_curados
-- Data: 2026-04-30
-- Proposito: ferramenta Virais passa a ser CURADA — busca SO em canais que
--            Felipe escolhe manualmente. Resolve simultaneamente:
--            - vazamento de hindi/india/indonesia (Felipe so adiciona PT/EN)
--            - videos longos (canal /shorts ja so posta shorts)
--            - estilo "narrado com legendas" (Felipe seleciona canais do estilo)
--            - filtros aleatorios (escopo estreito)
--
-- Como rodar: cole no Supabase SQL Editor.
-- Idempotente.
--
-- Rollback (cuidado: perde lista de canais curados):
--   DROP TABLE IF EXISTS virais_canais_curados CASCADE;
--   ALTER TABLE virais_banco DROP COLUMN IF EXISTS fonte;
--   ALTER TABLE virais_banco DROP COLUMN IF EXISTS canal_curado_id;
--   ALTER TABLE subscribers DROP COLUMN IF EXISTS virais_daily_alert;

-- ── 1. Tabela de canais curados ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS virais_canais_curados (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      TEXT UNIQUE NOT NULL,        -- UC... resolvido da URL
  channel_handle  TEXT,                        -- @Bubbletm (display)
  channel_name    TEXT,
  channel_url     TEXT,                        -- URL original que Felipe colou
  thumbnail_url   TEXT,
  total_inscritos BIGINT,
  nicho_manual    TEXT,                        -- escolhido na adicao
  idioma_manual   TEXT,                        -- escolhido na adicao
  ativo           BOOLEAN DEFAULT TRUE,
  added_at        TIMESTAMPTZ DEFAULT NOW(),
  ultimo_check    TIMESTAMPTZ,
  videos_coletados INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_canais_curados_ativo
  ON virais_canais_curados(ativo) WHERE ativo = true;

COMMENT ON TABLE  virais_canais_curados IS
  'Canais YouTube monitorados pela ferramenta Virais. Coletor roda a cada 2h.';
COMMENT ON COLUMN virais_canais_curados.channel_id     IS 'UC... resolvido via /channels?forHandle=';
COMMENT ON COLUMN virais_canais_curados.nicho_manual   IS 'Felipe escolhe ao adicionar (curiosidades|games|ia|...)';
COMMENT ON COLUMN virais_canais_curados.idioma_manual  IS 'Felipe escolhe ao adicionar (pt-BR|en-US|...)';

-- ── 2. Rastreio de origem em virais_banco ──────────────────────────────────
ALTER TABLE virais_banco
  ADD COLUMN IF NOT EXISTS fonte           TEXT,
  ADD COLUMN IF NOT EXISTS canal_curado_id UUID REFERENCES virais_canais_curados(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_virais_banco_fonte
  ON virais_banco(fonte) WHERE fonte IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_virais_banco_canal_curado
  ON virais_banco(canal_curado_id) WHERE canal_curado_id IS NOT NULL;

COMMENT ON COLUMN virais_banco.fonte           IS 'canal_curado | trending | nicho (legacy) | NULL';
COMMENT ON COLUMN virais_banco.canal_curado_id IS 'FK pro canal monitorado (se fonte=canal_curado)';

-- ── 3. Opt-in alerta diario (Master only) ──────────────────────────────────
ALTER TABLE subscribers
  ADD COLUMN IF NOT EXISTS virais_daily_alert BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_subs_virais_alert
  ON subscribers(email) WHERE virais_daily_alert = true;

COMMENT ON COLUMN subscribers.virais_daily_alert IS
  'Master que ativa = recebe email 7:30 BRT com 5 shorts virais explodindo';

-- Query exemplo pra Felipe rodar (audit):
-- SELECT cc.channel_handle, cc.channel_name, cc.nicho_manual, cc.idioma_manual,
--        cc.videos_coletados, cc.ultimo_check, cc.ativo
-- FROM virais_canais_curados cc ORDER BY cc.added_at DESC;
--
-- SELECT COUNT(*) FROM subscribers WHERE virais_daily_alert = true; -- master opt-in
