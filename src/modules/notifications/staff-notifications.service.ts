import { AccountType, ScopeType } from '@lib/constants';
import { User } from '@models/users/user.model';
import { resolveAccessContext, type AccessContext } from '@modules/identity';
import { createCommerceNotification } from '@modules/notifications/commerce-notification.service';
import { StaffNotificationCursor } from '@models/notifications/staff-notification-cursor.model';
import { STAFF_RULES, type StaffEvent } from '@modules/notifications/staff-notification-rules';

/**
 * The same "SUPER_ADMIN, or has the permission and is in scope" check
 * negotiation alerts use, generalized so any staff-facing event can reuse it
 * instead of hard-coding its own permission/scope logic.
 */
export function canReceiveStaffAlert(access: AccessContext, permission: string | string[], stateId?: string, hubId?: string) {
  const wanted = Array.isArray(permission) ? permission : [permission];
  if (!access.roleKeys.includes('SUPER_ADMIN') && !wanted.some((entry) => access.permissions.includes(entry))) return false;
  if (access.scopeType === ScopeType.GLOBAL) return true;
  if (!stateId || !access.stateIds.includes(stateId)) return false;
  return access.scopeType !== ScopeType.HUB || Boolean(hubId && access.hubIds.includes(hubId));
}

/**
 * Notifies every active staff account that holds `permission` (or SUPER_ADMIN)
 * and is in scope for `stateId`/`hubId`. Each recipient gets their own
 * idempotent notification (`eventKeyPrefix:accountId`), so a retried caller
 * never double-notifies. Best-effort: a failure notifying one admin does not
 * stop the others, and never throws back to the caller's business action.
 */
export async function notifyStaffByPermission(input: {
  /** One permission, or several: holding any of them is enough. */
  permission: string | string[];
  stateId?: string;
  hubId?: string;
  eventKeyPrefix: string;
  title: string;
  body: string;
  type: string;
  data?: Record<string, unknown>;
}) {
  try {
    const admins = await User.find({ accountType: AccountType.STAFF }).select('_id').lean();
    await Promise.all(admins.map(async (admin) => {
      const accountId = admin._id.toString();
      try {
        const access = await resolveAccessContext(accountId);
        if (!canReceiveStaffAlert(access, input.permission, input.stateId, input.hubId)) return;
        await createCommerceNotification({
          eventKey: `${input.eventKeyPrefix}:${accountId}`,
          userId: accountId,
          title: input.title,
          body: input.body,
          type: input.type,
          data: input.data,
        });
      } catch {
        // One admin's stale/inactive account must not stop the others from being notified.
      }
    }));
  } catch (error) {
    console.warn('[staff-notifications] delivery failed', error instanceof Error ? error.message : error);
  }
}

/** Notifies one non-staff account (Market Associate, Partner, or Customer). Idempotent when `eventKey` is passed; otherwise generates a one-off key. */
export async function notifyAccount(accountId: string, title: string, body: string, type: string, data?: Record<string, unknown>, eventKey?: string) {
  await createCommerceNotification({
    eventKey: eventKey || `${type}:${accountId}:${Date.now()}`,
    userId: accountId,
    title,
    body,
    type,
    data,
  });
}

const CATCH_UP_DAYS = 14;
// Nothing is re-read across syncs: live alerts cover the moment itself, and re-reading would bring back what an admin just cleared.
const OVERLAP_MS = 0;
const MIN_GAP_MS = 60_000;
const lastRun = new Map<string, number>();
const running = new Map<string, Promise<number>>();

async function catchUp(accountId: string): Promise<number> {
  const startedAt = new Date();
  const access = await resolveAccessContext(accountId);
  const cursor = await StaffNotificationCursor.findOne({ accountId }).lean() as { syncedUntil: Date; rules: string[] } | null;
  const firstLook = new Date(startedAt.getTime() - CATCH_UP_DAYS * 24 * 60 * 60_000);
  const isSuper = access.roleKeys.includes('SUPER_ADMIN');
  const permitted = STAFF_RULES.filter((rule) => isSuper || [rule.permission].flat().some((entry) => access.permissions.includes(entry)));
  let created = 0;
  for (const rule of permitted) {
    // A rule the account could not see at the last sync (a new role, a new permission) is caught up from scratch.
    const known = cursor?.rules.includes(rule.key);
    const since = known && cursor ? new Date(cursor.syncedUntil.getTime() - OVERLAP_MS) : firstLook;
    let events: StaffEvent[] = [];
    try { events = await rule.collect(since); } catch (error) { console.warn(`[staff-notifications] ${rule.key} catch-up failed`, error instanceof Error ? error.message : error); continue; }
    for (const event of events) {
      if (!canReceiveStaffAlert(access, rule.permission, event.stateId, event.hubId)) continue;
      const result: any = await createCommerceNotification({
        eventKey: `${event.eventKeyPrefix}:${accountId}`, userId: accountId, title: event.title, body: event.body, type: event.type, data: event.data, silent: true, at: event.at,
      }).catch(() => undefined);
      if (result && new Date(result.createdAt || 0).getTime() >= startedAt.getTime() - 1000) created += 1;
    }
  }
  await StaffNotificationCursor.updateOne({ accountId }, { $set: { syncedUntil: startedAt, rules: permitted.map((rule) => rule.key) } }, { upsert: true });
  return created;
}

/**
 * Sends a staff account the notifications it missed: events its permissions cover that happened while
 * it was offline, before it had the permission, or before the account existed (up to 14 days back).
 * Safe to call often: it throttles itself, and every notification is keyed per event and account, so
 * nothing the live alerts already delivered is repeated and nothing the admin cleared comes back.
 */
export function syncStaffNotifications(accountId: string, options: { force?: boolean } = {}): Promise<number> {
  const existing = running.get(accountId);
  if (existing) return existing;
  if (!options.force && Date.now() - (lastRun.get(accountId) || 0) < MIN_GAP_MS) return Promise.resolve(0);
  const job = catchUp(accountId)
    .catch((error) => { console.warn('[staff-notifications] catch-up failed', error instanceof Error ? error.message : error); return 0; })
    .finally(() => { lastRun.set(accountId, Date.now()); running.delete(accountId); });
  running.set(accountId, job);
  return job;
}

/** Sends one lifecycle event to every staff account whose permissions cover it. */
export function emitStaffEvent(event: StaffEvent, permission: string | string[]) {
  return notifyStaffByPermission({
    permission, stateId: event.stateId, hubId: event.hubId, eventKeyPrefix: event.eventKeyPrefix,
    title: event.title, body: event.body, type: event.type, data: event.data,
  });
}
