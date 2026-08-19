# Avaxon — Roadmap

Agencia de automatización con IA para pequeñas empresas en México.
Conectamos WhatsApp con agentes inteligentes para convertir conversaciones en ventas.

---

## Corto Plazo — Primer Cliente (Semanas 1–4)

**Objetivo: validar que el producto funciona y se vende.**

### Técnico
- [ ] Corregir webhook de n8n: cambiar `httpMethod` de `ALL` a `POST`
- [ ] Probar flujo completo con número de WhatsApp Business propio
- [ ] Confirmar que n8n recibe mensajes, el agente responde y el lead se registra
- [ ] Ajustar el system prompt del agente al negocio del primer cliente
- [ ] Conectar Google Sheets del cliente para captura de leads

### Primer cliente (target: suplementos deportivos)
- [ ] Definir catálogo de productos, precios y política de envíos
- [ ] Onboarding manual: agregar número del cliente en Meta for Developers
- [ ] Entregar bot funcionando en su WhatsApp Business
- [ ] Semana de prueba con clientes reales del negocio
- [ ] Recopilar feedback y ajustar respuestas del agente

### Comercial
- [ ] Precio piloto: cobrar simbólico o gratis a cambio de testimonio y caso de éxito
- [ ] Documentar resultado: cuántos leads capturó, tiempo de respuesta, ventas cerradas

---

## Mediano Plazo — Escalar (Mes 2–3)

**Objetivo: tener infraestructura para onboardear clientes sin intervención manual.**

### Producto
- [ ] Sistema multi-tenant en n8n: un workflow que sirve a múltiples clientes
      diferenciado por `phone_number_id` en el webhook
- [ ] Template de agente parametrizable: system prompt, catálogo y precios por cliente
- [ ] Memoria de conversación persistente (reemplazar buffer por base de datos)
- [ ] Manejo de mensajes de audio, imágenes y botones interactivos

### Sitio web (Next.js + Vercel)
- [ ] Landing page: propuesta de valor, casos de éxito, CTA
- [ ] Página de onboarding con **Embedded Signup de Meta**
      → cliente conecta su WhatsApp Business en 2 minutos sin tocar Meta for Developers
- [ ] Dashboard básico: ver leads capturados por cliente
- [ ] Deploy en Vercel (gratis, conectado a GitHub)

### Meta / WhatsApp
- [ ] Publicar la app de Meta (pasar de Development a Live)
- [ ] Solicitar permiso `whatsapp_business_messaging` en App Review
- [ ] Implementar Embedded Signup para onboarding self-serve

### Comercial
- [ ] Definir pricing: setup fee + mensualidad por cliente
- [ ] Proceso de ventas: outreach → demo → onboarding en 48h
- [ ] 3–5 clientes activos pagando

---

## Stack Actual

| Capa | Tecnología |
|------|-----------|
| Automatización | n8n Cloud |
| IA | GPT-4o via OpenAI API |
| Mensajería | WhatsApp Cloud API (Meta) |
| Leads | Google Sheets |
| Web (próximo) | Next.js + Vercel |

---

## Prioridad Inmediata

1. Bot funcionando end-to-end con número propio
2. Primer cliente en vivo con resultados reales
3. Después: sitio + Embedded Signup para escalar
