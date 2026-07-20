-- Auditoria vídeo-a-vídeo do Blublu (regra de ouro: precisão > quantidade).
-- Adiciona colunas ao log pra cada análise ver O QUE foi entregue e a cobertura.
-- Rode uma vez no Supabase SQL editor. Idempotente.

alter table blublu_chat_logs add column if not exists estrategia          text;   -- tematica | tematica_sem_direto | filtro | vazio
alter table blublu_chat_logs add column if not exists diretos             int;    -- casaram no tema (fala/titulo/canal) = precisão
alter table blublu_chat_logs add column if not exists relacionados        int;    -- volume-fill (parecidos, não diretos)
alter table blublu_chat_logs add column if not exists total_no_banco      int;    -- quantos casaram o critério no acervo
alter table blublu_chat_logs add column if not exists cortados_por_limite int;    -- tinha mais, não coube na quantidade pedida
alter table blublu_chat_logs add column if not exists itens_entregues     jsonb;  -- [{t:título, c:canal, v:views, por:confirmado_por}] de cada vídeo
