-- Chat estilo WhatsApp (2026-07-15): mídia nas mensagens + grupos privados
-- Rodar no Supabase SQL Editor.

-- Mídia nas mensagens 1:1 (foto, vídeo, áudio, gif)
alter table blue_messages add column if not exists media_url text;
alter table blue_messages add column if not exists media_type text;
alter table blue_messages add column if not exists media_duration int;

-- Sinais de visualização estilo WhatsApp:
-- enviado = row existe (1 ✓) · entregue = app do destinatário buscou (✓✓) ·
-- lido = destinatário abriu a conversa (✓✓ azul, coluna read já existe)
alter table blue_messages add column if not exists delivered boolean default false;

-- Mídia nas mensagens de grupo
alter table blue_grupo_mensagens add column if not exists media_url text;
alter table blue_grupo_mensagens add column if not exists media_type text;
alter table blue_grupo_mensagens add column if not exists media_duration int;

-- Grupos: avatar + última mensagem (pra lista de conversas estilo WhatsApp)
alter table blue_grupos add column if not exists avatar_url text;
alter table blue_grupos add column if not exists last_message text;
alter table blue_grupos add column if not exists last_message_at timestamptz;
