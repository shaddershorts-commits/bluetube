-- BlueEditor — estilos de edição + fila de jobs do pipeline FFmpeg
-- Executar no SQL editor do Supabase (mesmo projeto do BlueTube)

CREATE TABLE IF NOT EXISTS editor_estilos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  canal_referencia TEXT,
  configuracoes JSONB NOT NULL,
  aprovacoes INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS editor_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  railway_job_id TEXT,
  status TEXT DEFAULT 'pendente',
  progresso INTEGER DEFAULT 0,
  video_url TEXT,
  audio_url TEXT,
  output_url TEXT,
  estilo_id UUID REFERENCES editor_estilos(id) ON DELETE SET NULL,
  musica_url TEXT,
  erro TEXT,
  aprovado BOOLEAN,
  feedback_comentario TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  concluido_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_editor_jobs_user_created
  ON editor_jobs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_editor_jobs_status
  ON editor_jobs(status);

-- ── SEED: 4 estilos baseados em canais virais brasileiros ────────────────────
INSERT INTO editor_estilos (nome, canal_referencia, configuracoes) VALUES
(
  'Aburamezin',
  '@aburamezin',
  '{
    "corte_intervalo": 1.5,
    "zoom_intensidade": 0.15,
    "zoom_frequencia": "alto",
    "legenda_posicao": "centro",
    "legenda_fonte": "Arial Black",
    "legenda_tamanho": 72,
    "legenda_cor_ativa": "#FF4444",
    "legenda_cor_normal": "#FFFFFF",
    "setas_frequencia": "alto",
    "musica_volume": 0.20,
    "ritmo": "frenetico"
  }'::jsonb
),
(
  'Abavocadu',
  '@abavocadu',
  '{
    "corte_intervalo": 2.0,
    "zoom_intensidade": 0.10,
    "zoom_frequencia": "medio",
    "legenda_posicao": "centro",
    "legenda_fonte": "Arial Bold",
    "legenda_tamanho": 68,
    "legenda_cor_ativa": "#FFFF00",
    "legenda_cor_normal": "#FFFFFF",
    "setas_frequencia": "medio",
    "musica_volume": 0.15,
    "ritmo": "curiosidade"
  }'::jsonb
),
(
  'Luiz Stubbe',
  '@luiz_stubbe',
  '{
    "corte_intervalo": 1.2,
    "zoom_intensidade": 0.20,
    "zoom_frequencia": "muito_alto",
    "legenda_posicao": "centro-baixo",
    "legenda_fonte": "Impact",
    "legenda_tamanho": 76,
    "legenda_cor_ativa": "#FF0000",
    "legenda_cor_normal": "#FFFFFF",
    "setas_frequencia": "alto",
    "musica_volume": 0.25,
    "ritmo": "agressivo"
  }'::jsonb
),
(
  'TVVNC',
  '@TVVNC',
  '{
    "corte_intervalo": 2.5,
    "zoom_intensidade": 0.08,
    "zoom_frequencia": "baixo",
    "legenda_posicao": "centro",
    "legenda_fonte": "Arial Bold",
    "legenda_tamanho": 64,
    "legenda_cor_ativa": "#FFFF00",
    "legenda_cor_normal": "#FFFFFF",
    "setas_frequencia": "baixo",
    "musica_volume": 0.10,
    "ritmo": "informativo"
  }'::jsonb
)
ON CONFLICT DO NOTHING;
