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
