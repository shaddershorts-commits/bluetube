-- Programa de monetização do Blue — candidaturas por marco de seguidores.
-- Rodar UMA vez no SQL Editor do Supabase.
--
-- Marcos:
--   100    seguidores → link de produto nos vídeos
--   1.000  seguidores → lives com link + doações
--   10.000 seguidores → convite pro Programa de Parceria Blue (paga por view)
--
-- O endpoint /api/blue-monetizacao?action=programa-status funciona MESMO SEM
-- esta tabela (degrada com aviso), então a tela nunca quebra. O que a tabela
-- habilita é o botão "aplicar" e o aviso quando o marco é atingido.

CREATE TABLE IF NOT EXISTS blue_programa_aplicacoes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  marco        text NOT NULL CHECK (marco IN ('produto', 'lives', 'parceria')),
  status       text NOT NULL DEFAULT 'em_analise'
               CHECK (status IN ('em_analise', 'aprovado', 'recusado')),
  seguidores   integer NOT NULL DEFAULT 0,  -- foto do momento da candidatura
  observacao   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  decidido_em  timestamptz,
  UNIQUE (user_id, marco)     -- uma candidatura por marco por pessoa
);

CREATE INDEX IF NOT EXISTS idx_programa_user   ON blue_programa_aplicacoes (user_id);
CREATE INDEX IF NOT EXISTS idx_programa_status ON blue_programa_aplicacoes (status, created_at DESC);

-- Fila de aviso: quem pediu pra ser notificado ao ATINGIR um marco.
CREATE TABLE IF NOT EXISTS blue_programa_avisos (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  marco      text NOT NULL CHECK (marco IN ('produto', 'lives', 'parceria')),
  avisado_em timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, marco)
);

CREATE INDEX IF NOT EXISTS idx_avisos_pendentes ON blue_programa_avisos (marco) WHERE avisado_em IS NULL;

-- RLS: só a service key do backend escreve/lê (mesmo padrão do lockdown
-- de 17/07). O app nunca fala direto com estas tabelas.
ALTER TABLE blue_programa_aplicacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE blue_programa_aplicacoes FORCE  ROW LEVEL SECURITY;
ALTER TABLE blue_programa_avisos     ENABLE ROW LEVEL SECURITY;
ALTER TABLE blue_programa_avisos     FORCE  ROW LEVEL SECURITY;
