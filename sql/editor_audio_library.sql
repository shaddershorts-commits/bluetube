-- Biblioteca de áudio CURADA do BlueEditor (você adiciona manualmente por
-- categoria em /blueeditor-audio). Rode uma vez no Supabase SQL editor.

create table if not exists editor_audio_library (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('music','sfx')),   -- música ou efeito
  category    text not null default 'Geral',                   -- ex: "Lo-fi", "Whoosh"
  name        text not null,
  url         text not null,                                    -- mp3/wav público
  duration    numeric,                                          -- segundos (opcional)
  created_at  timestamptz default now()
);

create index if not exists editor_audio_library_kind_idx on editor_audio_library (kind);

alter table editor_audio_library enable row level security;

-- LEITURA pública (o editor lê pela anon key). ESCRITA só pelo endpoint admin
-- (service key), então NÃO criamos policy de insert/update/delete pra anon.
drop policy if exists "audio_lib_public_read" on editor_audio_library;
create policy "audio_lib_public_read" on editor_audio_library for select using (true);
