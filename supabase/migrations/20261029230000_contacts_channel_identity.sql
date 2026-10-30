-- Los contactos de Instagram/Messenger se guardaban con el IGSID/PSID metido
-- en `phone` (ej. 'ig:17841437975820718'), formateado en el dashboard como
-- si fuera un teléfono real. Esto les da una identidad propia (channel +
-- external_id + username) y deja `phone` solo para contactos que de verdad
-- tienen uno (WhatsApp, landing page, Zapier, CRM manual).
--
-- channel default 'whatsapp' porque todos los contactos existentes hoy son
-- de WhatsApp salvo el puñado de Instagram que ya se identifican por el
-- prefijo 'ig:' en phone -- esos se corrigen en un script de backfill aparte
-- (no en esta migración: necesita llamar a la Graph API con el token
-- guardado de cada org, no se puede hacer en SQL puro).
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp',
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS username text;

-- phone deja de ser obligatorio: un contacto de Instagram/Messenger no tiene
-- uno real y no se le va a inventar (ver supabase/functions/webhook-ig,
-- webhook-fb). El índice único (organization_id, phone) sigue intacto --
-- Postgres no considera iguales dos NULLs, así que varios contactos sin
-- teléfono en la misma org no chocan entre sí.
ALTER TABLE contacts ALTER COLUMN phone DROP NOT NULL;

-- Búsqueda por (org, canal, external_id) -- lo que usan webhook-ig/webhook-fb
-- para encontrar o crear el contacto de un IGSID/PSID. Único mientras haya
-- external_id, para no duplicar el mismo IGSID/PSID dos veces por un error
-- de carrera entre mensajes simultáneos.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_org_channel_external_id_key
  ON contacts (organization_id, channel, external_id)
  WHERE external_id IS NOT NULL;
