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
- Búsqueda web (re-verificada 2026-11-04, ver changelog oficial): versión
  vigente **Marketing API v26.0** (publicada 2026-07-29; v25.0 publicada
  2026-02-18 sigue activa hasta 2027-02-23; v24.0 expira 2026-11-10). Default
  de `META_MARKETING_API_VERSION` en `_shared/metaAds.ts` (§4) actualizado a
  `'v26.0'`, siempre tomado de `Deno.env` para subir de versión sin tocar
  código cuando Meta retire ésta.
- **Cambio de v26.0 revisado contra los endpoints que este proyecto usa**
  (`graph-api/changelog/version26.0`): no afecta `campaigns`,
  `object_story_id`/`source_instagram_media_id`, ni los campos de
  `delivery_estimate`/`insights` que se leen aquí (`estimate_mau_*`,
  `spend/reach/impressions/clicks/cpc/ctr/actions`). SÍ afecta ad sets con
  categoría especial de Vivienda/Empleo/Crédito ("HEC-F") que no usan
  targeting amplio: Meta exige `targeting_automation.advantage_audience`
  (0/1) explícito en `POST /{ad-account-id}/adsets` o responde
  `ADS_TARGETING__REQUIRE_EXPLICIT_ADVANTAGE_AUDIENCE_FLAG`. Como este
  proyecto permite segmentar por geo/género/idioma (no solo "broad") incluso
  para esas categorías, `buildTargetingSpec` ahora manda ese campo en `0`
  (sin expansión automática) siempre que haya una categoría restringida —
  ver `_shared/metaAds.ts`.
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
7. **Adaptador simulado, `META_ADS_MODE` obligatoria (`mock`/`live`, sin
   default)**: no hay cuenta publicitaria de pruebas real disponible en este
   entorno → `_shared/metaAds.ts` tiene un modo mock determinístico (mismos
   ids/formas de respuesta que la API real, datos falsos) activado por env
   var. `META_ADS_MODE` es obligatoria y solo acepta `"mock"` o `"live"` —
   si falta o tiene otro valor, `getAdsMode()` truena con un error claro
   *antes* de tocar red o cualquier rama mock, para que nunca quede
   ambiguo en qué modo corre un deploy. Todo el flujo (conectar cuenta,
   estimar alcance, crear, activar, pausar, métricas) se construyó y se
   prueba en modo `mock`. Lo que SÍ requiere una cuenta real queda listado en
   §8, no se afirma que funcione contra Meta real porque no se pudo probar.
   El modo mock nunca falla por sí solo, así que para poder probar rechazo de
   Meta/falla parcial con código real (no solo leyendo el código y confiando)
   se agregó un gancho de prueba: si el `object_story_id`/
   `source_instagram_media_id` (que viene de `external_post_id`, dato de
   prueba) contiene el substring `__E2E_MOCK_META_REJECT__`,
   `createAdCreative` lanza un error como si Meta lo hubiera rechazado — así
   el rollback de campaña+adset ya creados se ejercita de verdad. No tiene
   ningún efecto en modo `live`. Ver `_shared/metaAds.ts` y
   `tests/e2e-promociones/`.

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
    no solo advertencia en el wizard). **Además** (encontrado probando RLS de
    verdad contra dos organizaciones reales en local, 2026-11-04): verifica
    que `post_target_id` pertenezca a la MISMA `organization_id` de la fila.
    El RLS por sí solo no lo exige — una sesión de la Org A puede mandar
    `organization_id` correcto (A) con un `post_target_id` que en realidad es
    de la Org B, y ni el `USING`/`WITH CHECK` del RLS ni el FK de
    `post_target_id` (que solo valida que la fila exista, no de quién es) lo
    detectan. `social-ads-create/index.ts` ya validaba esto en la Edge
    Function antes de llamar a Meta, pero sin este trigger esa validación de
    aplicación era la ÚNICA barrera — se agregó esta verificación a nivel de
    base de datos como defensa en profundidad real, verificada insertando la
    fila tramposa directo por SQL (sin pasar por la Edge Function) antes y
    después del fix.

Nada de esto se aplicó con `supabase db push`/`db query --linked` contra la
base real — son archivos para revisión y para aplicar después en un ambiente
de pruebas o tras aprobación.

## 5. Backend

- `_shared/metaAds.ts` — cliente de Marketing API + adaptador mock
  (`META_ADS_MODE=mock`). Expone `createCampaign/createAdSet/createAdCreative/
  createAd/updateAdSet/updateCampaignStatus/deleteNode/getDeliveryEstimate/
  getInsights/listAdAccounts/debugToken`. Versión de API: `META_MARKETING_API_VERSION`
  (default `v26.0`), nunca hardcodeada en otro archivo (se centralizó también
  en `social-ads-connect`, que antes tenía su propio default `v25.0` suelto).
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

**Ronda 1 (2026-11-04)**: sin Deno/Docker preinstalados — se instaló **Deno
2.9.8 vía Homebrew** solo para correr pruebas unitarias reales. No había
stack local de Supabase/Postgres, así que las migraciones nunca se
ejecutaron contra nada, ni local ni prod.

**Ronda 2 (2026-11-05)**: con Docker ya disponible, se montó el stack
completo localmente y se probó de verdad lo que en la ronda 1 solo quedó
documentado como pendiente:

- **Unitarias** (`deno test`): 30 pruebas en `_shared/metaAds_test.ts` +
  `social-ads-create/logic_test.ts` — targeting spec, `object_story_id`
  reusado tal cual, `META_ADS_MODE` obligatoria (truena sin red si falta o es
  inválida), requisito de `targeting_automation.advantage_audience` de la
  v26.0 para categorías HEC-F, idempotencia y coherencia del modo mock.
- **`supabase db reset` real contra Docker local**: el historial de
  migraciones del repo **no es autosuficiente** — `organizations`,
  `profiles`, `is_super_admin()`, `get_my_org_id()` y ~22 migraciones más
  nunca tuvieron DDL real (son archivos "stub for history sync": el cambio
  real se hizo directo en prod vía SQL Editor). Para poder correr
  `db reset` se usó un archivo de prueba local **no commiteado**
  (`00000000000000_test_only_foundation_stub.sql`, creado y borrado dentro
  de esta misma sesión) que reconstruye solo lo mínimo que esta feature
  necesita, aplicado junto con las migraciones reales de
  `publicaciones_redes` y `promocion_publicaciones`. La migración de esta
  feature se confirmó **idempotente** (`db reset` corrido dos veces seguidas,
  mismo resultado).
- **RLS real entre dos organizaciones** (vía `psql`, sesiones con
  `request.jwt.claim.sub` simulando cada usuario): confirmado que una org no
  puede leer ni escribir las conexiones/públicos/promociones/auditoría de la
  otra; que el trigger de dependencia bloquea activar
  `promocion_publicaciones` sin `publicaciones_redes` y lo desactiva en
  cascada; que `social_promotion_audit` solo acepta `INSERT` de
  `service_role`/`super_admin`. **Se encontró y corrigió un hueco real**: el
  RLS por sí solo no impedía que una fila con `organization_id` correcto
  trajera un `post_target_id` de OTRA organización (el FK solo valida que la
  fila exista, no de quién es) — la única barrera era la validación de
  `social-ads-create/index.ts`. Se agregó la verificación también al trigger
  `validate_special_ad_category` en la migración, confirmada con la misma
  fila tramposa antes (pasaba) y después (bloqueada) del fix.
- **E2E con Playwright** (`tests/e2e-promociones/`, instalado como
  devDependency en `tests/e2e-promociones/package.json` para no interferir
  con el `deno check` de las Edge Functions — ver nota en ese archivo) contra
  Edge Functions servidas en local (`supabase functions serve
  --env-file ... --no-verify-jwt`, `META_ADS_MODE=mock`) y una copia del
  dashboard apuntada a Supabase local (no se tocó `dashboard/index.html` para
  esto, solo una copia en un directorio temporal). 16 pruebas, desktop y
  móvil, todas pasando: conectar cuenta (vía `social-ads-connect` en modo
  mock — ver bug corregido abajo), wizard completo de 5 pasos con público
  personalizado e intereses, confirmar y activar, ver la promoción en la
  lista, pausar, reanudar, editar presupuesto (con el `prompt()` nativo),
  duplicar, doble clic en "Confirmar y crear" (no crea una promoción
  duplicada — verificado también a nivel de fila en la base), token vencido
  (banner "necesita atención"), rechazo de Meta con falla parcial real (campaña
  y conjunto ya creados en Meta, el creative falla, rollback, **cero filas
  huérfanas en `social_promotions`** — verificado en la base, no solo en la
  UI), y permisos cruzados entre Org A y Org B desde la UI.
- **Gancho de prueba para simular rechazo de Meta en modo mock**: el modo
  mock nunca falla por sí solo, así que no había manera de ejercitar
  rollback/falla parcial con código real. Se agregó
  `__E2E_MOCK_META_REJECT__` (ver `_shared/metaAds.ts`) — si el
  `object_story_id`/`source_instagram_media_id` de prueba contiene ese
  substring, `createAdCreative` lanza un error como si Meta lo hubiera
  rechazado. Sin efecto en modo `live`.
- **Bug real encontrado y corregido durante las pruebas E2E**:
  `social-ads-connect` hacía el intercambio de token (`fb_exchange_token`)
  con una llamada real a `graph.facebook.com` **incluso en modo mock** — la
  única función de esta feature que rompía la garantía de "modo mock nunca
  toca Meta". Corregido: ahora ese paso también respeta `isMockMode()`.
- **Bug visual real encontrado en las capturas móviles y corregido**: el
  modal del wizard en viewport angosto (`<720px`) forzaba `height:100%`
  siempre, dejando un hueco vacío enorme en pasos con poco contenido (ej.
  paso 2 en modo Automático). Cambiado a un patrón de hoja inferior
  (`align-items:flex-end`, sin `height` forzado) que se ajusta al contenido
  real — confirmado con capturas antes/después.
- **Capturas** (`docs/capturas-promociones/`): login, los 5 pasos del
  wizard, estado "creando…", "promoción creada", lista con datos, estado
  vacío (filtro "Rechazadas"), banner de token vencido, y el rechazo de Meta
  — en desktop y en móvil.
- Lo que **sigue sin poder probarse** (requiere una cuenta real de Meta, no
  hay forma de simularlo de manera honesta): una llamada real a
  `graph.facebook.com` (campañas/adsets/creatives/ads reales, OAuth real vía
  `FB.login`), que `social-ads-metrics-sync` traiga números reales de Meta,
  y confirmar los mínimos de presupuesto reales de Meta contra una cuenta.
  Ver checklist en §8.

## 8. Pendientes manuales / qué falta para ir a producción

1. Meta App Review de los scopes `ads_management`/`ads_read` (y confirmar que
   el objetivo "Mensajes por WhatsApp" exige que la Page del cliente tenga un
   número de WhatsApp vinculado en Business Manager — no hay nada que el
   dashboard pueda resolver por su cuenta ahí, solo avisar).
2. ~~Aplicar las migraciones de §4 en un ambiente real... y correr las
   políticas RLS contra dos organizaciones reales.~~ **Hecho en local
   (2026-11-05)**, con una salvedad importante: se probó contra un
   **esquema mínimo de prueba**, no contra una copia real del esquema de
   producción (que el repo no puede reconstruir solo con sus migraciones —
   ver §7). Falta todavía: aplicar la migración de esta feature en un
   proyecto Supabase real/staging con el esquema de producción completo, y
   repetir ahí las pruebas de RLS entre dos organizaciones reales.
3. Conseguir una cuenta publicitaria de prueba de Meta (sandbox) para probar
   `social-ads-create`/`-activate`/`-estimate` contra la API real, con
   `META_ADS_MODE=live` (la variable es obligatoria: sin ella, o con
   cualquier valor que no sea `mock`/`live`, las funciones truenan sin tocar
   Meta).
4. Variables de entorno nuevas (nombres únicamente en `.env.example`, nunca
   valores): `META_MARKETING_API_VERSION`, `META_ADS_MODE`,
   `META_ADS_APP_ID`, `META_ADS_APP_SECRET` (puede reusar `META_APP_ID`/
   `META_APP_SECRET` ya existentes si la app de Meta es la misma).
5. Checklist de campaña real de bajo presupuesto antes de abrir esto a
   cualquier cliente — ver §11.

## 9. Exportar el esquema real de producción (solo esquema, sin datos ni secretos)

**Esto es una instrucción para que el usuario la corra — no se ejecutó.**
El repo ya está vinculado (`supabase link`) al proyecto `avaxon-prod`
(`wprvjhvtnyibiwpeiusc`), confirmado vía `supabase status` en esta sesión.

### Opción A — Supabase CLI (recomendada, no requiere pegar la contraseña en el comando)

```bash
cd /Users/hectorgarcia/avaxon
supabase db dump --linked --schema public -f /tmp/avaxon_prod_schema_$(date +%Y%m%d).sql
```

- Sin `--data-only`, `db dump` trae **solo DDL** (tablas, funciones, triggers,
  policies, constraints) — nunca filas de datos.
- `--schema public` limita el volcado al esquema `public` (donde viven
  `organizations`, `profiles`, `business_modules`, `social_*`,
  `is_super_admin()`, `get_my_org_id()`, etc.) y deja afuera `auth`/
  `storage`/`realtime`/`vault` — no hace falta tocar esos para esta feature,
  y así el archivo nunca puede incluir nada de `auth.users` ni tokens.
- El CLI va a pedir la contraseña de la base de forma interactiva (no se
  escribe en el comando, no queda en el historial de la shell). Si no la
  tienes a la mano: Supabase Dashboard → el proyecto → Project Settings →
  Database → "Database password" (ahí mismo hay un botón para resetearla si
  se perdió — resetearla no afecta nada en ejecución, solo la credencial).

### Opción B — pg_dump directo (si la CLI da problemas)

```bash
pg_dump "postgresql://postgres:<password>@<host>:5432/postgres" \
  --schema-only --schema=public --no-owner --no-privileges --no-comments \
  -f /tmp/avaxon_prod_schema_$(date +%Y%m%d).sql
```

- `<host>` y el puerto exactos están en Project Settings → Database →
  "Connection string" (usa la que dice "Direct connection" o el pooler en
  modo *session*, no *transaction*, para que `pg_dump` funcione bien).
- **No pegues la URL con la contraseña en el chat.** Si prefieres no
  escribirla en el comando tampoco, omite `:<password>@` de la URL y
  `pg_dump` la va a pedir por `stdin` de forma interactiva.
- `--schema-only` es, por definición, una operación de solo lectura —
  `pg_dump` nunca escribe en la base sin importar las flags.

### Verificar que el archivo no tiene datos ni secretos antes de compartirlo

```bash
grep -c "^COPY " /tmp/avaxon_prod_schema_*.sql   # debe dar 0
grep -i "password\|secret\|token" /tmp/avaxon_prod_schema_*.sql | grep -v "_token\b.*text\|access_token.*text"  # revisar a mano cualquier línea que salga
```

(`--schema-only`/sin `--data-only` nunca trae datos, así que esto es más
una doble verificación que un paso estrictamente necesario.)

### Entregarme el archivo

Como este entorno comparte el mismo sistema de archivos que tu terminal,
con que guardes el dump dentro de `/Users/hectorgarcia/avaxon/` o en
`/tmp/` y me digas la ruta es suficiente — no hace falta pegarlo en el chat
(sería un archivo grande). Ejemplo: guárdalo como
`/tmp/avaxon_prod_schema.sql` y dime "ya está" con esa ruta.

## 10. Comparación contra el historial actual y propuesta de migración base

**No se reescribió nada todavía — esto es una propuesta para decidir.**

### Qué hace el historial actual hoy

`supabase db reset` contra el historial completo del repo truena porque
~23 migraciones (incluida la primera, `001_admin_setup.sql`) son archivos
vacíos "stub for history sync" o dependen de tablas (`organizations`,
`profiles`) que nunca se crearon en ningún migration file — se crearon
directo en prod por SQL Editor. Confirmado en la ronda anterior (§7).

### Qué cambiaría con el volcado de producción (§9)

Una vez que tengamos `avaxon_prod_schema.sql`, la migración base
propuesta sería:

1. Crear `supabase/migrations/00000000000000_baseline_prod_schema.sql` con
   el contenido completo del volcado (ajustado: quitar sentencias que
   `pg_dump`/`db dump` agregan que no aplican a un archivo de migración,
   como `SET` de sesión o comentarios de extensión — revisión manual rápida,
   no automática).
2. Esa única migración reemplazaría, en la práctica, a las ~30 migraciones
   anteriores a ella — pero **no se borran los archivos viejos todavía**;
   se dejan como registro histórico y se documenta en el propio archivo
   nuevo que es un snapshot, no una migración incremental más.
3. A partir de ahí, `supabase db reset` funcionaría de verdad, sin el
   stub temporal que usé en la ronda anterior.

### El riesgo real que esto introduce (por qué no se hace todavía)

Supabase rastrea, **en la base de producción misma**
(`supabase_migrations.schema_migrations`), qué migraciones ya se aplicaron
ahí, por nombre de archivo/versión. Si agrego un archivo nuevo con un
timestamp `00000000000000` (anterior a todo lo que prod ya tiene
registrado), `supabase db push` lo va a ver como **pendiente** la próxima
vez que alguien lo corra contra prod — e intentaría crear de nuevo tablas
que prod ya tiene. La mayoría de los `CREATE TABLE` en este repo usan
`if not exists`, así que probablemente no tronaría, pero no es algo para
confiar a ciegas contra producción.

**El paso que falta antes de adoptar esto** (tampoco se ejecutó, queda
para decidir): marcar la migración base como "ya aplicada" en prod sin
correr su contenido, con:

```bash
supabase migration repair 00000000000000 --status applied --linked
```

Esto le dice a Supabase "esta versión ya está aplicada ahí, no la vuelvas
a correr" — es el mecanismo que la propia documentación de Supabase
recomienda para "adoptar" una base de datos existente en el flujo de
migraciones. Es una operación sobre la tabla de control de migraciones,
no sobre el esquema real — pero toca prod (aunque sea solo metadata), así
que debe decidirse explícitamente, no asumirse.

### Recomendación

Primero correr `scripts/validate-promociones-schema.sh` (§9/§3) contra el
volcado real para confirmar que la migración de esta feature es segura. Con
eso confirmado, decidir en una conversación aparte si vale la pena adoptar
la migración base (afecta a todo el repo, no solo a esta feature) o seguir
usando el patrón de "stub temporal, no commiteado" cada vez que haga falta
probar localmente.

## 11. Orden exacto de pasos hasta la primera prueba en vivo

1. **Exportar el esquema real** (§9) — lo haces tú, fuera de este chat.
2. **Validar la migración de esta feature contra ese esquema**
   (`./scripts/validate-promociones-schema.sh /ruta/al/dump.sql`, §3) — lo
   corro yo una vez que me des la ruta del archivo.
3. **Crear un proyecto Supabase de pruebas/staging** (nunca el de prod) —
   Supabase Dashboard → New Project. Clonar el esquema real ahí (restaurar
   el mismo dump de §9 directo por `psql`, sin pasar por el sistema de
   migraciones) y aplicar únicamente la migración de esta feature con
   `supabase link` apuntando a ese proyecto nuevo + `supabase db push`.
4. **Desplegar las 6 Edge Functions de esta feature** a ese proyecto de
   staging: `supabase functions deploy social-ads-connect social-ads-estimate
   social-ads-create social-ads-activate social-ads-action
   social-ads-metrics-sync --project-ref <ref-de-staging>`.
5. **Configurar variables de entorno** en ese proyecto (Dashboard → Edge
   Functions → Secrets, o `supabase secrets set`): `META_ADS_MODE=live`,
   `META_MARKETING_API_VERSION` (v26.0 o la vigente al momento),
   `META_ADS_MIN_DAILY_BUDGET_MXN`, `META_APP_ID`/`META_APP_SECRET` (puede
   ser la misma app de Meta que ya usa publicaciones-redes),
   `INTEGRATIONS_ENCRYPTION_KEY` (una clave nueva, no reusar la de prod en
   staging).
6. **Activar los módulos** `publicaciones_redes` y `promocion_publicaciones`
   en `business_modules` para una organización de prueba en ese proyecto.
7. **Conectar una cuenta publicitaria real de Meta** de bajo gasto —
   `FB.login` real vía el dashboard apuntado a staging (cambiar
   `SUPABASE_URL`/`EDGE_BASE` temporalmente, igual que en las pruebas E2E de
   esta sesión, nunca commiteado) — confirmar que `account_status`/
   `funding_source_details` se leen bien de una cuenta real.
8. **Promocionar una publicación real** con presupuesto mínimo real (ej.
   $50–100 MXN/día, 1 día de duración) y confirmar que queda **PAUSED** en
   Meta antes de activarla — revisar en Business Manager, no solo en el
   dashboard de Avaxon.
9. **Activar** y confirmar que entra a revisión en Meta de verdad.
10. **Esperar el cron de `social-ads-metrics-sync`** (cada 30 min) y
    confirmar que trae números reales (probablemente 0 al inicio, es
    normal).
11. **Probar pausar/reanudar/editar presupuesto/duplicar** contra la cuenta
    real.
12. Con todo eso confirmado, recién ahí tiene sentido una conversación sobre
    App Review de Meta y abrir esto a un cliente real.

## 12. Pendientes antes de reiniciar la sesión (2026-11-09)

Resumen para la próxima sesión -- nada de esto se ejecutó aquí salvo lo que
se marca explícitamente como hecho.

1. **Objetivo "Mensajes por WhatsApp" bloqueado al boostear un post ya
   publicado.** Probando el objetivo `whatsapp` (`destination_type=WHATSAPP`,
   ver `_shared/metaAds.ts:177-307`) contra la cuenta real en staging, Meta
   rechaza el creative con **"Application does not have the capability"** y,
   en otro intento, **"el contenido no es compatible con el objetivo
   seleccionado"**. Lectura más probable: Click-to-WhatsApp sobre un post
   *existente* (`object_story_id`/`source_instagram_media_id`) es una
   combinación que requiere que la app de Meta tenga aprobado el caso de uso
   de mensajería/anuncios de WhatsApp (App Review), no solo los scopes
   `ads_management`/`ads_read` ya pedidos -- consistente con el prerrequisito
   que ya estaba anotado en §8.1. **Pendiente**: revisar el estado de App
   Review de la app y, si ya está aprobado para otro caso de uso pero no para
   este, confirmar en el changelog/doc de Meta qué permiso o feature
   específico falta (candidatos: `Advanced Access` del scope de WhatsApp,
   o una feature separada para "Click to WhatsApp Ads"). No tiene arreglo de
   código -- es aprobación de Meta.
2. **Objetivo "Tráfico" (`traffic`, `OUTCOME_TRAFFIC`) bloqueado por la misma
   causa.** Mismo par de errores ("Application does not have the
   capability" / contenido no compatible) al intentar boostear el mismo post
   existente con este objetivo. Como `engagement`/`awareness` sí llegaron a
   crear campaña/adset/ad en pruebas previas (ver comentarios con fecha
   2026-11-10 en `_shared/metaAds.ts`), el patrón apunta a que **cualquier
   objetivo que no sea compromiso/reconocimiento puro** sobre un post
   reusado necesita una capability de la app que no está aprobada todavía
   --no necesariamente algo exclusivo de WhatsApp. **Pendiente**: repetir la
   prueba de `traffic` después de resolver (1) para ver si comparten la
   misma causa raíz o son dos bloqueos independientes.
3. **Revisar en prod (solo lectura) la conversación vacía de
   `5218994518537`.** No se tocó -- hay que entrar a Conversaciones en el
   dashboard de prod (nunca escribir/enviar nada ahí) y ver por qué esa
   conversación no tiene mensajes: candidatos a revisar primero son si el
   contacto nunca llegó a tener un mensaje entrante real (fila creada por
   algún flujo de alta sin primer mensaje) o si los mensajes existen en
   `conversations`/`messages` pero el dashboard los está filtrando mal por
   canal (ver `dashboard/index.html:6064,6231`, el fallback
   `channel ?? 'whatsapp'`).
4. **Verificar si prod tiene el fix de polling de Instagram del 29 oct.**
   El fix es `016b27e` ("espera a que Instagram termine de procesar el
   contenedor antes de publicar", PR #3,
   `fix/instagram-publish` → merge `0b11b7a` el 2026-10-29) y **sí está en
   el historial de `origin/main`** (confirmado con
   `git merge-base --is-ancestor 016b27e origin/main`). Lo que NO está
   confirmado es que el *deploy* de Edge Functions en prod incluya ese
   commit -- este repo no tiene ningún workflow de CI que despliegue
   Functions automáticamente al mergear a main (`.github/` no tiene ningún
   workflow con "supabase"/"deploy"), así que estar en `main` no garantiza
   estar desplegado. **Pendiente**: comparar el código fuente desplegado de
   la función de publicación de Instagram en prod (Dashboard → Edge
   Functions → ver código, o `supabase functions download --project-ref
   wprvjhvtnyibiwpeiusc <función>`) contra lo que hay en `main` para ese
   archivo, y si falta, desplegar solo ese fix.
5. **`main` local tiene commits sin publicar en `origin/main` y hace falta
   rebase antes de push.** Confirmado en esta sesión:
   - `origin/main` va en `f56a048` (docs: privacy.html/data-deletion.html).
   - `main` local va en `3995d7a`, con el mismo mensaje de commit que
     `f56a048` pero **otro hash** -- se escribió el mismo contenido de forma
     independiente en los dos lados, así que de verdad divergieron (no es
     un simple adelanto lineal).
   - Debajo de ese commit duplicado, `main` local tiene **2 commits que
     `origin/main` no tiene**: `f6e8548` (fix: Graph API v20.0→v22.0 en
     envío de mensajes de WhatsApp) y `d830a0a` (merge de
     `fix/graph-api-v22-whatsapp` a `main`, local, sin push).
   - **Antes de hacer push**: `git fetch` + `git rebase origin/main` sobre
     `main` local. Al llegar al commit duplicado (`3995d7a`), probablemente
     quede vacío contra `f56a048` y git lo salte solo (o pida `git rebase
     --skip` si no lo detecta como vacío) -- confirmar que el contenido de
     privacy.html/data-deletion.html quede igual que en `origin/main`
     después del rebase, no se asuma. No se ejecutó nada de esto en esta
     sesión.

### Cómo levantar el preview de staging en localhost:8788

```bash
cd /Users/hectorgarcia/avaxon
python3 .staging-setup/serve_staging_preview.py
```

Abre `http://localhost:8788/dashboard/` o `http://localhost:8788/admin/`.
Sirve los archivos del repo tal cual están en disco, pero reescribe al vuelo
(solo en la respuesta HTTP, nunca en el archivo) `SUPABASE_URL`/`SUPABASE_KEY`/
`EDGE_BASE` de `dashboard/index.html`/`admin/index.html` para apuntar al
proyecto de staging (`vfwictrnpzmvlwnslbss`) en vez de prod. `Ctrl+C` para
detenerlo.

**`localhost:8787` no se usa.** Era un proceso viejo (servidor estático
plano, sin este script de reescritura) que por lo tanto servía el dashboard
con el `SUPABASE_URL` que está hardcodeado en el archivo en disco -- es
decir, prod. Ya se mató; si vuelve a aparecer algo corriendo en 8787, no es
este script y probablemente esté pegado a prod, no a staging.
