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

export type PushDiagnosis = {
  pushEnabled: boolean;
  devices: Array<{
    platform?: string;
    deviceName?: string;
    lastSeenAt?: Date;
    /** What Expo said when it accepted or refused the message. */
    ticket: 'accepted' | 'refused' | 'unreachable';
    /** What the phone makers' push services said when Expo tried to deliver it, if known yet. */
    receipt?: 'delivered' | 'failed' | 'pending';
    error?: string;
    message?: string;
    advice?: string;
  }>;
};

/** Plain-language next step for the errors Expo reports, so a failed test says what to fix. */
function adviceFor(error?: string, message?: string) {
  switch (error) {
    case 'DeviceNotRegistered': return 'The token is no longer valid. Reinstall the app, sign in again and allow notifications.';
    case 'InvalidCredentials': return 'Expo has no valid push credentials for this app. iOS: upload the APNs key in EAS (eas credentials). Android: upload the FCM v1 service-account key in EAS.';
    case 'MismatchSenderId': return 'The Android build uses a different Firebase project than the key uploaded to EAS. Use the same hook-africa project for google-services.json and the FCM key.';
    case 'MessageTooBig': return 'The notification payload is too large.';
    case 'MessageRateExceeded': return 'Too many notifications were sent to this device. Try again shortly.';
    default:
      if (/push security|access token|authoriz|401|403/i.test(String(message))) return 'Expo refused the request: set EXPO_ACCESS_TOKEN on the server (enhanced push security is on for this project).';
      return undefined;
  }
}

/**
 * Sends a real test notification to every active device of one account and reports Expo's answer for each, including the
 * delivery receipt when it arrives within a few seconds. This is the one place a push failure is made visible instead of
 * being swallowed, so "push does not work" can be traced to a missing key, a wrong project or a dead token in one tap.
 */
export async function diagnosePushForUser(userId: string): Promise<PushDiagnosis> {
  const devices = await DeviceToken.find({ userId, isActive: true }).select('expoPushToken platform deviceName lastSeenAt').lean();
  const result: PushDiagnosis = { pushEnabled: pushEnabled(), devices: [] };
  if (!devices.length || !result.pushEnabled) return result;

  const response = await fetch(SEND_URL, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(devices.map((device) => ({
      to: device.expoPushToken,
      title: 'Hook test notification',
      body: 'If you can read this, push notifications work on this device.',
      sound: 'default',
      channelId: 'default',
      priority: 'high',
      data: { type: 'push_test' },
    }))),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => undefined);
  const parsed = response ? ((await response.json().catch(() => ({}))) as { data?: Ticket[]; errors?: Array<{ message?: string }> }) : undefined;
  const tickets = parsed?.data;
  const ids: string[] = [];

  devices.forEach((device, index) => {
    const base = { platform: device.platform, deviceName: device.deviceName, lastSeenAt: device.lastSeenAt };
    const ticket = tickets?.[index];
    if (!ticket) {
      const message = parsed?.errors?.[0]?.message || (response ? `Expo answered ${response.status}` : 'Could not reach Expo');
      result.devices.push({ ...base, ticket: 'unreachable', message, advice: adviceFor(undefined, message) });
    } else if (ticket.status === 'ok') {
      ids[index] = ticket.id;
      result.devices.push({ ...base, ticket: 'accepted', receipt: 'pending' });
    } else {
      result.devices.push({ ...base, ticket: 'refused', error: ticket.details?.error, message: ticket.message, advice: adviceFor(ticket.details?.error, ticket.message) });
      if (ticket.details?.error === 'DeviceNotRegistered') void deactivate(devices[index].expoPushToken);
    }
  });

  // Expo usually has receipts within seconds; ask a few times and report what is known when time runs out.
  const wanted = ids.filter(Boolean);
  for (let attempt = 0; attempt < 3 && wanted.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const receipts = await post<Record<string, Receipt>>(RECEIPTS_URL, { ids: wanted }).catch(() => undefined);
    if (!receipts) continue;
    let pending = 0;
    ids.forEach((id, index) => {
      if (!id) return;
      const entry = result.devices[index];
      const receipt = receipts[id];
      if (!receipt) { pending += 1; return; }
      if (receipt.status === 'ok') entry.receipt = 'delivered';
      else {
        entry.receipt = 'failed';
        entry.error = receipt.details?.error;
        entry.message = receipt.message;
        entry.advice = adviceFor(receipt.details?.error, receipt.message);
      }
    });
    if (!pending) break;
  }
  return result;
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
