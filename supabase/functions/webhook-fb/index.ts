import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// Mismo specifier que usan _shared/humanHandoff.ts y webhook-wa (su otro
// consumidor) para createClient -- jsr:@supabase/supabase-js tipaba `sb`
// como un ReturnType distinto y el type-check de flagNeedsHuman fallaba.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHmac } from "node:crypto";
import { parseAgentReply } from "../_shared/agentReply.ts";
import { flagNeedsHuman, notifyOwnerAlert } from "../_shared/humanHandoff.ts";
import { sendFbMessage } from "../_shared/socialSend.ts";
import { getGoogleAccessToken } from "../_shared/google.ts";
import { buildCalendarCtx, buildForcedAvailabilityContext, runAppointmentAgentLoop } from "../_shared/appointmentTools.ts";

const VERIFY_TOKEN = Deno.env.get('META_WEBHOOK_VERIFY_TOKEN') ?? '';
const APP_SECRET   = Deno.env.get('META_APP_SECRET') ?? '';
const OPENAI_KEY   = Deno.env.get('OPENAI_API_KEY') ?? '';
const SUPA_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SUPA_SVC     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// Perfil del remitente vía Graph API -- Messenger (a diferencia de
// Instagram) no expone un username/handle público, solo nombre y foto, y
// solo si la Página tiene los permisos de Messenger Platform vigentes. Si
// falla o viene vacío, se sigue con el nombre genérico; nunca se inventa un
// teléfono ni se bloquea el mensaje por esto.
async function fetchFbProfile(psid: string, pageAccessToken: string): Promise<{ name?: string } | null> {
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${psid}?fields=first_name,last_name&access_token=${encodeURIComponent(pageAccessToken)}`);
    if (!res.ok) {
      console.error('webhook-fb: Graph API rechazó la consulta de perfil:', res.status, await res.text().catch(() => ''));
      return null;
    }
    const data = await res.json();
    const name = [data?.first_name, data?.last_name].filter(Boolean).join(' ').trim();
    return { name: name || undefined };
  } catch (err) {
    console.error('webhook-fb: fallo consultando el perfil del remitente:', err);
    return null;
  }
}


async function handleIncomingMessage(
  sb: ReturnType<typeof createClient>,
  orgId: string,
  pageId: string,
  senderId: string,
  messageText: string,
  externalMsgId: string,
  pageAccessToken: string,
) {
  // 1. Find or create contact -- identificado por (org, canal, PSID), no
  // por teléfono: Messenger no entrega uno real. Antes se guardaba el PSID
  // en `phone` (ej. 'fb:1234567890') y el dashboard lo mostraba formateado
  // como si fuera un número de verdad.
  let { data: contact } = await sb
    .from('contacts')
    .select('id, name')
    .eq('organization_id', orgId)
    .eq('channel', 'facebook')
    .eq('external_id', senderId)
    .maybeSingle();

  if (!contact) {
    const profile = await fetchFbProfile(senderId, pageAccessToken);
    const { data: newContact } = await sb
      .from('contacts')
      .insert({
        organization_id: orgId,
        channel: 'facebook',
        external_id: senderId,
        name: profile?.name || `Messenger ${senderId.slice(-6)}`,
      })
      .select('id, name')
      .single();
    contact = newContact;
  }
  if (!contact) return;

  // 2. Find or create open conversation
  let { data: conv } = await sb
    .from('conversations')
    .select('id, needs_human, human_pause_until')
    .eq('organization_id', orgId)
    .eq('contact_id', contact.id)
    .eq('channel', 'facebook')
    .eq('channel_account_id', pageId)
    .eq('status', 'open')
    .maybeSingle();

  if (!conv) {
    const { data: newConv } = await sb
      .from('conversations')
      .insert({
        organization_id: orgId,
        contact_id: contact.id,
        channel: 'facebook',
        channel_account_id: pageId,
        status: 'open',
        last_message_at: new Date().toISOString(),
      })
      .select('id, needs_human, human_pause_until')
      .single();
    conv = newConv;
  }
  if (!conv) return;

  // 3. Store inbound message
  await sb.from('messages').insert({
    conversation_id: conv.id,
    organization_id: orgId,
    direction: 'inbound',
    content: messageText,
    wa_message_id: externalMsgId,
  });

  await sb.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', conv.id);

  // 4. Skip bot if paused for human
  const pausedUntil = conv.human_pause_until ? new Date(conv.human_pause_until) : null;
  if (conv.needs_human && (!pausedUntil || pausedUntil > new Date())) return;

  // 5. Get bot config
  const { data: botCfg } = await sb
    .from('bot_configs')
    .select('enabled, system_prompt, schedule')
    .eq('organization_id', orgId)
    .maybeSingle();

  if (!botCfg?.enabled) return;

  // 6. Check schedule
  if (botCfg.schedule) {
    const now  = new Date();
    const day  = now.getDay();
    const hour = now.getHours();
    const sched = botCfg.schedule as { days?: number[]; start_hour?: number; end_hour?: number };
    if (sched.days && !sched.days.includes(day)) return;
    if (sched.start_hour !== undefined && hour < sched.start_hour) return;
    if (sched.end_hour !== undefined && hour >= sched.end_hour) return;
  }

  // 7. Build conversation history for OpenAI
  const { data: history } = await sb
    .from('messages')
    .select('direction, content')
    .eq('conversation_id', conv.id)
    .order('created_at', { ascending: true })
    .limit(20);

  const openaiHistory = (history ?? []).map((m) => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.content ?? '',
  }));

  // 7b. Calendario (si la org tiene Google Calendar conectado) -- mismo
  // mecanismo de agenda que ya tenía webhook-wa (ver _shared/appointmentTools.ts),
  // para que el bot pueda consultar disponibilidad y agendar de verdad en
  // vez de solo prometerlo en texto.
  const [{ data: orgProfile }, { data: orgRow }, calendarToken] = await Promise.all([
    sb.from('organization_profile').select('hours').eq('organization_id', orgId).maybeSingle(),
    sb.from('organizations').select('timezone').eq('id', orgId).maybeSingle(),
    getGoogleAccessToken(sb, orgId),
  ]);
  const timezone = orgRow?.timezone || 'America/Matamoros';
  const hours = orgProfile?.hours;
  const hasBusinessHours = Object.values(hours || {}).some((h: any) => h && !h.closed && h.open && h.close);

  const now = new Date();
  const todayLabel = now.toLocaleDateString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: timezone });
  const nowTimeLabel = now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: timezone });
  const fechaHoraCtx = `\n\nFECHA Y HORA ACTUAL: Hoy es ${todayLabel}, son las ${nowTimeLabel} (zona horaria ${timezone}). Usa este dato SIEMPRE para resolver referencias relativas como "hoy", "mañana" o "el viernes" -- nunca asumas o inventes qué día es.`;
  const calendarCtx = buildCalendarCtx({ calendarToken, todayLabel, nowTimeLabel, timezone, hasBusinessHours });
  // Si el cliente solo confirma ("sí", "agéndame") sin repetir fecha/hora,
  // se resuelve contra lo que el bot ya había propuesto -- mismo criterio
  // que usa webhook-wa.
  const lastBotMessage = [...openaiHistory].reverse().find((m) => m.role === 'assistant')?.content || '';
  const forcedAvailabilityCtx = await buildForcedAvailabilityContext({
    combinedText: messageText, lastBotMessage, todayLabel, nowTimeLabel, timezone,
    openaiKey: OPENAI_KEY, calendarToken, hours,
  });

  const systemPrompt = [
    botCfg.system_prompt ?? 'Eres un asistente de atención al cliente.',
    fechaHoraCtx,
    calendarCtx,
    forcedAvailabilityCtx,
  ].filter(Boolean).join('\n\n');

  // 8. Llamar al agente (con las herramientas de agenda si hay calendario)
  const { rawReply, appointmentBooked } = await runAppointmentAgentLoop({
    sb, openaiKey: OPENAI_KEY, model: 'gpt-4o-mini',
    systemPrompt, history: openaiHistory.slice(0, -1), userText: messageText,
    calendarToken, timezone, hours,
    organizationId: orgId, contactId: contact.id, conversationId: conv.id,
    channel: 'facebook',
  });
  if (!rawReply) return;

  // 8b. Parsear la respuesta del agente ({text, buttons, notify_owner}) --
  // misma lógica que usa webhook-wa, nunca se manda el JSON crudo al cliente.
  const { text: replyText, buttons, notifyOwner } = parseAgentReply(rawReply);

  // notify_owner normalmente pausa el bot (needs_human) porque el cliente
  // necesita a una persona -- pero si lo que pasó en este turno fue que el
  // bot YA agendó la cita, notify_owner solo significa "avísale al dueño",
  // no "este cliente necesita a alguien". Pausar ahí dejaría al bot sin
  // poder seguir atendiendo a un cliente que no pidió hablar con nadie.
  if (notifyOwner) {
    if (appointmentBooked) {
      await notifyOwnerAlert(sb, orgId, conv.id, 'Cita agendada', 'El agente agendó una cita para el cliente y marcó notify_owner');
    } else {
      await flagNeedsHuman(sb, conv.id, orgId, 'El agente marcó que el cliente necesita atención');
    }
  }

  // 9. Store outbound message
  const savedContent = buttons.length > 0 ? `${replyText}\n[Botones: ${buttons.join(' | ')}]` : replyText;
  await sb.from('messages').insert({
    conversation_id: conv.id,
    organization_id: orgId,
    direction: 'outbound',
    content: savedContent,
    processed_at: new Date().toISOString(),
  });

  // 10. Send reply via Messenger (quick replies en vez de botones)
  await sendFbMessage(pageAccessToken, senderId, replyText, buttons);
}

// ── Main handler ──────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  // Webhook verification (GET)
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const mode      = url.searchParams.get('hub.mode');
    const token     = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
      return new Response(challenge, { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const rawBody = await req.text();

  // Verify Meta signature
  const sig      = req.headers.get('x-hub-signature-256') ?? '';
  const expected = 'sha256=' + createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
  if (APP_SECRET && sig !== expected) {
    console.warn('Invalid FB webhook signature');
    return new Response('Invalid signature', { status: 401 });
  }

  let body: Record<string, unknown>;
  try { body = JSON.parse(rawBody); } catch { return new Response('OK', { status: 200 }); }

  if (body.object !== 'page') return new Response('OK', { status: 200 });

  const sb = createClient(SUPA_URL, SUPA_SVC);

  for (const entry of (body.entry as Record<string, unknown>[]) ?? []) {
    const pageId = entry.id as string;
    const messagingEvents = (entry.messaging as Record<string, unknown>[]) ?? [];

    // Look up org by Facebook page ID
    const { data: integration } = await sb
      .from('integrations')
      .select('organization_id, credentials')
      .eq('provider', 'facebook_messenger')
      .eq('status', 'connected')
      .filter('credentials->>page_id', 'eq', pageId)
      .maybeSingle();

    if (!integration) continue;

    const orgId: string = integration.organization_id;
    const pageAccessToken: string = (integration.credentials as Record<string, string>).page_access_token;

    for (const event of messagingEvents) {
      const msg = event.message as Record<string, unknown> | undefined;
      if (!msg || msg.is_echo) continue;
      const text = msg.text as string | undefined;
      if (!text) continue;

      const senderId = (event.sender as Record<string, string>)?.id;
      const msgId    = msg.mid as string;

      await handleIncomingMessage(sb, orgId, pageId, senderId, text, msgId, pageAccessToken);
    }
  }

  return new Response('OK', { status: 200 });
});
