-- Migration: add_lang_source_to_voices
-- Data: 2026-04-29
-- Proposito: rastrear COMO cada voz foi classificada (auto vs manual).
--            Camada 7 da defesa em camadas do BlueVoice — ajuda debug
--            futuro do dicionario de nomes / regex de labels.
--
-- Valores possiveis em lang_source:
--   'auto_labels'   — bateu via regex em labels/verified_languages (Camada 1)
--   'auto_name'     — bateu via dicionario de nomes (Camada 2)
--   'auto_eleven'   — bateu via lookup with_settings=true na ElevenLabs (Camada 3)
--   'manual'        — user escolheu no dropdown (Camada 4)
--   'manual_edit'   — user editou voz ja existente (Camada 6)
--   NULL            — voz antiga, antes deste tracking
--
-- Como rodar: cole no Supabase SQL Editor.
-- Idempotente: usa IF NOT EXISTS.
--
-- Rollback (perde info de tracking, mantem lang_code):
--   ALTER TABLE blue_custom_voices DROP COLUMN IF EXISTS lang_source;

ALTER TABLE blue_custom_voices
  ADD COLUMN IF NOT EXISTS lang_source TEXT;

COMMENT ON COLUMN blue_custom_voices.lang_source IS
  'Como o lang_code foi classificado: auto_labels|auto_name|auto_eleven|manual|manual_edit|NULL';

-- Query exemplo pra audit (cole no SQL Editor):
-- SELECT lang_source, COUNT(*) FROM blue_custom_voices
--   GROUP BY lang_source ORDER BY count DESC;
--
-- Vozes ainda nao classificadas (target da Camada 8):
-- SELECT user_id, voice_id, name, idioma_real, lang_code, lang_source
--   FROM blue_custom_voices WHERE lang_code IS NULL;
