-- editor_v0_state.sql — Estado de edicao em curso pra autosave (2026-06-26)
-- =====================================================================
-- Adiciona campos pra autosave do BlueEditor V0:
--   project_state JSONB — estado completo do editor (trim, textos, etc)
--   updated_at TIMESTAMPTZ — track de ultima edicao
--   nome_projeto TEXT — titulo customizavel pelo user
--
-- Usa o status='editing' (novo) pra diferenciar de jobs ja exportados:
--   - editing: user esta editando, autosave ativo
--   - queued/processing/done/error: fluxo de export ja existente
--
-- Cada user pode ter MULTIPLOS projetos editing (rascunhos). Cron futuro
-- pode limpar editing nao tocados > 30d.
--
-- IDEMPOTENTE — pode rodar 2x sem efeito.

ALTER TABLE editor_jobs
  ADD COLUMN IF NOT EXISTS project_state JSONB,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS nome_projeto TEXT;

-- Index pra buscar rapido o projeto mais recente em edicao de cada user
CREATE INDEX IF NOT EXISTS idx_editor_jobs_editing
  ON editor_jobs(user_id, updated_at DESC)
  WHERE status = 'editing';

-- Verificacao rapida
-- SELECT id, user_id, status, nome_projeto, updated_at,
--        jsonb_pretty(project_state) AS state
-- FROM editor_jobs
-- WHERE status = 'editing'
-- ORDER BY updated_at DESC;
