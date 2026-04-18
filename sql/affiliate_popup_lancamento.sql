-- sql/affiliate_popup_lancamento.sql
-- Coluna pra rastrear se o afiliado ja viu o popup unico de lancamento.
-- Permite que aparece 1x e nunca mais, persistido no banco (nao localStorage,
-- que pode ser limpo ou nao sincroniza entre dispositivos).

ALTER TABLE affiliates
  ADD COLUMN IF NOT EXISTS popup_lancamento_visto BOOLEAN DEFAULT FALSE;

-- Indice parcial otimiza a query de quem AINDA nao viu (tabela fica pequena
-- com tempo, so a fracao que ainda precisa ver).
CREATE INDEX IF NOT EXISTS idx_affiliates_popup_pendente
  ON affiliates(popup_lancamento_visto)
  WHERE popup_lancamento_visto = FALSE;

-- Verificacao (rode depois):
--   SELECT email, name, popup_lancamento_visto FROM affiliates ORDER BY created_at DESC LIMIT 10;
