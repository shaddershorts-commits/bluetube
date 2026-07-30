-- blue_calls — chamadas de voz/vídeo 1:1 do BlueChat (v1.5.2 / AAB 153)
-- Rodar no SQL Editor do Supabase.
--
-- A tabela é só o REGISTRO da chamada (histórico + estado). A negociação
-- técnica (SDP/ICE do WebRTC) NÃO passa pelo banco: vai por canal Realtime
-- broadcast `call-<id>`, que não persiste nada.

CREATE TABLE IF NOT EXISTS public.blue_calls (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id   uuid NOT NULL,
  callee_id   uuid NOT NULL,
  tipo        text NOT NULL DEFAULT 'audio' CHECK (tipo IN ('audio','video')),
  -- ringing → active → ended | declined | missed | cancelled
  status      text NOT NULL DEFAULT 'ringing'
              CHECK (status IN ('ringing','active','ended','declined','missed','cancelled')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  ended_at    timestamptz,
  duration_s  integer DEFAULT 0,
  -- Fase 2 ("adicionar pessoa na ligação", já previsto no schema pra não
  -- precisar de segunda migração): quem mais entrou além do par original.
  participantes jsonb NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_blue_calls_caller ON public.blue_calls (caller_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_blue_calls_callee ON public.blue_calls (callee_id, started_at DESC);
-- watchdog: achar chamadas penduradas em 'ringing'
CREATE INDEX IF NOT EXISTS idx_blue_calls_ringing ON public.blue_calls (status) WHERE status = 'ringing';

-- Mesmo padrão do lockdown 2026-07-17: anon NÃO enxerga nada; todo acesso
-- passa pela API (service key).
ALTER TABLE public.blue_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blue_calls FORCE ROW LEVEL SECURITY;
