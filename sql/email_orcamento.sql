-- sql/email_orcamento.sql — teto diário compartilhado do email de marketing
--
-- Por que existe: o Resend caiu pra 100/dia · 3.000/mês e os 8 jobs de
-- marketing não se conhecem. Cada um respeitando "30 por dia" viraria 240 e
-- derrubaria o código de cadastro (OTP), que sai pela mesma cota. Esta tabela
-- é o contador ÚNICO do dia — quem chega primeiro gasta, quem chega depois
-- pega o resto, e quando zera ninguém manda mais até o dia virar.
--
-- Uma linha por dia. Não precisa limpar: são ~365 linhas por ano.

create table if not exists email_orcamento (
  dia            date        primary key,
  enviados       integer     not null default 0,
  atualizado_em  timestamptz not null default now()
);

-- O incremento é compare-and-swap (PATCH filtrando pelo valor lido), então a
-- chave primária em `dia` é o que garante uma linha só por dia mesmo com dois
-- crons disparando no mesmo minuto.

-- Segurança: igual ao resto do banco depois do lockdown — RLS ligada e NENHUMA
-- policy, ou seja, só a service key do backend enxerga. O anon não lê nem grava.
alter table email_orcamento enable row level security;

-- Conferir o gasto de hoje:
--   select * from email_orcamento order by dia desc limit 7;
--
-- Zerar o dia na mão (ex: pra testar, ou depois de subir o plano do Resend):
--   update email_orcamento set enviados = 0 where dia = current_date;
