-- BlueScore — tabela de análises com aprendizado por feedback (PT)
-- Executar no SQL editor do Supabase

CREATE TABLE IF NOT EXISTS bluescore_analises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canal_id TEXT NOT NULL,
  canal_nome TEXT,
  nicho TEXT,
  eh_shorts BOOLEAN DEFAULT FALSE,
  score INTEGER,
  faixa TEXT,
  metricas JSONB,
  diagnostico TEXT,
  dicas TEXT[],
  feedback_util BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bluescore_analises_nicho_ok
  ON bluescore_analises(nicho, feedback_util)
  WHERE feedback_util = TRUE;

CREATE INDEX IF NOT EXISTS idx_bluescore_analises_faixa_ok
  ON bluescore_analises(eh_shorts, faixa, feedback_util)
  WHERE feedback_util = TRUE;

CREATE INDEX IF NOT EXISTS idx_bluescore_analises_canal
  ON bluescore_analises(canal_id, created_at DESC);
