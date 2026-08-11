-- storage_lockdown_2026_08_11.sql
--
-- FECHA A ENUMERAÇÃO DO BUCKET blue-videos.
--
-- O que foi encontrado (teste real, 11/08, com a chave anon que está embutida
-- no APK e que qualquer um extrai em minutos):
--
--   POST /storage/v1/object/list/blue-videos  -> HTTP 200, 44 pastas de usuário
--   ... e dentro delas, <uid>/chat/ (mídia PRIVADA de conversa: foto, vídeo,
--   áudio) e <uid>/stories/. Um áudio de conversa privada de terceiro
--   respondeu HTTP 200 / audio/m4a / 93.567 bytes num HEAD sem nenhuma chave.
--
-- Causa: existe uma policy de SELECT em storage.objects liberando o bucket
-- pra todo mundo. Em bucket público, SELECT não é o que serve o arquivo
-- (isso é a rota /object/public/, que ignora RLS) — SELECT é o que permite
-- LISTAR. Ou seja: dá pra tirar o SELECT aberto sem parar nenhum vídeo.
--
-- Verificado antes de escrever este script: nem o app nem a API chamam
-- /object/list em lugar nenhum (grep em bluetube-app/src e bluetube/api).
-- Portanto ninguém depende dessa permissão.
--
-- O que este script faz:
--   1. apaga as policies de storage.objects que alcançam o bucket blue-videos
--   2. recria só o necessário:
--      - SELECT: cada um enxerga APENAS a própria pasta (<auth.uid()>/...)
--      - INSERT/UPDATE: cada um escreve APENAS na própria pasta
--   3. deixa a leitura pública dos vídeos intacta (rota /object/public/)
--
-- Idempotente: pode rodar de novo sem efeito colateral.

-- 1) limpa o que existe hoje pro bucket
DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND (qual ILIKE '%blue-videos%' OR with_check ILIKE '%blue-videos%'
           OR qual IS NULL OR qual = 'true')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', p.policyname);
  END LOOP;
END $$;

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 2) cada um só enxerga a própria pasta.
--    foldername(name)[1] é o primeiro segmento do caminho — que na nossa
--    convenção é sempre o user_id de quem subiu (<uid>/chat/..., <uid>/stories/...,
--    <uid>/videos/...). Fora dela, a listagem volta vazia.
DROP POLICY IF EXISTS "blue_videos_select_own" ON storage.objects;
CREATE POLICY "blue_videos_select_own" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'blue-videos' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 3) escrita: só na própria pasta, e só logado.
--    (antes, a permissão era ampla o bastante pra chave anon enumerar tudo)
DROP POLICY IF EXISTS "blue_videos_insert_own" ON storage.objects;
CREATE POLICY "blue_videos_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'blue-videos' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "blue_videos_update_own" ON storage.objects;
CREATE POLICY "blue_videos_update_own" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'blue-videos' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'blue-videos' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "blue_videos_delete_own" ON storage.objects;
CREATE POLICY "blue_videos_delete_own" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'blue-videos' AND (storage.foldername(name))[1] = auth.uid()::text);

-- CONFERÊNCIA (roda junto e mostra o resultado):
-- deve listar exatamente as 4 policies acima e nada com 'true' solto.
SELECT policyname, cmd, roles::text
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
ORDER BY policyname;

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK DE EMERGÊNCIA — se depois disto algum UPLOAD do app parar de
-- funcionar, cole e rode SÓ o bloco abaixo pra voltar ao estado anterior
-- (upload liberado pra logado). A enumeração reabre, mas o app volta na hora.
-- Depois me chama que eu investigo o caso específico.
--
--   CREATE POLICY "blue_videos_rollback" ON storage.objects
--     FOR ALL TO authenticated
--     USING (bucket_id = 'blue-videos')
--     WITH CHECK (bucket_id = 'blue-videos');
-- ─────────────────────────────────────────────────────────────────────────
