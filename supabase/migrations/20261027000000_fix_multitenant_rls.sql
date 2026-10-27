-- =============================================================================
-- Migración: Integridad multi-tenant — RLS hardening completo
-- Fecha: 2026-10-27
--
-- Problemas corregidos:
--   1. Funciones SECURITY DEFINER helper eran invocables por anon
--   2. Todas las políticas usaban TO public en vez de TO authenticated
--   3. Políticas ALL sin WITH CHECK permitían insertar filas en otra org
--   4. orders, delivery_zones y reminders tenían RLS on pero cero políticas
--   5. invitations solo accesible por super_admin (owners/admins excluidos)
-- =============================================================================

-- ── 1. Restringir funciones helper a authenticated ──────────────────────────

REVOKE EXECUTE ON FUNCTION get_my_org_id() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION get_my_org_id() TO authenticated;

REVOKE EXECUTE ON FUNCTION is_super_admin() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION is_super_admin() TO authenticated;

REVOKE EXECUTE ON FUNCTION module_enabled(uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION module_enabled(uuid, text) TO authenticated;


-- ── 2. Tablas críticas de negocio ────────────────────────────────────────────

DROP POLICY IF EXISTS conversations_org_scope ON conversations;
CREATE POLICY conversations_org_scope ON conversations TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id())
  WITH CHECK (is_super_admin() OR organization_id = get_my_org_id());

DROP POLICY IF EXISTS messages_org_scope ON messages;
CREATE POLICY messages_org_scope ON messages TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id())
  WITH CHECK (is_super_admin() OR organization_id = get_my_org_id());

DROP POLICY IF EXISTS contacts_org_scope ON contacts;
CREATE POLICY contacts_org_scope ON contacts TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id())
  WITH CHECK (is_super_admin() OR organization_id = get_my_org_id());

DROP POLICY IF EXISTS campaigns_org_scope ON campaigns;
CREATE POLICY campaigns_org_scope ON campaigns TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id())
  WITH CHECK (is_super_admin() OR organization_id = get_my_org_id());

DROP POLICY IF EXISTS campaign_contacts_org_scope ON campaign_contacts;
CREATE POLICY campaign_contacts_org_scope ON campaign_contacts TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id())
  WITH CHECK (is_super_admin() OR organization_id = get_my_org_id());

DROP POLICY IF EXISTS conversation_notes_org_scope ON conversation_notes;
CREATE POLICY conversation_notes_org_scope ON conversation_notes TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id())
  WITH CHECK (is_super_admin() OR organization_id = get_my_org_id());

DROP POLICY IF EXISTS knowledge_org_scope ON knowledge_items;
CREATE POLICY knowledge_org_scope ON knowledge_items TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id())
  WITH CHECK (is_super_admin() OR organization_id = get_my_org_id());

DROP POLICY IF EXISTS appointments_org_scope ON appointments;
CREATE POLICY appointments_org_scope ON appointments TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id())
  WITH CHECK (is_super_admin() OR organization_id = get_my_org_id());

DROP POLICY IF EXISTS templates_org_scope ON message_templates;
CREATE POLICY templates_org_scope ON message_templates TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id())
  WITH CHECK (is_super_admin() OR organization_id = get_my_org_id());

DROP POLICY IF EXISTS phones_org_scope ON phone_numbers;
CREATE POLICY phones_org_scope ON phone_numbers TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id())
  WITH CHECK (is_super_admin() OR organization_id = get_my_org_id());

DROP POLICY IF EXISTS wa_accounts_org_scope ON whatsapp_accounts;
CREATE POLICY wa_accounts_org_scope ON whatsapp_accounts TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id())
  WITH CHECK (is_super_admin() OR organization_id = get_my_org_id());

DROP POLICY IF EXISTS subscriptions_org_scope ON subscriptions;
CREATE POLICY subscriptions_org_scope ON subscriptions TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id())
  WITH CHECK (is_super_admin() OR organization_id = get_my_org_id());

DROP POLICY IF EXISTS report_configs_org_scope ON report_configs;
CREATE POLICY report_configs_org_scope ON report_configs TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id())
  WITH CHECK (is_super_admin() OR organization_id = get_my_org_id());

DROP POLICY IF EXISTS orgs_scope ON organizations;
CREATE POLICY orgs_scope ON organizations TO authenticated
  USING (is_super_admin() OR id = get_my_org_id())
  WITH CHECK (is_super_admin() OR id = get_my_org_id());

DROP POLICY IF EXISTS organization_profile_scope ON organization_profile;
CREATE POLICY organization_profile_scope ON organization_profile TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id())
  WITH CHECK (is_super_admin() OR organization_id = get_my_org_id());


-- ── 3. Tablas de soporte y admin ─────────────────────────────────────────────

DROP POLICY IF EXISTS agent_change_requests_insert ON agent_change_requests;
DROP POLICY IF EXISTS agent_change_requests_select ON agent_change_requests;
DROP POLICY IF EXISTS agent_change_requests_update_admin ON agent_change_requests;
CREATE POLICY agent_change_requests_insert ON agent_change_requests FOR INSERT TO authenticated
  WITH CHECK (is_super_admin() OR organization_id = get_my_org_id());
CREATE POLICY agent_change_requests_select ON agent_change_requests FOR SELECT TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id());
CREATE POLICY agent_change_requests_update_admin ON agent_change_requests FOR UPDATE TO authenticated
  USING (is_super_admin()) WITH CHECK (is_super_admin());

DROP POLICY IF EXISTS bot_configs_delete_admin ON bot_configs;
DROP POLICY IF EXISTS bot_configs_insert_admin ON bot_configs;
DROP POLICY IF EXISTS bot_configs_select ON bot_configs;
DROP POLICY IF EXISTS bot_configs_update_admin ON bot_configs;
CREATE POLICY bot_configs_delete_admin ON bot_configs FOR DELETE TO authenticated
  USING (is_super_admin());
CREATE POLICY bot_configs_insert_admin ON bot_configs FOR INSERT TO authenticated
  WITH CHECK (is_super_admin());
CREATE POLICY bot_configs_select ON bot_configs FOR SELECT TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id());
CREATE POLICY bot_configs_update_admin ON bot_configs FOR UPDATE TO authenticated
  USING (is_super_admin()) WITH CHECK (is_super_admin());

DROP POLICY IF EXISTS bot_error_logs_super_admin_only ON bot_error_logs;
CREATE POLICY bot_error_logs_super_admin_only ON bot_error_logs TO authenticated
  USING (is_super_admin()) WITH CHECK (is_super_admin());

DROP POLICY IF EXISTS super_admin_all ON bot_tool_logs;
CREATE POLICY super_admin_all ON bot_tool_logs TO authenticated
  USING (is_super_admin()) WITH CHECK (is_super_admin());

DROP POLICY IF EXISTS business_modules_write_super_admin ON business_modules;
DROP POLICY IF EXISTS business_modules_select ON business_modules;
CREATE POLICY business_modules_write_super_admin ON business_modules TO authenticated
  USING (is_super_admin()) WITH CHECK (is_super_admin());
CREATE POLICY business_modules_select ON business_modules FOR SELECT TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id());

DROP POLICY IF EXISTS admins_manage_employees ON employees;
DROP POLICY IF EXISTS members_read_employees ON employees;
CREATE POLICY admins_manage_employees ON employees TO authenticated
  USING (organization_id IN (
    SELECT p.organization_id FROM profiles p
    WHERE p.id = auth.uid() AND p.role = ANY(ARRAY['owner','admin','super_admin'])
  ))
  WITH CHECK (organization_id IN (
    SELECT p.organization_id FROM profiles p
    WHERE p.id = auth.uid() AND p.role = ANY(ARRAY['owner','admin','super_admin'])
  ));
CREATE POLICY members_read_employees ON employees FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT p.organization_id FROM profiles p WHERE p.id = auth.uid()
  ));

DROP POLICY IF EXISTS integrations_select_org_scope ON integrations;
CREATE POLICY integrations_select_org_scope ON integrations FOR SELECT TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id());

DROP POLICY IF EXISTS invitations_scope ON invitations;
CREATE POLICY invitations_scope ON invitations TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id())
  WITH CHECK (is_super_admin() OR organization_id = get_my_org_id());

DROP POLICY IF EXISTS onboarding_admin_read ON onboarding_requests;
DROP POLICY IF EXISTS onboarding_admin_update ON onboarding_requests;
CREATE POLICY onboarding_admin_read ON onboarding_requests FOR SELECT TO authenticated
  USING (is_super_admin());
CREATE POLICY onboarding_admin_update ON onboarding_requests FOR UPDATE TO authenticated
  USING (is_super_admin()) WITH CHECK (is_super_admin());

DROP POLICY IF EXISTS "org members can read their staff" ON org_staff;
CREATE POLICY "org members can read their staff" ON org_staff FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT p.organization_id FROM profiles p WHERE p.id = auth.uid()
  ));

DROP POLICY IF EXISTS payments_select ON payments;
CREATE POLICY payments_select ON payments FOR SELECT TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id());

DROP POLICY IF EXISTS post_templates_write_super_admin ON post_templates;
DROP POLICY IF EXISTS post_templates_read_all ON post_templates;
CREATE POLICY post_templates_write_super_admin ON post_templates TO authenticated
  USING (is_super_admin()) WITH CHECK (is_super_admin());
CREATE POLICY post_templates_read_all ON post_templates FOR SELECT TO authenticated
  USING (is_active OR is_super_admin());

DROP POLICY IF EXISTS profiles_scope ON profiles;
CREATE POLICY profiles_scope ON profiles FOR SELECT TO authenticated
  USING (is_super_admin() OR id = auth.uid() OR organization_id = get_my_org_id());


-- ── 4. Tablas de redes sociales ──────────────────────────────────────────────

DROP POLICY IF EXISTS social_accounts_org_scope ON social_accounts;
CREATE POLICY social_accounts_org_scope ON social_accounts TO authenticated
  USING ((is_super_admin() OR organization_id = get_my_org_id()) AND module_enabled(organization_id, 'publicaciones_redes'))
  WITH CHECK ((is_super_admin() OR organization_id = get_my_org_id()) AND module_enabled(organization_id, 'publicaciones_redes'));

DROP POLICY IF EXISTS social_post_media_via_post ON social_post_media;
CREATE POLICY social_post_media_via_post ON social_post_media TO authenticated
  USING (EXISTS (
    SELECT 1 FROM social_posts p
    WHERE p.id = post_id
      AND (is_super_admin() OR p.organization_id = get_my_org_id())
      AND module_enabled(p.organization_id, 'publicaciones_redes')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM social_posts p
    WHERE p.id = post_id
      AND (is_super_admin() OR p.organization_id = get_my_org_id())
      AND module_enabled(p.organization_id, 'publicaciones_redes')
  ));

DROP POLICY IF EXISTS social_post_targets_org_scope ON social_post_targets;
CREATE POLICY social_post_targets_org_scope ON social_post_targets TO authenticated
  USING ((is_super_admin() OR organization_id = get_my_org_id()) AND module_enabled(organization_id, 'publicaciones_redes'))
  WITH CHECK ((is_super_admin() OR organization_id = get_my_org_id()) AND module_enabled(organization_id, 'publicaciones_redes'));

DROP POLICY IF EXISTS social_posts_org_scope ON social_posts;
CREATE POLICY social_posts_org_scope ON social_posts TO authenticated
  USING ((is_super_admin() OR organization_id = get_my_org_id()) AND module_enabled(organization_id, 'publicaciones_redes'))
  WITH CHECK ((is_super_admin() OR organization_id = get_my_org_id()) AND module_enabled(organization_id, 'publicaciones_redes'));


-- ── 5. Tablas sin políticas previas ──────────────────────────────────────────

CREATE POLICY orders_org_scope ON orders TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id())
  WITH CHECK (is_super_admin() OR organization_id = get_my_org_id());

CREATE POLICY delivery_zones_org_scope ON delivery_zones TO authenticated
  USING (is_super_admin() OR organization_id = get_my_org_id())
  WITH CHECK (is_super_admin() OR organization_id = get_my_org_id());

-- reminders no tiene organization_id; se aisla via phone_numbers
CREATE POLICY reminders_org_scope ON reminders TO authenticated
  USING (
    is_super_admin() OR
    EXISTS (
      SELECT 1 FROM phone_numbers pn
      WHERE pn.id::text = reminders.phone_number_id
        AND pn.organization_id = get_my_org_id()
    )
  )
  WITH CHECK (
    is_super_admin() OR
    EXISTS (
      SELECT 1 FROM phone_numbers pn
      WHERE pn.id::text = reminders.phone_number_id
        AND pn.organization_id = get_my_org_id()
    )
  );
