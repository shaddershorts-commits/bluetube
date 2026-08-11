-- storage_lockdown_2026_08_11.sql  (v3 — cobre storage.objects E storage.prefixes)
--
-- O QUE ESTE SCRIPT FAZ (e o que NÃO faz):
--   FECHA a ENUMERAÇÃO do bucket blue-videos — ou seja, esconde a LISTA de
--   pastas/arquivos. Antes, com a chave anon do APK, dava pra pedir
--   POST /object/list/blue-videos e receber as 44 pastas de usuário.
--
--   NÃO fecha o DOWNLOAD direto: o bucket é público, então quem souber o
--   caminho exato de um arquivo ainda baixa por /object/public. Fechar isso
--   exige mover a mídia de chat pra um bucket privado (conserto maior, adiado
--   por decisão do dono em 11/08 — "faz o básico"). Este script é a 1ª camada:
--   encarece MUITO a descoberta, que é o passo que a auditoria provou aberto.
--
-- POR QUE É SEGURO (banco compartilhado com o site):
--   NÃO apaga nem altera nenhuma policy existente. Só ADICIONA policies
--   RESTRICTIVE, que combinam por E (AND). A regra é "para LISTAR: ou o bucket
--   não é blue-videos (então nada muda pro site — avatares, comunidade), ou é
--   blue-videos e a pasta é sua". Download público segue intacto (ignora RLS).
--   Upload do dono segue intacto (a própria pasta passa no dono-check).
--
-- POR QUE DUAS TABELAS:
--   Versões novas do Supabase Storage resolvem a listagem de PASTAS por uma
--   tabela separada, storage.prefixes, com RLS PRÓPRIO. Sem cobrir ela, a
--   restrictive em storage.objects fecharia a lista de ARQUIVOS mas deixaria a
--   de PASTAS aberta — exatamente o que vazou. O bloco abaixo cobre as duas,
--   e a de prefixes só é criada se a tabela existir naquele projeto.

-- Guard: policy restritiva só vale com RLS LIGADO. No Supabase já vem ligado.
-- Se estiver desligado, o script NÃO liga sozinho (isso teria blast radius no
-- site) — só avisa pra você me chamar.
DO $$
DECLARE ligado boolean;
BEGIN
  SELECT relrowsecurity INTO ligado FROM pg_class WHERE oid = 'storage.objects'::regclass;
  IF ligado IS DISTINCT FROM true THEN
    RAISE WARNING '>> RLS DESLIGADO em storage.objects: a policy foi criada mas NAO tera efeito. NAO ligue sozinho (afeta o site). Me chame com este aviso.';
  ELSE
    RAISE NOTICE '>> RLS ligado em storage.objects — a restritiva vai valer.';
  END IF;
END $$;

-- (1) ARQUIVOS — storage.objects
DROP POLICY IF EXISTS "blue_videos_sem_enumeracao" ON storage.objects;
CREATE POLICY "blue_videos_sem_enumeracao" ON storage.objects
  AS RESTRICTIVE
  FOR SELECT
  TO public
  USING (
    bucket_id <> 'blue-videos'
    OR (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

-- (2) PASTAS — storage.prefixes (só se a tabela existir nesta versão)
DO $$
BEGIN
  IF to_regclass('storage.prefixes') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "blue_videos_sem_enumeracao_prefix" ON storage.prefixes';
    EXECUTE $p$
      CREATE POLICY "blue_videos_sem_enumeracao_prefix" ON storage.prefixes
        AS RESTRICTIVE
        FOR SELECT
        TO public
        USING (
          bucket_id <> 'blue-videos'
          OR (storage.foldername(name))[1] = (SELECT auth.uid())::text
        )
    $p$;
    RAISE NOTICE '>> storage.prefixes existe — restritiva de pastas criada.';
  ELSE
    RAISE NOTICE '>> storage.prefixes nao existe nesta versao — so storage.objects foi coberto (ok).';
  END IF;
END $$;

-- CONFERÊNCIA (só prova que a policy EXISTE; a prova de que FILTRA é o teste
-- real com a chave do app, que eu faço depois que você rodar isto).
SELECT schemaname, tablename, policyname, permissive, cmd
FROM pg_policies
WHERE (schemaname, tablename) IN (('storage','objects'), ('storage','prefixes'))
  AND policyname LIKE 'blue_videos_sem_enumeracao%'
ORDER BY tablename;

-- ROLLBACK (se algo do site parar de listar — não deve, só o blue-videos é
-- afetado):
--   DROP POLICY IF EXISTS "blue_videos_sem_enumeracao" ON storage.objects;
--   DROP POLICY IF EXISTS "blue_videos_sem_enumeracao_prefix" ON storage.prefixes;
