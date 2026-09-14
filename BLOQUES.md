# Avaxon — Bloques de desarrollo

Historial de bloques completados y pendientes. Actualizar aquí cuando se cierre o arranque un bloque.

---

## Bloque 1 — Infraestructura base ✅ COMPLETO

- Repo en GitHub: `sologuicho/avaxon` → desplegado en `https://avaxon.lat` (GitHub Pages)
- Landing page en `index.html`
- Supabase configurado: tablas contacts, conversations, messages, appointments, phone_numbers, whatsapp_accounts, organizations, profiles, plans, bot_configs, invitations
- Auth con Supabase (email + password)
- Dashboard base en `dashboard/index.html`

---

## Bloque 2 — Panel de Admin ✅ COMPLETO (2026-09-13)

### Qué se construyó
- Panel de super_admin en `admin/index.html` → `https://avaxon.lat/admin/`
- Vista Overview: KPIs globales, tabla de clientes, distribución por plan, actividad reciente
- Vista Clientes: KPI cards, filtros por estado, buscador, crear/editar/pausar clientes
- Vista Usuarios: KPI cards, filtros por rol, buscador, crear/editar/eliminar usuarios
- Edge Functions desplegadas en Supabase:
  - `admin-create-client` — crea org + invita admin por email
  - `admin-create-user` — crea usuario y perfil
  - `admin-list-users` — lista usuarios con datos de org (usa service_role)
  - `admin-delete-user` — elimina usuario
- RLS activado en todas las tablas (contacts, conversations, messages, appointments, phone_numbers, whatsapp_accounts, organizations, profiles, invitations)
- Funciones helper en BD: `get_my_org_id()`, `is_super_admin()`
- Perfil de Luis con `role = 'super_admin'` verificado en BD

### Acceso
- URL: `https://avaxon.lat/admin/`
- Solo accesible para usuarios con `role = 'super_admin'` en la tabla `profiles`

---

## Bloque 3 — Inbox + Bot WhatsApp ✅ COMPLETO (2026-09-13)

### Qué se construyó
- Inbox de conversaciones en el dashboard (`dashboard/index.html` → vista Conversaciones)
  - Lista de conversaciones con último mensaje y tiempo relativo
  - Historial de mensajes con burbujas inbound/outbound
  - Panel derecho con datos del contacto y citas
  - Filtros: Todas / Abiertas / Cerradas + buscador
  - Actualización en tiempo real (Supabase Realtime)
  - Cambio de estado open/closed desde el dashboard
  - Envío manual de mensajes desde el inbox
- Edge Function `send-message` — envía mensajes por WhatsApp Cloud API y los guarda en BD
- `webhook-wa` reescrito para formato nativo de Meta Cloud API:
  - GET: verificación de webhook (responde hub.challenge)
  - POST: recibe mensajes entrantes, guarda en Supabase, llama GPT-4o, envía respuesta
- Bot GPT-4o activo con prompt de ventas de Avaxon (ver sección Bot abajo)
- Número de Avaxon registrado en BD

### Configuración en Supabase (secrets)
| Secret | Descripción |
|--------|-------------|
| `WA_ACCESS_TOKEN` | Token permanente de Meta (System User) |
| `WA_PHONE_NUMBER_ID` | `1348271025028457` |
| `WEBHOOK_VERIFY_TOKEN` | `avaxon_meta_verify_2026` |
| `OPENAI_API_KEY` | En `.env` local |

### Configuración en Meta
- App ID: `2086225228635820` (developers.facebook.com)
- WABA ID: `3512648718898077`
- Número: `+52 18991709336` (Phone Number ID: `1348271025028457`)
- Webhook URL: `https://wprvjhvtnyibiwpeiusc.supabase.co/functions/v1/webhook-wa`
- Verify Token: `avaxon_meta_verify_2026`
- Suscripción: `messages`

### Bot
- El bot se controla por la tabla `bot_configs` en Supabase
- `enabled = true` activa el bot para esa org
- `system_prompt` define el comportamiento
- Para cambiar el prompt de Avaxon:
  ```sql
  UPDATE bot_configs
  SET system_prompt = 'nuevo prompt aquí'
  WHERE organization_id = 'e30d23e7-b512-44c8-a0bf-23f102300198';
  ```
- Para desactivar el bot temporalmente:
  ```sql
  UPDATE bot_configs SET enabled = false
  WHERE organization_id = 'e30d23e7-b512-44c8-a0bf-23f102300198';
  ```

### IDs importantes en BD
| Recurso | ID |
|---------|-----|
| Org Avaxon | `e30d23e7-b512-44c8-a0bf-23f102300198` |
| Org Suplementos Demo | `b6d075cd-8b7a-407d-a7be-1ccbe8461d1e` |

---

## Bloque 4 — Embedded Signup (multi-tenant) ⏳ PENDIENTE

**Bloqueado por:** aprobación de Meta como Tech Provider.
Trámite enviado el 2026-09-13. Meta tarda ~5 días hábiles.

### Qué se construirá
- Flujo de Embedded Signup en el panel de admin (`admin/index.html`)
  - Botón "Conectar WhatsApp" en la vista de cada cliente
  - Abre el popup oficial de Meta para que el cliente autorice su número
  - Al completar, se guarda automáticamente el phone_number_id y WABA del cliente en BD
- Creación automática de `bot_configs` con prompt personalizable por cliente
- El webhook ya soporta multi-tenant por `phone_number_id` — sin cambios necesarios ahí

### Prerequisito técnico (cuando llegue la aprobación)
1. Meta manda correo de aprobación como Tech Provider
2. Retomar desarrollo del Bloque 4

---

## Stack técnico

| Capa | Tecnología |
|------|-----------|
| Frontend | HTML/CSS/JS vanilla (sin framework) |
| Auth + BD | Supabase (PostgreSQL + RLS) |
| Backend | Supabase Edge Functions (Deno/TypeScript) |
| IA | OpenAI GPT-4o |
| WhatsApp | Meta WhatsApp Cloud API (oficial) |
| Deploy | GitHub Pages (`sologuicho/avaxon` → `avaxon.lat`) |
| Dominio | `avaxon.lat` |

## URLs de producción

| | URL |
|--|-----|
| Landing | `https://avaxon.lat` |
| Dashboard (clientes) | `https://avaxon.lat/dashboard/` |
| Panel admin | `https://avaxon.lat/admin/` |
| Webhook Meta | `https://wprvjhvtnyibiwpeiusc.supabase.co/functions/v1/webhook-wa` |
