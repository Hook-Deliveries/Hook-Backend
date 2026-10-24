import { ScopeType, UserRole } from '@lib/constants';
import { isActiveAccount, isActiveStaffProfile } from '@lib/account-state';
import { Role } from '@models/platform/access.model';
import { StaffProfile } from '@models/platform/operations-accounts.model';
import { User } from '@models/users/user.model';
import { HttpError } from '@utils/http';

export interface AccessContext {
  permissions: string[];
  roleKeys: string[];
  scopeType: ScopeType;
  stateIds: string[];
  hubIds: string[];
}

export async function resolveAccessContext(accountId: string, knownUser?: any): Promise<AccessContext> {
  // `knownUser` (req.user) omits isActive/accountStatus, so re-read from the DB when those fields are absent rather than treating missing as inactive.
  const canTrustKnownUser =
    knownUser && (knownUser.isActive !== undefined || knownUser.accountStatus !== undefined);
  const [user, staff] = await Promise.all([
    canTrustKnownUser ? Promise.resolve(knownUser) : User.findById(accountId).lean(),
    StaffProfile.findOne({ accountId }).lean(),
  ]);
  if (!user || !isActiveAccount(user)) {
    throw new HttpError(401, 'Account is not active', undefined, 'TOKEN_INVALID');
  }
  // Older seeded super-admin accounts may predate StaffProfile; keep recovery authority usable until the next full seed repairs the profile.
  if (!staff && user.role === 'super_admin') {
    const superAdminRole = await Role.findOne({ key: 'SUPER_ADMIN', isActive: true }).lean();
    return {
      permissions: superAdminRole?.permissionKeys || user.permissions || [],
      roleKeys: ['SUPER_ADMIN'],
      scopeType: ScopeType.GLOBAL,
      stateIds: [],
      hubIds: [],
    };
  }
  if (!staff || !isActiveStaffProfile(staff)) {
    throw new HttpError(401, 'Account is not active', undefined, 'TOKEN_INVALID');
  }
  if (user.role === UserRole.SUPER_ADMIN) {
    return {
      permissions: user.permissions || [],
      roleKeys: ['SUPER_ADMIN'],
      scopeType: staff.scopeType as ScopeType,
      stateIds: staff.stateIds || [],
      hubIds: staff.hubIds || [],
    };
  }
  const roles = await Role.find({ _id: { $in: staff.roleIds }, isActive: true }).select('key permissionKeys').lean();
  const roleKeys = roles.map((role) => role.key);
  const permissions = [...new Set(roles.flatMap((role) => role.permissionKeys))];
  return {
    permissions,
    roleKeys,
    scopeType: staff.scopeType as ScopeType,
    stateIds: staff.stateIds || [],
    hubIds: staff.hubIds || [],
  };
}

export function assertPermission(context: AccessContext, permission: string) {
  if (context.roleKeys.includes('SUPER_ADMIN')) return;
  if (!context.permissions.includes(permission)) {
    throw new HttpError(403, 'You do not have permission to perform this action', undefined, 'ACCESS_DENIED');
  }
}

export function assertScope(context: AccessContext, stateId?: string, hubId?: string) {
  if (context.scopeType === ScopeType.GLOBAL) return;
  if (stateId && !context.stateIds.includes(stateId)) {
    throw new HttpError(403, 'The requested state is outside your assigned scope', undefined, 'SCOPE_DENIED');
  }
  if (hubId && !context.hubIds.includes(hubId)) {
    throw new HttpError(403, 'The requested Hub is outside your assigned scope', undefined, 'SCOPE_DENIED');
  }
}

export function scopedFilter<T>(
  context: AccessContext,
  filter: Record<string, unknown> = {},
  selectedStateId?: string,
  selectedHubId?: string,
) {
  assertScope(context, selectedStateId, selectedHubId);
  const scoped = { ...filter } as Record<string, unknown>;
  if (context.scopeType !== ScopeType.GLOBAL) {
    scoped.stateId = selectedStateId || { $in: context.stateIds };
    if (context.scopeType === ScopeType.HUB) {
      scoped.hubId = selectedHubId || { $in: context.hubIds };
    }
  } else {
    if (selectedStateId) scoped.stateId = selectedStateId;
    if (selectedHubId) scoped.hubId = selectedHubId;
  }
  return scoped;
}
