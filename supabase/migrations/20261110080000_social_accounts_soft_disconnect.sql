-- Bug en prod: "Desconectar" en Publicaciones en redes hace
-- DELETE directo sobre social_accounts (dashboard/index.html,
-- disconnectSocialAccount()). Eso falla con
-- "update or delete on table social_accounts violates foreign key
-- constraint social_post_targets_social_account_id_fkey" en cuanto la
-- cuenta tiene al menos un post publicado -- social_post_targets.
-- social_account_id es NOT NULL y sin on delete a propósito (no se quiere
-- perder, para un post ya publicado, con qué cuenta se publicó).
--
-- Fix: "Desconectar" pasa a ser un soft-delete (status='disconnected' +
-- access_token=NULL) en vez de un DELETE. Reconectar sigue funcionando
-- igual que hoy sin tocar nada más: social-oauth-callback ya hace
-- upsert(..., {onConflict: 'organization_id,platform'}), así que al volver
-- a conectar sobrescribe esta misma fila (nuevo external_id/name/token,
-- status='connected') -- no hace falta tocar el unique(organization_id,
-- platform) ni el flujo de conexión.
--
-- Nada que lea access_token revienta con NULL: _shared/socialPublish.ts y
-- social-token-health-check ya usan `?? ''` como fallback, y ambos filtran
-- por status antes de usar el token (socialPublish corta si status !==
-- 'connected'; token-health-check solo selecciona status='connected').

alter table public.social_accounts alter column access_token drop not null;

alter table public.social_accounts drop constraint if exists social_accounts_status_check;
alter table public.social_accounts add constraint social_accounts_status_check
  check (status in ('connected', 'token_expired', 'error', 'disconnected'));
