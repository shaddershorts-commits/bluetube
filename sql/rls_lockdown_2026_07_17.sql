-- rls_lockdown_2026_07_17.sql — CORRECAO CRITICA DE SEGURANCA (RLS)
-- 34 tabelas estavam legiveis pela chave publica (anon key, exposta no site/app).
-- A tabela subscribers permitia ate INSERT/UPDATE/DELETE anon:
--   qualquer um podia se auto-promover a Master ou apagar clientes.
-- Todas sao acessadas SO pela API (service key, que IGNORA RLS por design),
-- entao ligar RLS sem policy TRANCA o anon e NAO quebra o app. Idempotente.
-- Rode no SQL Editor do Supabase. Depois: verifique o painel Authentication >
-- Policies (deve mostrar RLS enabled, 0 policies = ninguem alem do service key).

ALTER TABLE public.affiliate_fingerprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_fingerprints FORCE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_nivel_historico ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_nivel_historico FORCE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_reconcile_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_reconcile_log FORCE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_saques ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_saques FORCE ROW LEVEL SECURITY;
ALTER TABLE public.blue_backups_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blue_backups_log FORCE ROW LEVEL SECURITY;
ALTER TABLE public.blue_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blue_follows FORCE ROW LEVEL SECURITY;
ALTER TABLE public.blue_fundo_criadores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blue_fundo_criadores FORCE ROW LEVEL SECURITY;
ALTER TABLE public.blue_grupos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blue_grupos FORCE ROW LEVEL SECURITY;
ALTER TABLE public.blue_hashtags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blue_hashtags FORCE ROW LEVEL SECURITY;
ALTER TABLE public.blue_moderacao ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blue_moderacao FORCE ROW LEVEL SECURITY;
ALTER TABLE public.blue_notificacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blue_notificacoes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.blue_popup_impressoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blue_popup_impressoes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.blue_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blue_rate_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE public.blue_salvos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blue_salvos FORCE ROW LEVEL SECURITY;
ALTER TABLE public.blue_video_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blue_video_analytics FORCE ROW LEVEL SECURITY;
ALTER TABLE public.blue_video_hashtags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blue_video_hashtags FORCE ROW LEVEL SECURITY;
ALTER TABLE public.bluescore_analises ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bluescore_analises FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commission_patch_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_patch_queue FORCE ROW LEVEL SECURITY;
ALTER TABLE public.editor_estilos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.editor_estilos FORCE ROW LEVEL SECURITY;
ALTER TABLE public.editor_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.editor_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ip_online ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ip_online FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ip_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ip_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ip_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ip_visits FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payment_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscribers FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tendencias_analise ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tendencias_analise FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tendencias_canais_conectados ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tendencias_canais_conectados FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tendencias_rpm_nichos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tendencias_rpm_nichos FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tendencias_sessoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tendencias_sessoes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_feedback FORCE ROW LEVEL SECURITY;
ALTER TABLE public.virais_banco ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.virais_banco FORCE ROW LEVEL SECURITY;
ALTER TABLE public.virais_clusters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.virais_clusters FORCE ROW LEVEL SECURITY;
ALTER TABLE public.virais_coletas_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.virais_coletas_log FORCE ROW LEVEL SECURITY;
ALTER TABLE public.virais_modelo_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.virais_modelo_log FORCE ROW LEVEL SECURITY;
