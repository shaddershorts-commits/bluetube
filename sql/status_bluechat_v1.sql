-- status_bluechat_v1.sql — Batch BlueChat (2026-07-17)
-- Rode no SQL Editor do Supabase. Idempotente (pode rodar 2x sem quebrar).

-- ── 1. Stories ganham audiência ──────────────────────────────────────────────
-- 'stories' = aparece pro perfil/seguidores (comportamento atual)
-- 'status'  = aparece SÓ pros contatos aceitos do BlueChat (estilo WhatsApp)
alter table blue_stories add column if not exists audience text not null default 'stories';
create index if not exists idx_bstories_aud_exp on blue_stories(audience, expirado_em);

-- ── 2. Compartilhar vídeo do feed no story/status ────────────────────────────
alter table blue_stories add column if not exists video_id uuid;

-- ── 3. Contatos com aceite (adicionar usuário → outro precisa aceitar) ───────
-- Retrocompat: contatos existentes viram 'accepted' pelo default.
alter table blue_contatos add column if not exists status text not null default 'accepted';
create index if not exists idx_bcontatos_pending on blue_contatos(contato_id, status);

-- ── 4. Perfil: privacidade + tipo de conta ───────────────────────────────────
-- is_private: perfil privado (vídeos só pra seguidores)
-- account_type: 'profissional' (tudo: insights, curtidas, monetização) |
--               'pessoal' (simples: chat + assistir, sem insights/monetização)
alter table blue_profiles add column if not exists is_private boolean not null default false;
alter table blue_profiles add column if not exists account_type text not null default 'profissional';
