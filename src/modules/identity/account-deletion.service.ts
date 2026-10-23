import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { adminAppBaseUrl } from '@modules/notifications';
import mongoose from 'mongoose';
import { AccountStatus, AccountType, UserRole } from '@lib/constants';
import { comparePassword, hashPassword } from '@lib/security';
import { EmailService } from '@emails/email.service';
import { Otp } from '@models/auth/otp.model';
import { CommerceOrderStatus } from '@lib/constants';
import { Order } from '@models/orders/order.model';
import { RefundRequest } from '@models/orders/refund-request.model';
import { FulfilmentRefund, ReturnRequest } from '@models/fulfilment/fulfilment.model';
import { DeviceToken } from '@models/notifications/device-token.model';
import {
  AccountDeletionRequest,
  LIVE_DELETION_STATUSES,
} from '@models/support/account-deletion-request.model';
import { User } from '@models/users/user.model';
import { revokeAccountSessions } from '@modules/identity/account-session.service';
import { HttpError, isDuplicateKeyError } from '@utils/http';

/**
 * Customer-initiated account deletion: verify ownership, refuse while money or
 * goods are in motion, schedule erasure after a cooling-off window, and let the
 * customer cancel at any point before erasure starts. The erasure itself lives
 * in account-erasure.service and is run by the worker.
 */

export type OwnerProof = { password?: string; code?: string };

const CODE_TYPE = 'account_deletion' as const;
const CODE_TTL_MINUTES = 10;
const CODE_RESEND_SECONDS = 60;
const CODE_MAX_ATTEMPTS = 5;

/** Orders past these statuses need nothing further from Hook, so they never block deletion. */
const FINISHED_ORDER_STATUSES = [
  CommerceOrderStatus.DELIVERED,
  CommerceOrderStatus.COLLECTED,
  CommerceOrderStatus.COMPLETED,
  CommerceOrderStatus.REFUNDED,
  CommerceOrderStatus.CANCELLED,
];
/** Payment states meaning the customer has paid, or a payment is in flight. */
const COMMITTED_PAYMENT_STATUSES = ['CONFIRMED', 'PAID', 'PROCESSING', 'DUE_AT_HANDOVER'];
const OPEN_REFUND_STATUSES = ['REQUESTED', 'APPROVED', 'PROVIDER_PENDING', 'PROVIDER_UNKNOWN'];
const OPEN_RETURN_STATUSES = ['REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'AWAITING_HANDOVER', 'RECEIVED'];
const OPEN_REFUND_REQUEST_STATUSES = ['requested', 'under_review', 'approved', 'provider_pending'];

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function coolingOffDays() {
  const days = Number(process.env.ACCOUNT_DELETION_COOLING_OFF_DAYS);
  return Number.isFinite(days) && days >= 0 ? days : 14;
}

export function formatDeletionDate(date: Date) {
  return date.toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });
}

let dummyHash: Promise<string> | undefined;
/** Burned on unknown emails so "no such account" costs the same as "wrong password". */
const timingDecoy = () => (dummyHash ??= hashPassword(randomBytes(12).toString('hex')));

function safeEqualHex(a: string, b: string) {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

const invalid = () => new HttpError(401, 'The email or password is incorrect.', undefined, 'INVALID_CREDENTIALS');

export type DeletionView = {
  state: 'none' | 'scheduled' | 'erasing';
  scheduledFor?: string;
  canCancel: boolean;
  alreadyRequested?: boolean;
};

export class AccountDeletionService {
  constructor(private readonly email = new EmailService()) {}

  // ── Ownership ───────────────────────────────────────────────────────────

  private isCustomer(user: any) {
    return user.accountType ? user.accountType === AccountType.CUSTOMER : user.role === UserRole.SHOPPER;
  }

  /**
   * Proves the caller owns the account. Every failure (unknown email, staff
   * account, wrong password, wrong code, a password given to a social account)
   * is the same 401, so this endpoint cannot be used to discover accounts.
   * Only after ownership is proven do we tell the caller anything specific.
   */
  async verifyOwner(email: string, proof: OwnerProof) {
    const normalized = String(email || '').toLowerCase().trim();
    const user: any = await User.findOne({ email: normalized }).lean({ virtuals: true });
    const eligible = Boolean(user) && this.isCustomer(user) && user.accountStatus !== AccountStatus.ANONYMIZED;

    let proven = false;
    if (eligible && proof.password !== undefined) {
      proven = Boolean(user.password) && (await comparePassword(proof.password, user.password));
    } else if (eligible && proof.code !== undefined) {
      // A code stands in for a password only for accounts that have none.
      proven = !user.password && (await this.consumeCode(normalized, proof.code));
    } else {
      await comparePassword(proof.password ?? 'x', await timingDecoy());
    }
    if (!proven) throw invalid();

    if (![AccountStatus.ACTIVE, AccountStatus.DELETION_REQUESTED].includes(user.accountStatus ?? AccountStatus.ACTIVE)) {
      throw new HttpError(403, 'This account cannot be deleted online. Please contact support.', undefined, 'ACCESS_DENIED');
    }
    return user;
  }

  /** Emails a one-time code to social-sign-in customers. Always looks the same to the caller. */
  async sendCode(email: string) {
    const normalized = String(email || '').toLowerCase().trim();
    const user: any = await User.findOne({ email: normalized }).lean({ virtuals: true });
    if (!user || !this.isCustomer(user) || user.password) return;
    if (![AccountStatus.ACTIVE, AccountStatus.DELETION_REQUESTED].includes(user.accountStatus ?? AccountStatus.ACTIVE)) return;
    const recent = await Otp.findOne({
      email: normalized,
      type: CODE_TYPE,
      createdAt: { $gt: new Date(Date.now() - CODE_RESEND_SECONDS * 1000) },
    }).lean();
    if (recent) return;
    const code = String(randomInt(100000, 1000000));
    await Otp.updateMany({ email: normalized, type: CODE_TYPE, isUsed: false }, { $set: { isUsed: true } });
    await Otp.create({
      email: normalized,
      type: CODE_TYPE,
      code: sha256(code),
      expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000),
      attempts: 0,
    });
    await this.email.sendAccountDeletion({
      email: normalized,
      kind: 'code',
      name: user.firstName,
      code,
      expiresInMinutes: CODE_TTL_MINUTES,
    });
  }

  private async consumeCode(email: string, code: string) {
    if (!/^\d{6}$/.test(code)) return false;
    const otp: any = await Otp.findOne({ email, type: CODE_TYPE, isUsed: false, expiresAt: { $gt: new Date() } })
      .sort({ createdAt: -1 })
      .lean();
    if (!otp) return false;
    if (safeEqualHex(otp.code, sha256(code))) {
      // Single use, and atomic so two simultaneous requests cannot both spend it.
      const spent = await Otp.updateOne({ _id: otp._id, isUsed: false }, { $set: { isUsed: true } });
      return spent.modifiedCount === 1;
    }
    const attempts = Number(otp.attempts || 0) + 1;
    await Otp.updateOne(
      { _id: otp._id },
      { $set: { attempts, ...(attempts >= CODE_MAX_ATTEMPTS ? { isUsed: true } : {}) } },
    );
    return false;
  }

  // ── Blockers ────────────────────────────────────────────────────────────

  /** What still needs to finish before an account can be deleted. Empty means clear. */
  async blockers(userId: string) {
    const [openOrders, allOrders] = await Promise.all([
      Order.find({
        userId,
        commerceStatus: { $nin: FINISHED_ORDER_STATUSES },
        commercePaymentStatus: { $in: COMMITTED_PAYMENT_STATUSES },
      } as any)
        .select('publicId orderCode')
        .limit(20)
        .lean(),
      Order.find({ userId }).select('_id').limit(5000).lean(),
    ]);
    const orderIds = allOrders.map((order: any) => String(order._id));
    const [refunds, returns, refundRequests] = orderIds.length
      ? await Promise.all([
          FulfilmentRefund.countDocuments({ orderId: { $in: orderIds }, status: { $in: OPEN_REFUND_STATUSES } } as any),
          ReturnRequest.countDocuments({ orderId: { $in: orderIds }, status: { $in: OPEN_RETURN_STATUSES } } as any),
          RefundRequest.countDocuments({ orderId: { $in: orderIds }, status: { $in: OPEN_REFUND_REQUEST_STATUSES } } as any),
        ])
      : [0, 0, 0];
    const orders = openOrders.map((order: any) => String(order.publicId || order.orderCode || order._id));
    const pendingRefunds = refunds + refundRequests;
    return { orders, refunds: pendingRefunds, returns, blocked: orders.length + pendingRefunds + returns > 0 };
  }

  private async assertNoBlockers(userId: string) {
    const found = await this.blockers(userId);
    if (!found.blocked) return;
    const parts: string[] = [];
    if (found.orders.length) parts.push(`order${found.orders.length > 1 ? 's' : ''} ${found.orders.slice(0, 3).join(', ')} still in progress`);
    if (found.refunds) parts.push('a refund that is still being processed');
    if (found.returns) parts.push('a return that is still open');
    throw new HttpError(
      409,
      `We can't delete your account yet because you have ${parts.join(' and ')}. Please try again once they are complete.`,
      { orders: found.orders, refunds: found.refunds, returns: found.returns },
      'ACCOUNT_DELETION_BLOCKED',
    );
  }

  // ── Request / status / cancel ───────────────────────────────────────────

  private present(request: any, alreadyRequested = false): DeletionView {
    if (!request) return { state: 'none', canCancel: false };
    const erasing = request.status === 'erasing';
    return {
      state: erasing ? 'erasing' : 'scheduled',
      scheduledFor: new Date(request.coolingOffUntil).toISOString(),
      canCancel: !erasing,
      ...(alreadyRequested ? { alreadyRequested: true } : {}),
    };
  }

  async request(user: any, options: { reason?: string; source: 'web' | 'app' }): Promise<DeletionView> {
    const userId = String(user._id || user.id);
    const live = await AccountDeletionRequest.findOne({ userId, status: { $in: LIVE_DELETION_STATUSES } }).lean();
    if (live) return this.present(live, true);
    // Closed by Hook support (no request of the customer's own): not theirs to reopen or re-request.
    if (user.accountStatus === AccountStatus.DELETION_REQUESTED) {
      throw new HttpError(409, 'This account was closed by Hook support. Please contact support.', undefined, 'ACCESS_DENIED');
    }
    await this.assertNoBlockers(userId);

    const token = randomBytes(32).toString('base64url');
    const scheduledFor = new Date(Date.now() + coolingOffDays() * 24 * 60 * 60 * 1000);
    let created: any;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // Legacy accounts may have no status at all, which also counts as active.
        await User.updateOne(
          { _id: userId, $or: [{ accountStatus: AccountStatus.ACTIVE }, { accountStatus: { $exists: false } }, { accountStatus: null }] } as any,
          { $set: { accountStatus: AccountStatus.DELETION_REQUESTED } },
          { session },
        );
        [created] = await AccountDeletionRequest.create([{
          userId,
          reason: options.reason?.slice(0, 1000),
          status: 'cooling_off',
          source: options.source,
          identityVerifiedAt: new Date(),
          coolingOffUntil: scheduledFor,
          cancelTokenHash: sha256(token),
        }], { session });
      });
    } catch (error) {
      // Lost a race with the same person's other request: report theirs.
      if (isDuplicateKeyError(error)) {
        const winner = await AccountDeletionRequest.findOne({ userId, status: { $in: LIVE_DELETION_STATUSES } }).lean();
        if (winner) return this.present(winner, true);
      }
      throw error;
    } finally {
      await session.endSession();
    }

    // From here the account is closed to sign-in. Everything below is best effort.
    await revokeAccountSessions(userId, 'account_deletion_requested');
    await DeviceToken.updateMany({ userId }, { $set: { isActive: false } });
    await this.email.sendAccountDeletion({
      email: user.email,
      kind: 'scheduled',
      name: user.firstName,
      scheduledFor: formatDeletionDate(scheduledFor),
      cancelUrl: await this.cancelUrl(token),
    }).catch((error) => console.error('[account-deletion] confirmation email failed', error instanceof Error ? error.message : error));
    return this.present(created);
  }

  async status(user: any): Promise<DeletionView> {
    const live = await AccountDeletionRequest.findOne({ userId: String(user._id || user.id), status: { $in: LIVE_DELETION_STATUSES } }).lean();
    return this.present(live);
  }

  /** Cheap lookup used by sign-in to explain why an account is unavailable. */
  async scheduledFor(userId: string): Promise<Date | undefined> {
    const live: any = await AccountDeletionRequest.findOne({ userId, status: { $in: LIVE_DELETION_STATUSES } }).select('coolingOffUntil').lean();
    return live ? new Date(live.coolingOffUntil) : undefined;
  }

  /** Cancels by proving ownership (email + password/code) or by the single-use link from the email. */
  async cancel(input: { user?: any; token?: string }): Promise<DeletionView> {
    let request: any;
    if (input.token) {
      request = await AccountDeletionRequest.findOne({ cancelTokenHash: sha256(input.token), status: { $in: LIVE_DELETION_STATUSES } })
        .select('+cancelTokenHash')
        .lean();
      if (!request) throw new HttpError(410, 'This link has expired or was already used. If your account is still scheduled for deletion, you can cancel by signing in with your email and password.', undefined, 'NOT_FOUND');
    } else {
      request = await AccountDeletionRequest.findOne({ userId: String(input.user._id || input.user.id), status: { $in: LIVE_DELETION_STATUSES } }).lean();
      if (!request) {
        if (input.user.accountStatus === AccountStatus.DELETION_REQUESTED) {
          throw new HttpError(409, 'This account was closed by Hook support. Please contact support to restore it.', undefined, 'ACCESS_DENIED');
        }
        return { state: 'none', canCancel: false };
      }
    }
    const userId = String(request.userId);
    if (request.status === 'erasing') {
      throw new HttpError(409, 'Your account is already being deleted and can no longer be restored.', undefined, 'ACCOUNT_DELETION_IN_PROGRESS');
    }
    let restored = false;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // Guarded on status: if the worker claimed it a moment ago, this loses cleanly.
        const cancelled = await AccountDeletionRequest.updateOne(
          { _id: request._id, status: { $in: ['requested', 'identity_verified', 'cooling_off', 'approved'] } },
          { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: 'customer' }, $unset: { cancelTokenHash: 1 } },
          { session },
        );
        restored = cancelled.modifiedCount === 1;
        if (!restored) return;
        await User.updateOne(
          { _id: userId, accountStatus: AccountStatus.DELETION_REQUESTED },
          { $set: { accountStatus: AccountStatus.ACTIVE } },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
    if (!restored) {
      throw new HttpError(409, 'Your account is already being deleted and can no longer be restored.', undefined, 'ACCOUNT_DELETION_IN_PROGRESS');
    }
    const owner: any = await User.findById(userId).select('email firstName').lean();
    if (owner?.email) {
      await this.email.sendAccountDeletion({ email: owner.email, kind: 'restored', name: owner.firstName })
        .catch((error) => console.error('[account-deletion] restore email failed', error instanceof Error ? error.message : error));
    }
    return { state: 'none', canCancel: false };
  }

  /** Support cancels a request: same guarded transition as the customer's, attributed to admin. */
  async cancelByAdmin(requestId: string) {
    const request: any = await AccountDeletionRequest.findById(requestId).lean();
    if (!request) throw new HttpError(404, 'Deletion request not found');
    if (request.status === 'cancelled') return;
    if (request.status === 'erasing' || request.status === 'anonymized') {
      throw new HttpError(409, 'Erasure has already started and cannot be cancelled.', undefined, 'ACCOUNT_DELETION_IN_PROGRESS');
    }
    let cancelled = false;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const result = await AccountDeletionRequest.updateOne(
          { _id: request._id, status: { $in: ['requested', 'identity_verified', 'cooling_off', 'approved'] } },
          { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: 'admin' }, $unset: { cancelTokenHash: 1 } },
          { session },
        );
        cancelled = result.modifiedCount === 1;
        if (!cancelled) return;
        await User.updateOne({ _id: request.userId, accountStatus: AccountStatus.DELETION_REQUESTED }, { $set: { accountStatus: AccountStatus.ACTIVE } }, { session });
      });
    } finally {
      await session.endSession();
    }
    if (!cancelled) throw new HttpError(409, 'Erasure has already started and cannot be cancelled.', undefined, 'ACCOUNT_DELETION_IN_PROGRESS');
    const owner: any = await User.findById(request.userId).select('email firstName').lean();
    if (owner?.email) await this.email.sendAccountDeletion({ email: owner.email, kind: 'restored', name: owner.firstName }).catch(() => undefined);
  }

  private async cancelUrl(token: string) {
    const base = await adminAppBaseUrl();
    return `${base}/delete-account/cancel?token=${encodeURIComponent(token)}`;
  }
}
