# Avaxon — Información Completa

---

## ¿Qué es Avaxon?

Avaxon es una agencia mexicana de automatización con inteligencia artificial, enfocada en negocios que usan WhatsApp como canal principal de comunicación con clientes.

Construimos e implementamos **agentes de IA conversacionales** personalizados para cada cliente — sin que el dueño del negocio tenga que aprender software, sin formularios complicados, sin técnicos internos. El agente vende 24/7, califica prospectos, agenda citas, da seguimiento automático y reporta resultados directo por WhatsApp.

**Tagline:** *"Automatiza tus ventas. Nosotros construimos el agente, tú cobras los resultados."*

**Descripción corta:** Agencia de agentes IA para negocios mexicanos: vende, califica leads y da seguimiento por WhatsApp.

**Diferenciador clave:** Cada agente es 100% personalizado al negocio del cliente — su catálogo, su tono, su proceso de venta. No es un bot genérico, es un vendedor digital entrenado en el negocio.

---

## Propuesta de Valor

| Problema | Solución Avaxon |
|----------|----------------|
| WhatsApp del negocio saturado de mensajes | Agente IA 24/7 que atiende y califica solo |
| Prospectos que se enfrían sin respuesta rápida | Respuesta inmediata + seguimiento automático |
| Leads que no se registran ni se dan seguimiento | Captura automática en Google Sheets o CRM |
| Citas perdidas por no-shows | Recordatorios automáticos de confirmación |
| Dueño sin visibilidad de cuántos leads entran | Reporte diario automático por WhatsApp |
| Contratar vendedor es caro y riesgoso | Agente IA que trabaja 24/7 por fracción del costo |

---

## Infraestructura y Stack

| Componente | Plataforma | Detalle |
|-----------|-----------|---------|
| **Automatización / Workflows** | n8n Cloud | `avaxon2938409.app.n8n.cloud` |
| **Canal de mensajería** | WhatsApp Cloud API (Meta) | Conectado vía n8n webhook |
| **IA / LLM** | OpenAI GPT-4o | Motor del chatbot y análisis |
| **Memoria de conversación** | n8n Simple Memory | Por número de teléfono |
| **CRM / Leads** | Google Sheets | Captura estructurada por cliente |
| **Agendamiento** | Google Calendar API | Sincronización de citas |
| **Infraestructura** | n8n Cloud | Sin self-host, estable desde día 1 |

---

## Planes y Precios (MXN)

### Planes disponibles

| Plan | Setup | Mensualidad | Incluye | Ideal para |
|------|-------|------------|---------|-----------|
| **Básico** | $3,000 | $1,500 | Chatbot 24/7 + calificación de leads + Google Sheets | Negocios chicos que quieren empezar |
| **Estándar** | $5,000 | $2,500 | Básico + seguimiento automático + agendamiento Google Calendar | Negocios con flujo de citas o leads constante |
| **Completo** | $8,000 | $3,500 | Estándar + reporte diario al dueño + manejo de imágenes/audio con IA + personalización avanzada | Negocios con mayor volumen y proceso de venta más complejo |

> **Nota:** Todos los planes incluyen 1 semana de prueba + ajustes post go-live. La mensualidad cubre mantenimiento, mejoras al agente y soporte.

### Modelo de ingreso por cliente (Completo)

| Concepto | Monto |
|----------|-------|
| Setup único | $8,000 MXN |
| Mensualidad × 12 meses | $42,000 MXN |
| **Total anual por cliente** | **$50,000 MXN** |

---

## Servicios Principales

### 1. Chatbot de Ventas y Atención 24/7
Agente IA entrenado con el catálogo, precios, FAQs y tono del negocio. Atiende prospectos en cualquier momento, responde preguntas frecuentes y detecta intención de compra.

### 2. Calificación de Leads
El agente identifica automáticamente: nombre, necesidad, presupuesto y timeline del prospecto. Registra todo en Google Sheets con estatus y fecha.

### 3. Agendamiento de Citas
El agente recopila disponibilidad del prospecto y confirma citas. Sincronización con Google Calendar del negocio + recordatorio automático previo a la cita.

### 4. Seguimiento Automático
Secuencias de mensajes para leads que no respondieron o quedaron fríos. El agente reactiva conversaciones sin intervención humana.

### 5. Reporte Diario al Dueño
Resumen automático enviado cada mañana por WhatsApp: leads capturados, citas agendadas, conversaciones activas, métricas clave.

### 6. Manejo de Media con IA (Plan Completo)
El agente procesa imágenes y audios enviados por el cliente. Útil para negocios que reciben fotos de productos, órdenes de trabajo o comprobantes.

---

## El Vendedor Digital — 4 Niveles de IA

Avaxon implementa agentes de forma progresiva según las necesidades del cliente:

| Nivel | Nombre | Comportamiento |
|-------|--------|---------------|
| **0** | Chatbot | Responde FAQs, califica leads, transfiere a humano cuando lo necesita |
| **1** | Asistente | Sugiere respuestas al agente humano (el humano envía, la IA propone) |
| **2** | Aprendiz | Redacta la respuesta, el dueño aprueba antes de enviar |
| **3** | Autónomo | Responde solo dentro de parámetros configurados, notifica al dueño resúmenes |

> La mayoría de los clientes arrancan en **Nivel 0**. El upgrade de nivel es parte de la evolución natural del servicio y una oportunidad de venta adicional.

---

## Módulos / Add-ons

| Módulo | Estado | Descripción |
|--------|--------|-------------|
| **Chatbot 24/7** | Incluido en todos los planes | Bot que atiende y califica leads automáticamente |
| **Captura de leads (Google Sheets)** | Incluido en todos los planes | Registro estructurado de cada prospecto |
| **Seguimiento de leads fríos** | Plan Estándar y Completo | Secuencias automáticas de reactivación |
| **Agendamiento con Google Calendar** | Plan Estándar y Completo | Citas vía WhatsApp + recordatorios |
| **Reporte diario al dueño** | Plan Completo | Resumen matutino por WhatsApp con métricas |
| **Manejo de imágenes y audio** | Plan Completo | IA procesa media enviada por el cliente |
| **Personalización avanzada** | Plan Completo | Tono, frases, flujos y reglas específicas del negocio |

---

## Industrias que Atendemos

| Industria | Giros |
|-----------|-------|
| **Automotriz** | Refaccionaria, Taller Mecánico, Agencia Automotriz |
| **Salud** | Clínica, Consultorio Dental, Nutriólogo, Veterinaria, Óptica |
| **Belleza** | Salón de Belleza, Spa, Estética |
| **Alimentos** | Restaurante, Cafetería, Panadería, Servicio de Catering |
| **Fitness y Bienestar** | Gimnasio, Yoga/Pilates, Entrenador Personal |
| **Servicios Profesionales** | Despacho Contable, Abogados, Arquitectos, Consultoría |
| **Comercio** | Tienda de Ropa, Mueblería, Ferretería, Electrónica |
| **Educación** | Escuelas, Institutos, Cursos, Tutorías |
| **Inmobiliaria** | Agencias inmobiliarias, Desarrolladores |
| **General** | Cualquier negocio que use WhatsApp como canal de ventas |

---

## Proceso de Onboarding por Cliente

| Paso | Actividad | Responsable | Tiempo |
|------|-----------|-------------|--------|
| **1. Descubrimiento** | Reunión para entender el negocio, FAQs, flujo de ventas y tono | Hector + Luis | 1 sesión |
| **2. Configuración** | System prompt personalizado, Google Sheets, número WhatsApp, flujo en n8n | Luis | 2–3 días |
| **3. Pruebas internas** | Conversaciones de prueba, ajustes al agente | Luis + Hector | 2–3 días |
| **4. Go-live** | Activación con número real del cliente, monitoreo primera semana | Luis + Hector | 7 días |
| **5. Entrega y reporte** | Primer reporte de leads capturados, ajustes finales | Hector | Semana 2 |

---

## Integraciones

| Integración | Uso |
|------------|-----|
| **Meta / WhatsApp Cloud API** | Canal principal de mensajería, recibido y enviado vía n8n |
| **OpenAI GPT-4o** | Motor de IA del chatbot, calificación y análisis de mensajes |
| **Google Sheets** | CRM de leads: captura, estatus y seguimiento |
| **Google Calendar** | Agendamiento y sincronización de citas |
| **n8n Cloud** | Orquestador de todos los workflows y automatizaciones |

---

## Socios

| Nombre | Rol |
|--------|-----|
| **Luis Flores** | Tech Lead — arquitectura, desarrollo de workflows, integraciones API |
| **Hector García** | Operativo — ventas, onboarding de clientes, soporte |
| **Jose Luis** | Estrategia comercial — relaciones con clientes, expansión |

---

## Estado Actual

| Área | Estado |
|------|--------|
| Workflow base en n8n | ✅ Construido y probado |
| Credenciales OpenAI | ✅ Activas con créditos |
| Meta Business Manager | ✅ Creado |
| Número WhatsApp Telcel | 🔄 Pendiente conectar a Meta API |
| Primer cliente activo | ⏳ Target: suplementos deportivos |
| Sitio web Avaxon | ⏳ Pendiente (Next.js + Vercel) |
| Meta Embedded Signup | ⏳ Mes 2–3 |

---

## Modelo de Negocio

- **Servicio:** Agencia (no SaaS) — construimos e implementamos el agente por el cliente
- **Ingresos:** Setup único + mensualidad por mantenimiento y operación
- **Facturación:** RFC personal Luis Flores (RESICO) hasta constituir Avaxon formalmente
- **Pagos:** SPEI / transferencia bancaria

---

## Contacto

- **Web:** (pendiente — avaxon.mx)
- **Email Luis:** floresescobedoluisalberto@gmail.com
- **País:** México 🇲🇽

---

*Documento creado: agosto 2026 — Avaxon*
