-- ═══════════════════════════════════════════════════════════════
-- Migración: Módulo Reportes — esquema base
-- Habilita reportes financieros por empleado, cortes de caja
-- y catálogo de servicios ligados a citas y pagos.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Catálogo de servicios ─────────────────────────────────
CREATE TABLE public.services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  description      text,
  price            numeric NOT NULL DEFAULT 0,
  duration_minutes integer NOT NULL DEFAULT 60,
  category         text,
  color            text,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;

CREATE INDEX services_org_idx ON public.services(organization_id);

CREATE POLICY "org members can view services"
  ON public.services FOR SELECT
  TO authenticated
  USING (organization_id = get_my_org_id());

CREATE POLICY "org admins can manage services"
  ON public.services FOR ALL
  TO authenticated
  USING (organization_id = get_my_org_id())
  WITH CHECK (organization_id = get_my_org_id());


-- ── 2. Cortes de caja ────────────────────────────────────────
CREATE TABLE public.cash_registers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  opened_by            uuid REFERENCES public.profiles(id),
  closed_by            uuid REFERENCES public.profiles(id),
  opened_at            timestamptz NOT NULL DEFAULT now(),
  closed_at            timestamptz,
  date                 date NOT NULL DEFAULT CURRENT_DATE,
  status               text NOT NULL DEFAULT 'open',   -- 'open' | 'closed'
  cash_total           numeric NOT NULL DEFAULT 0,
  card_total           numeric NOT NULL DEFAULT 0,
  transfer_total       numeric NOT NULL DEFAULT 0,
  tips_total           numeric NOT NULL DEFAULT 0,
  discount_total       numeric NOT NULL DEFAULT 0,
  grand_total          numeric GENERATED ALWAYS AS (cash_total + card_total + transfer_total) STORED,
  appointments_count   integer NOT NULL DEFAULT 0,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.cash_registers ENABLE ROW LEVEL SECURITY;

CREATE INDEX cash_registers_org_date_idx ON public.cash_registers(organization_id, date DESC);

CREATE POLICY "org members can view cash registers"
  ON public.cash_registers FOR SELECT
  TO authenticated
  USING (organization_id = get_my_org_id());

CREATE POLICY "org admins can manage cash registers"
  ON public.cash_registers FOR ALL
  TO authenticated
  USING (organization_id = get_my_org_id())
  WITH CHECK (organization_id = get_my_org_id());


-- ── 3. Horarios de empleados ─────────────────────────────────
CREATE TABLE public.employee_schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  day_of_week     integer NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0=dom ... 6=sab
  start_time      time NOT NULL,
  end_time        time NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, day_of_week)
);

ALTER TABLE public.employee_schedules ENABLE ROW LEVEL SECURITY;

CREATE INDEX emp_schedules_employee_idx ON public.employee_schedules(employee_id);
CREATE INDEX emp_schedules_org_idx      ON public.employee_schedules(organization_id);

CREATE POLICY "org members can view schedules"
  ON public.employee_schedules FOR SELECT
  TO authenticated
  USING (organization_id = get_my_org_id());

CREATE POLICY "org admins can manage schedules"
  ON public.employee_schedules FOR ALL
  TO authenticated
  USING (organization_id = get_my_org_id())
  WITH CHECK (organization_id = get_my_org_id());


-- ── 4. Columnas nuevas en appointments ───────────────────────
ALTER TABLE public.appointments
  ADD COLUMN employee_id      uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  ADD COLUMN service_id       uuid REFERENCES public.services(id) ON DELETE SET NULL,
  ADD COLUMN price            numeric NOT NULL DEFAULT 0,
  ADD COLUMN tip              numeric NOT NULL DEFAULT 0,
  ADD COLUMN discount         numeric NOT NULL DEFAULT 0,
  ADD COLUMN payment_method   text,
  ADD COLUMN cash_register_id uuid REFERENCES public.cash_registers(id) ON DELETE SET NULL,
  ADD COLUMN paid_at          timestamptz;

CREATE INDEX appointments_employee_idx  ON public.appointments(employee_id);
CREATE INDEX appointments_service_idx   ON public.appointments(service_id);
CREATE INDEX appointments_scheduled_idx ON public.appointments(organization_id, scheduled_at DESC);


-- ── 5. Columnas nuevas en payments ───────────────────────────
ALTER TABLE public.payments
  ADD COLUMN appointment_id   uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  ADD COLUMN employee_id      uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  ADD COLUMN cash_register_id uuid REFERENCES public.cash_registers(id) ON DELETE SET NULL,
  ADD COLUMN payment_method   text,
  ADD COLUMN tip              numeric NOT NULL DEFAULT 0,
  ADD COLUMN discount         numeric NOT NULL DEFAULT 0,
  ADD COLUMN is_manual        boolean NOT NULL DEFAULT false;

CREATE INDEX payments_appointment_idx   ON public.payments(appointment_id);
CREATE INDEX payments_employee_idx      ON public.payments(employee_id);
CREATE INDEX payments_cash_register_idx ON public.payments(cash_register_id);
CREATE INDEX payments_org_paid_idx      ON public.payments(organization_id, paid_at DESC);
