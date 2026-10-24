import { Request, Response } from 'express';
import { AccountStatus, AccountType, PaymentStatus, UserRole } from '@lib/constants';
import { auditAdminAction } from '@lib/audit';
import { hashPassword } from '@lib/security';
import { HttpError, sendCreated, sendSuccess } from '@utils/http';
import { adminRepos, getPagination, paginated, routeParam } from './admin.helpers';
import { User } from '@models/users/user.model';
import { Order } from '@models/orders/order.model';
import { CustomerAddress } from '@models/commerce/commerce.model';
import { revokeAccountSessions } from '@modules/identity/account-session.service';
import { CreditService } from '@modules/orders/credit.service';

const USER_LIST_FIELDS = 'publicId email phone firstName lastName role accountType accountStatus scopeType assignedStateIds assignedHubIds assignedCategoryIds isEmailVerified isPhoneVerified isActive lastLoginAt createdAt updatedAt';

function searchRegex(value: string) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

function safeUser(user: any) {
  const { _id, ...safe } = user;
  delete safe.password;
  delete safe.refreshToken;
  return { ...safe, id: safe.publicId || safe.id || _id?.toString?.() };
}

export class AdminUsersController {
  private readonly credits = new CreditService();

  list = async (req: Request, res: Response) => {
    const { page, limit, skip } = getPagination(req.query);
    const role = typeof req.query.role === 'string' ? req.query.role : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search.toLowerCase() : undefined;
    const where: Record<string, any> = {};
    if (role) where.role = role;
    if (!role) {
      where.$and = [{
        $or: [
          { accountType: AccountType.CUSTOMER },
          { accountType: { $exists: false }, role: UserRole.SHOPPER },
        ],
      }];
    }
    if (search) {
      const expression = searchRegex(search);
      const searchClause = { $or: [{ email: expression }, { firstName: expression }, { lastName: expression }] };
      if (where.$and) {
        where.$and.push(searchClause);
      } else {
        where.$and = [searchClause];
      }
    }
    const [data, total] = await Promise.all([
      User.find(where).select(USER_LIST_FIELDS).sort({ createdAt: -1 }).skip(skip).limit(limit).lean({ virtuals: true }),
      User.countDocuments(where),
    ]);
    sendSuccess(res, paginated((data as any[]).map(safeUser), total, page, limit));
  };

  customers = async (req: Request, res: Response) => {
    const { page, limit, skip } = getPagination(req.query);
    const search = typeof req.query.search === 'string' ? req.query.search.toLowerCase() : undefined;
    const where: Record<string, any> = {
      $and: [{
        $or: [
          { accountType: AccountType.CUSTOMER },
          { accountType: { $exists: false }, role: UserRole.SHOPPER },
        ],
      }],
    };
    if (search) {
      const expression = searchRegex(search);
      where.$and.push({ $or: [{ email: expression }, { firstName: expression }, { lastName: expression }] });
    }
    const [data, total] = await Promise.all([
      User.find(where).select(USER_LIST_FIELDS).sort({ createdAt: -1 }).skip(skip).limit(limit).lean({ virtuals: true }),
      User.countDocuments(where),
    ]);
    sendSuccess(res, paginated((data as any[]).map(safeUser), total, page, limit));
  };

  detail = async (req: Request, res: Response) => {
    const user = await adminRepos.users().findOne({ where: { id: routeParam(req.params.id) } });
    if (!user) throw new HttpError(404, 'User not found');
    const customerId = user.id;
    const [defaultAddress, spendAgg, recentOrders, creditBalanceMinor] = await Promise.all([
      CustomerAddress.findOne({ customerId, status: 'active' }).sort({ isDefault: -1, createdAt: -1 }).lean(),
      Order.aggregate([
        { $match: { userId: customerId, paymentStatus: PaymentStatus.SUCCESSFUL } },
        { $group: { _id: null, totalSpentMinor: { $sum: '$totalMinor' }, orderCount: { $sum: 1 } } },
      ]),
      Order.find({ userId: customerId })
        .select('publicId orderCode totalMinor status paymentStatus createdAt')
        .sort({ createdAt: -1 })
        .limit(10)
        .lean({ virtuals: true }),
      this.credits.balance(customerId),
    ]);
    sendSuccess(res, {
      ...safeUser(user),
      defaultAddress: defaultAddress || null,
      totalSpentMinor: spendAgg[0]?.totalSpentMinor || 0,
      orderCount: spendAgg[0]?.orderCount || 0,
      recentOrders,
      creditBalanceMinor,
    });
  };

  /** A manual, one-off credit gift with a reason — separate from any order or the waitlist campaign. */
  giftCredit = async (req: Request, res: Response) => {
    const users = adminRepos.users();
    const user = await users.findOne({ where: { id: routeParam(req.params.id) } });
    if (!user) throw new HttpError(404, 'User not found');
    await this.credits.grantAdminCredit({
      userId: user.id,
      amountMinor: req.body.amountMinor,
      reason: req.body.reason,
      actorId: req.user!.sub,
      idempotencyKey: req.body.idempotencyKey,
    });
    await auditAdminAction(req, 'customer.gift_credit', 'user', user.id, { amountMinor: req.body.amountMinor, reason: req.body.reason });
    const creditBalanceMinor = await this.credits.balance(user.id);
    sendSuccess(res, { id: user.id, creditBalanceMinor });
  };

  create = async (req: Request, res: Response) => {
    const users = adminRepos.users();
    const existing = await users.findOne({ where: { email: req.body.email } });
    if (existing) throw new HttpError(400, 'Email already in use');
    const user = await users.save(users.create({
      email: req.body.email,
      password: await hashPassword(req.body.password),
      firstName: req.body.firstName || '',
      lastName: req.body.lastName || '',
      role: req.body.role || UserRole.SHOPPER,
      isActive: true,
      isEmailVerified: true,
    }));
    sendCreated(res, safeUser(user));
  };

  toggle = async (req: Request, res: Response) => {
    const users = adminRepos.users();
    const user = await users.findOne({ where: { id: routeParam(req.params.id) } });
    if (!user) throw new HttpError(404, 'User not found');
    user.isActive = !user.isActive;
    await users.save(user);
    sendSuccess(res, { id: user.id, isActive: user.isActive });
  };

  role = async (req: Request, res: Response) => {
    const users = adminRepos.users();
    const user = await users.findOne({ where: { id: routeParam(req.params.id) } });
    if (!user) throw new HttpError(404, 'User not found');
    user.role = req.body.role;
    await users.save(user);
    sendSuccess(res, { id: user.id, email: user.email, role: user.role });
  };

  /**
   * Reversible: the account is deactivated and flagged for deletion, but
   * every field and every order/address record is kept exactly as-is so an
   * admin (or the customer, if they change their mind) can be restored.
   */
  softDelete = async (req: Request, res: Response) => {
    const users = adminRepos.users();
    const user = await users.findOne({ where: { id: routeParam(req.params.id) } });
    if (!user) throw new HttpError(404, 'User not found');
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) throw new HttpError(400, 'A reason is required to delete this account', undefined, 'VALIDATION_ERROR');
    user.isActive = false;
    user.accountStatus = AccountStatus.DELETION_REQUESTED;
    await users.save(user);
    await revokeAccountSessions(user.id, 'admin_soft_delete', req.user?.sub);
    await auditAdminAction(req, 'customer.soft_delete', 'user', user.id, { reason });
    sendSuccess(res, { id: user.id, accountStatus: user.accountStatus });
  };

  restore = async (req: Request, res: Response) => {
    const users = adminRepos.users();
    const user = await users.findOne({ where: { id: routeParam(req.params.id) } });
    if (!user) throw new HttpError(404, 'User not found');
    user.isActive = true;
    user.accountStatus = AccountStatus.ACTIVE;
    await users.save(user);
    await auditAdminAction(req, 'customer.restore', 'user', user.id, {});
    sendSuccess(res, { id: user.id, accountStatus: user.accountStatus });
  };

  /**
   * Irreversible. The User document and their saved addresses are deleted
   * from the database entirely. Past Orders keep their own customerSnapshot
   * captured at checkout time, so order history still displays correctly —
   * only the live link to an account record is gone, which is the expected
   * result of a real deletion. The client must send the exact confirmation
   * phrase; this is re-validated here rather than trusted from the UI
   * alone, since a destructive action like this must never rely solely on
   * client-side gating.
   */
  hardDelete = async (req: Request, res: Response) => {
    const users = adminRepos.users();
    const user = await users.findOne({ where: { id: routeParam(req.params.id) } });
    if (!user) throw new HttpError(404, 'User not found');
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) throw new HttpError(400, 'A reason is required to permanently delete this account', undefined, 'VALIDATION_ERROR');
    const expectedConfirmation = `DELETE ${user.publicId || user.id}`;
    if (String(req.body?.confirmation || '').trim() !== expectedConfirmation) {
      throw new HttpError(400, `Type "${expectedConfirmation}" exactly to confirm permanent deletion`, undefined, 'VALIDATION_ERROR');
    }
    await revokeAccountSessions(user.id, 'admin_hard_delete', req.user?.sub);
    // Logged before the document is removed — nothing would be left to
    // attach an audit entry to afterward.
    await auditAdminAction(req, 'customer.hard_delete', 'user', user.id, { reason, email: user.email });
    await CustomerAddress.deleteMany({ customerId: user.id });
    await User.deleteOne({ _id: user.id });
    sendSuccess(res, { id: user.id, deleted: true });
  };
}
