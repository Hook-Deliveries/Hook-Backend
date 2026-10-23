import { Notification } from '@models/notifications/notification.model';
import { User } from '@models/users/user.model';
import { definitionFor, renderNotification, type NotificationGroup } from '../notifications/catalog';
import { publishRealtime } from '@modules/platform/realtime.service';
import { sendPushToUser } from '@services/push.service';

export interface NotificationPreferences {
  groups: Record<NotificationGroup, boolean>;
  quietHours: { enabled: boolean; start: string; end: string };
}

/** Customers can switch these off. Order and security notifications cannot be. */
export const SWITCHABLE_GROUPS: NotificationGroup[] = ['credit', 'reminders', 'discovery'];
export const DEFAULT_PREFERENCES: NotificationPreferences = {
  groups: { orders: true, account: true, credit: true, reminders: true, discovery: true },
  quietHours: { enabled: true, start: '21:00', end: '08:00' },
};

export const DAILY_ENGAGEMENT_CAP = Number(process.env.PUSH_DAILY_CAP || 1);
export const WEEKLY_ENGAGEMENT_CAP = Number(process.env.PUSH_WEEKLY_CAP || 3);

/** Nigeria has no daylight saving: Lagos time is always UTC+1. */
const lagosMinutes = (date: Date) => (date.getUTCHours() * 60 + date.getUTCMinutes() + 60) % (24 * 60);
const toMinutes = (value: string) => {
  const [hours, minutes] = value.split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
};

/** True when `date` falls inside the customer's quiet hours (which may cross midnight). */
export function isQuietHour(date: Date, quiet: NotificationPreferences['quietHours']) {
  if (!quiet.enabled) return false;
  const now = lagosMinutes(date);
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

export type DispatchResult = 'sent' | 'deduped' | 'deferred' | 'suppressed' | 'disabled';

export async function getPreferences(userId: string): Promise<NotificationPreferences> {
  const user = (await User.findById(userId).select('preferences').lean()) as { preferences?: { notifications?: Partial<NotificationPreferences> } } | null;
  const saved = user?.preferences?.notifications;
  return {
    groups: { ...DEFAULT_PREFERENCES.groups, ...(saved?.groups || {}), orders: true, account: true },
    quietHours: { ...DEFAULT_PREFERENCES.quietHours, ...(saved?.quietHours || {}) },
  };
}

export async function updatePreferences(userId: string, patch: { groups?: Partial<Record<NotificationGroup, boolean>>; quietHours?: Partial<NotificationPreferences['quietHours']> }) {
  const current = await getPreferences(userId);
  const next: NotificationPreferences = {
    groups: { ...current.groups },
    quietHours: { ...current.quietHours, ...(patch.quietHours || {}) },
  };
  for (const group of SWITCHABLE_GROUPS) {
    if (patch.groups && typeof patch.groups[group] === 'boolean') next.groups[group] = Boolean(patch.groups[group]);
  }
  await User.updateOne({ _id: userId }, { $set: { 'preferences.notifications': next } });
  return next;
}

/** The one way to notify a customer; transactional types always go out, while engagement types are held back by preference, quiet hours, or the daily/weekly cap. */
export async function dispatchNotification(input: {
  type: string;
  userId: string;
  params?: Record<string, string | number | undefined>;
  /** Makes the notification idempotent: the same key never sends twice. */
  eventKey: string;
  data?: Record<string, unknown>;
  now?: Date;
}): Promise<DispatchResult> {
  const definition = definitionFor(input.type);
  const now = input.now || new Date();

  if (definition.priority === 'engagement') {
    const preferences = await getPreferences(input.userId);
    if (!preferences.groups[definition.group]) return 'disabled';
    if (isQuietHour(now, preferences.quietHours)) return 'deferred';
    const day = new Date(now.getTime() - 24 * 3_600_000);
    const week = new Date(now.getTime() - 7 * 24 * 3_600_000);
    const [today, thisWeek] = await Promise.all([
      Notification.countDocuments({ userId: input.userId, priority: 'engagement', pushedAt: { $gt: day } }),
      Notification.countDocuments({ userId: input.userId, priority: 'engagement', pushedAt: { $gt: week } }),
    ]);
    if (today >= DAILY_ENGAGEMENT_CAP || thisWeek >= WEEKLY_ENGAGEMENT_CAP) return 'suppressed';
    if (definition.cooldownHours) {
      const since = new Date(now.getTime() - definition.cooldownHours * 3_600_000);
      const recent = await Notification.exists({ userId: input.userId, type: input.type, pushedAt: { $gte: since } });
      if (recent) return 'suppressed';
    }
  }

  const { title, body } = renderNotification(input.type, input.params);
  const created = await Notification.findOneAndUpdate(
    { eventKey: input.eventKey },
    {
      $setOnInsert: {
        userId: input.userId, title, body, type: input.type, eventKey: input.eventKey, isRead: false,
        group: definition.group, priority: definition.priority, data: { ...(input.params || {}), ...(input.data || {}) },
      },
    },
    { upsert: true, returnDocument: 'after', includeResultMetadata: true },
  );
  if (created.lastErrorObject?.updatedExisting) return 'deduped';

  const notification = created.value as { _id: { toString(): string } };
  publishRealtime({ type: 'notification.created', entityId: input.eventKey, version: 1 }, { accountId: input.userId });
  await sendPushToUser(input.userId, {
    title,
    body,
    data: { type: input.type, group: definition.group, screen: definition.screen, params: { ...(input.params || {}), ...(input.data || {}) }, notificationId: notification._id.toString() },
  }).catch(() => undefined);
  await Notification.updateOne({ _id: notification._id }, { $set: { pushedAt: now } });
  return 'sent';
}
