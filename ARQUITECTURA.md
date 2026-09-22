# Avaxon — Arquitectura del Sistema

*Última actualización: septiembre 2026*
*Autor: Luis Flores (Tech Lead)*

---

## Resumen ejecutivo

Avaxon es una plataforma multi-tenant de mensajería conversacional con IA para WhatsApp Business. El sistema permite a múltiples empresas (clientes de Avaxon) tener un agente de IA que recibe y responde mensajes de WhatsApp, con un dashboard donde sus vendedores pueden ver conversaciones, responder manualmente y gestionar leads.

**Stack:**
- **Meta Cloud API** — canal de mensajería (WhatsApp)
- **Supabase** — base de datos, auth, Edge Functions, Realtime
- **n8n Cloud** — automatizaciones asíncronas
- **GPT-4o** — motor de IA conversacional
- **Dashboard** — frontend HTML/JS para vendedores y admins

---

## Principio de diseño central

> **Supabase es el cerebro. n8n es el sistema de automatización. Meta es el canal.**

- La Edge Function `webhook-wa` es el **único punto de entrada** de mensajes de Meta.
- Supabase es la **fuente de verdad** de todos los datos.
- n8n **nunca está en el camino crítico** de recibir o guardar mensajes — opera de forma asíncrona sobre datos ya persistidos.
- El dashboard se comunica **solo con Supabase** (queries + Edge Functions), nunca con Meta directamente.

---

## Diagrama general

```
                    ┌─────────────────────────────────────────────┐
                    │              CAPA DE CANAL                  │
                    │                                             │
                    │   Cliente → WhatsApp → Meta Cloud API       │
                    └───────────────────┬─────────────────────────┘
                                        │
                                   POST webhook
                                   (timeout: 15s)
                                        │
                    ┌───────────────────▼─────────────────────────┐
                    │          CAPA DE RECEPCIÓN                  │
                    │                                             │
                    │   webhook-wa (Supabase Edge Function)       │
                    │   ──────────────────────────────────        │
                    │   · Único receptor de webhooks de Meta      │
                    │   · Idempotencia por wa_message_id          │
                    │   · Resuelve org por phone_number_id        │
                    │   · Persiste contacto, conversación,        │
                    │     mensaje en Supabase                     │
                    │   · Devuelve 200 OK a Meta (obligatorio)    │
                    │   · Si bot activo: GPT-4o → responde        │
                    └───────────────────┬─────────────────────────┘
                                        │
                              Supabase Realtime
                           (WebSocket, instantáneo)
                                        │
               ┌────────────────────────┼────────────────────────┐
               │                        │                        │
               ▼                        ▼                        ▼
┌──────────────────────┐  ┌─────────────────────┐  ┌────────────────────┐
│     Dashboard        │  │       n8n           │  │  Futuras apps      │
│     (vendedor)       │  │  (automatizaciones) │  │  (CRM, API, etc.)  │
│                      │  │                     │  │                    │
│ · Inbox tiempo real  │  │ · Seguimientos      │  │ · Webhooks custom  │
│ · Respuesta manual   │  │ · Notif. al dueño   │  │ · Integraciones    │
│ · Asignación conv.   │  │ · Google Sheets     │  │                    │
│ · Gestión de leads   │  │ · Flujos complejos  │  │                    │
└──────────┬───────────┘  └─────────────────────┘  └────────────────────┘
           │
           │ POST (JWT autenticado)
           ▼
┌──────────────────────┐
│   send-message       │
│  (Edge Function)     │
│                      │
│ · Verifica JWT       │
│ · Token por org      │
│ · POST Meta API      │
│ · Persiste mensaje   │
└──────────┬───────────┘
           │
           ▼
  Meta API → WhatsApp → Cliente
```

---

## Flujos de datos

### Mensaje entrante

```
[1]  Cliente escribe en WhatsApp
[2]  Meta Cloud API recibe y hace POST al webhook
[3]  webhook-wa recibe el payload de Meta:
       - Verifica idempotencia: wa_message_id ya en DB? → 200 OK y termina
       - Resuelve org_id desde phone_numbers.phone_number_id
       - Upsert en contacts (org, phone, name, last_seen_at)
       - Get or create conversación abierta
       - INSERT mensaje inbound en messages
[4]  RETURN 200 OK a Meta ← CRÍTICO antes de 15s
[5]  Si bot_configs.enabled = true:
       - Lee historial (últimos 10 mensajes)
       - Llama GPT-4o con system_prompt del cliente
       - INSERT mensaje outbound
       - POST Meta API con la respuesta
[6]  Supabase Realtime notifica vía WebSocket
[7]  Dashboard actualiza inbox en tiempo real
[8]  n8n recibe notificación async → ejecuta automatizaciones
```

### Mensaje saliente (vendedor)

```
[1]  Vendedor escribe en el dashboard
[2]  Dashboard llama: POST /functions/v1/send-message
       Headers: { Authorization: Bearer {JWT} }
       Body: { conversation_id, message }
[3]  send-message verifica JWT → obtiene user_id
[4]  Obtiene de DB: contact.phone, phone_numbers.phone_number_id,
                    phone_numbers.wa_access_token (token del cliente)
[5]  POST a Meta Graph API con el token de la org
[6]  INSERT mensaje outbound + UPDATE conversation.last_message_at
       + sent_by = user_id (para saber qué vendedor envió)
[7]  Supabase Realtime notifica → dashboard confirma envío
```

### Captura de lead desde landing

```
[1]  Visitante llena formulario en avaxon.lat
[2]  POST /functions/v1/landing-lead { name, phone }
[3]  Upsert en contacts (org = Avaxon, status='new', tags=['landing_page'])
[4]  n8n puede escuchar este evento y ejecutar un flujo de bienvenida
```

---

## Base de datos

### Esquema de tablas (relevantes para mensajería)

```sql
organizations
  id              uuid PK
  name            text
  industry        text
  plan_id         text          -- starter | pro | enterprise
  status          text          -- active | trial | paused | cancelled
  trial_ends_at   timestamptz

profiles                        -- usuarios de la plataforma
  id              uuid PK       -- = auth.users.id
  role            text          -- super_admin | admin | agent
  organization_id uuid FK
  full_name       text

whatsapp_accounts               -- WABA de cada cliente
  id              uuid PK
  organization_id uuid FK
  waba_id         text          -- ID de Meta
  business_name   text
  status          text

phone_numbers                   -- números de WhatsApp por cliente
  id              uuid PK
  organization_id uuid FK
  whatsapp_account_id uuid FK
  phone_number_id text          -- ID de Meta (para routing de webhook)
  display_phone_number text
  verified_name   text
  quality_rating  text          -- GREEN | YELLOW | RED
  status          text
  webhook_verified bool
  wa_access_token text          -- ← TOKEN POR ORG (multi-tenant)

contacts                        -- leads y clientes de cada org
  id              uuid PK
  organization_id uuid FK
  phone           text
  name            text
  email           text
  status          text          -- new | contacted | qualified | won | lost
  tags            text[]
  last_seen_at    timestamptz

conversations
  id              uuid PK
  organization_id uuid FK
  contact_id      uuid FK
  phone_number_id uuid FK
  status          text          -- open | closed
  assigned_to     uuid FK → profiles.id   -- ← ASIGNACIÓN DE VENDEDOR
  last_message_at timestamptz
  updated_at      timestamptz

messages
  id              uuid PK
  conversation_id uuid FK
  organization_id uuid FK
  direction       text          -- inbound | outbound
  content         text
  media_type      text          -- text | image | audio | video | document
  wa_message_id   text UNIQUE   -- idempotencia (Meta retries)
  sent_by         uuid FK → profiles.id   -- quién envió (si outbound manual)
  created_at      timestamptz

bot_configs                     -- configuración del bot por org
  id              uuid PK
  organization_id uuid FK
  system_prompt   text
  enabled         bool

appointments                    -- citas agendadas por el bot
  id              uuid PK
  organization_id uuid FK
  contact_id      uuid FK
  title           text
  service         text
  scheduled_at    timestamptz
  status          text
  notes           text
```

### Multi-tenancy y RLS

Todas las tablas tienen RLS activado. Las políticas permiten:
- `super_admin` → acceso a todos los registros
- `admin` / `agent` → solo registros donde `organization_id = get_my_org_id()`

El routing multi-tenant en el webhook funciona por `phone_number_id`:
```
Meta envía → phone_numbers.phone_number_id → organization_id → todos los queries filtrados
```

---

## Edge Functions

| Función | Método | Auth | Responsabilidad |
|---------|--------|------|-----------------|
| `webhook-wa` | GET + POST | Sin auth (Meta firma con HMAC) | Recibir webhook Meta, persistir, bot IA |
| `send-message` | POST | JWT requerido | Enviar mensaje manual desde dashboard |
| `admin-create-client` | POST | super_admin | Crear org + invitar admin |
| `admin-create-user` | POST | super_admin | Crear usuario con rol |
| `admin-delete-user` | POST | super_admin | Eliminar usuario |
| `admin-list-users` | GET | super_admin | Listar usuarios con datos de org |
| `landing-lead` | POST | Público | Capturar lead desde landing page |
| `landing-stats` | GET | Público | Métricas públicas para landing |
| `mock-webhook` | POST | super_admin | **[PENDIENTE]** Simular mensajes entrantes en dev |
| `wa-embedded-signup` | POST | JWT requerido | **[PENDIENTE - espera Meta]** Conectar número de cliente |

---

## Rol de n8n

n8n opera **exclusivamente de forma asíncrona** sobre datos ya persistidos en Supabase. Nunca es el receptor primario de webhooks de Meta.

### Qué SÍ hace n8n
- Escuchar cambios en Supabase (Database Webhooks o polling) y ejecutar automatizaciones
- Seguimientos automáticos: "si contacto no responde en 24h, enviar mensaje X"
- Reporte diario al dueño del negocio vía WhatsApp
- Sync con Google Sheets (para clientes que lo prefieran a Supabase)
- Notificaciones internas (Slack, email al admin cuando entra lead calificado)
- Flujos complejos de calificación multi-paso
- Secuencias de nurturing programadas

### Qué NO hace n8n
- Recibir el webhook primario de Meta
- Guardar mensajes en Supabase (eso es responsabilidad de webhook-wa)
- Enviar mensajes salientes del dashboard (eso es send-message Edge Function)
- Ser la fuente de verdad de ningún dato

### Cómo se conecta n8n a Supabase
```
Supabase Database Webhook (en tabla messages, event INSERT)
  ↓ HTTP POST al webhook de n8n
n8n procesa el evento async
  ↓ Lee datos adicionales de Supabase si los necesita
  ↓ Ejecuta automatización (send WA, Google Sheets, etc.)
```

---

## Onboarding de clientes

### Modo actual (sin Embedded Signup — mientras Meta aprueba Tech Provider)

El onboarding es manual, una vez por cliente (~10-15 min):

| Paso | Responsable | Acción |
|------|-------------|--------|
| 1 | Cliente | Crea Meta Business Manager y agrega número a WhatsApp Business API |
| 2 | Cliente | Genera System User Token permanente con scopes: `whatsapp_business_messaging`, `whatsapp_business_management` |
| 3 | Luis | En Admin Panel: crear org con `admin-create-client` |
| 4 | Luis | En Supabase: INSERT en `whatsapp_accounts` (waba_id del cliente) |
| 5 | Luis | En Supabase: INSERT en `phone_numbers` (phone_number_id + wa_access_token del cliente) |
| 6 | Luis | En Supabase: INSERT en `bot_configs` con system_prompt personalizado |
| 7 | Luis | En Meta del cliente: configurar webhook URL → `https://wprvjhvtnyibiwpeiusc.supabase.co/functions/v1/webhook-wa` |
| 8 | — | Listo — el webhook multi-tenant enruta automáticamente por phone_number_id |

### Modo futuro (con Embedded Signup — cuando Meta apruebe)

El cliente conecta su propio número desde el dashboard sin intervención de Luis:

```
Admin del cliente → Dashboard → "Conectar WhatsApp" 
  → FB.login() popup de Meta
  → Cliente autoriza en su Meta Business Manager
  → Edge Function wa-embedded-signup recibe el código
  → Intercambia por token de acceso
  → Crea whatsapp_account + phone_number en DB automáticamente
  → Bot activo en minutos
```

---

## Arquitectura de desarrollo (sin verificación Meta)

Para desarrollar y probar sin depender de Meta, hay una Edge Function `mock-webhook` que inyecta mensajes en el flujo real:

```
Dashboard (super_admin) → Modal "Simular mensaje"
  ↓ POST /functions/v1/mock-webhook
  { from: "+521234567890", name: "Cliente Test", message: "Hola" }
  ↓
mock-webhook construye payload idéntico al de Meta y llama webhook-wa internamente
  ↓
Flujo normal: contacts → conversations → messages → Realtime → Dashboard
```

Para el envío saliente, la Edge Function `send-message` tiene un flag de entorno:
```
APP_ENV = development  →  respuesta simulada de Meta (sin llamar Graph API real)
APP_ENV = production   →  llamada real a Meta API
```

---

## Estado de implementación

### Completado ✅
- Tablas de Supabase con RLS (organizations, profiles, contacts, conversations, messages, phone_numbers, whatsapp_accounts, bot_configs, appointments, invitations)
- webhook-wa: recepción de webhook Meta + bot GPT-4o
- send-message: envío manual desde dashboard
- Dashboard: inbox con Realtime, historial, envío manual, leads, calendario
- Admin panel: CRUD de clientes y usuarios
- Landing page + formulario de captura
- Edge Functions admin-* completas
- Módulo de conexiones en dashboard (UI del Bloque 4)

### Pendiente — desbloqueantes ⏳
- [ ] **System User Token permanente** en Meta Business Manager
  → Scopes: `whatsapp_business_messaging`, `whatsapp_business_management`
  → Guardar en `phone_numbers.wa_access_token` (no en env var global)
- [ ] **Migración SQL**: agregar `wa_access_token` a `phone_numbers`
- [ ] **Migración SQL**: agregar `assigned_to` y `sent_by` a conversations/messages
- [ ] **Idempotencia**: agregar `UNIQUE` constraint en `messages.wa_message_id`
- [ ] **webhook-wa**: usar token por org (leer de `phone_numbers.wa_access_token`)
- [ ] **webhook-wa**: devolver 200 antes de llamar GPT-4o (usar `waitUntil` o proceso async)

### Pendiente — verificación Meta ⏳
- [ ] **Verificación de negocio** en Meta Business Center (persona física, RFC RESICO)
  → Desbloquea: System User Token permanente, tier de mensajes, templates
- [ ] **Tech Provider status** (requiere entidad moral)
  → Desbloquea: Embedded Signup (conexión automática de números de clientes)
- [ ] **Embedded Signup**: Edge Function `wa-embedded-signup`

### Pendiente — features ⏳
- [ ] Asignación de vendedores en el dashboard
- [ ] Edge Function `mock-webhook` para desarrollo local
- [ ] n8n: reescribir workflow como automatización async (no receptor de webhook)
- [ ] n8n: seguimiento automático de leads fríos
- [ ] n8n: reporte diario al dueño vía WhatsApp

---

## Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|--------|---------|------------|
| Meta no responde 200 en < 15s | Reintentos → mensajes duplicados | UNIQUE en `wa_message_id` + devolver 200 antes de GPT-4o |
| Token 24h expira silenciosamente | Sistema deja de responder | System User Token permanente ASAP |
| n8n y webhook-wa procesan el mismo mensaje | Respuesta duplicada al cliente | Un solo webhook URL: apunta a webhook-wa, no a n8n |
| Token único global para todos los clientes | No escala a multi-tenant | `wa_access_token` por `phone_number` en DB |
| RLS incorrecta | Cliente ve datos de otro | Tests de aislamiento por org |
| Dos vendedores respondiendo la misma conv | Experiencia caótica | Columna `assigned_to` + indicador visual en dashboard |
| Rate limit Meta (1000 msgs/día en tier básico) | Mensajes bloqueados | Cola de envío en n8n si volumen escala |
| Webhook URL pública expuesta | Abuso o spam | Validar `X-Hub-Signature-256` header de Meta |

---

## Variables de entorno

### Supabase Secrets (producción)

| Variable | Descripción | Estado |
|----------|-------------|--------|
| `WA_ACCESS_TOKEN` | Token de Meta (temporal 24h) | ⚠️ Reemplazar con token por org en DB |
| `WA_PHONE_NUMBER_ID` | Phone Number ID de Avaxon | ✅ |
| `WEBHOOK_VERIFY_TOKEN` | Token de verificación del webhook | ✅ `avaxon_meta_verify_2026` |
| `OPENAI_API_KEY` | Clave de OpenAI para GPT-4o | ✅ |
| `APP_ENV` | `development` o `production` | ⏳ Agregar |

### Meta (por cliente)
Cada cliente tendrá en la tabla `phone_numbers`:
- `phone_number_id` — ID del número en Meta
- `wa_access_token` — System User Token permanente del cliente

---

## URLs del sistema

| Recurso | URL |
|---------|-----|
| Landing | `https://avaxon.lat` |
| Dashboard cliente | `https://avaxon.lat/dashboard/` |
| Admin panel | `https://avaxon.lat/admin/` |
| Supabase proyecto | `https://wprvjhvtnyibiwpeiusc.supabase.co` |
| Webhook Meta (producción) | `https://wprvjhvtnyibiwpeiusc.supabase.co/functions/v1/webhook-wa` |
| n8n instance | `https://avaxon2938409.app.n8n.cloud` |
| Meta App ID | `2086225228635820` |
| WABA ID (Avaxon) | `3512648718898077` |
| Phone Number ID (Avaxon) | `1348271025028457` |
| Número Avaxon | `+52 18991709336` |

---

## Decisiones de arquitectura registradas

| Fecha | Decisión | Razón |
|-------|----------|-------|
| Sep 2026 | webhook-wa es el único receptor de Meta, no n8n | Edge Functions garantizan < 15s; n8n tiene latencia variable |
| Sep 2026 | n8n opera async sobre Supabase, no sobre Meta directamente | Separación de responsabilidades; n8n no debe ser punto de falla crítico |
| Sep 2026 | Token de Meta por org en `phone_numbers.wa_access_token`, no en env var global | Escalabilidad multi-tenant; cada cliente tiene su propio token |
| Sep 2026 | Embedded Signup en pausa hasta aprobación Meta Tech Provider | Requiere entidad moral; onboarding manual mientras tanto |
| Jul 2026 | Twilio descartado | Bundle México rechazado; Meta API directo es más confiable |
| Jul 2026 | Facturación bajo RFC personal (RESICO) | Evitar gastos notariales; revisar en Fase 3 con contadora |

---

*Este documento es la fuente de verdad de la arquitectura técnica de Avaxon.*
*Actualizar cada vez que se tome una decisión de arquitectura relevante.*
