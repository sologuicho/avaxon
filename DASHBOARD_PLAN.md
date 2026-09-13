# PLAN DE REDISEÑO: DASHBOARD AVAXON

> Diagnóstico y plan por bloque. Generado: 2026-09-13.
> No tocar código hasta decidir por dónde arrancar.

---

## CONTEXTO TÉCNICO ACTUAL

El dashboard es un **HTML monolítico de 2,396 líneas** (`dashboard/index.html`) con CSS y JS inline, sin framework moderno. El backend es Supabase (PostgreSQL + Edge Functions + Auth). No hay librería de gráficas instalada.

**Stack:**
- Frontend: HTML + vanilla JS (un solo archivo)
- Backend: Supabase Edge Functions (Deno)
- DB: Supabase PostgreSQL
- Automatización: n8n Cloud
- IA: OpenAI GPT-4o
- Auth: Supabase Auth (email/password)

---

## BLOQUE 1 — DASHBOARD DE CLIENTE

### Qué existe hoy

| Vista | Estado |
|-------|--------|
| Inicio (KPIs) | ✅ Funciona — 4 cards numéricas (contactos, conversaciones abiertas, mensajes hoy, mensajes totales) |
| Leads/Contactos | ✅ Funciona — tabla de 50 últimos contactos con búsqueda |
| Calendario | ✅ Funciona — calendario local con citas, sin Google Calendar real |
| Conversaciones | 🔒 BLOQUEADO — solo muestra "Próximamente" |
| Conexiones | ⚠️ Solo lectura — cards estáticas, sin edición |

**Gráficas actuales:** ninguna. Solo números. No hay Chart.js, D3 ni nada similar instalado.

### Problemas de UX

- Los KPIs no tienen contexto temporal (¿este mes? ¿hoy? ¿siempre?). Solo hay uno filtrado por fecha: "mensajes hoy".
- No hay tendencias: no sabes si los contactos van subiendo o bajando.
- Vista de conversaciones bloqueada — es lo que más le interesa al cliente.
- El calendario no sincroniza con Google Calendar; las citas viven solo en la BD.
- Layout de una sola columna en desktop, se desperdicia espacio.

### Gráficas a agregar

| Gráfica | Dato fuente | Valor para el cliente |
|---------|-------------|----------------------|
| Línea: mensajes enviados/recibidos por día (últimos 30 días) | `messages.created_at + direction` | Ver actividad del bot |
| Barras: nuevos contactos por semana | `contacts.created_at` | Medir captación |
| Donut: estado de conversaciones (abierta/cerrada/pendiente) | `conversations.status` | Entender carga de trabajo |
| KPI con tendencia (flecha ↑↓) | comparar periodo actual vs anterior | Contextualizar los números |
| Vista de conversaciones real | `conversations + messages + contacts` | Es la funcionalidad más importante |

### Plan de implementación

1. Instalar **Chart.js** (ligero, sin build step, compatible con vanilla JS).
2. Agregar gráfica de línea en el inicio (mensajes últimos 30 días) con query agregada a Supabase.
3. Agregar gráfica de barras (contactos por semana).
4. Añadir selector de período (7d / 30d / 90d) a los KPIs con comparativo vs período anterior.
5. Desbloquear vista de conversaciones: lista de chats con último mensaje, filtros (abierta/cerrada), click para ver hilo completo.
6. Mejorar layout: grid de 2 columnas en desktop para KPIs + gráficas.

**Esfuerzo:** MEDIO (3–5 días)

---

## BLOQUE 2 — DASHBOARD DE ADMINISTRADOR

### Qué existe hoy

El sistema de roles en BD es mínimo:

```
profiles.role = 'super_admin' | 'admin' | 'agent'
profiles.organization_id → fk a organizations
```

El email `floresescobedoluisalberto@gmail.com` está **hardcodeado** en el JS del dashboard para detectar super_admin. Riesgo: cualquiera que vea el HTML puede ver el email y la lógica de permisos.

**No existe:**
- Panel para crear clientes/organizaciones desde la UI.
- Jerarquía de sub-cuentas o permisos granulares.
- Invitación de usuarios por email.
- Vista separada para el admin vs el cliente.
- RLS policies que refuercen permisos a nivel BD (solo se filtra en JS hoy).

### Jerarquía propuesta

```
super_admin (Luis — Avaxon)
  └── organization (cliente de Avaxon)
        ├── admin (dueño del negocio del cliente)
        └── agent (empleado del cliente)
```

### Cambios de BD necesarios

1. **Tabla `invitations`** — para invitar usuarios por email con rol predefinido.
   ```sql
   create table invitations (
     id uuid primary key default gen_random_uuid(),
     email text not null,
     organization_id uuid references organizations(id),
     role text not null,
     token text unique not null,
     expires_at timestamptz not null,
     used_at timestamptz,
     created_by uuid references profiles(id)
   );
   ```

2. **RLS policies** en tablas críticas (`contacts`, `conversations`, `messages`) para que cada organización solo vea sus datos a nivel BD, no solo en JS.

### Plan de implementación

1. Crear tabla `invitations` con migración en Supabase.
2. Agregar RLS policies a tablas críticas (contacts, conversations, messages).
3. Quitar el email hardcodeado del JS; usar solo `profiles.role = 'super_admin'`.
4. Crear vista de admin (`/admin`) separada con:
   - Tabla de organizaciones (crear, editar, cambiar plan/estado, ver trial).
   - Tabla de usuarios (crear cuenta, asignar org+rol, resetear password).
   - Métricas globales: total clientes, total mensajes del mes, uso por cliente.
5. Formulario de "crear cliente" que en un solo flujo: crea la `organization`, crea el `profile` de admin del cliente, y envía email de bienvenida.

**Esfuerzo:** GRANDE (1–2 semanas) — es el bloque más crítico de infraestructura

---

## BLOQUE 3 — APARTADO DE CONEXIONES

### Qué existe hoy

5 cards estáticas. Solo 1 tiene datos reales:

| Card | Estado real |
|------|-------------|
| WhatsApp Business | ✅ Lee de BD (`phone_numbers`, `whatsapp_accounts`) — muestra número, quality rating, webhook status |
| Bot IA (GPT-4o) | 🟡 Hardcoded como "activo" — no valida nada |
| n8n Workflows | 🟡 Hardcoded como "conectado" — no valida nada |
| Google Calendar | 🔒 Placeholder — "Próximamente" |
| CRM/Leads Export | 🔒 Placeholder — "Próximamente" |

No hay ningún campo en la UI para que el cliente ingrese o edite API keys. Todo es de solo lectura.

### Qué rescatar vs rehacer

**Rescatar:** La lógica de leer `phone_numbers` y `whatsapp_accounts` de Supabase ya funciona.

**Rehacer completamente:**
- Eliminar cards de n8n y Bot IA (el cliente no necesita ver eso).
- Eliminar placeholders de Google Calendar y CRM Export.
- Reemplazar todo por un apartado de "Conectar canales" real.

### Nueva estructura propuesta

**Sección A — WhatsApp/Meta (Embedded Signup)**
- Botón "Conectar WhatsApp" que abre el popup de Facebook (Embedded Signup).
- Al completar: guarda `waba_id`, `phone_number_id`, y access token del cliente en BD.
- Muestra número conectado + estado (verde/rojo) + botón "Desconectar".

**Sección B — API Keys del cliente**
- Campo para que el cliente ingrese su `OpenAI API Key` (si quieren usar su propia cuenta).
- Almacenado cifrado en Supabase (columna `encrypted` o usando Vault de Supabase).
- Por ahora: solo el campo de OpenAI es el más relevante para el stack actual.

**Sección C — Webhooks y estado del bot**
- URL del webhook de n8n para el cliente (readonly, para que sepan cuál es).
- Estado real del webhook (ping al endpoint y mostrar latency).

**Esfuerzo:** MEDIO (3–5 días, pero depende de que Bloque 4 esté avanzado para el Embedded Signup real)

---

## BLOQUE 4 — SER SOCIO DE META (TECH PROVIDER)

### Qué tenemos hoy

| Item | Estado |
|------|--------|
| App de Meta creada | ✅ (hay `META_WABA_ID` configurado) |
| Webhook de WhatsApp funcionando | ✅ (Edge Function en Supabase) |
| Token de acceso | ⚠️ Token temporal de 24h — no es System User Token |
| Número de teléfono conectado | ⚠️ Pendiente conectar número Telcel a Meta API |
| Business Verification de Meta | ❓ No confirmado |
| Embedded Signup implementado | ❌ No implementado |
| Tech Provider / Partner status | ❌ No iniciado |

### Pasos para llegar a Embedded Signup (en orden)

**Paso 1 — Business Verification de Meta** *(sin esto nada de lo demás funciona)*
- Ir a Meta Business Suite → Security Center → Verificar negocio.
- Requiere: documentos legales del negocio (acta constitutiva o comprobante de empresa) + dominio verificado en Meta Business Manager.
- Tiempo estimado: 3–10 días hábiles.
- **Acción: iniciar hoy.**

**Paso 2 — System User Token permanente**
- Crear un System User en Meta Business Manager.
- Generar token permanente (no expira a 24h).
- Asignarle permisos de admin sobre el WABA.
- Reemplazar `META_ACCESS_TOKEN` en `.env` con este token.
- Este es un blocker actual mencionado en PROGRESO.md.

**Paso 3 — Conectar número Telcel a Meta API**
- Blocker actual mencionado en PROGRESO.md.
- Requiere número activo verificado en Meta Business Manager.

**Paso 4 — App de Meta en modo Live con permisos correctos**
- La app necesita los permisos: `whatsapp_business_management`, `whatsapp_business_messaging`, `business_management`.
- Verificar en Graph API Explorer que el token tiene estos scopes.
- Cambiar app de modo Development a **Live**.

**Paso 5 — Activar Embedded Signup en la app**
- En la configuración de la app de Meta: activar "Embedded Signup" bajo WhatsApp.
- Requiere que Business Verification esté aprobada (Paso 1).
- Configurar los `redirect_uri` permitidos apuntando al dominio de Avaxon.

**Paso 6 — Implementar el flujo en el dashboard** *(esto es el Bloque 3)*
- SDK de Facebook (`FB.init`) en el HTML del dashboard.
- Botón que llama `FB.login()` con los scopes de WhatsApp Business.
- Callback que recibe el `code`, lo intercambia por token, y guarda `waba_id` + `phone_number_id` en BD.

**Paso 7 — Tech Provider Program** *(opcional, para escalar)*
- Aplicar en `developers.facebook.com`.
- Requiere: Business Verification ✅ + historial de uso de la API + descripción del producto.
- Beneficios: soporte prioritario, mayor rate limit, acceso a features beta.
- No es necesario para usar Embedded Signup, pero sí para escalar a muchos clientes.

### Lista de pendientes (checklist)

- [ ] Confirmar si Business Verification está aprobada en Meta Business Manager
- [ ] Crear System User Token permanente
- [ ] Conectar número Telcel a Meta API
- [ ] App en modo Live con permisos correctos
- [ ] Activar Embedded Signup en la configuración de la app
- [ ] Implementar flujo de Embedded Signup en el dashboard (Bloque 3)
- [ ] Aplicar al Tech Provider Program

**Esfuerzo:** GRANDE para la parte de Meta (depende de tiempos de aprobación externos: 3–10 días solo para Business Verification). La implementación técnica es MEDIO (2–3 días una vez Meta esté aprobado).

---

## RESUMEN EJECUTIVO

| Bloque | Qué existe hoy | Qué falta | Esfuerzo | Prioridad |
|--------|---------------|-----------|----------|-----------|
| **1. Dashboard cliente** | KPIs numéricos, tablas, sin gráficas | Chart.js, gráficas de tendencia, vista de conversaciones | MEDIO (3–5 días) | 2 |
| **2. Admin dashboard** | Email hardcodeado, rol básico en BD | RLS real, vista admin, crear clientes desde UI, invitaciones | GRANDE (1–2 semanas) | 1 |
| **3. Conexiones** | 1 card real (WA), 4 estáticas/placeholder | Embedded Signup, API keys editables, webhooks reales | MEDIO (3–5 días, depende del B4) | 3 |
| **4. Meta Tech Provider** | Token temporal, webhook funcionando | Business Verification, System User, app en Live, Embedded Signup | GRANDE + tiempos externos | 4 |

### Orden recomendado

```
1. Bloque 4 (Meta)  → iniciar HOY los trámites (son lentos, corren en paralelo con lo demás)
2. Bloque 2 (Admin) → infraestructura base; sin esto no puedes crear clientes sin terminal
3. Bloque 1 (Dashboard) → mejora de valor percibido para el cliente piloto
4. Bloque 3 (Conexiones) → una vez Meta aprobado, conectar Embedded Signup
```

---

## DEUDA TÉCNICA IDENTIFICADA

Estos problemas existen hoy independientemente de los 4 bloques:

| Problema | Riesgo | Acción |
|----------|--------|--------|
| `META_ACCESS_TOKEN` en `.env` expira cada 24h | Alto — el bot deja de funcionar | Crear System User Token (Bloque 4, Paso 2) |
| Email de super_admin hardcodeado en JS | Medio — expone lógica de permisos | Mover a `profiles.role` (Bloque 2) |
| Sin RLS en BD — filtros solo en JS | Alto — datos de clientes sin protección real | Agregar RLS policies (Bloque 2) |
| n8n webhook httpMethod configurado como `ALL` | Medio — acepta métodos no esperados | Cambiar a `POST` |
| Dashboard monolítico (2,396 líneas en 1 archivo) | Bajo-Medio — difícil de mantener | Modularizar al refactorizar (Bloque 1) |
