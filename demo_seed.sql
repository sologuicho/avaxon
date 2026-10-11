-- ================================================================
-- DEMO SEED — Cuenta publicitaria Avaxon
-- Clínica Estética "Luz & Piel"
-- Usuario: demo@avaxon.lat / Demo2026!
--
-- ANTES DE CORRER:
--   1. Crea el usuario en Supabase Dashboard:
--      Authentication → Users → Add user → Create new user
--      Email: demo@avaxon.lat  |  Password: Demo2026!  |  Auto Confirm: ON
--   2. Copia el UUID del usuario creado
--   3. Reemplaza AQUÍ abajo el valor de DEMO_USER_ID
-- ================================================================

-- ⚠️ REEMPLAZA ESTE UUID CON EL DEL DASHBOARD:
\set DEMO_USER_ID 'PEGA-AQUI-EL-UUID-DEL-USUARIO'

-- (si \set no funciona en el editor, reemplaza manualmente
--  todas las ocurrencias de PEGA-AQUI-EL-UUID-DEL-USUARIO)


-- ── 1. Organización ──────────────────────────────────────────────
INSERT INTO organizations (id, name, industry, status, plan_id, timezone, trial_ends_at, created_at, updated_at)
VALUES (
  'bbbb0000-0000-0000-0000-000000000001',
  'Luz & Piel — Clínica Estética',
  'Salud y belleza',
  'active',
  'pro',
  'America/Mexico_City',
  now() + interval '30 days',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;


-- ── 2. Perfil (vincula usuario → org) ────────────────────────────
INSERT INTO profiles (id, full_name, role, organization_id, onboarding_done_at, terms_accepted_at)
VALUES (
  'PEGA-AQUI-EL-UUID-DEL-USUARIO',
  'Sofía Ramírez',
  'owner',
  'bbbb0000-0000-0000-0000-000000000001',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;


-- ── 3. Contactos / Leads ──────────────────────────────────────────
INSERT INTO contacts (id, organization_id, name, phone, email, status, tags, last_seen_at, created_at)
VALUES
  ('c001-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'Valentina Torres',   '+5215512340001', 'valentina@email.com', 'lead',     ARRAY['facial','VIP'],          now() - interval '1 day',   now() - interval '10 days'),
  ('c002-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'Mariana Gutiérrez',  '+5215512340002', 'mariana@email.com',   'lead',     ARRAY['microblading'],          now() - interval '2 days',  now() - interval '15 days'),
  ('c003-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'Fernanda Castillo',  '+5215512340003', null,                  'lead',     ARRAY['botox'],                 now() - interval '3 days',  now() - interval '8 days'),
  ('c004-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'Daniela Mendoza',    '+5215512340004', 'daniela@email.com',   'customer', ARRAY['VIP','relleno'],         now() - interval '1 day',   now() - interval '20 days'),
  ('c005-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'Camila Herrera',     '+5215512340005', null,                  'lead',     ARRAY['facial'],                now() - interval '5 days',  now() - interval '5 days'),
  ('c006-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'Lucía Flores',       '+5215512340006', 'lucia@email.com',     'customer', ARRAY['facial','hidratacion'],  now() - interval '2 days',  now() - interval '30 days'),
  ('c007-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'Sofía Jiménez',      '+5215512340007', null,                  'lead',     ARRAY['limpieza'],              now() - interval '6 hours', now() - interval '2 days'),
  ('c008-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'Isabella Ramírez',   '+5215512340008', 'isabella@email.com',  'customer', ARRAY['VIP','botox'],           now() - interval '1 day',   now() - interval '40 days'),
  ('c009-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'Andrea López',       '+5215512340009', null,                  'lead',     ARRAY['relleno'],               now() - interval '12 hours',now() - interval '1 day'),
  ('c010-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'Gabriela Morales',   '+5215512340010', 'gaby@email.com',      'lead',     ARRAY['microblading','VIP'],    now() - interval '3 days',  now() - interval '7 days'),
  ('c011-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'Natalia Cruz',       '+5215512340011', null,                  'lead',     ARRAY['facial'],                now() - interval '4 hours', now() - interval '3 days'),
  ('c012-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'Regina Vázquez',     '+5215512340012', 'regina@email.com',    'customer', ARRAY['hidratacion'],           now() - interval '2 days',  now() - interval '25 days')
ON CONFLICT (id) DO NOTHING;


-- ── 4. Citas ─────────────────────────────────────────────────────
INSERT INTO appointments (id, organization_id, contact_id, contact_name, title, service, notes, status, scheduled_at, duration_minutes, created_by)
VALUES
  ('a001-0000-0000-0000-000000000001','bbbb0000-0000-0000-0000-000000000001','c001-0000-0000-0000-000000000001','Valentina Torres',
   'Limpieza facial profunda','Limpieza profunda','Primera visita — piel mixta','confirmed',
   '2026-10-10 14:00:00+00',60,'PEGA-AQUI-EL-UUID-DEL-USUARIO'),

  ('a002-0000-0000-0000-000000000001','bbbb0000-0000-0000-0000-000000000001','c004-0000-0000-0000-000000000001','Daniela Mendoza',
   'Aplicación de botox','Botox preventivo','Zona frente y entrecejo','confirmed',
   '2026-10-10 16:30:00+00',45,'PEGA-AQUI-EL-UUID-DEL-USUARIO'),

  ('a003-0000-0000-0000-000000000001','bbbb0000-0000-0000-0000-000000000001','c002-0000-0000-0000-000000000001','Mariana Gutiérrez',
   'Microblading de cejas','Microblading','Tono rubio ceniza','pending',
   '2026-10-11 10:00:00+00',90,'PEGA-AQUI-EL-UUID-DEL-USUARIO'),

  ('a004-0000-0000-0000-000000000001','bbbb0000-0000-0000-0000-000000000001','c007-0000-0000-0000-000000000001','Sofía Jiménez',
   'Hidratación profunda','Hidratación','Piel seca con signos de deshidratación','confirmed',
   '2026-10-12 11:00:00+00',60,'PEGA-AQUI-EL-UUID-DEL-USUARIO'),

  ('a005-0000-0000-0000-000000000001','bbbb0000-0000-0000-0000-000000000001','c005-0000-0000-0000-000000000001','Camila Herrera',
   'Consulta inicial','Valoración gratuita','Quiere saber sobre relleno de labios','pending',
   '2026-10-13 09:30:00+00',30,'PEGA-AQUI-EL-UUID-DEL-USUARIO'),

  ('a006-0000-0000-0000-000000000001','bbbb0000-0000-0000-0000-000000000001','c008-0000-0000-0000-000000000001','Isabella Ramírez',
   'Relleno de labios','Ácido hialurónico','Retoque 0.5ml — cliente VIP','confirmed',
   '2026-10-14 15:00:00+00',45,'PEGA-AQUI-EL-UUID-DEL-USUARIO'),

  ('a007-0000-0000-0000-000000000001','bbbb0000-0000-0000-0000-000000000001','c003-0000-0000-0000-000000000001','Fernanda Castillo',
   'Botox preventivo','Botox','Zona patas de gallo','pending',
   '2026-10-15 13:00:00+00',45,'PEGA-AQUI-EL-UUID-DEL-USUARIO'),

  ('a008-0000-0000-0000-000000000001','bbbb0000-0000-0000-0000-000000000001','c006-0000-0000-0000-000000000001','Lucía Flores',
   'Peeling químico','Peeling','Ácido glicólico 20%','confirmed',
   '2026-10-17 10:00:00+00',60,'PEGA-AQUI-EL-UUID-DEL-USUARIO'),

  ('a009-0000-0000-0000-000000000001','bbbb0000-0000-0000-0000-000000000001','c010-0000-0000-0000-000000000001','Gabriela Morales',
   'Microblading — retoque 30 días','Microblading retoque','Retoque 1 mes','confirmed',
   '2026-10-17 14:30:00+00',60,'PEGA-AQUI-EL-UUID-DEL-USUARIO'),

  ('a010-0000-0000-0000-000000000001','bbbb0000-0000-0000-0000-000000000001','c009-0000-0000-0000-000000000001','Andrea López',
   'Relleno de pómulos','Ácido hialurónico','Clienta nueva — referida por Daniela','pending',
   '2026-10-20 11:00:00+00',45,'PEGA-AQUI-EL-UUID-DEL-USUARIO'),

  ('a011-0000-0000-0000-000000000001','bbbb0000-0000-0000-0000-000000000001','c011-0000-0000-0000-000000000001','Natalia Cruz',
   'Limpieza facial','Limpieza facial','Piel con tendencia a acné','pending',
   '2026-10-22 09:00:00+00',60,'PEGA-AQUI-EL-UUID-DEL-USUARIO'),

  ('a012-0000-0000-0000-000000000001','bbbb0000-0000-0000-0000-000000000001','c001-0000-0000-0000-000000000001','Valentina Torres',
   'Consulta de seguimiento','Valoración','Seguimiento post-limpieza facial','confirmed',
   '2026-10-22 16:00:00+00',30,'PEGA-AQUI-EL-UUID-DEL-USUARIO'),

  ('a013-0000-0000-0000-000000000001','bbbb0000-0000-0000-0000-000000000001','c012-0000-0000-0000-000000000001','Regina Vázquez',
   'Hidratación con vitamina C','Hidratación vitamínica',null,'confirmed',
   '2026-10-24 12:00:00+00',60,'PEGA-AQUI-EL-UUID-DEL-USUARIO'),

  ('a014-0000-0000-0000-000000000001','bbbb0000-0000-0000-0000-000000000001','c002-0000-0000-0000-000000000001','Mariana Gutiérrez',
   'Retoque microblading','Microblading retoque','Retoque 4 semanas','pending',
   '2026-10-28 10:30:00+00',60,'PEGA-AQUI-EL-UUID-DEL-USUARIO'),

  ('a015-0000-0000-0000-000000000001','bbbb0000-0000-0000-0000-000000000001','c004-0000-0000-0000-000000000001','Daniela Mendoza',
   'Botox — mantenimiento 3 meses','Botox','Retoque zona frente','pending',
   '2026-11-03 15:00:00+00',45,'PEGA-AQUI-EL-UUID-DEL-USUARIO'),

  ('a016-0000-0000-0000-000000000001','bbbb0000-0000-0000-0000-000000000001','c008-0000-0000-0000-000000000001','Isabella Ramírez',
   'Peeling + hidratación VIP','Tratamiento combinado','Paquete VIP mensual','confirmed',
   '2026-11-07 11:00:00+00',90,'PEGA-AQUI-EL-UUID-DEL-USUARIO')

ON CONFLICT (id) DO NOTHING;


-- ================================================================
-- ✅ VERIFICACIÓN
-- ================================================================
-- SELECT id, full_name, role FROM profiles WHERE organization_id = 'bbbb0000-0000-0000-0000-000000000001';
-- SELECT COUNT(*) FROM contacts WHERE organization_id = 'bbbb0000-0000-0000-0000-000000000001';
-- SELECT title, scheduled_at::date, status FROM appointments WHERE organization_id = 'bbbb0000-0000-0000-0000-000000000001' ORDER BY scheduled_at;


-- ================================================================
-- 🗑️  CLEANUP — Corre esto para eliminar la cuenta demo
-- ================================================================
/*
DELETE FROM appointments WHERE organization_id = 'bbbb0000-0000-0000-0000-000000000001';
DELETE FROM contacts    WHERE organization_id = 'bbbb0000-0000-0000-0000-000000000001';
DELETE FROM profiles    WHERE organization_id = 'bbbb0000-0000-0000-0000-000000000001';
DELETE FROM organizations WHERE id = 'bbbb0000-0000-0000-0000-000000000001';
-- Y en Authentication → Users, eliminar demo@avaxon.lat manualmente
*/
