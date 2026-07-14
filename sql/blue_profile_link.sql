-- Link estilo Instagram no perfil do Blue (2026-07-14)
-- Rodar no Supabase SQL Editor.
alter table blue_profiles add column if not exists link_url text;
alter table blue_profiles add column if not exists link_label text;
