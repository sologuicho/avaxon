-- =============================================================================
-- Migración: exige CRON_SECRET en las llamadas de pg_cron a los jobs de
-- resume-paused-conversations (jobid 7) y close-inactive-conversations
-- (jobid 16).
--
-- NO APLICAR TAL CUAL. Antes de correr esta migración:
--   1. Generar el valor real de CRON_SECRET.
--   2. Reemplazar las 3 apariciones de __CRON_SECRET_PLACEHOLDER__ abajo por
--      ese valor.
--   3. Configurar ese mismo valor en las Edge Functions en el mismo momento:
--      supabase secrets set CRON_SECRET=<valor> --project-ref wprvjhvtnyibiwpeiusc
--      (orden: primero el secret de las funciones, luego esta migración --
--      al revés, los crons quedarían mandando un header que la función aún
--      no espera, lo cual no rompe nada porque CRON_SECRET sin configurar
--      desactiva el check; en el otro orden sí quedarían 401 unos segundos).
--
-- Hoy, sin CRON_SECRET configurado en las Edge Functions, el check
-- `if (CRON_SECRET && ...)` de ambas funciones es un no-op: cualquiera con
-- la URL puede invocarlas sin autenticación. Esta migración por sí sola NO
-- arregla eso -- solo actualiza lo que pg_cron manda. El fix real pasa por
-- configurar el secret también.
-- =============================================================================

DO $$
BEGIN
  IF '__CRON_SECRET_PLACEHOLDER__' = '__CRON_SECRET_PLACEHOLDER__' THEN
    RAISE EXCEPTION 'Reemplaza __CRON_SECRET_PLACEHOLDER__ por el valor real de CRON_SECRET antes de aplicar esta migración.';
  END IF;
END $$;

SELECT cron.alter_job(
  job_id  := 7,
  command := $cmd$
    select net.http_post(
      url     := 'https://wprvjhvtnyibiwpeiusc.supabase.co/functions/v1/resume-paused-conversations',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer __CRON_SECRET_PLACEHOLDER__'),
      body    := '{}'::jsonb
    )
  $cmd$
);

SELECT cron.alter_job(
  job_id  := 16,
  command := $cmd$
    select net.http_post(
      url     := 'https://wprvjhvtnyibiwpeiusc.supabase.co/functions/v1/close-inactive-conversations',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer __CRON_SECRET_PLACEHOLDER__'),
      body    := '{}'::jsonb
    )
  $cmd$
);
