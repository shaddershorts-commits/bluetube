-- ============================================================================
-- sql/audit_log.sql — Trilha de auditoria completa de mudancas criticas
-- Triggers automaticos em tabelas sensiveis. Compliance + debugging + fraude.
-- Rodar no Supabase SQL Editor. Idempotente.
-- ============================================================================

-- 1) TABELA PRINCIPAL de auditoria --------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tabela TEXT NOT NULL,
  row_id TEXT,                          -- id da row afetada (pode ser uuid/bigint)
  acao TEXT NOT NULL,                   -- 'INSERT' | 'UPDATE' | 'DELETE'
  operacao_por TEXT,                    -- 'service_role' | 'authenticated' | etc (role)
  usuario_id UUID,                      -- se disponivel via session
  old_data JSONB,                       -- antes da mudanca (UPDATE/DELETE)
  new_data JSONB,                       -- depois (INSERT/UPDATE)
  campos_alterados TEXT[],              -- nomes das colunas que mudaram (so UPDATE)
  sql_context TEXT,                     -- current_query, primeiros 500 chars
  ip_address INET,                      -- inet_client_addr(), se aplicavel
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_tabela_row
  ON audit_log(tabela, row_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_usuario
  ON audit_log(usuario_id, created_at DESC) WHERE usuario_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_data
  ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_acao
  ON audit_log(acao, created_at DESC);

-- 2) FUNCTION GENERICA de trigger ---------------------------------------------
-- Captura automaticamente INSERT/UPDATE/DELETE com diff minimo
-- Nota: uso alias 'je' explicito em jsonb_each pra evitar ambiguidade com
-- variaveis PL/pgSQL (v_new, v_old) que causava erro "relation v_changed"
CREATE OR REPLACE FUNCTION audit_log_trigger() RETURNS trigger AS $fn$
DECLARE
  v_old JSONB;
  v_new JSONB;
  v_changed TEXT[] := ARRAY[]::TEXT[];
  v_row_id TEXT;
  rec RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD);
    v_new := NULL;
    v_row_id := COALESCE(v_old->>'id', v_old->>'user_id', v_old->>'email', '');
  ELSIF TG_OP = 'INSERT' THEN
    v_old := NULL;
    v_new := to_jsonb(NEW);
    v_row_id := COALESCE(v_new->>'id', v_new->>'user_id', v_new->>'email', '');
  ELSE
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    v_row_id := COALESCE(v_new->>'id', v_new->>'user_id', v_new->>'email', '');
    -- Loop explicito: evita parser ambiguity do SELECT INTO com variaveis
    FOR rec IN SELECT k FROM jsonb_object_keys(v_new) AS k LOOP
      IF rec.k NOT IN ('updated_at', 'atualizado_em')
         AND (v_new -> rec.k) IS DISTINCT FROM (v_old -> rec.k) THEN
        v_changed := array_append(v_changed, rec.k);
      END IF;
    END LOOP;
    IF array_length(v_changed, 1) IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO audit_log (
    tabela, row_id, acao, operacao_por, old_data, new_data, campos_alterados, sql_context, ip_address
  ) VALUES (
    TG_TABLE_NAME, v_row_id, TG_OP, current_user, v_old, v_new,
    CASE WHEN array_length(v_changed, 1) IS NULL THEN NULL ELSE v_changed END,
    LEFT(current_query(), 500), inet_client_addr()
  );

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3) TRIGGERS nas tabelas criticas --------------------------------------------
-- subscribers — plano, pagamentos, downgrade
DROP TRIGGER IF EXISTS audit_subscribers ON subscribers;
CREATE TRIGGER audit_subscribers
  AFTER INSERT OR UPDATE OR DELETE ON subscribers
  FOR EACH ROW EXECUTE FUNCTION audit_log_trigger();

-- affiliate_commissions — dinheiro
DROP TRIGGER IF EXISTS audit_affiliate_commissions ON affiliate_commissions;
CREATE TRIGGER audit_affiliate_commissions
  AFTER INSERT OR UPDATE OR DELETE ON affiliate_commissions
  FOR EACH ROW EXECUTE FUNCTION audit_log_trigger();

-- affiliate_saques — Pix saindo pra fora
DROP TRIGGER IF EXISTS audit_affiliate_saques ON affiliate_saques;
CREATE TRIGGER audit_affiliate_saques
  AFTER INSERT OR UPDATE OR DELETE ON affiliate_saques
  FOR EACH ROW EXECUTE FUNCTION audit_log_trigger();

-- affiliates — niveis, chaves Pix (mudam = auditar)
DROP TRIGGER IF EXISTS audit_affiliates ON affiliates;
CREATE TRIGGER audit_affiliates
  AFTER INSERT OR UPDATE OR DELETE ON affiliates
  FOR EACH ROW EXECUTE FUNCTION audit_log_trigger();

-- blue_videos — so audita DELETEs (INSERTs/UPDATEs sao muitos e pouco criticos)
CREATE OR REPLACE FUNCTION audit_log_trigger_delete_only() RETURNS trigger AS $fn$
BEGIN
  INSERT INTO audit_log (tabela, row_id, acao, operacao_por, old_data, sql_context, ip_address)
  VALUES (
    TG_TABLE_NAME, COALESCE((to_jsonb(OLD))->>'id', ''), 'DELETE', current_user,
    to_jsonb(OLD), LEFT(current_query(), 500), inet_client_addr()
  );
  RETURN OLD;
END;
$fn$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS audit_blue_videos_delete ON blue_videos;
CREATE TRIGGER audit_blue_videos_delete
  AFTER DELETE ON blue_videos
  FOR EACH ROW EXECUTE FUNCTION audit_log_trigger_delete_only();

-- blue_profiles — audita mudancas de username, verificado, banido
DROP TRIGGER IF EXISTS audit_blue_profiles ON blue_profiles;
CREATE TRIGGER audit_blue_profiles
  AFTER UPDATE OR DELETE ON blue_profiles
  FOR EACH ROW EXECUTE FUNCTION audit_log_trigger();

-- pioneiros_programa — dinheiro da campanha
DROP TRIGGER IF EXISTS audit_pioneiros ON pioneiros_programa;
CREATE TRIGGER audit_pioneiros
  AFTER INSERT OR UPDATE OR DELETE ON pioneiros_programa
  FOR EACH ROW EXECUTE FUNCTION audit_log_trigger();

-- 4) GC automatico — apaga audit_log > 180 dias (exceto DELETEs que valem por 2 anos)
CREATE OR REPLACE FUNCTION audit_log_gc() RETURNS TABLE (deleted_count BIGINT) AS $$
DECLARE
  v_count BIGINT;
BEGIN
  DELETE FROM audit_log
  WHERE created_at < NOW() - INTERVAL '180 days'
    AND acao != 'DELETE';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  DELETE FROM audit_log
  WHERE created_at < NOW() - INTERVAL '2 years'
    AND acao = 'DELETE';

  RETURN QUERY SELECT v_count;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION audit_log_gc() TO service_role;

-- 5) RPC pra query amigavel do admin -----------------------------------------
CREATE OR REPLACE FUNCTION audit_log_search(
  p_tabela TEXT DEFAULT NULL,
  p_row_id TEXT DEFAULT NULL,
  p_usuario_id UUID DEFAULT NULL,
  p_acao TEXT DEFAULT NULL,
  p_desde TIMESTAMPTZ DEFAULT NULL,
  p_limit INT DEFAULT 50
)
RETURNS TABLE (
  id UUID,
  tabela TEXT,
  row_id TEXT,
  acao TEXT,
  operacao_por TEXT,
  usuario_id UUID,
  campos_alterados TEXT[],
  resumo JSONB,
  created_at TIMESTAMPTZ
) LANGUAGE sql STABLE AS $$
  SELECT
    id, tabela, row_id, acao, operacao_por, usuario_id, campos_alterados,
    -- Resumo: so os campos que mudaram (so pra UPDATE), senao old/new inteiros
    CASE
      WHEN acao = 'UPDATE' AND campos_alterados IS NOT NULL THEN
        jsonb_build_object(
          'antes', (SELECT jsonb_object_agg(key, old_data -> key) FROM unnest(campos_alterados) key),
          'depois', (SELECT jsonb_object_agg(key, new_data -> key) FROM unnest(campos_alterados) key)
        )
      WHEN acao = 'DELETE' THEN old_data
      WHEN acao = 'INSERT' THEN new_data
    END AS resumo,
    created_at
  FROM audit_log
  WHERE (p_tabela IS NULL OR tabela = p_tabela)
    AND (p_row_id IS NULL OR row_id = p_row_id)
    AND (p_usuario_id IS NULL OR usuario_id = p_usuario_id)
    AND (p_acao IS NULL OR acao = p_acao)
    AND (p_desde IS NULL OR created_at >= p_desde)
  ORDER BY created_at DESC
  LIMIT LEAST(p_limit, 500);
$$;

GRANT EXECUTE ON FUNCTION audit_log_search(TEXT, TEXT, UUID, TEXT, TIMESTAMPTZ, INT) TO service_role;
