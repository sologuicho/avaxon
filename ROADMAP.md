# Avaxon — Roadmap 90 Días
*Agosto — Noviembre 2026*

**Equipo activo:** Luis Flores (Tech) · Hector García (Comercial)
**Objetivo:** Primer cliente en vivo → 3–5 clientes pagando → infraestructura para escalar

---

## Fase 1 — Infraestructura Funcional
### Semanas 1–2 · 19 ago – 1 sep

**Meta: el bot funciona de punta a punta con nuestro propio número.**

| # | Tarea | Quién | Estado |
|---|-------|-------|--------|
| 1.1 | Corregir webhook n8n: cambiar `httpMethod` de `ALL` a `POST` | Luis | ⏳ |
| 1.2 | Conectar número Telcel a WhatsApp Cloud API en Meta for Developers | Luis | ⏳ |
| 1.3 | Configurar webhook de Meta apuntando a n8n | Luis | ⏳ |
| 1.4 | Probar flujo completo: mensaje entra → GPT-4o responde → lead se guarda en Sheets | Luis + Hector | ⏳ |
| 1.5 | Preparar template de contrato de prestación de servicios | Hector | ⏳ |
| 1.6 | Agendar junta con contadora (fiscal + estructura legal) | Hector | ⏳ |

**Criterio de éxito:** Enviamos un mensaje por WhatsApp, el bot responde y el lead aparece en Google Sheets.

---

## Fase 2 — Primer Cliente en Vivo
### Semanas 3–6 · 2 sep – 29 sep

**Meta: un cliente real con el bot funcionando en su WhatsApp Business.**

| # | Tarea | Quién | Estado |
|---|-------|-------|--------|
| 2.1 | Reunión de descubrimiento con cliente de suplementos deportivos | Hector | ⏳ |
| 2.2 | Personalizar system prompt: catálogo, precios, tono, FAQs del negocio | Luis | ⏳ |
| 2.3 | Conectar número WhatsApp Business del cliente a n8n | Luis | ⏳ |
| 2.4 | Configurar Google Sheets del cliente para captura de leads | Luis | ⏳ |
| 2.5 | Pruebas internas (3–5 días) antes de go-live | Luis + Hector | ⏳ |
| 2.6 | Go-live + monitoreo primera semana | Luis + Hector | ⏳ |
| 2.7 | Firmar contrato y cobrar setup | Hector | ⏳ |
| 2.8 | Entregar primer reporte de resultados al cliente | Hector | ⏳ |
| 2.9 | Recopilar testimonio y caso de éxito (foto, texto, video corto) | Hector | ⏳ |

**Criterio de éxito:** Cliente pagó el setup, el bot está activo y capturó al menos 10 leads reales.

---

## Fase 3 — Escalar a 3–5 Clientes
### Semanas 7–10 · 30 sep – 27 oct

**Meta: infraestructura para onboardear más clientes rápido y empezar a cobrar mensualidades.**

| # | Tarea | Quién | Estado |
|---|-------|-------|--------|
| 3.1 | Armar blueprints de agente por industria (automotriz, salud, belleza, restaurante, servicios profesionales) | Luis | ⏳ |
| 3.2 | Multi-tenant en n8n: diferenciar clientes por `phone_number_id` en el webhook | Luis | ⏳ |
| 3.3 | Módulo de seguimiento automático de leads fríos (secuencias en n8n) | Luis | ⏳ |
| 3.4 | Módulo de reporte diario al dueño vía WhatsApp (resumen matutino automático) | Luis | ⏳ |
| 3.5 | Outreach activo: 20 negocios contactados por Hector con propuesta | Hector | ⏳ |
| 3.6 | Cerrar 2 clientes adicionales (con contrato y setup cobrado) | Hector | ⏳ |
| 3.7 | Definir proceso de ventas: outreach → demo → propuesta → firma en menos de 72h | Hector | ⏳ |
| 3.8 | Junta con contadora: resultado y definir estructura formal de Avaxon | Hector + Luis | ⏳ |

**Criterio de éxito:** 3 clientes activos pagando mensualidad. Onboarding de nuevo cliente tarda menos de 3 días.

---

## Fase 4 — Producto y Presencia
### Semanas 11–13 · 28 oct – 17 nov

**Meta: sitio web live, proceso de ventas documentado, base para crecer a 10+ clientes.**

| # | Tarea | Quién | Estado |
|---|-------|-------|--------|
| 4.1 | Landing page Avaxon (Next.js + Vercel): propuesta de valor + casos de éxito + CTA | Luis | ⏳ |
| 4.2 | Módulo de agendamiento con Google Calendar (para clientes que lo necesiten) | Luis | ⏳ |
| 4.3 | Dashboard básico de leads por cliente (opcional: Supabase + tabla simple) | Luis | ⏳ |
| 4.4 | Publicar caso de éxito del primer cliente en redes / LinkedIn | Hector | ⏳ |
| 4.5 | Definir pricing final y deck de ventas para demos | Hector | ⏳ |
| 4.6 | Cerrar 2 clientes adicionales (meta: 5 clientes en total) | Hector | ⏳ |
| 4.7 | Revisar y actualizar este roadmap para el siguiente trimestre | Luis + Hector | ⏳ |

**Criterio de éxito:** Sitio live, 5 clientes activos, ingresos mensuales recurrentes > $12,500 MXN.

---

## Resumen de Metas

| Fase | Semanas | Meta clave | Ingresos estimados |
|------|---------|-----------|-------------------|
| 1 — Infraestructura | 1–2 | Bot funcionando end-to-end | $0 |
| 2 — Primer cliente | 3–6 | 1 cliente live + pagando | $3k–$8k setup |
| 3 — Escalar | 7–10 | 3 clientes activos | +$4.5k–$10.5k/mes |
| 4 — Producto | 11–13 | 5 clientes + sitio web | +$7.5k–$17.5k/mes |

---

## Stack Técnico

| Capa | Tecnología |
|------|-----------|
| Automatización | n8n Cloud |
| IA | GPT-4o (OpenAI) |
| Mensajería | WhatsApp Cloud API (Meta) vía n8n |
| Leads | Google Sheets |
| Agendamiento | Google Calendar API |
| Web (Fase 4) | Next.js + Vercel |

---

## Reglas de operación

1. **Un workflow por cliente** — se duplica y personaliza, no es genérico compartido
2. **El canal es WhatsApp vía n8n** — conectado a Meta Cloud API con webhook
3. **Google Sheets es el CRM por ahora** — no hay base de datos propia hasta Fase 4
4. **Facturación bajo RFC de Luis** (RESICO) hasta que la contadora defina la estructura
5. **Cada cliente firma contrato antes de go-live**

---

*Última actualización: agosto 2026 · Próxima revisión: noviembre 2026*
