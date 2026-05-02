-- BlueLens Ultimate — fingerprint visual completo de vídeos.
-- Tudo que NÃO seja imagem foi removido (título, narração, áudio falado,
-- duração genérica) — só importa o que o ladrão NÃO consegue mudar:
-- PIXELS dos frames.
--
-- Schema cobre Fases α (multi-hash básico) → ε (forensic temporal).
-- Campos opcionais ficam NULL até Fases relevantes serem ativadas.

CREATE TABLE IF NOT EXISTS video_visual_fingerprints (
  id BIGSERIAL PRIMARY KEY,

  -- Identificação
  source_url TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('youtube','tiktok','instagram','x','unknown')),
  video_id_external TEXT, -- youtube videoId, tiktok video id, etc

  -- Metadados básicos (só pra contexto, NÃO usados em matching)
  duration_seconds NUMERIC(8,2),
  width INT,
  height INT,
  total_frames_extracted INT NOT NULL DEFAULT 0,
  fps_extracted NUMERIC(5,2) NOT NULL DEFAULT 1.0, -- 1fps na Fase α, escala pra 15+ depois

  -- ── FASE α: Multi-hash visual ────────────────────────────────────────────
  -- Arrays de hashes hex de 16 chars (64-bit cada). Tamanho do array = total_frames_extracted
  p_hashes TEXT[] NOT NULL DEFAULT '{}',  -- Perceptual hash (mais usado)
  d_hashes TEXT[] NOT NULL DEFAULT '{}',  -- Difference hash (robust a brilho)

  -- ── FASE β: Multi-hash adicional + scene detection ───────────────────────
  w_hashes TEXT[] DEFAULT '{}',           -- Wavelet hash
  a_hashes TEXT[] DEFAULT '{}',           -- Average hash (rápido)
  color_hashes TEXT[] DEFAULT '{}',       -- Histograma RGB compactado em hash
  scene_boundaries INT[] DEFAULT '{}',    -- Indices dos frames onde houve mudança brusca de cena

  -- ── FASE γ: Motion + temporal ────────────────────────────────────────────
  motion_signature TEXT,                  -- Hash sintetizado de movimento entre frames consecutivos
  temporal_hash TEXT,                     -- DCT 3D hash (assinatura temporal completa)

  -- ── FASE δ: Face + object detection ──────────────────────────────────────
  -- Embeddings de rostos detectados (cosine similarity pra match cross-video)
  -- Cada elemento e um JSON: { frame_idx, bbox, embedding_vector_b64 }
  face_embeddings JSONB DEFAULT '[]',
  -- Objetos detectados por frame: [{ frame_idx, tags: ['coffee','elephant'] }]
  object_tags JSONB DEFAULT '[]',
  -- Edge/contour signatures (lib local)
  edge_signatures TEXT[] DEFAULT '{}',

  -- ── FASE ε: Forensic temporal localization ───────────────────────────────
  -- Computed during match (não armazenado): qual segmento bate exato

  -- Auditoria
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_matched_at TIMESTAMPTZ,
  times_matched INT NOT NULL DEFAULT 0,
  index_source TEXT DEFAULT 'manual' CHECK (index_source IN ('manual','user_analysis','viral_seeder','crawler'))
);

-- Indices criticos
CREATE INDEX IF NOT EXISTS idx_vvf_source_url ON video_visual_fingerprints (source_url);
CREATE INDEX IF NOT EXISTS idx_vvf_platform_indexed ON video_visual_fingerprints (platform, indexed_at DESC);
-- Index pra busca por video_id_external (pra evitar reindexar mesmo video em URLs diferentes)
CREATE INDEX IF NOT EXISTS idx_vvf_video_id_external ON video_visual_fingerprints (video_id_external) WHERE video_id_external IS NOT NULL;
-- Index parcial: vídeos virais indexados pelo seeder (priorizados em matching)
CREATE INDEX IF NOT EXISTS idx_vvf_seeder ON video_visual_fingerprints (indexed_at DESC) WHERE index_source = 'viral_seeder';

ALTER TABLE video_visual_fingerprints DISABLE ROW LEVEL SECURITY;

-- Comentários explicativos (visíveis em Supabase UI)
COMMENT ON TABLE video_visual_fingerprints IS 'BlueLens Ultimate: visual fingerprints frame-by-frame. NÃO armazena pixels — só hashes.';
COMMENT ON COLUMN video_visual_fingerprints.p_hashes IS 'Array de Perceptual Hashes (16 chars hex cada). Hamming distance < 5 = frames similares.';
COMMENT ON COLUMN video_visual_fingerprints.face_embeddings IS 'face-api.js embeddings 128-dim base64. Privacy: NÃO permite reconstruir rosto, só comparar.';

-- Tabela de log de matches detectados (auditoria + feedback loop)
CREATE TABLE IF NOT EXISTS bluelens_visual_matches (
  id BIGSERIAL PRIMARY KEY,
  source_video_id BIGINT REFERENCES video_visual_fingerprints(id),
  matched_video_id BIGINT REFERENCES video_visual_fingerprints(id),
  match_score NUMERIC(5,2) NOT NULL,
  matched_frames_count INT,
  total_frames_compared INT,
  -- Detalhes por algoritmo (qual hash foi usado)
  algorithm_scores JSONB,
  -- Localização temporal: quais segmentos bateram
  temporal_overlap JSONB, -- [{src_start, src_end, dst_start, dst_end}]
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_feedback TEXT, -- 'confirmed' | 'false_positive' | NULL
  CHECK (source_video_id <> matched_video_id)
);
CREATE INDEX IF NOT EXISTS idx_blvm_source ON bluelens_visual_matches (source_video_id, match_score DESC);
ALTER TABLE bluelens_visual_matches DISABLE ROW LEVEL SECURITY;

-- Limpeza automatica de fingerprints velhos sem matches (>180 dias)
-- Opcional via pg_cron (descomentar se quiser ativar)
-- SELECT cron.schedule('clean-old-fingerprints', '0 4 1 * *',
--   $$DELETE FROM video_visual_fingerprints
--     WHERE indexed_at < NOW() - INTERVAL '180 days'
--     AND times_matched = 0
--     AND index_source IN ('user_analysis','crawler')$$);
