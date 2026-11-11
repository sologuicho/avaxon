-- Promocionar publicaciones — falta el pg_cron job de
-- social-ads-metrics-sync. La función ya se despliega en el Paso 3 del
-- rollout (ver docs/promociones-meta.md) pero nada la invoca nunca si no
-- existe este job -- las métricas (spend/reach/impressions/clicks/messages)
-- de social_promotions se quedarían siempre en 0.
--
-- Mismo patrón que 20261029210000_social_publishing_cron_jobs.sql:
-- net.http_post sin header Authorization (CRON_SECRET no está configurado
-- como secret en las Edge Functions hoy), idempotente vía
-- cron.unschedule() antes de cron.schedule().

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'social-ads-metrics-sync') THEN
    PERFORM cron.unschedule('social-ads-metrics-sync');
  END IF;
END $$;

-- cada 30 min -- sincroniza spend/reach/impressions/clicks/messages desde
-- Meta Marketing API hacia social_promotion_metrics para las promociones
-- activas/pausadas
SELECT cron.schedule(
  'social-ads-metrics-sync',
  '*/30 * * * *',
  $cmd$
    select net.http_post(
      url     := 'https://wprvjhvtnyibiwpeiusc.supabase.co/functions/v1/social-ads-metrics-sync',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body    := '{}'::jsonb
    )
  $cmd$
);
