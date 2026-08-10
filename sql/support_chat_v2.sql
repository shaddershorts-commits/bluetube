-- sql/support_chat_v2.sql — prints, selo de visto e presença no chat de suporte
-- ===========================================================================
-- Roda em cima do sql/support_chat.sql. Idempotente: rodar 2x não dá erro.
--
-- 1. PRINT — support_messages.image_path guarda o CAMINHO no storage, não uma
--    URL pública. Print de suporte costuma ter email, cobrança, dado pessoal;
--    URL pública é link eterno pra quem descobrir o endereço. O backend assina
--    uma URL de 1 hora na hora de entregar a mensagem.
--
-- 2. SELO DE VISTO — support_messages.read_at já existia e já era preenchido
--    dos dois lados; o que faltava era mostrar. Nada a mudar aqui.
--
-- 3. PRESENÇA — tabela nova. Só o admin lê (o usuário não fica sabendo se
--    você está online; a recíproca não foi pedida e vaza mais do que ajuda).

alter table support_messages add column if not exists image_path text;

-- Mensagem pode ser só imagem (sem texto). O NOT NULL original obrigava texto.
alter table support_messages alter column content drop not null;

-- ── PRESENÇA ───────────────────────────────────────────────────────────────
-- Uma linha por usuário, sobrescrita. Não é histórico de sessão: é só "quando
-- foi a última vez que esta pessoa deu sinal de vida no site".
-- user_id sai do PRÓPRIO token (auth.uid()), não do corpo do request: assim o
-- navegador não precisa mandar quem ele é, e nem consegue mentir sobre isso.
create table if not exists support_presenca (
  user_id   uuid primary key default auth.uid(),
  visto_em  timestamptz not null default now()
);

create index if not exists support_presenca_visto_idx
  on support_presenca (visto_em desc);

alter table support_presenca enable row level security;

-- O navegador grava DIRETO aqui (sem passar pela Vercel) — por isso precisa de
-- policy. Só a própria linha, só escrita.
drop policy if exists presenca_insert_own on support_presenca;
create policy presenca_insert_own on support_presenca
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists presenca_update_own on support_presenca;
create policy presenca_update_own on support_presenca
  for update to authenticated using (auth.uid() = user_id);

-- SEM policy de SELECT de propósito: quem lê é só o backend com service key.
-- Usuário não descobre quem mais está online.

-- ── BUCKET DOS PRINTS ──────────────────────────────────────────────────────
-- PRIVADO de propósito (public=false). Criado pelo backend na primeira vez,
-- mas dá pra criar aqui também se preferir:
--
--   insert into storage.buckets (id, name, public)
--   values ('support-prints', 'support-prints', false)
--   on conflict (id) do nothing;
