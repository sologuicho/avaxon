-- ============================================================
-- ADMIN SETUP — Correr en Supabase SQL Editor
-- ============================================================
-- IMPORTANTE: Correr en este orden, una sección a la vez.
-- Verificar que cada sección no rompe nada antes de continuar.
-- ============================================================


-- ── 1. Tabla invitations ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'admin',
  invited_by      uuid REFERENCES profiles(id),
  created_at      timestamptz DEFAULT now()
);


-- ── 2. Asegurar perfil super_admin de Luis ──────────────────
-- (solo actualiza si el perfil existe y el rol no es super_admin)
UPDATE profiles
SET role = 'super_admin'
WHERE id = (
  SELECT id FROM auth.users WHERE email = 'floresescobedoluisalberto@gmail.com'
)
AND role IS DISTINCT FROM 'super_admin';

-- Verificar:
-- SELECT id, role FROM profiles WHERE id = (SELECT id FROM auth.users WHERE email = 'floresescobedoluisalberto@gmail.com');


-- ── 3. Funciones helper para RLS ────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_org_id()
RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT organization_id FROM profiles WHERE id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT COALESCE(
    (SELECT role = 'super_admin' FROM profiles WHERE id = auth.uid()),
    false
  )
$$;


-- ── 4. RLS — Activar una tabla a la vez ─────────────────────
-- ⚠️  RIESGO: Verifica que no haya datos sin organization_id antes
--     de activar cada tabla. Query de verificación incluida.

-- contacts
-- SELECT COUNT(*) FROM contacts WHERE organization_id IS NULL;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "contacts_org_scope" ON contacts;
CREATE POLICY "contacts_org_scope" ON contacts
  USING (public.is_super_admin() OR organization_id = public.get_my_org_id());

-- conversations
-- SELECT COUNT(*) FROM conversations WHERE organization_id IS NULL;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "conversations_org_scope" ON conversations;
CREATE POLICY "conversations_org_scope" ON conversations
  USING (public.is_super_admin() OR organization_id = public.get_my_org_id());

-- messages
-- SELECT COUNT(*) FROM messages WHERE organization_id IS NULL;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "messages_org_scope" ON messages;
CREATE POLICY "messages_org_scope" ON messages
  USING (public.is_super_admin() OR organization_id = public.get_my_org_id());

-- appointments
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "appointments_org_scope" ON appointments;
CREATE POLICY "appointments_org_scope" ON appointments
  USING (public.is_super_admin() OR organization_id = public.get_my_org_id());

-- phone_numbers
ALTER TABLE phone_numbers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "phones_org_scope" ON phone_numbers;
CREATE POLICY "phones_org_scope" ON phone_numbers
  USING (public.is_super_admin() OR organization_id = public.get_my_org_id());

-- whatsapp_accounts
ALTER TABLE whatsapp_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wa_accounts_org_scope" ON whatsapp_accounts;
CREATE POLICY "wa_accounts_org_scope" ON whatsapp_accounts
  USING (public.is_super_admin() OR organization_id = public.get_my_org_id());

-- organizations (super_admin ve todas, admin/agent solo la suya)
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "orgs_scope" ON organizations;
CREATE POLICY "orgs_scope" ON organizations
  USING (public.is_super_admin() OR id = public.get_my_org_id());

-- profiles (cada usuario ve el suyo; super_admin ve todos; admin ve los de su org)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "profiles_scope" ON profiles;
CREATE POLICY "profiles_scope" ON profiles
  USING (
    public.is_super_admin()
    OR id = auth.uid()
    OR organization_id = public.get_my_org_id()
  );

-- invitations (solo super_admin las ve)
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "invitations_scope" ON invitations;
CREATE POLICY "invitations_scope" ON invitations
  USING (public.is_super_admin());
