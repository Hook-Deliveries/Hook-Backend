import { Request } from 'express';
import { PlatformAuditLog } from '@models/platform/audit-log.model';
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
