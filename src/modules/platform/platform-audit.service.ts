import { Request } from 'express';
import { PlatformAuditLog } from '@models/platform/audit-log.model';
import { AccountType } from '@lib/constants';
import { User } from '@models/users/user.model';
import { nextPublicId } from './public-id.service';

const sensitive = /password|token|secret|authorization|otp|code|credential|private.?key/i;

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !sensitive.test(key))
      .map(([key, entry]) => [key, sanitize(entry)]),
  );
}

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string;
  entityPublicId?: string;
  stateId?: string;
  hubId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

export async function recordAudit(req: Request, input: AuditInput) {
  if (!req.user) return;
  await PlatformAuditLog.create({
    publicId: await nextPublicId('audit'),
    actorType: req.user.accountType || 'staff',
    actorId: req.user.sub,
    actorPublicId: req.user.publicId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    entityPublicId: input.entityPublicId,
    stateId: input.stateId,
    hubId: input.hubId,
    before: sanitize(input.before) as Record<string, unknown> | undefined,
    after: sanitize(input.after) as Record<string, unknown> | undefined,
    reason: input.reason,
    requestId: req.requestId || 'unknown',
    ipAddress: req.ip,
    userAgent: req.header('user-agent'),
  });
}

/**
 * Records a staff / operations account signing in, or failing to. Customers are never logged here,
 * and a missing account is ignored, so it can neither flood the log nor reveal which emails exist.
 * Never throws: auditing must not be able to break sign-in.
 */
export async function recordSignInAudit(req: Request, email: string, outcome: 'success' | 'failed', reason?: string) {
  try {
    const account = await User.findOne({ email: String(email || '').toLowerCase().trim(), accountType: { $ne: AccountType.CUSTOMER } })
      .select('publicId accountType firstName lastName')
      .lean() as { _id: unknown; publicId?: string; accountType?: string } | null;
    if (!account) return;
    await PlatformAuditLog.create({
      publicId: await nextPublicId('audit'),
      actorType: account.accountType || 'staff',
      actorId: String(account._id),
      actorPublicId: account.publicId,
      action: outcome === 'success' ? 'auth.sign_in' : 'auth.sign_in_failed',
      entityType: 'account',
      entityId: String(account._id),
      entityPublicId: account.publicId,
      reason,
      requestId: req.requestId || 'unknown',
      ipAddress: req.ip,
      userAgent: req.header('user-agent'),
    });
  } catch (error) {
    console.warn('[audit] could not record sign-in', error instanceof Error ? error.message : error);
  }
}
