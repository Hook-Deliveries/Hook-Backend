import { NextFunction, Request, Response } from 'express';
import { HttpError } from '@utils/http';

/**
 * All granular permission keys — mirrors hook-admin/lib/permissions.ts exactly.
 */
export type Permission =
  | 'orders.view'   | 'orders.edit'   | 'orders.create'
  | 'products.view' | 'products.review' | 'products.edit'
  | 'customers.view' | 'customers.edit'
  | 'runners.view' | 'runners.manage'
  | 'financials.view'
  | 'financials.refund' | 'financials.reconcile'
  | 'refunds.view' | 'refunds.manage'
  | 'deletions.view' | 'deletions.manage'
  | 'reports.view'
  | 'ai_negotiation.view'
  | 'settings.view'
  | 'coupons.view'
  | 'coupons.manage'
  | 'credits.view'
  | 'credits.adjust'
  | 'waitlist.view'
  | 'waitlist.manage'
  | 'communications.send'
  | 'faq.view'
  | 'faq.manage'
  | string;

/**
 * requirePermission(perm)
 *
 * Permissions are resolved from active Role records on every authenticated
 * request. Legacy User role enums are not authorization grants.
 *
 * Must be used AFTER requireAuth + requireAdmin.
 */
export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) return next(new HttpError(401, 'Authentication required'));

    if (user.roleKeys?.includes('SUPER_ADMIN')) {
      return next();
    }
    if (user.accountType === 'staff' && user.permissions.includes(permission)) {
      return next();
    }
    return next(new HttpError(403, `Permission denied: ${permission}`, undefined, 'ACCESS_DENIED'));
  };
}

/**
 * Passes when the staff member holds ANY of the listed permissions. For shared
 * utility endpoints — image upload, say — that several unrelated areas need:
 * gating those on one area's permission locks every other area out of it.
 */
export function requireAnyPermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) return next(new HttpError(401, 'Authentication required'));

    if (user.roleKeys?.includes('SUPER_ADMIN')) return next();
    if (user.accountType === 'staff' && permissions.some((permission) => user.permissions.includes(permission))) {
      return next();
    }
    return next(new HttpError(403, `Permission denied: one of ${permissions.join(', ')}`, undefined, 'ACCESS_DENIED'));
  };
}
