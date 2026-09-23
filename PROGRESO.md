# Avaxon — Bitácora de Progreso

Registro compartido entre Luis Flores y Héctor Parra.
**Regla:** cada vez que se haga un avance o quede algo pendiente, agregar una entrada con fecha, nombre y descripción.

---

## Formato de entrada

```
### YYYY-MM-DD — [Nombre]
**Hecho:** ...
**Pendiente:** ...
**Notas:** ...
```

---

## Entradas

### 2026-08-25 — Luis Flores
**Hecho:**
- Meta Business Manager activo, cuenta sin restricciones ("0 issues")
- Héctor Parra agregado como socio con accesos sincronizados
- Número de WhatsApp Business en fase final de verificación en Meta
- Dominio `avaxon.lat` configurado
- Arquitectura técnica definida: n8n Cloud + WhatsApp Cloud API + GPT-4o

**Pendiente:**
1. Generar **System User Token permanente** en Meta Business Suite
   - Scopes requeridos: `whatsapp_business_messaging` + `whatsapp_business_management`
   - Guardar: `PHONE_NUMBER_ID`, `WABA_ID`, `PERMANENT_TOKEN`
2. Configurar credenciales en n8n (WhatsApp Business Cloud credential)
3. Configurar Webhook en Meta Developers apuntando al trigger de n8n
   - Campo a suscribir: `messages`
   - Verify Token: definir uno fijo (ej. `avaxon_webhook_2024`)
4. Probar flujo completo:
   - Enviar mensaje desde celular → n8n recibe payload → GPT-4o responde → Meta envía respuesta

**Notas:**
- Twilio descartado (bundle MX rechazado), se usa Meta API directo
- n8n Cloud en trial: avaxon2938409.app.n8n.cloud
- Facturación bajo RFC personal de Luis (RESICO) hasta formalizar Avaxon como empresa

---

### 2026-09-17 — Héctor Parra (vía Claude Code)

**Hecho:**
- Landing rediseñada (dark mode, mockup de teléfono animado) reconstruida a partir del canvas final de Claude Design
- 3 de las 4 funciones "Próximamente" del panel ya están construidas y desplegadas: lectura de fotos/audio (Vision + Whisper), reactivación de leads fríos y reporte diario (`reactivate-cold-leads`, `daily-report`) — ver detalle técnico en `BLOQUES.md`
- Fusioné mi trabajo con el de Luis en `webhook-wa` (botones interactivos de WhatsApp + manejo de fotos/audio conviven ahora en la misma función)
- Corregí inconsistencia: el mockup del "reporte nocturno" en la landing mostraba números de ejemplo (38 conversaciones, etc.) que no cuadraban con los del panel en vivo justo arriba (2 conversaciones reales). Ahora ambos muestran los mismos datos reales de Supabase.
- Empecé WhatsApp Embedded Signup: cada cliente puede conectar su propio número desde su dashboard (botón "Conectar WhatsApp"), sin pasar por Meta for Developers

**Pendiente — necesito que Luis coordine/confirme esto:**
1. Para el reporte diario automático: ¿a qué número de WhatsApp se debe mandar? (`REPORT_PHONE`, aún no configurado)
2. Verificar en el dashboard de Supabase (Project → Edge Functions) si los cron jobs de `daily-report` y `reactivate-cold-leads` quedaron activos — los configuré vía `supabase/config.toml` pero no tengo forma de confirmarlo desde la CLI
3. Para que el botón "Conectar WhatsApp" funcione, faltan 3 cosas del lado de Meta App Dashboard:
   - `META_CONFIG_ID` (crear una "Embedded Signup configuration" en developers.facebook.com → la App → WhatsApp → Configuración)
   - `META_APP_SECRET` como nuevo secret en Supabase
   - Confirmar que el App ID sigue siendo `2086225228635820`
4. **Corrección de entendimiento sobre "Agenda citas" (Google Calendar):** no es el calendario de Avaxon — cada cliente debe conectar su propio calendario personal, igual que con WhatsApp. Para construir ese flujo se necesita crear un proyecto en Google Cloud Console con credenciales OAuth (Client ID + Secret) — eso todavía no existe y es requisito para poder empezar esa función.

**Notas:**
- Mientras Luis y yo trabajemos en paralelo en el mismo repo, puede haber conflictos de merge (ya pasó una vez con `index.html` y `webhook-wa`) — avisar por aquí antes de hacer cambios grandes ayuda a no pisarnos el trabajo.

---

### 2026-09-23 — Héctor Parra (vía Claude Code)

**Leí `ARQUITECTURA.md` de Luis (muy completo, buen trabajo) y encontré 2 choques con lo que ya construí — hay que coordinar antes de que alguien duplique o rompa lo del otro:**

1. **Nombre de función distinto para lo mismo.** `ARQUITECTURA.md` lista `wa-embedded-signup` como **[PENDIENTE - espera Meta]**. Pero yo ya construí y desplegué esa función con el nombre `whatsapp-embedded-signup` (el 2026-09-17, ver entrada arriba) — botón "Conectar WhatsApp" en el dashboard del cliente + Edge Function que intercambia el código de Meta y guarda el número. Sigue sin poder usarse en producción porque faltan `META_CONFIG_ID` y `META_APP_SECRET` (mismo pendiente #3 de mi entrada anterior), pero el código YA existe. Antes de que Luis la reconstruya desde cero con otro nombre, decidamos cuál se queda.

2. **Modelo de token de WhatsApp distinto.** `ARQUITECTURA.md` documenta el diseño correcto a futuro: cada cliente con su propio `wa_access_token` guardado en `phone_numbers` (multi-tenant real, sección "Riesgos y mitigaciones": *"Token único global para todos los clientes → No escala a multi-tenant"*). Mi función `whatsapp-embedded-signup` y el `webhook-wa` actual usan el token **global** (`WA_ACCESS_TOKEN`, System User de Avaxon) para todos los clientes — el modelo viejo. Si Luis migra a token-por-org (que es lo correcto y ya está documentado como pendiente en su doc), mi función de Embedded Signup necesita actualizarse para leer/guardar el token del cliente en vez de usar el global.

**Pendiente — decisión de Luis:**
- ¿Cuál `wa-*-embedded-signup` se queda? Si es la mía, dime y la renombro/ajusto a como la documentaste; si prefieres la tuya, dime y la borro para no dejar dos versiones sueltas.
- Avísame cuándo migres a token-por-org en `phone_numbers.wa_access_token` para actualizar mi función en consecuencia (hoy rompería si el campo no existe o si `webhook-wa` deja de usar el token global sin que yo lo sepa).
