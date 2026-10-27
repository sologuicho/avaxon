// Publicaciones en redes — lógica real de Graph API (Facebook + Instagram).
//
// Un solo lugar para la mecánica de publicar, usado tanto por
// social-publish-now (publicar ahora) como por social-post-scheduler (cron
// de programados/reintentos) -- así la lógica de publicar existe una sola
// vez, nunca duplicada entre los dos triggers.
//
// Fase 3 (actual): post de texto + 1 imagen en Facebook e Instagram.
// Fase 3b (pendiente, NO implementada aquí todavía): carrusel de 2-10
// imágenes -- requiere el flujo de contenedores hijos de Graph API en
// ambas redes, bastante más complejo que 1 imagen. publishToTarget()
// detecta ese caso y deja la fila en 'fallido' con un mensaje claro en
// vez de intentar algo que no está terminado.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { decryptField } from './crypto.ts'

const GRAPH = 'https://graph.facebook.com/v22.0'

type SupabaseClient = ReturnType<typeof createClient>

// Códigos de error de Meta que significan "el token ya no sirve" -- ante
// cualquiera de estos, la cuenta se marca como token_expired/error en vez
// de solo dejar la publicación en fallido, para que el banner de Cuentas
// conectadas / Calendario se entere sin esperar al cron de salud diario.
const TOKEN_ERROR_CODES = new Set([190, 102, 463, 467])
// code 200 = permiso retirado (pages_manage_posts, etc.) -- distinto de un
// token vencido, pero también requiere reconectar.
const PERMISSION_ERROR_CODES = new Set([200, 10])

interface TargetRow {
  id: string
  post_id: string
  organization_id: string
  social_account_id: string
  platform: 'facebook_page' | 'instagram_business'
  attempt_count: number
}

// El caption base es compartido (una sola textarea en el Editor); el CTA a
// WhatsApp se compone distinto por red porque Facebook SÍ hipervincula URLs
// dentro del texto de un post normal, e Instagram NO hipervincula nada en
// el caption -- ahí un link solo se ve como texto plano, no es clickeable.
function composeCaption(
  baseCaption: string,
  platform: 'facebook_page' | 'instagram_business',
  ctaWhatsapp: boolean,
  whatsappNumber: string | null,
): string {
  if (!ctaWhatsapp || !whatsappNumber) return baseCaption
  if (platform === 'facebook_page') {
    return `${baseCaption}\n\nPide por WhatsApp: https://wa.me/${whatsappNumber}`
  }
  // Instagram: sin link real (no es clickeable en el caption), solo texto.
  return `${baseCaption}\n\nEscríbenos al WhatsApp ${whatsappNumber} 📲`
}

async function publishFacebookSingle(
  pageAccessToken: string,
  pageId: string,
  caption: string,
  imageUrl: string | null,
): Promise<{ externalPostId: string }> {
  const path = imageUrl ? `${pageId}/photos` : `${pageId}/feed`
  const body: Record<string, unknown> = imageUrl
    ? { url: imageUrl, caption, published: true }
    : { message: caption }

  const res = await fetch(`${GRAPH}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pageAccessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) {
    throw new GraphApiError(data?.error?.message ?? 'Error desconocido de Facebook', data?.error?.code, data?.error)
  }
  // /photos regresa { id, post_id }; /feed regresa { id }.
  return { externalPostId: data.post_id ?? data.id }
}

async function publishInstagramSingle(
  pageAccessToken: string,
  igUserId: string,
  caption: string,
  imageUrl: string,
): Promise<{ externalPostId: string }> {
  // Paso 1: crear el contenedor de media.
  const createRes = await fetch(`${GRAPH}/${igUserId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pageAccessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: imageUrl, caption }),
  })
  const createData = await createRes.json()
  if (!createRes.ok || !createData.id) {
    throw new GraphApiError(createData?.error?.message ?? 'Error creando el contenedor de Instagram', createData?.error?.code, createData?.error)
  }

  // Paso 2: publicar el contenedor.
  const publishRes = await fetch(`${GRAPH}/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pageAccessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: createData.id }),
  })
  const publishData = await publishRes.json()
  if (!publishRes.ok || !publishData.id) {
    throw new GraphApiError(publishData?.error?.message ?? 'Error publicando el contenedor de Instagram', publishData?.error?.code, publishData?.error)
  }
  return { externalPostId: publishData.id }
}

export class GraphApiError extends Error {
  code?: number
  raw?: unknown
  constructor(message: string, code?: number, raw?: unknown) {
    super(message)
    this.code = code
    this.raw = raw
  }
}

// Publica (o intenta publicar) una fila de social_post_targets. Siempre
// deja la fila en un estado terminal coherente ('publicado' o 'fallido'
// con error_code/error_message) -- nunca la deja a medias. Si el error es
// de token/permiso, además marca social_accounts.status para que el resto
// del dashboard se entere sin esperar al siguiente intento.
export async function publishToTarget(adminClient: SupabaseClient, targetId: string): Promise<void> {
  const { data: target, error: targetErr } = await adminClient
    .from('social_post_targets')
    .select('id, post_id, organization_id, social_account_id, platform, attempt_count')
    .eq('id', targetId)
    .single()
  if (targetErr || !target) throw new Error(`No se encontró social_post_targets ${targetId}`)
  const t = target as TargetRow

  const markFailed = async (message: string, code?: string) => {
    await adminClient.from('social_post_targets').update({
      status: 'fallido',
      error_code: code ?? null,
      error_message: message,
      attempt_count: t.attempt_count + 1,
      last_attempt_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', t.id)
  }

  try {
    const { data: post } = await adminClient
      .from('social_posts')
      .select('caption, cta_whatsapp, organization_id')
      .eq('id', t.post_id)
      .single()
    if (!post) { await markFailed('No se encontró el contenido de la publicación.'); return }

    const { data: media } = await adminClient
      .from('social_post_media')
      .select('public_url, position')
      .eq('post_id', t.post_id)
      .order('position', { ascending: true })

    const { data: account } = await adminClient
      .from('social_accounts')
      .select('platform, external_id, access_token, status')
      .eq('id', t.social_account_id)
      .single()
    if (!account) { await markFailed('No se encontró la cuenta conectada para esta red.'); return }
    if (account.status !== 'connected') {
      await markFailed('La cuenta no está conectada (token expirado o error de permisos). Reconéctala en Cuentas conectadas.', 'account_not_connected')
      return
    }

    if ((media?.length ?? 0) > 1) {
      // Fase 3b (carrusel) todavía no está implementada -- se deja un
      // mensaje honesto en vez de publicar mal o truncar imágenes.
      await markFailed('Esta publicación tiene más de 1 imagen. El carrusel todavía no está implementado (fase 3b).', 'carousel_not_implemented')
      return
    }

    const imageUrl = media?.[0]?.public_url ?? null

    // Número de WhatsApp del negocio para el CTA -- se resuelve del lado
    // del servidor, nunca lo manda el cliente.
    let whatsappNumber: string | null = null
    if (post.cta_whatsapp) {
      const { data: pn } = await adminClient
        .from('phone_numbers')
        .select('display_phone_number')
        .eq('organization_id', t.organization_id)
        .maybeSingle()
      whatsappNumber = pn?.display_phone_number?.replace(/\D/g, '') ?? null
    }

    const caption = composeCaption(post.caption, t.platform, post.cta_whatsapp, whatsappNumber)

    let externalPostId: string
    if (t.platform === 'facebook_page') {
      const r = await publishFacebookSingle(account.access_token, account.external_id, caption, imageUrl)
      externalPostId = r.externalPostId
    } else {
      if (!imageUrl) { await markFailed('Instagram requiere al menos 1 imagen.', 'ig_requires_image'); return }
      const r = await publishInstagramSingle(account.access_token, account.external_id, caption, imageUrl)
      externalPostId = r.externalPostId
    }

    await adminClient.from('social_post_targets').update({
      status: 'publicado',
      external_post_id: externalPostId,
      published_at: new Date().toISOString(),
      attempt_count: t.attempt_count + 1,
      last_attempt_at: new Date().toISOString(),
      error_code: null,
      error_message: null,
      updated_at: new Date().toISOString(),
    }).eq('id', t.id)
  } catch (e) {
    const err = e as GraphApiError
    await markFailed(err.message ?? 'Error desconocido al publicar.', err.code ? String(err.code) : undefined)

    if (err.code && (TOKEN_ERROR_CODES.has(err.code) || PERMISSION_ERROR_CODES.has(err.code))) {
      await adminClient.from('social_accounts').update({
        status: TOKEN_ERROR_CODES.has(err.code) ? 'token_expired' : 'error',
        last_error_code: String(err.code),
        last_error_message: err.message,
        updated_at: new Date().toISOString(),
      }).eq('id', t.social_account_id)
    }
  }
}
