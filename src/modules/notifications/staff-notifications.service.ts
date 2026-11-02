import { AccountType, ScopeType } from '@lib/constants';
import { User } from '@models/users/user.model';
import { resolveAccessContext, type AccessContext } from '@modules/identity';
import { createCommerceNotification } from '@modules/notifications/commerce-notification.service';

/**
 * The same "SUPER_ADMIN, or has the permission and is in scope" check
 * negotiation alerts use, generalized so any staff-facing event can reuse it
 * instead of hard-coding its own permission/scope logic.
 */
export function canReceiveStaffAlert(access: AccessContext, permission: string, stateId?: string, hubId?: string) {
  if (!access.roleKeys.includes('SUPER_ADMIN') && !access.permissions.includes(permission)) return false;
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
  permission: string;
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
