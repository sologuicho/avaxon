# Promocionar publicaciones (Meta Marketing API)

Rama: `feature/promocionar-publicaciones` (desde `main`). Construido de forma
autónoma, documentando decisiones aquí en vez de pedir OK en cada paso, por
instrucción explícita del usuario. **Nada de esto se aplica a producción**:
migraciones solo como archivos, sin `supabase db push`/`functions deploy`, sin
tokens ni cuentas publicitarias reales, sin gasto real.

## 1. Contexto y qué ya existe

El módulo "Publicaciones en redes" (`feature/publicaciones-redes`, ya **mergeado
a `main` y en producción** — la nota de memoria que decía "solo rama, nunca a
main" está desactualizada, la corrijo en memoria aparte) deja publicar
orgánicamente en una Page de Facebook + una cuenta de Instagram profesional
por organización:

- `social_accounts` — cuenta conectada (token de Page cifrado con
  `_shared/crypto.ts`, formato `encv1:...`).
- `social_posts` / `social_post_media` — contenido (caption + imágenes).
- `social_post_targets` — una fila por (post, red), con `status`
  (`borrador|programado|en_cola|publicado|fallido`) y, cuando ya se publicó,
  `external_post_id`.
- `business_modules` + `module_enabled(org, key)` — flag por organización,
  reforzado en cada política RLS, no solo en el frontend.
- Patrón de Edge Function: JWT del caller → `adminClient` (service-role)
  resuelve `organization_id` desde `profiles`, revalida `module_enabled` a
  mano (defensa en profundidad, no confiar solo en RLS), nunca regresa tokens
  al navegador.

Esta tarea agrega **"Promocionar publicación"**: convertir un
`social_post_target` ya publicado (`status='publicado'`, ya tiene
`external_post_id`) en un anuncio pagado vía la Marketing API de Meta, con
cuenta publicitaria propia de cada cliente (nunca la de Avaxon).

**Hallazgo clave que simplifica todo el diseño**: como ya existe un post
*publicado orgánicamente*, "promocionar" en la Marketing API es literalmente
"anuncio que reusa un post existente" (`object_story_id` /
`source_instagram_media_id` en el creative) — **no** hay que reconstruir
imagen/caption como creative nuevo. Verificado contra la documentación oficial
(ver §2).

## 2. Documentación de Meta consultada (no se asumió nada de memoria)

- `developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/` —
  campos de `POST /act_{id}/campaigns`: `special_ad_categories` es el único
  campo marcado requerido (array; `[]`/`NONE` si no aplica). `status` solo
  acepta `ACTIVE`/`PAUSED` al crear. Objetivos vigentes (outcome-based, v17+):
  `OUTCOME_ENGAGEMENT`, `OUTCOME_AWARENESS`, `OUTCOME_TRAFFIC`,
  `OUTCOME_LEADS`, `OUTCOME_SALES`, `OUTCOME_APP_PROMOTION`. Los legacy
  (`REACH`, `LINK_CLICKS`, `MESSAGES`, etc.) siguen existiendo pero Meta los
  marca deprecados.
- `developers.facebook.com/docs/marketing-api/reference/ad-account/delivery_estimate/`
  — `GET /{ad_account_id}/delivery_estimate?optimization_goal=...&targeting_spec=...&promoted_object=...`
  → `data[]` de nodos `AdCampaignDeliveryEstimate`
  (`estimate_mau_lower_bound`, `estimate_mau_upper_bound`, `estimate_ready`).
  Sin audiencias lookalike inactivas. Nunca garantiza el alcance real — por
  eso el wizard SIEMPRE lo muestra como rango, nunca como promesa.
- `developers.facebook.com/docs/marketing-api/reference/ad-creative/` —
  para anunciar un post YA publicado: **`object_story_id`** con formato
  `"<PAGE_ID>_<POST_ID>"` (Facebook) o **`source_instagram_media_id`**
  (Instagram, solo el id de medio). No se manda `object_story_spec` en este
  caso (eso es solo para creatives nuevos). Confirma que
  `social_post_targets.external_post_id` ya guardado por el publish orgánico
  (ver `_shared/socialPublish.ts:79,166` — para FB es `data.post_id ?? data.id`,
  ya viene como `pageid_postid`; para IG es el id de media tal cual) sirve
  **sin transformación** como valor de estos campos.
- Búsqueda web (nov 2026): versión vigente **Marketing API v25.0** (anunciada
  2026-02-18), v26 en camino. Por eso la versión **nunca se hardcodea**: ver
  `META_MARKETING_API_VERSION` en `_shared/metaAds.ts` (§4), default `'v25.0'`
  pero siempre tomado de `Deno.env`, igual de fácil de subir a v26 sin tocar
  código cuando Meta lo retire.
- No se encontró endpoint "click to WhatsApp" documentado con una URL estable
  en esta búsqueda — queda anotado como **objetivo con prerrequisito manual**
  (§8), no implementado a ciegas.

## 3. Decisiones de diseño (no se reabren sin razón)

1. **Nuevo módulo propio `promocion_publicaciones`**, dependiente de
   `publicaciones_redes` (mismo patrón trigger-cascada que
   `reports`/`commissions` dependen de `income` en el feature de
   ingresos) — no se reutiliza el flag existente. Razón: involucra gasto real
   de dinero del cliente y una cuenta publicitaria separada; un negocio con
   "Publicaciones en redes" activo no debe heredar automáticamente la
   capacidad de gastar en ads sin que Avaxon lo active a propósito.
2. **Cuenta publicitaria = la del cliente, siempre.** `social_ad_connections`
   guarda el token (cifrado) y el `ad_account_id` elegido por el propio
   cliente durante el OAuth. Nunca hay fallback a una cuenta de Avaxon — si
   no hay cuenta publicitaria conectada y con método de pago, el flujo se
   detiene con un mensaje claro, no intenta "ayudar" con otra cuenta.
3. **Todo se crea en `PAUSED`** (campaña + conjunto + anuncio) y una llamada
   separada (`social-ads-activate`, paso explícito tras el resumen de
   confirmación) lo pasa a `ACTIVE`. Esto es requisito explícito del usuario
   y además es político de seguridad: ninguna llamada de creación puede
   terminar gastando dinero por sí sola.
4. **Idempotencia**: cada intento de creación manda un `idempotency_key`
   (hash de `post_target_id + nonce` generado client-side una vez al abrir el
   wizard, reenviado igual en reintentos/doble-click) — `social_promotions`
   tiene `unique(idempotency_key)`. Si la fila ya existe, la función regresa
   esa fila en vez de crear otra campaña en Meta.
5. **Limpieza si falla un paso**: campaña→conjunto→creative→anuncio se crean
   en ese orden; si un paso falla, se borra (`DELETE`) lo ya creado en Meta
   antes de responder error, y la fila de `social_promotions` queda en
   `error` con el motivo — nunca se deja un conjunto de anuncios huérfano sin
   registro.
6. **Métricas**: snapshot diario (`social_promotion_metrics`, una fila por
   promoción por día) vía cron, más `social_promotions` guarda el acumulado
   más reciente para que la lista no tenga que agregar on-the-fly.
7. **Adaptador simulado (`META_ADS_MODE=mock`)**: no hay cuenta publicitaria
   de pruebas real disponible en este entorno → `_shared/metaAds.ts` tiene un
   modo mock determinístico (mismos ids/formas de respuesta que la API real,
   datos falsos) activado por env var. Todo el flujo (conectar cuenta,
   estimar alcance, crear, activar, pausar, métricas) se construyó y se
   prueba en este modo. Lo que SÍ requiere una cuenta real queda listado en
   §8, no se afirma que funcione contra Meta real porque no se pudo probar.

## 4. Esquema nuevo (migraciones, archivos únicamente)

- `supabase/migrations/<ts>_promociones_meta_schema.sql`:
  - Amplía el check de `business_modules.module_key` para incluir
    `'promocion_publicaciones'`.
  - Trigger de dependencia: bloquea activar `promocion_publicaciones` si
    `publicaciones_redes` no está activo para esa org; si se desactiva
    `publicaciones_redes`, desactiva `promocion_publicaciones` en cascada
    (mismo patrón que income→reports/commissions).
  - `social_ad_connections(organization_id unique, ad_account_id, ad_account_name,
    currency, business_id, access_token[cifrado], status, last_error_*,
    connected_by, connected_at, token_expires_at)`.
  - `social_audiences(organization_id, name, spec jsonb, created_by, created_at)`
    — públicos guardados ("Automático" nunca se guarda, solo los
    personalizados con nombre).
  - `social_promotions(id, organization_id, post_target_id→social_post_targets,
    idempotency_key unique, objective, audience_mode('auto'|'custom'),
    audience_spec jsonb, saved_audience_id→social_audiences null,
    budget_mode('daily'|'lifetime'), budget_amount numeric, currency,
    start_time, end_time, placements('auto'|'facebook'|'instagram'),
    special_ad_categories text[] default '{}', status(
    'borrador'|'en_revision'|'activa'|'pausada'|'rechazada'|'error'|'finalizada'),
    rejection_reason, meta_campaign_id, meta_adset_id, meta_ad_id,
    meta_creative_id, estimate_lower, estimate_upper, spend_total,
    reach_total, impressions_total, clicks_total, messages_total,
    created_by, created_at, updated_at)`.
  - `social_promotion_metrics(id, promotion_id, date, spend, reach,
    impressions, clicks, cpc, ctr, messages, synced_at,
    unique(promotion_id, date))`.
  - `social_promotion_audit(id, promotion_id, organization_id, action, actor_id,
    detail jsonb, created_at)` — log de crear/pausar/reanudar/editar/duplicar/
    activar, para soporte y para que un cliente no pueda negar que apretó
    "Activar".
  - RLS: mismo patrón `(is_super_admin() OR organization_id = get_my_org_id())
    AND module_enabled(organization_id, 'promocion_publicaciones')` en todas
    salvo `social_promotion_audit`, que además es **solo-lectura** para el
    negocio (`INSERT` solo vía service-role desde las Edge Functions) para
    que no pueda manipular su propio registro de auditoría.
  - Trigger `validate_special_ad_category` (`BEFORE INSERT OR UPDATE` en
    `social_promotions`): si `special_ad_categories` no es `{}`, exige que
    `audience_spec` no tenga `age_min < 18` cuando la categoría sea
    `EMPLOYMENT|HOUSING|CREDIT` (edad mínima real exigida por Meta en esas
    categorías) y bloquea `custom audience` por intereses para esas
    categorías (Meta mismo lo restringe; se replica la regla en servidor,
    no solo advertencia en el wizard).

Nada de esto se aplicó con `supabase db push`/`db query --linked` contra la
base real — son archivos para revisión y para aplicar después en un ambiente
de pruebas o tras aprobación.

## 5. Backend

- `_shared/metaAds.ts` — cliente de Marketing API + adaptador mock
  (`META_ADS_MODE=mock`). Expone `createCampaign/createAdSet/createAdCreative/
  createAd/updateAdSet/updateCampaignStatus/deleteNode/getDeliveryEstimate/
  getInsights/listAdAccounts/debugToken`. Versión de API: `META_MARKETING_API_VERSION`
  (default `v25.0`), nunca hardcodeada en otro archivo.
- `supabase/functions/social-ads-connect` — OAuth de cuenta publicitaria
  (scopes `ads_management,ads_read`), `/me/adaccounts` para elegir cuenta,
  detecta `account_status` deshabilitada y `funding_source_details` ausente
  (sin método de pago), explica cómo resolver cada caso en el mensaje de
  error.
- `supabase/functions/social-ads-estimate` — wrapper de `delivery_estimate`
  para el paso 2 del wizard.
- `supabase/functions/social-ads-create` — crea campaña→adset→creative→ad en
  `PAUSED`, idempotente, con limpieza si falla un paso, valida pertenencia +
  `module_enabled` + categoría especial + presupuesto mínimo real de la
  moneda de la cuenta.
- `supabase/functions/social-ads-activate` — el único camino para pasar de
  `PAUSED` a `ACTIVE`, exige confirmación explícita ya hecha en el frontend.
- `supabase/functions/social-ads-action` — pausar/reanudar/editar presupuesto
  o fecha final/duplicar (duplicar = nueva fila `borrador`, no toca la
  original).
- `supabase/functions/social-ads-metrics-sync` — cron, trae insights de cada
  promoción `activa`/`pausada` reciente, upsert en `social_promotion_metrics`
  + refresca acumulados en `social_promotions`, y sincroniza `status` real
  desde Meta (`rechazada`, `finalizada` por fecha de término, etc.).

## 6. Dashboard

- Botón **"Promocionar"** en Historial de Publicaciones, solo en filas
  `status='publicado'`.
- Asistente de 5 pasos (modal propio, reutiliza estilos `card`/`btn-primary`
  existentes): Objetivo → Público → Presupuesto y duración → Ubicaciones y
  vista previa → Confirmación. Rango de alcance siempre mostrado como
  "X – Y personas aprox.", nunca un número único.
- Vista nueva **Promociones** (tab dentro de Publicaciones): tabla con
  estado/gasto/alcance/impresiones/clics/CPC/CTR/mensajes, filtro de fecha,
  gráfica (reusa el patrón SVG de `buildMsgChart`), acciones pausar/reanudar/
  editar/duplicar, motivo de rechazo visible.

## 7. Pruebas

Sin Deno/Docker preinstalados en este entorno — se instaló **Deno 2.9.8 vía
Homebrew** solo para poder correr pruebas reales (no hay stack local de
Supabase/Postgres, así que las migraciones SQL no se ejecutaron contra nada,
ni local ni prod — ver §8).

- `supabase/functions/_shared/metaAds_test.ts` — `deno test`, cubre: modo
  mock devuelve formas válidas, construcción de payloads (objective→mapping,
  special_ad_categories, `object_story_id` reusado tal cual), idempotencia.
- `supabase/functions/social-ads-create/logic_test.ts` — pruebas de la lógica
  pura extraída (validación de presupuesto mínimo, elegibilidad de edad para
  categorías especiales, rollback simulado) sin tocar red ni DB real.
- Lo que **no** se pudo probar end-to-end (requiere cuenta real de Meta o un
  Postgres real): aplicar las migraciones, RLS real entre dos orgs, un
  `social-ads-create` contra `graph.facebook.com` real, que
  `social-ads-metrics-sync` traiga números reales. Ver checklist en §8.

## 8. Pendientes manuales / qué falta para ir a producción

1. Meta App Review de los scopes `ads_management`/`ads_read` (y confirmar que
   el objetivo "Mensajes por WhatsApp" exige que la Page del cliente tenga un
   número de WhatsApp vinculado en Business Manager — no hay nada que el
   dashboard pueda resolver por su cuenta ahí, solo avisar).
2. Aplicar las migraciones de §4 en un ambiente real (local con Docker o un
   proyecto Supabase de pruebas) y correr las políticas RLS contra dos
   organizaciones reales.
3. Conseguir una cuenta publicitaria de prueba de Meta (sandbox) para probar
   `social-ads-create`/`-activate`/`-estimate` contra la API real, con
   `META_ADS_MODE` sin definir (modo real).
4. Variables de entorno nuevas (nombres únicamente en `.env.example`, nunca
   valores): `META_MARKETING_API_VERSION`, `META_ADS_MODE`,
   `META_ADS_APP_ID`, `META_ADS_APP_SECRET` (puede reusar `META_APP_ID`/
   `META_APP_SECRET` ya existentes si la app de Meta es la misma).
5. Checklist de campaña real de bajo presupuesto antes de abrir esto a
   cualquier cliente — ver reporte final.
