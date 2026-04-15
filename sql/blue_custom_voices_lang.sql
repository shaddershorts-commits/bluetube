-- BlueVoice — metadados reais de idioma/sotaque/gênero/estilo para vozes customizadas
-- Executar no SQL editor do Supabase

ALTER TABLE blue_custom_voices
  ADD COLUMN IF NOT EXISTS idioma_real  TEXT,
  ADD COLUMN IF NOT EXISTS lang_code    TEXT,
  ADD COLUMN IF NOT EXISTS lang_flag    TEXT,
  ADD COLUMN IF NOT EXISTS sotaque      TEXT,
  ADD COLUMN IF NOT EXISTS genero       TEXT,
  ADD COLUMN IF NOT EXISTS idade        TEXT,
  ADD COLUMN IF NOT EXISTS estilo       TEXT,
  ADD COLUMN IF NOT EXISTS descricao    TEXT,
  ADD COLUMN IF NOT EXISTS multilingual BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS metadata     JSONB;

CREATE INDEX IF NOT EXISTS idx_blue_custom_voices_lang_code
  ON blue_custom_voices(lang_code);

CREATE INDEX IF NOT EXISTS idx_blue_custom_voices_multilingual
  ON blue_custom_voices(multilingual)
  WHERE multilingual = TRUE;
