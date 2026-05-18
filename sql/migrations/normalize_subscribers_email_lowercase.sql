-- sql/migrations/normalize_subscribers_email_lowercase.sql
--
-- Pre-requisito do fix UPSERT case-insensitive em api/webhook.js (2026-05-18).
-- Antes do deploy, normaliza TODOS os emails de subscribers pra lowercase.
-- Sem isso, o webhook que agora insere com email.toLowerCase() pode criar
-- row duplicada se DB tem versao maiuscula antiga (FELIPE@x vs felipe@x).
--
-- Rodar UMA VEZ no Supabase SQL Editor. Idempotente (so atualiza rows com case errado).

-- 1. Detecta duplicatas potenciais ANTES de normalizar (pra log)
--    Se houver, voce vai precisar resolver manualmente — escolher qual row vence.
WITH duplicates AS (
  SELECT LOWER(email) AS email_lower, count(*) AS dup_count
  FROM subscribers
  GROUP BY LOWER(email)
  HAVING count(*) > 1
)
SELECT * FROM duplicates;
-- Esperado: 0 rows. Se aparecer algum email, NAO rode o UPDATE abaixo
-- ate decidir qual row manter (e DELETE as outras).

-- 2. Normaliza tudo pra lowercase (so toca rows com case errado)
UPDATE subscribers
SET email = LOWER(email), updated_at = NOW()
WHERE email != LOWER(email);

-- 3. (Opcional defesa em profundidade) Adiciona indice unique case-insensitive
--    Garante que duplicatas case-insensitive NUNCA voltem a aparecer.
--    Comentado por padrao porque schema atual ja tem UNIQUE(email) e a
--    normalizacao acima resolve o caso pratico.
-- CREATE UNIQUE INDEX IF NOT EXISTS idx_subscribers_email_lower
--   ON subscribers (LOWER(email));

-- 4. Verifica pos-normalizacao
SELECT count(*) AS total_rows,
       count(*) FILTER (WHERE email = LOWER(email)) AS lowercase_count,
       count(*) FILTER (WHERE email != LOWER(email)) AS still_mixed_case_count
FROM subscribers;
-- Esperado: total = lowercase_count, still_mixed_case_count = 0
