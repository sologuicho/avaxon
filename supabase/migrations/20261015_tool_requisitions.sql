-- ── Tabla: tool_requisitions ────────────────────────────────────────────────
-- Registra solicitudes de nuevas herramientas hechas por clientes de Avaxon.

create table if not exists public.tool_requisitions (
  id              uuid        primary key default gen_random_uuid(),
  req_id          text        not null,
  organization_id uuid        references public.organizations(id) on delete set null,
  requested_by    uuid        references auth.users(id) on delete set null,
  tool_name       text        not null,
  description     text,
  use_case        text,
  status          text        not null default 'pending',
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Index para consultas por organización
create index if not exists tool_requisitions_organization_id_idx
  on public.tool_requisitions (organization_id);

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.tool_requisitions enable row level security;

-- super_admin puede hacer todo
create policy "super_admin_all_tool_requisitions"
  on public.tool_requisitions
  for all
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
        and profiles.role = 'super_admin'
    )
  )
  with check (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
        and profiles.role = 'super_admin'
    )
  );

-- Usuarios pueden ver las requisiciones de su propia organización
create policy "org_members_select_tool_requisitions"
  on public.tool_requisitions
  for select
  to authenticated
  using (
    organization_id in (
      select profiles.organization_id from public.profiles
      where profiles.id = auth.uid()
    )
  );

-- Usuarios pueden insertar requisiciones para su propia organización
create policy "org_members_insert_tool_requisitions"
  on public.tool_requisitions
  for insert
  to authenticated
  with check (
    organization_id in (
      select profiles.organization_id from public.profiles
      where profiles.id = auth.uid()
    )
    and requested_by = auth.uid()
  );
