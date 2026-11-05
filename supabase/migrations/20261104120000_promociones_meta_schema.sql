-- Promocionar publicaciones (Meta Marketing API) — esquema nuevo.
--
-- NO se aplica a producción todavía -- solo queda como archivo en el repo
-- hasta que el usuario lo autorice explícitamente (ver docs/promociones-meta.md).
-- Construido sobre el módulo "Publicaciones en redes" ya mergeado a main
-- (social_accounts/social_posts/social_post_targets/business_modules).

-- ── module_key nuevo: 'promocion_publicaciones' ─────────────────────────
alter table public.business_modules drop constraint if exists business_modules_module_key_check;
alter table public.business_modules add constraint business_modules_module_key_check
  check (module_key in ('income', 'commissions', 'reports', 'publicaciones_redes', 'promocion_publicaciones'));

-- module_enabled() ya contempla la dependencia reports/commissions->income;
-- se amplía para que promocion_publicaciones dependa de publicaciones_redes,
-- mismo patrón.
create or replace function public.module_enabled(p_org uuid, p_module text)
returns boolean language sql security definer stable set search_path = public as $$
  select case
    when not (public.is_super_admin() or p_org = public.get_my_org_id() or auth.role() = 'service_role') then false
    when p_module in ('reports', 'commissions') then
      coalesce((select enabled from business_modules where organization_id = p_org and module_key = p_module), false)
      and coalesce((select enabled from business_modules where organization_id = p_org and module_key = 'income'), false)
    when p_module = 'promocion_publicaciones' then
      coalesce((select enabled from business_modules where organization_id = p_org and module_key = p_module), false)
      and coalesce((select enabled from business_modules where organization_id = p_org and module_key = 'publicaciones_redes'), false)
    else
      coalesce((select enabled from business_modules where organization_id = p_org and module_key = p_module), false)
  end
$$;

-- Bloquea activar promocion_publicaciones si publicaciones_redes no está
-- activo, y si se desactiva publicaciones_redes, desactiva
-- promocion_publicaciones en cascada -- mismo patrón que
-- income->reports/commissions del feature de ingresos.
create or replace function public.enforce_promocion_publicaciones_dependency()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.module_key = 'promocion_publicaciones' and new.enabled then
    if not coalesce((select enabled from business_modules where organization_id = new.organization_id and module_key = 'publicaciones_redes'), false) then
      raise exception 'No se puede activar "promocion_publicaciones" sin que "publicaciones_redes" esté activo primero';
    end if;
  end if;
  if new.module_key = 'publicaciones_redes' and not new.enabled then
    update business_modules
       set enabled = false, notes = coalesce(notes, '') || ' [desactivado en cascada: publicaciones_redes se apagó]'
     where organization_id = new.organization_id and module_key = 'promocion_publicaciones' and enabled;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_promocion_publicaciones_dependency on public.business_modules;
create trigger trg_promocion_publicaciones_dependency
  before insert or update on public.business_modules
  for each row execute function public.enforce_promocion_publicaciones_dependency();

-- ── social_ad_connections — cuenta publicitaria de Meta por organización,
--    siempre la del cliente, nunca una de respaldo de Avaxon ────────────
create table if not exists public.social_ad_connections (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null unique references organizations(id) on delete cascade,
  ad_account_id      text not null,            -- "act_<id>"
  ad_account_name    text,
  business_id        text,
  currency           text not null default 'MXN',
  access_token       text not null,            -- cifrado (encv1:...), token de usuario con ads_management/ads_read
  status             text not null default 'connected' check (status in ('connected', 'token_expired', 'disabled', 'no_payment_method', 'error')),
  last_error_code    text,
  last_error_message text,
  scopes             text,
  connected_by       uuid references profiles(id),
  connected_at       timestamptz not null default now(),
  token_expires_at   timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.social_ad_connections enable row level security;
drop policy if exists "social_ad_connections_org_scope" on public.social_ad_connections;
create policy "social_ad_connections_org_scope" on public.social_ad_connections
  using (
    (public.is_super_admin() or organization_id = public.get_my_org_id())
    and public.module_enabled(organization_id, 'promocion_publicaciones')
  );

-- ── social_audiences — públicos personalizados guardados (no se guarda
--    "Automático", solo los personalizados con nombre) ─────────────────
create table if not exists public.social_audiences (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name            text not null,
  spec            jsonb not null, -- { geo:{type,lat,lng,radius_km|location_names}, age_min, age_max, genders[], locales[], interests[] }
  created_by      uuid references profiles(id),
  created_at      timestamptz not null default now()
);

alter table public.social_audiences enable row level security;
drop policy if exists "social_audiences_org_scope" on public.social_audiences;
create policy "social_audiences_org_scope" on public.social_audiences
  using (
    (public.is_super_admin() or organization_id = public.get_my_org_id())
    and public.module_enabled(organization_id, 'promocion_publicaciones')
  );

-- ── social_promotions — una promoción = una campaña/adset/creative/ad en
--    Meta, ligada a un social_post_target ya publicado ────────────────
create table if not exists public.social_promotions (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references organizations(id) on delete cascade,
  post_target_id       uuid not null references social_post_targets(id) on delete cascade,
  idempotency_key      text not null unique,
  objective            text not null check (objective in ('engagement', 'whatsapp', 'traffic', 'awareness')),
  audience_mode        text not null default 'auto' check (audience_mode in ('auto', 'custom')),
  audience_spec        jsonb not null default '{}'::jsonb,
  saved_audience_id    uuid references social_audiences(id),
  budget_mode          text not null check (budget_mode in ('daily', 'lifetime')),
  budget_amount        numeric(12,2) not null check (budget_amount > 0),
  currency             text not null default 'MXN',
  start_time           timestamptz not null default now(),
  end_time             timestamptz,
  placements           text not null default 'auto' check (placements in ('auto', 'facebook_page', 'instagram_business')),
  special_ad_categories text[] not null default '{}',
  status               text not null default 'borrador' check (status in ('borrador', 'en_revision', 'activa', 'pausada', 'rechazada', 'error', 'finalizada')),
  rejection_reason     text,
  meta_campaign_id     text,
  meta_adset_id        text,
  meta_ad_id           text,
  meta_creative_id     text,
  estimate_lower       integer,
  estimate_upper       integer,
  spend_total          numeric(12,2) not null default 0,
  reach_total          integer not null default 0,
  impressions_total    integer not null default 0,
  clicks_total         integer not null default 0,
  messages_total       integer not null default 0,
  created_by           uuid references profiles(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (end_time is null or end_time > start_time)
);

alter table public.social_promotions enable row level security;
drop policy if exists "social_promotions_org_scope" on public.social_promotions;
create policy "social_promotions_org_scope" on public.social_promotions
  using (
    (public.is_super_admin() or organization_id = public.get_my_org_id())
    and public.module_enabled(organization_id, 'promocion_publicaciones')
  );

create index if not exists idx_social_promotions_org_status
  on public.social_promotions (organization_id, status);

-- Edad mínima real + restricción de intereses para categorías especiales de
-- anuncios (Meta mismo lo exige; se replica en servidor, no solo aviso en UI).
create or replace function public.validate_special_ad_category()
returns trigger language plpgsql as $$
begin
  if new.special_ad_categories is not null and new.special_ad_categories <> '{}' then
    if new.special_ad_categories && array['EMPLOYMENT','HOUSING','CREDIT']::text[] then
      if coalesce((new.audience_spec->>'age_min')::int, 18) < 18 then
        raise exception 'Las categorías de empleo, vivienda o crédito exigen edad mínima 18';
      end if;
      if new.audience_spec ? 'interests' and jsonb_array_length(new.audience_spec->'interests') > 0 then
        raise exception 'Las categorías de empleo, vivienda o crédito no permiten segmentar por intereses';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_special_ad_category on public.social_promotions;
create trigger trg_validate_special_ad_category
  before insert or update on public.social_promotions
  for each row execute function public.validate_special_ad_category();

-- ── social_promotion_metrics — snapshot diario, sincronizado por cron ──
create table if not exists public.social_promotion_metrics (
  id            uuid primary key default gen_random_uuid(),
  promotion_id  uuid not null references social_promotions(id) on delete cascade,
  "date"        date not null,
  spend         numeric(12,2) not null default 0,
  reach         integer not null default 0,
  impressions   integer not null default 0,
  clicks        integer not null default 0,
  cpc           numeric(12,4),
  ctr           numeric(8,4),
  messages      integer not null default 0,
  synced_at     timestamptz not null default now(),
  unique (promotion_id, "date")
);

alter table public.social_promotion_metrics enable row level security;
drop policy if exists "social_promotion_metrics_via_promotion" on public.social_promotion_metrics;
create policy "social_promotion_metrics_via_promotion" on public.social_promotion_metrics
  using (
    exists (
      select 1 from social_promotions p
      where p.id = social_promotion_metrics.promotion_id
        and (public.is_super_admin() or p.organization_id = public.get_my_org_id())
        and public.module_enabled(p.organization_id, 'promocion_publicaciones')
    )
  );

-- ── social_promotion_audit — log de acciones, solo-lectura para el negocio
--    (INSERT solo vía service-role desde las Edge Functions) ───────────
create table if not exists public.social_promotion_audit (
  id              uuid primary key default gen_random_uuid(),
  promotion_id    uuid not null references social_promotions(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  action          text not null check (action in ('crear', 'activar', 'pausar', 'reanudar', 'editar_presupuesto', 'editar_fecha_fin', 'duplicar', 'rechazo_detectado', 'finalizar')),
  actor_id        uuid references profiles(id),
  detail          jsonb,
  created_at      timestamptz not null default now()
);

alter table public.social_promotion_audit enable row level security;
drop policy if exists "social_promotion_audit_select" on public.social_promotion_audit;
create policy "social_promotion_audit_select" on public.social_promotion_audit
  for select using (
    (public.is_super_admin() or organization_id = public.get_my_org_id())
    and public.module_enabled(organization_id, 'promocion_publicaciones')
  );

drop policy if exists "social_promotion_audit_insert_service_role" on public.social_promotion_audit;
create policy "social_promotion_audit_insert_service_role" on public.social_promotion_audit
  for insert with check (auth.role() = 'service_role' or public.is_super_admin());
