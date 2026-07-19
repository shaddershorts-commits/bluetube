-- Ativa o log da RESPOSTA do Blublu + flag de cobertura fina na análise diária.
-- Roda no SQL Editor do Supabase. Seguro (IF NOT EXISTS): não mexe em dado existente.
ALTER TABLE blublu_chat_logs ADD COLUMN IF NOT EXISTS resposta text;
ALTER TABLE blublu_chat_logs ADD COLUMN IF NOT EXISTS cobertura_fina boolean;
