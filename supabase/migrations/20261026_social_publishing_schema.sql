-- Publicaciones en redes (Facebook/Instagram) — Fase 0/1
-- Feature flag (business_modules, recreada de forma idempotente porque en
-- producción ya existe desde el feature de ingresos/comisiones/reportes
-- pero esa migración nunca se comiteó en main) + esquema completo del
-- módulo nuevo.
--
-- NO se aplica a producción todavía -- solo queda como archivo en el repo
-- hasta que el usuario lo autorice explícitamente.

-- ── business_modules (idempotente: ya existe en prod, puede no existir
--    en un ambiente nuevo que solo tenga las migraciones de main) ───────
create table if not exists public.business_modules (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  module_key      text not null,
  enabled         boolean not null default false,
  enabled_at      timestamptz,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, module_key)
);

-- Amplía el check de module_key en vez de asumir que no existe o que ya
-- incluye 'publicaciones_redes' -- cubre los 3 casos (tabla nueva, tabla
-- existente sin constraint, tabla existente con el constraint angosto de
-- income/commissions/reports).
alter table public.business_modules drop constraint if exists business_modules_module_key_check;
alter table public.business_modules add constraint business_modules_module_key_check
  check (module_key in ('income', 'commissions', 'reports', 'publicaciones_redes'));

alter table public.business_modules enable row level security;

drop policy if exists "business_modules_select" on public.business_modules;
create policy "business_modules_select" on public.business_modules
  for select using (public.is_super_admin() or organization_id = public.get_my_org_id());

-- Escritura SOLO super_admin -- un negocio nunca puede activarse su propio
-- módulo.
drop policy if exists "business_modules_write_super_admin" on public.business_modules;
create policy "business_modules_write_super_admin" on public.business_modules
  for all using (public.is_super_admin()) with check (public.is_super_admin());

-- Valida que quien pregunta sea super_admin, de esa misma org, o el
-- service_role (Edge Functions de cron) -- nunca revela el estado de
-- módulos de otra organización. 'publicaciones_redes' no depende de
-- ningún otro módulo (a diferencia de reports/commissions, que dependen
-- de income en el feature de ingresos), así que cae directo al default.
create or replace function public.module_enabled(p_org uuid, p_module text)
returns boolean language sql security definer stable set search_path = public as $$
  select case
    when not (public.is_super_admin() or p_org = public.get_my_org_id() or auth.role() = 'service_role') then false
    when p_module in ('reports', 'commissions') then
      coalesce((select enabled from business_modules where organization_id = p_org and module_key = p_module), false)
      and coalesce((select enabled from business_modules where organization_id = p_org and module_key = 'income'), false)
    else
      coalesce((select enabled from business_modules where organization_id = p_org and module_key = p_module), false)
  end
$$;

-- ── social_accounts — una Page de Facebook y/o una cuenta de Instagram
--    profesional conectada por organización ──────────────────────────
create table if not exists public.social_accounts (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references organizations(id) on delete cascade,
  platform           text not null check (platform in ('facebook_page', 'instagram_business')),
  external_id        text not null, -- Page ID o IG Business Account ID
  name               text not null,
  username           text,          -- handle de Instagram
  avatar_url         text,
  facebook_page_id   text,          -- en filas de Instagram: la Page vinculada
  access_token       text not null, -- token de Page de larga duración, nunca se regresa al navegador
  status             text not null default 'connected' check (status in ('connected', 'token_expired', 'error')),
  last_error_code    text,
  last_error_message text,
  scopes             text,
  connected_by       uuid references profiles(id),
  connected_at       timestamptz not null default now(),
  token_expires_at   timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, platform) -- MVP: máximo 1 Page + 1 IG por org
);

alter table public.social_accounts enable row level security;
drop policy if exists "social_accounts_org_scope" on public.social_accounts;
create policy "social_accounts_org_scope" on public.social_accounts
  using (
    (public.is_super_admin() or organization_id = public.get_my_org_id())
    and public.module_enabled(organization_id, 'publicaciones_redes')
  );

-- ── post_templates — catálogo estático sembrado por Avaxon, no por
--    organización (sin RLS multi-tenant, solo is_active). Va antes de
--    social_posts porque esta la referencia (template_id). ────────────
create table if not exists public.post_templates (
  id               uuid primary key default gen_random_uuid(),
  giro             text not null,
  name             text not null,
  format           text not null check (format in ('post', 'carrusel')),
  platforms        text[] not null default array['facebook_page', 'instagram_business'],
  preview_kicker   text,
  preview_headline text,
  preview_subtext  text,
  caption_template text not null default '',
  media_urls       jsonb not null default '[]'::jsonb,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now()
);

alter table public.post_templates enable row level security;
drop policy if exists "post_templates_read_all" on public.post_templates;
create policy "post_templates_read_all" on public.post_templates
  for select using (is_active or public.is_super_admin());

drop policy if exists "post_templates_write_super_admin" on public.post_templates;
create policy "post_templates_write_super_admin" on public.post_templates
  for all using (public.is_super_admin()) with check (public.is_super_admin());

-- ── social_posts — contenido autoría compartida entre redes ─────────
create table if not exists public.social_posts (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references organizations(id) on delete cascade,
  created_by           uuid references profiles(id),
  caption              text not null default '',
  cta_whatsapp         boolean not null default false,
  template_id          uuid references post_templates(id),
  ai_generation_params jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.social_posts enable row level security;
drop policy if exists "social_posts_org_scope" on public.social_posts;
create policy "social_posts_org_scope" on public.social_posts
  using (
    (public.is_super_admin() or organization_id = public.get_my_org_id())
    and public.module_enabled(organization_id, 'publicaciones_redes')
  );

-- ── social_post_media — imágenes del post (post simple o carrusel) ───
create table if not exists public.social_post_media (
  id            uuid primary key default gen_random_uuid(),
  post_id       uuid not null references social_posts(id) on delete cascade,
  storage_path  text not null,
  public_url    text not null,
  "position"    smallint not null default 0, -- 0 = portada
  width         int,
  height        int,
  created_at    timestamptz not null default now()
);

-- RLS vía el post dueño (no tiene organization_id propio) -- igual de
-- estricto porque social_posts ya exige module_enabled.
alter table public.social_post_media enable row level security;
drop policy if exists "social_post_media_via_post" on public.social_post_media;
create policy "social_post_media_via_post" on public.social_post_media
  using (
    exists (
      select 1 from social_posts p
      where p.id = social_post_media.post_id
        and (public.is_super_admin() or p.organization_id = public.get_my_org_id())
        and public.module_enabled(p.organization_id, 'publicaciones_redes')
    )
  );

-- ── social_post_targets — una fila por (post, red social); esta es la
--    fila real que se programa/publica/reintenta ────────────────────
create table if not exists public.social_post_targets (
  id                uuid primary key default gen_random_uuid(),
  post_id           uuid not null references social_posts(id) on delete cascade,
  organization_id   uuid not null references organizations(id) on delete cascade, -- denormalizado para RLS/queries directas
  social_account_id uuid not null references social_accounts(id),
  platform          text not null check (platform in ('facebook_page', 'instagram_business')), -- denormalizado
  status            text not null default 'borrador' check (status in ('borrador', 'programado', 'en_cola', 'publicado', 'fallido')),
  publish_mode      text not null default 'now' check (publish_mode in ('now', 'scheduled')),
  scheduled_at      timestamptz,
  "timezone"        text,
  attempt_count     int not null default 0,
  last_attempt_at   timestamptz,
  next_attempt_at   timestamptz,
  error_code        text,
  error_message     text,
  external_post_id  text,
  published_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.social_post_targets enable row level security;
drop policy if exists "social_post_targets_org_scope" on public.social_post_targets;
create policy "social_post_targets_org_scope" on public.social_post_targets
  using (
    (public.is_super_admin() or organization_id = public.get_my_org_id())
    and public.module_enabled(organization_id, 'publicaciones_redes')
  );

-- Índice para el poll del cron de programación.
create index if not exists idx_social_post_targets_due
  on public.social_post_targets (status, scheduled_at, next_attempt_at)
  where status in ('programado', 'en_cola');
