-- Publicaciones en redes — bucket de Storage para imágenes de posts.
--
-- Los 2 buckets existentes (org-logos, agent-requests) no tienen límite de
-- tamaño/tipo de archivo ni políticas comiteadas en ninguna migración (se
-- configuraron a mano en Studio). Para este bucket sí se fija un límite
-- real de tamaño/tipo y la policy queda en una migración trackeada.
--
-- NO se aplica a producción todavía -- solo queda como archivo en el repo
-- hasta que el usuario lo autorice explícitamente.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'social-media',
  'social-media',
  true, -- público: Graph API necesita una URL pública para publicar
  10485760, -- 10 MB por archivo
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = true,
  file_size_limit = 10485760,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

-- Convención de ruta: {organization_id}/{post_id}/{nombre_sanitizado} --
-- (storage.foldername(name))[1] es el primer segmento de la ruta, igual
-- al patrón ya usado implícitamente por org-logos/agent-requests (prefijo
-- por organizationId), solo que aquí sí queda comiteado como policy real.

drop policy if exists "social_media_public_read" on storage.objects;
create policy "social_media_public_read" on storage.objects
  for select using (bucket_id = 'social-media');

drop policy if exists "social_media_org_write" on storage.objects;
create policy "social_media_org_write" on storage.objects
  for insert with check (
    bucket_id = 'social-media'
    and (
      public.is_super_admin()
      or (storage.foldername(name))[1] = public.get_my_org_id()::text
    )
    and public.module_enabled(((storage.foldername(name))[1])::uuid, 'publicaciones_redes')
  );

drop policy if exists "social_media_org_delete" on storage.objects;
create policy "social_media_org_delete" on storage.objects
  for delete using (
    bucket_id = 'social-media'
    and (
      public.is_super_admin()
      or (storage.foldername(name))[1] = public.get_my_org_id()::text
    )
  );
