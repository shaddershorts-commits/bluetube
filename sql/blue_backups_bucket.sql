-- sql/blue_backups_bucket.sql — Cria bucket privado pra backups (Fix 7 - Gap 2)
-- Felipe ja rodou em 2026-04-25 antes do deploy.
-- Idempotente.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'blue-backups',
  'blue-backups',
  false,
  52428800,  -- 50MB max por arquivo
  ARRAY['application/octet-stream', 'application/gzip']
)
ON CONFLICT (id) DO UPDATE SET public = false;

-- Verifica criação
SELECT id, name, public, file_size_limit FROM storage.buckets WHERE id = 'blue-backups';
