-- Publicaciones en redes — faltaban los pg_cron jobs de social-post-scheduler
-- y social-token-health-check. Ambas funciones ya estaban desplegadas
-- (ACTIVE) pero nada las invocaba nunca: no existe ningún cron.job para
-- ellas ni ningún trigger de base de datos, así que los posts programados
-- y los reintentos ("Reintentar" en el Historial) se quedaban en
-- 'en_cola'/'programado' para siempre -- "Publicar ahora" (social-publish-now)
-- es la única función que sí se invoca directo, por eso esa sí funciona.
--
-- Mismo patrón que los jobs ya existentes (resume-paused-conversations,
-- close-inactive-conversations): net.http_post sin header Authorization,
-- ya que CRON_SECRET no está configurado como secret en las Edge Functions
-- hoy (ver migración 20261028000000_require_cron_secret_on_jobs, todavía no
-- aplicada de verdad).
--
-- Idempotente: cron.unschedule() antes de cron.schedule() si el job ya
-- existe, para que correr esta migración dos veces no falle.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'social-post-scheduler') THEN
    PERFORM cron.unschedule('social-post-scheduler');
  END IF;
END $$;

-- cada 2 min -- cola unificada de publicaciones programadas/en reintento,
-- para Facebook e Instagram (igual que declarado en
-- supabase/config.toml -> [functions.social-post-scheduler])
SELECT cron.schedule(
  'social-post-scheduler',
  '*/2 * * * *',
  $cmd$
    select net.http_post(
      url     := 'https://wprvjhvtnyibiwpeiusc.supabase.co/functions/v1/social-post-scheduler',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body    := '{}'::jsonb
    )
  $cmd$
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'social-token-health-check') THEN
    PERFORM cron.unschedule('social-token-health-check');
  END IF;
END $$;

-- diario, 07:00 hora de Ciudad de México (UTC-6) = 13:00 UTC -- chequeo
-- proactivo de tokens de Meta (igual que declarado en supabase/config.toml
-- -> [functions.social-token-health-check])
SELECT cron.schedule(
  'social-token-health-check',
  '0 13 * * *',
  $cmd$
    select net.http_post(
      url     := 'https://wprvjhvtnyibiwpeiusc.supabase.co/functions/v1/social-token-health-check',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body    := '{}'::jsonb
    )
  $cmd$
);
