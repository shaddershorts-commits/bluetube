-- Adiciona utm_id ao subscribers para atribuição por criativo do Meta Ads.
-- utm_id = {{ad.id}} (chave ESTÁVEL pro cruzamento com a Marketing API — o nome
-- do anúncio pode mudar, o id não). Idempotente: seguro rodar mais de uma vez.
-- O endpoint api/marketing-attribution.js já grava utm_id de forma resiliente:
-- enquanto esta coluna não existir, o utm_source/content continua salvando e o
-- utm_id só é ignorado (log). Depois de rodar isto, utm_id passa a persistir.

ALTER TABLE subscribers
  ADD COLUMN IF NOT EXISTS utm_id VARCHAR(100);

-- Índice leve pro relatório cruzar por criativo (utm_id) sem full scan.
CREATE INDEX IF NOT EXISTS idx_subscribers_utm_id
  ON subscribers (utm_id)
  WHERE utm_id IS NOT NULL;
