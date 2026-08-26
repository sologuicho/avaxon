# Vesvir Technology — Información Completa

---

## ¿Qué es Vesvir?

Vesvir es una plataforma SaaS mexicana de automatización de ventas con inteligencia artificial, enfocada en negocios que usan WhatsApp como canal principal de comunicación con clientes.

El corazón del producto es **Buddy**, un asistente de IA conversacional que el dueño del negocio configura hablándole por WhatsApp — sin formularios, sin tutoriales, sin técnicos. Buddy vende 24/7, califica prospectos, da seguimiento automático, agenda citas, reporta métricas y gestiona al equipo de ventas.

**Tagline:** *"Tu negocio entero. Un solo chat."*

**Descripción corta:** Asistente de IA para negocios mexicanos: vende, cobra y da seguimiento por WhatsApp.

**Diferenciador clave:** Vesvir es **Meta Tech Provider oficial** — los números de WhatsApp Business se conectan directamente vía API sin intermediarios (BSP), sin costo por número conectado.

---

## Propuesta de Valor

| Problema | Solución Vesvir |
|----------|----------------|
| WhatsApp del negocio saturado | Bot 24/7 que atiende y califica solo |
| Prospectos que se enfrían sin respuesta | Seguimiento automático por secuencias |
| Equipo sin visibilidad del dueño | CRM + reportes en tiempo real |
| Citas perdidas por no-shows | Recordatorios automáticos y confirmaciones |
| Configurar software es complicado | Todo se configura hablándole a Buddy por WhatsApp |

---

## Infraestructura y Servidores

| Componente | Plataforma | Detalle |
|-----------|-----------|---------|
| **Producción (vesvir.com)** | Hostinger | Branch `main`, deploy manual vía panel |
| **Staging (dev.vesvir.com)** | Vercel | Branch `develop`, auto-deploy |
| **Base de datos** | Supabase (PostgreSQL) | Proyecto: `lkifqofwnrtohwagmexi.supabase.co` |
| **Auth** | Supabase Auth | JWT, RLS en 149+ tablas |
| **Edge Functions** | Supabase Edge Functions (Deno) | 74 funciones desplegadas |
| **Realtime** | Supabase Realtime | Subscripciones en inbox y cola de aprobación IA |
| **Almacenamiento** | Supabase Storage | Imágenes y medios |
| **Pagos** | Stripe | Suscripciones, checkouts, portal de facturación |
| **WhatsApp** | Meta Graph API (API oficial) | Meta Tech Provider — sin BSP intermediario |
| **IA / LLM** | Anthropic (Claude Sonnet 4.5) | Motor del chatbot, sugerencias, reportes |
| **Llamadas IA** | Retell AI | Llamadas automáticas outbound |
| **Analytics** | PostHog | Eventos de producto, onboarding, diagnóstico |
| **Calendario** | Google Calendar API | Sincronización de citas |
| **Email** | (vía Edge Functions) | Drip de onboarding, reportes semanales |
| **Repositorio** | GitHub (`vesvirtechnology`) | CI/CD con Vercel |

---

## Planes y Precios (MXN)

### Planes disponibles públicamente

| Plan | Precio Mensual | Precio Anual | Setup | Usuarios incluidos | Usuario extra | Conversaciones WA/mes | Nivel IA máx |
|------|---------------|-------------|-------|-------------------|--------------|----------------------|-------------|
| **Mostrador** | $2,990 | $22,990/año | $5,000 | 1 | $290 | 800 | Nivel 2 |
| **Sucursal** | $4,990 | $39,990/año | $12,000 | 3 | $290 | 1,500 | Nivel 3 |
| **Cadena** | $10,990 | $89,990/año | $22,000 | 10 | $290 | 3,500 | Nivel 4 |
| **Enterprise** | $20,000 | $200,000/año | $30,000 | Ilimitados | — | Ilimitadas | Nivel 4 |

### Planes internos / especiales

| Plan | Precio | Notas |
|------|--------|-------|
| **Free** (`fm_free`) | $0 | Sin expiración, uso interno / demos |
| **Esencial** | $990/mes | Plan legacy básico |
| **Growth** | $4,990/mes | 5 usuarios, 5,000 conv/mes, 14 días prueba |
| **Scale** | $9,990/mes | 15 usuarios, 20,000 conv/mes, 30 días prueba |

### Soporte incluido por plan

| Plan | Canal de soporte |
|------|----------------|
| Mostrador | Email + Centro de ayuda |
| Sucursal | WhatsApp + Email |
| Cadena | WhatsApp grupal + Prioridad |
| Enterprise | Ejecutivo dedicado + WhatsApp grupal |

---

## Módulos (Add-ons)

Cada plan incluye módulos base. Los siguientes son módulos adicionales activables por tenant:

| Módulo | Código | Precio/mes | Setup | Descripción |
|--------|--------|-----------|-------|-------------|
| **Chatbot WhatsApp 24/7** | `core` | Incluido | — | Bot que atiende y califica leads automáticamente |
| **Recupera Clientes Perdidos** | `followups` | Incluido | $2,000 | Secuencias de reactivación para leads fríos |
| **Campañas de Secuencias** | `campaigns` | Incluido | — | Campañas masivas que enrolan leads en secuencias |
| **Multi-canal** | `multichannel` | Incluido | — | Instagram y Messenger en el mismo inbox |
| **Reputación y Reseñas** | `surveys` | $190 | $1,500 | NPS automático post-venta, alertas de insatisfacción |
| **Contenido para Redes** | `content` | $290 | $3,000 | Posts + imágenes IA, calendario semanal |
| **Gestión de Equipo** | `assignment` | $290 | $3,500 | Reglas de asignación automática de leads por vendedor |
| **Piloto Automático** | `sequences` | $390 | — | Secuencias automatizadas multicanal |
| **Agenda Automática** | `appointments` | $390 | $4,000 | Citas vía WhatsApp + Google Calendar + recordatorios |
| **Demo en Vivo desde Landing** | `landing_demo` | $490 | — | Visitantes prueban el bot, leads capturados en CRM |
| **Asistente de Ventas IA** | `copilot` | $490 | — | IA que aprende de conversaciones y sugiere respuestas |
| **Publicidad Inteligente** | `ads` | $590 | — | Funnel Builder, Estratega IA, Estudio Creativo |
| **Confirmación de Servicio** | `service_appointments` | $590 | — | Confirmaciones de citas de servicio automotriz + DMS |
| **Llamadas con IA** | `calls` | $690 | $4,000 | Llamadas automáticas outbound (Retell AI) |

---

## Funcionalidades Principales del Dashboard

### CRM y Ventas
- Pipeline Kanban con arrastrar y soltar
- Calificación de leads con IA
- Notas, etiquetas y línea de tiempo de actividad
- Asignación automática por reglas (horario, especialidad, carga de trabajo)
- Exportación CSV de métricas y leads

### Inbox / Conversaciones
- Chat unificado: WhatsApp + Messenger + Instagram
- Filtros por tipo: ventas / servicio
- Sugerencias de respuesta generadas por IA
- Respuestas rápidas (templates reutilizables)
- Análisis de sentimiento en tiempo real
- Resúmenes automáticos de conversación
- Análisis de imágenes con Vision AI (Claude)
- Vista móvil optimizada

### Bot y Personas
- **Brain Form**: rol, tono, industria, instrucciones, frases
- **Botones por intent**: saludo, precio, agendar, etc.
- **Knowledge Items**: productos, FAQs, políticas, precios
- **Activation Rules**: cuándo activar cada persona
- **Sandbox**: prueba conversaciones sin tocar producción
- Prompt compilado y cacheado automáticamente

### Vendedor Digital (IA Progresiva — 4 Niveles)
| Nivel | Nombre | Comportamiento |
|-------|--------|---------------|
| 0 | Chatbot | Califica, responde FAQs, transfiere |
| 1 | Observador | Aprende de conversaciones humanas en silencio |
| 2 | Asistente | Sugiere respuestas al agente |
| 3 | Aprendiz | Redacta respuesta, humano aprueba antes de enviar |
| 4 | Autónomo | Responde solo dentro de parámetros configurados |

### Secuencias y Automatización
- Constructor visual tipo Drawflow
- Tipos: WhatsApp texto, template, llamada IA, WhatsApp Flow, espera, condición
- Campañas masivas con segmentación
- Plantillas del marketplace por industria
- Seguimiento de no-shows y recordatorios

### Agenda y Citas
- Reservas automáticas desde WhatsApp
- Sincronización bidireccional con Google Calendar
- Recordatorios configurables
- Confirmaciones de servicio automotriz (integración DMS)

### Reportes y Analytics
- Métricas configurables por tenant (lenguaje natural con Buddy)
- Reporte diario automático (email + WhatsApp)
- Dashboard de ROI
- Heatmap de disponibilidad
- Snapshots mensuales

### Configuración
- Templates de WhatsApp (crear, editar, sincronizar desde Meta)
- WhatsApp Flows (formularios interactivos)
- Horario del bot
- Encargos y seguimiento de pedidos
- Cuestionarios de productos con imágenes por categoría
- Roles y permisos por usuario (RBAC)

### Onboarding
- Wizard de 5 pasos para nuevos tenants
- Widget de progreso en sidebar
- Bot pre-armado según el giro del negocio (blueprint automático)
- Drip de emails personalizados post-registro

---

## Giros / Industrias que Atiende (41 nichos)

| Categoría | Giros |
|-----------|-------|
| **Alimentos** | Restaurante, Bar/Antro, Cafetería, Carnicería, Panadería/Pastelería |
| **Automotriz** | Agencia Automotriz, Refaccionaria/Auto Partes, Taller Mecánico |
| **Belleza** | Salón de Belleza/Spa |
| **Comercio** | Ferretería, Florería, Joyería, Maderería, Mueblería, Papelería, Electrónica, Tienda de Mascotas |
| **Educación** | Escuela/Instituto Educativo |
| **Finanzas** | Agencia de Seguros |
| **Inmobiliaria** | Inmobiliaria |
| **Moda** | Boutique/Ropa, Vestidos de Novia, Zapatería |
| **Profesional** | Despacho Contable, Abogados, Arquitectura, Estudio Fotográfico |
| **Salud** | Clínica, Consultorio Dental, Yoga/Pilates, Farmacia, Gimnasio, Nutriólogo, Óptica, Veterinaria |
| **Servicios** | Cerrajería, Imprenta, Lavandería |
| **Turismo** | Agencia de Viajes, Hotel/Hospedaje |
| **General** | Cualquier otro giro |

---

## Integraciones

| Integración | Uso |
|------------|-----|
| **Meta / WhatsApp Business API** | Canal principal de mensajería (Tech Provider oficial) |
| **Meta Embedded Signup** | Conexión de números sin BSP intermediario |
| **Stripe** | Pagos, suscripciones, portal de facturación, cobros por uso |
| **Google Calendar** | Agenda y sincronización de citas |
| **Retell AI** | Llamadas telefónicas automáticas con IA |
| **Anthropic (Claude)** | Motor de IA: chatbot, sugerencias, reportes, visión |
| **PostHog** | Analytics de producto |
| **BIND ERP** | Consulta de inventario en tiempo real (módulo automotriz) |
| **Instagram / Messenger** | Multi-canal en inbox unificado |
| **Google Sheets** | Sincronización de inventario |

---

## Clientes en Producción

| Cliente | Industria | Estado |
|---------|-----------|--------|
| **RDC Refacciones** (Alejandro Bugarin) | Refaccionaria automotriz | 🔴 LIVE — cliente pagando |
| **APSA Santiago** | Refaccionaria (Santiago Papasquiaro, Dgo.) | 🔴 LIVE — ~800 mensajes/semana |
| **Vesvir Agency** | Agencia (cuenta propia) | 🟡 Testing + embudo de alta activo |

---

## Stack Tecnológico

### Frontend
- Vanilla JavaScript (sin frameworks)
- Tailwind CSS (CDN)
- Chart.js (gráficas)
- Sortable.js (Kanban drag & drop)
- Fuentes: Outfit, Syne, Inter, DM Sans, Space Mono
- PWA: Service Worker + manifests + íconos

### Backend
- **Supabase**: PostgreSQL + Auth + Edge Functions + Realtime + Storage
- **Edge Functions**: Deno (TypeScript), 74 funciones
- **Base de datos**: 149 tablas, RLS habilitado en todas
- **RPCs**: Funciones SQL personalizadas para permisos, métricas, compilación de prompts

### Arquitectura
- Multi-tenant (cada cliente es un `tenant_id`)
- RBAC granular (roles: owner, admin, manager, agent, supervisor, scheduler, viewer)
- Feature flags por tenant (`stable`, `beta_features`, `invoice_bot`, `ai_msg_cap`, etc.)
- Prompt del bot ensamblado en tiempo real desde: Personas + Knowledge + Reglas

---

## Contacto Vesvir

- **Web:** https://vesvir.com
- **WhatsApp comercial:** +52 56 6450 3051
- **Staging / QA:** https://dev.vesvir.com
- **País:** México 🇲🇽

---

*Documento generado el 2026-08-17*
