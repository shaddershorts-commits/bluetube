-- Fix permanente fluidez do feed Blue (2026-07-13)
-- Marca quando o video foi re-encodado (faststart + compressao) pelo Railway.
-- Rodar no Supabase SQL Editor.

alter table blue_videos add column if not exists transcoded_at timestamptz;

-- indice parcial pro sweeper do cron (busca so os pendentes)
create index if not exists idx_blue_videos_transcode_pending
  on blue_videos (created_at desc)
  where transcoded_at is null and status = 'active';
