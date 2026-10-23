import webpush from 'web-push';
import { DeviceToken } from '@models/notifications/device-token.model';
import { PushTicket } from '@models/notifications/push-ticket.model';
import { WebPushSubscription } from '@models/notifications/web-push-subscription.model';

/**
 * Sends push notifications through Expo's push service and looks after what
 * comes back. Push is always best effort: nothing here may fail the business
 * action that triggered it, and every problem is logged without the token
 * (a push token identifies a person's device).
 */

const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const CHUNK_SIZE = 100; // Expo's documented maximum per request
const REQUEST_TIMEOUT_MS = 10_000;
/** Give Expo and Google time to attempt delivery before asking how it went. */
const RECEIPT_DELAY_MS = 15 * 60_000;

export type PushMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

type Ticket = { status: 'ok'; id: string } | { status: 'error'; message?: string; details?: { error?: string } };
type Receipt = { status: 'ok' } | { status: 'error'; message?: string; details?: { error?: string } };

export const pushEnabled = () => process.env.PUSH_ENABLED !== 'false';

function headers() {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    // With "enhanced push security" on in the Expo dashboard, only requests
    // carrying this token may push to your project's tokens.
    ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}),
  };
}

const CHANNELS = new Set(['orders', 'account', 'credit', 'reminders', 'discovery']);
/** Each notification group has its own Android channel; older app builds only know 'default'. */
const channelFor = (message: PushMessage) => (CHANNELS.has(String(message.data?.group)) ? String(message.data?.group) : 'default');

const chunk = <T>(items: T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

async function post<T>(url: string, body: unknown): Promise<T | undefined> {
  const response = await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    console.warn(`[push] Expo responded ${response.status}`);
    return undefined;
  }
  return ((await response.json()) as { data?: T }).data;
}

/** A token Expo says no longer belongs to a working install: stop sending to it. */
async function deactivate(expoPushToken: string) {
  await DeviceToken.updateMany({ expoPushToken }, { $set: { isActive: false } });
}

function noteError(kind: string, error?: string, message?: string) {
  if (error === 'DeviceNotRegistered') return;
  // InvalidCredentials / MismatchSenderId mean the FCM key or google-services.json is wrong.
  console.warn(`[push] ${kind}: ${error || 'unknown'}${message ? ` - ${message}` : ''}`);
}

export async function sendPushMessages(messages: PushMessage[]) {
  if (!pushEnabled() || !messages.length) return;
  for (const batch of chunk(messages, CHUNK_SIZE)) {
    try {
      const tickets = await post<Ticket[]>(
        SEND_URL,
        batch.map((message) => ({
          ...message,
          sound: 'default',
          // Android: `default` is the channel the app creates at startup, and
          // high priority lets the banner appear while the phone is dozing.
          channelId: channelFor(message),
          priority: 'high',
        })),
      );
      if (!Array.isArray(tickets)) continue;
      const accepted: Array<{ ticketId: string; expoPushToken: string }> = [];
      tickets.forEach((ticket, index) => {
        const token = batch[index]?.to;
        if (!token) return;
        if (ticket.status === 'ok') {
          accepted.push({ ticketId: ticket.id, expoPushToken: token });
          // Development only: proof that Expo accepted the push, since delivery itself is invisible here.
          if (process.env.NODE_ENV !== 'production') console.info(`[push] accepted by Expo for ${token.slice(0, 26)}… (ticket ${ticket.id})`);
        }
        else if (ticket.details?.error === 'DeviceNotRegistered') void deactivate(token);
        else noteError('send rejected', ticket.details?.error, ticket.message);
      });
      if (accepted.length) await PushTicket.insertMany(accepted, { ordered: false }).catch(() => undefined);
    } catch (error) {
      console.warn('[push] send failed', error instanceof Error ? error.message : error);
    }
  }
}

export async function sendPushToUser(userId: string, content: Omit<PushMessage, 'to'>) {
  if (!pushEnabled()) return;
  const devices = await DeviceToken.find({ userId, isActive: true }).select('expoPushToken').lean();
  await sendPushMessages(devices.map((device) => ({ ...content, to: device.expoPushToken })));
}

const vapidConfigured = () => Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
let vapidSet = false;
function ensureVapid() {
  if (vapidSet || !vapidConfigured()) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:support@hook.ng',
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );
  vapidSet = true;
}

/** Browser (Web Push) delivery for staff/Market Associate/Partner accounts — Expo tokens don't apply to a browser tab. */
export async function sendWebPushToUser(userId: string, content: { title: string; body: string; data?: Record<string, unknown> }) {
  if (!pushEnabled() || !vapidConfigured()) return;
  ensureVapid();
  const subscriptions = await WebPushSubscription.find({ userId, isActive: true }).lean();
  if (!subscriptions.length) return;
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify({ title: content.title, body: content.body, data: content.data || {} }),
      );
    } catch (error) {
      const statusCode = (error as { statusCode?: number })?.statusCode;
      // Gone/Not Found: the browser dropped this subscription — stop sending to it.
      if (statusCode === 404 || statusCode === 410) {
        await WebPushSubscription.updateOne({ _id: subscription._id }, { $set: { isActive: false } });
      } else {
        console.warn('[push] web-push send failed', statusCode || (error instanceof Error ? error.message : error));
      }
    }
  }));
}

/** Every existing caller of createCommerceNotification keeps working unchanged and now also reaches staff browsers. */
export async function notifyPush(userId: string, content: Omit<PushMessage, 'to'>) {
  await Promise.all([sendPushToUser(userId, content), sendWebPushToUser(userId, content)]);
}

/**
 * Collects receipts for tickets old enough to have one. This is how dead
 * tokens (uninstalled apps, revoked permission) are found: Expo reports
 * DeviceNotRegistered here, not when the message is sent.
 */
export async function processPushReceipts(limit = 300) {
  if (!pushEnabled()) return { checked: 0, deactivated: 0 };
  const due = await PushTicket.find({ createdAt: { $lte: new Date(Date.now() - RECEIPT_DELAY_MS) } })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();
  let deactivated = 0;
  for (const batch of chunk(due, CHUNK_SIZE)) {
    let receipts: Record<string, Receipt> | undefined;
    try {
      receipts = await post<Record<string, Receipt>>(RECEIPTS_URL, { ids: batch.map((ticket) => ticket.ticketId) });
    } catch (error) {
      console.warn('[push] receipts failed', error instanceof Error ? error.message : error);
    }
    if (!receipts) continue;
    const finished: string[] = [];
    for (const ticket of batch) {
      const receipt = receipts[ticket.ticketId];
      if (!receipt) continue; // not ready yet; asked again next time
      finished.push(ticket.ticketId);
      if (receipt.status === 'ok') continue;
      if (receipt.details?.error === 'DeviceNotRegistered') {
        await deactivate(ticket.expoPushToken);
        deactivated += 1;
      } else {
        noteError('delivery failed', receipt.details?.error, receipt.message);
      }
    }
    if (finished.length) await PushTicket.deleteMany({ ticketId: { $in: finished } });
  }
  return { checked: due.length, deactivated };
}
