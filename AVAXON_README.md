# Avaxon — README para Claude Code

## ¿Qué es Avaxon?

Avaxon es una agencia de automatización con IA enfocada en el mercado mexicano. Construimos e implementamos agentes de WhatsApp impulsados por inteligencia artificial para PyMEs de diversos sectores, permitiéndoles automatizar sus ventas, atención al cliente y seguimiento de leads sin necesidad de contratar personal adicional.

El modelo es simple: cobramos un fee de setup único y una mensualidad por mantenimiento y operación del agente.

---

## Socios

| Nombre | Rol |
|---|---|
| **Luis Flores** | Tech Lead — arquitectura, desarrollo de workflows, integraciones API |
| **Hector García** | Socio operativo — ventas, onboarding de clientes, soporte |
| **Jose Luis** | Socio de negocio — estrategia comercial, relaciones con clientes |

---

## Servicios que ofrece Avaxon

1. **Chatbot de ventas y atención al cliente** — agente AI que responde preguntas frecuentes 24/7 por WhatsApp
2. **Calificación de leads automática** — el agente detecta intención de compra, recopila datos clave (nombre, necesidad, presupuesto, timeline) y los guarda en una hoja de Google Sheets
3. **Agendamiento de citas** — el agente recopila disponibilidad y confirma citas sin intervención humana
4. **Seguimiento post-venta** — mensajes automáticos de seguimiento a clientes después de una compra o servicio

---

## Mercado objetivo

PyMEs mexicanas de múltiples sectores:
- Negocios locales (restaurantes, clínicas, talleres, salones)
- Automotriz
- E-commerce
- Servicios profesionales (despachos, consultoras, agencias)

---

## Stack Técnico

| Capa | Tecnología |
|---|---|
| **Automatización / Workflows** | n8n Cloud |
| **Canal de comunicación** | WhatsApp Business API (Meta oficial) |
| **IA / LLM** | OpenAI GPT-4o |
| **Memoria de conversación** | n8n built-in (Simple Memory node) |
| **Almacenamiento de leads** | Google Sheets |
| **Infraestructura** | n8n Cloud (sin self-host por ahora) |

### Credenciales y cuentas activas
- **n8n Cloud:** `avaxon2938409.app.n8n.cloud` (trial activo, 14 días)
- **OpenAI:** cuenta activa con créditos cargados
- **Meta Business Manager:** portafolio Avaxon recién creado (en proceso de verificación)
- **Twilio:** cuenta trial activa, bundle México rechazado por name mismatch en comprobante de domicilio — **pendiente resolver o migrar a Meta API directo**
- **WhatsApp Business:** número Telcel nuevo instalado, pendiente de conectar a Meta API

---

## Arquitectura del Workflow Principal

```
[WhatsApp mensaje entrante]
        ↓
[Meta Webhook → n8n Trigger]
        ↓
[Business Assistant Agent]
    ├── GPT-4o (modelo)
    ├── Simple Memory (sesión por número de teléfono)
    └── Intent Parser (detecta: question / lead / appointment)
        ↓
[Router: Check If Lead or Appointment]
    ├── TRUE → Save Lead to Google Sheets
    └── FALSE → continúa
        ↓
[Send WhatsApp Reply via Meta API]
```

### System Prompt del agente (base)
```
You are a helpful business assistant. Your goals are:
(1) Answer frequently asked questions about our services,
(2) Qualify leads by asking about their business needs, budget, and timeline,
(3) Schedule appointments by collecting name, date preference, and contact info,
(4) Send confirmations when a lead is qualified or appointment is booked.
Always respond in the same language the user writes in. Be concise and professional.
```

> **Nota:** Este system prompt se personaliza por cliente con el nombre del negocio, sus servicios específicos, horarios, FAQs y tono de comunicación.

---

## Google Sheets — Estructura de leads

| Columna | Descripción |
|---|---|
| `phone` | Número de WhatsApp del lead |
| `name` | Nombre del prospecto |
| `business_need` | Qué necesita el cliente |
| `budget` | Presupuesto aproximado |
| `timeline` | Cuándo quiere empezar |
| `status` | qualified / appointment / pending |
| `timestamp` | Fecha y hora del registro |

---

## Modelo de Negocio

### Estructura de precios (propuesta inicial)
- **Setup:** $3,000 — $8,000 MXN (según complejidad del agente)
- **Mensualidad:** $1,500 — $3,500 MXN (mantenimiento, ajustes, reportes)

### Proceso de onboarding por cliente
1. Reunión de descubrimiento — entender el negocio, FAQs, flujo de ventas
2. Configuración del agente — system prompt personalizado, Google Sheets, número WhatsApp
3. Pruebas internas (3-5 días)
4. Go-live + monitoreo primera semana
5. Entrega de reporte mensual de leads capturados

---

## Estado Actual del Proyecto

### ✅ Completado
- Cuenta n8n Cloud activa
- Workflow base construido y probado (recibe mensajes, procesa con GPT-4o, guarda leads en Sheets)
- Credenciales OpenAI, Twilio y Google Sheets configuradas en n8n
- Meta Business Manager de Avaxon creado
- Número Telcel nuevo adquirido para WhatsApp Business

### 🔄 En progreso
- Verificación de cuenta Meta for Developers (pendiente confirmar número o tarjeta de crédito)
- Conectar número Telcel a WhatsApp Business API oficial de Meta
- Reemplazar Twilio por Meta API en el workflow de n8n

### ⏳ Pendiente
- Crear Meta App con producto WhatsApp en developers.facebook.com
- Configurar webhook de Meta en n8n
- Personalizar system prompt para primer cliente real
- Definir pricing final y contrato de servicio
- Facturación bajo RFC personal de Luis Flores (RESICO) hasta tener RFC de Avaxon

---

## Reglas importantes para Claude Code

1. **Este proyecto es independiente de Vesvir** — no mezclar código, credenciales, ni contexto con el repo `~/vesvir-b2c`
2. **Los workflows viven en n8n Cloud**, no en un repo local — los cambios se hacen directo en la UI de n8n o vía API de n8n
3. **El canal principal es WhatsApp vía Meta API** — Twilio es backup/sandbox únicamente
4. **Cada cliente tiene su propio workflow** — no un workflow genérico compartido; se duplica y personaliza por cliente
5. **Google Sheets es el CRM por ahora** — no hay base de datos propia todavía
6. **La facturación es bajo RFC personal de Luis Flores** hasta constituir Avaxon formalmente

---

## Contacto del equipo

- **Luis Flores** — Tech Lead — luis@avaxon (pendiente dominio)
- **Hector García** — hectorgarcia2907@gmail.com
- **Jose Luis** — (agregar correo)

---

*Documento creado: Junio 2026 — Actualizar conforme avance el proyecto*
