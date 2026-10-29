import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const APP_ID     = '2086225228635820';
const APP_SECRET = Deno.env.get('META_APP_SECRET') ?? '';
const SUPA_URL   = Deno.env.get('SUPABASE_URL') ?? '';
const SUPA_SVC   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPA_ANON  = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  try {
    // Verify JWT and get user
    const authHeader = req.headers.get('Authorization') ?? '';
    const userClient = createClient(SUPA_URL, SUPA_ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return json({ ok: false, error: 'No autorizado' }, 401);

    const sb = createClient(SUPA_URL, SUPA_SVC);
    const { data: profile } = await sb.from('profiles').select('organization_id').eq('id', user.id).single();
    if (!profile?.organization_id) return json({ ok: false, error: 'Sin organización' }, 400);
    const orgId: string = profile.organization_id;

    const body = await req.json();
    const shortToken: string = body?.access_token ?? '';
    if (!shortToken) return json({ ok: false, error: 'access_token requerido' }, 400);

    // Exchange short-lived user token → long-lived
    const exRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${encodeURIComponent(shortToken)}`
    );
    const exData = await exRes.json();
    if (!exData.access_token) {
      return json({ ok: false, error: exData.error?.message ?? 'Error al intercambiar token con Meta' }, 400);
    }
    const longToken: string = exData.access_token;

    // Get user pages
    const pagesRes = await fetch(
      `https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token&access_token=${longToken}`
    );
    const pagesData = await pagesRes.json();
    if (!pagesData.data?.length) {
      return json({
        ok: false,
        error: 'No se encontraron páginas de Facebook. Crea una Página y vincúlala con tu cuenta de Instagram Business.',
      }, 400);
    }

    // Find the page that has a linked Instagram Business Account
    let igAccount: Record<string, string> | null = null;
    let connectedPage: Record<string, string> | null = null;

    for (const page of pagesData.data) {
      const igRes = await fetch(
        `https://graph.facebook.com/v21.0/${page.id}?fields=instagram_business_account{id,username,name,profile_picture_url}&access_token=${page.access_token}`
      );
      const igData = await igRes.json();
      if (igData.instagram_business_account?.id) {
        igAccount = igData.instagram_business_account;
        connectedPage = page;
        break;
      }
    }

    if (!igAccount || !connectedPage) {
      return json({
        ok: false,
        error: 'No se encontró una cuenta de Instagram Business vinculada a tus páginas. Ve a Meta Business Suite → Configuración → Cuentas de Instagram.',
      }, 400);
    }

    // Subscribe page to Instagram messaging webhook events
    const subRes = await fetch(
      `https://graph.facebook.com/v21.0/${connectedPage.id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_reads&access_token=${connectedPage.access_token}`,
      { method: 'POST' }
    );
    const subData = await subRes.json();
    if (!subData.success) {
      // Antes esto solo se logueaba y la función seguía de todas formas,
      // mostrando "Conectado" en el dashboard aunque la Página nunca quedó
      // suscrita a los eventos de mensajería -- el bot nunca recibía DMs.
      console.error('instagram-embedded-signup: fallo suscribiendo subscribed_apps:', JSON.stringify(subData));
      return json({
        ok: false,
        error: `No se pudo suscribir la Página a los eventos de mensajería de Instagram: ${subData?.error?.message ?? 'Meta no confirmó la suscripción (subscribed_apps).'}`,
      }, 502);
    }

    // Upsert integration
    const { error: upsertErr } = await sb.from('integrations').upsert({
      organization_id: orgId,
      provider: 'instagram',
      status: 'connected',
      credentials: {
        ig_account_id: igAccount.id,
        username: igAccount.username,
        display_name: igAccount.name,
        page_id: connectedPage.id,
        page_name: connectedPage.name,
        page_access_token: connectedPage.access_token,
        long_lived_user_token: longToken,
      },
      config: {},
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'organization_id,provider' });

    if (upsertErr) return json({ ok: false, error: upsertErr.message }, 500);

    return json({ ok: true, username: igAccount.username, page_name: connectedPage.name });

  } catch (err) {
    console.error('instagram-embedded-signup error:', err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
});
