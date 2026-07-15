-- BlueClean v2 — pipeline com chunking (Railway orquestra o job único) (2026-07-15)
-- Rodar no Supabase SQL Editor.
alter table blueclean_jobs add column if not exists stage text default 'processing';
alter table blueclean_jobs add column if not exists railway_id text;
-- Colunas do desenho antigo de 3 estágios (mantidas por compatibilidade; inócuas):
alter table blueclean_jobs add column if not exists black_url text;
alter table blueclean_jobs add column if not exists mask_url text;
alter table blueclean_jobs add column if not exists railway_mask_id text;
