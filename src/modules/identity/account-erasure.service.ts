import { randomUUID } from 'crypto';
import { adminAppBaseUrl } from '@modules/notifications';
import mongoose from 'mongoose';
import { AccountStatus, OrderStatus } from '@lib/constants';
import { timelineEntry } from '@lib/order-timeline';
import { EmailService } from '@emails/email.service';
import { Cart } from '@models/cart/cart.model';
import { CartItem } from '@models/cart/cart-item.model';
import { CheckoutPreview, CustomerAddress } from '@models/commerce/commerce.model';
import { CommerceImport } from '@models/commerce/commerce-import.model';
import { Negotiation } from '@models/negotiations/negotiation.model';
import { DeviceToken } from '@models/notifications/device-token.model';
import { Notification } from '@models/notifications/notification.model';
import { Otp } from '@models/auth/otp.model';
import { Order } from '@models/orders/order.model';
import { PaymentLink } from '@models/payments/payment-link.model';
import { PlatformAuditLog } from '@models/platform/audit-log.model';
import { AccountSession } from '@models/platform/session.model';
import { ProductLike } from '@models/products/product-like.model';
import { AccountDeletionRequest } from '@models/support/account-deletion-request.model';
import { User } from '@models/users/user.model';
import { restoreOrderIncentives } from '@modules/orders';
import { AccountDeletionService, formatDeletionDate, sha256 } from '@modules/identity/account-deletion.service';
import { nextPublicId } from '@modules/platform';

/** Permanently removes a customer's personal data after the cooling-off window, atomically claimed and resumable step-by-step; financial records (orders, payments, refunds, ledger, audit logs) are kept with identity removed. */

const STALE_ERASURE_MS = 10 * 60_000;
const DEFER_MS = 24 * 60 * 60_000;
const REMINDER_WINDOW_MS = 3 * 24 * 60 * 60_000;

export const anonymizedEmail = (userId: string) => `deleted-${sha256(userId).slice(0, 16)}@anonymized.hook`;

export class AccountErasureService {
  constructor(
    private readonly deletions = new AccountDeletionService(),
    private readonly email = new EmailService(),
  ) {}

  /** Worker entry point. Claims due requests (and resumes interrupted ones) and erases them. */
  async runDue(limit = 5) {
    let erased = 0;
    let deferred = 0;
    for (let i = 0; i < limit; i += 1) {
      const now = new Date();
      let claimed: any = await AccountDeletionRequest.findOneAndUpdate(
        {
          status: 'cooling_off',
          paused: { $ne: true },
          coolingOffUntil: { $lte: now },
          $or: [{ deferredUntil: { $exists: false } }, { deferredUntil: { $lte: now } }],
        },
        { $set: { status: 'erasing', erasureStartedAt: now } },
        { sort: { coolingOffUntil: 1 }, returnDocument: 'after' },
      ).lean();
      if (!claimed) {
        // Resume one a crashed worker left half-done.
        claimed = await AccountDeletionRequest.findOneAndUpdate(
          { status: 'erasing', paused: { $ne: true }, erasureStartedAt: { $lt: new Date(now.getTime() - STALE_ERASURE_MS) } },
          { $set: { erasureStartedAt: now } },
          { returnDocument: 'after' },
        ).lean();
      }
      if (!claimed) break;
      try {
        const result = await this.erase(claimed);
        if (result === 'deferred') deferred += 1;
        else erased += 1;
      } catch (error) {
        // Left in 'erasing'; it is picked up again after STALE_ERASURE_MS, at the recorded step.
        console.error('[account-erasure] failed, will resume', String(claimed._id), error instanceof Error ? error.message : error);
      }
    }
    return { erased, deferred };
  }

  /** One reminder, three days before erasure. Points at the page, since the one-click token is only ever emailed once. */
  async sendReminders(limit = 25) {
    const now = new Date();
    const due: any[] = await AccountDeletionRequest.find({
      status: 'cooling_off',
      paused: { $ne: true },
      reminderSentAt: { $exists: false },
      coolingOffUntil: { $gt: now, $lte: new Date(now.getTime() + REMINDER_WINDOW_MS) },
    }).limit(limit).lean();
    let sent = 0;
    const base = (await adminAppBaseUrl());
    for (const request of due) {
      const claimed = await AccountDeletionRequest.updateOne({ _id: request._id, reminderSentAt: { $exists: false } }, { $set: { reminderSentAt: now } });
      if (!claimed.modifiedCount) continue;
      const user: any = await User.findById(request.userId).select('email firstName').lean();
      if (!user?.email) continue;
      await this.email.sendAccountDeletion({
        email: user.email,
        kind: 'reminder',
        name: user.firstName,
        scheduledFor: formatDeletionDate(new Date(request.coolingOffUntil)),
        cancelUrl: `${base}/delete-account`,
      }).then(() => { sent += 1; }).catch(async () => {
        // Let the next tick retry a reminder that could not be delivered.
        await AccountDeletionRequest.updateOne({ _id: request._id }, { $unset: { reminderSentAt: 1 } });
      });
    }
    return { sent };
  }

  async erase(request: any): Promise<'erased' | 'deferred'> {
    const userId = String(request.userId);
    const done = new Set<string>(request.erasureSteps || []);
    const step = async (name: string, work: () => Promise<void>) => {
      if (done.has(name)) return;
      await work();
      await AccountDeletionRequest.updateOne({ _id: request._id }, { $addToSet: { erasureSteps: name } });
      done.add(name);
    };

    // Before the first destructive step, make sure nothing new is in motion.
    if (!done.has('notify')) {
      const blockers = await this.deletions.blockers(userId);
      if (blockers.blocked) {
        await AccountDeletionRequest.updateOne(
          { _id: request._id, status: 'erasing' },
          {
            $set: {
              status: 'cooling_off',
              deferredUntil: new Date(Date.now() + DEFER_MS),
              deferReason: 'An order, refund or return is still in progress',
            },
            $unset: { erasureStartedAt: 1 },
          },
        );
        return 'deferred';
      }
    }

    await step('cancel_unpaid', () => this.cancelUnpaidOrders(userId));
    await step('notify', async () => {
      const user: any = await User.findById(userId).select('email firstName').lean();
      if (user?.email && user.email !== anonymizedEmail(userId)) {
        await this.email.sendAccountDeletion({ email: user.email, kind: 'deleted', name: user.firstName })
          .catch((error) => console.error('[account-erasure] final email failed', error instanceof Error ? error.message : error));
      }
    });
    await step('delete_personal', () => this.deletePersonalRecords(userId));
    await step('scrub_orders', () => this.scrubOrders(userId));
    await step('scrub_negotiations', () => this.scrubNegotiations(userId));
    await step('anonymize_user', () => this.anonymizeUser(userId));

    await AccountDeletionRequest.updateOne(
      { _id: request._id },
      { $set: { status: 'anonymized', anonymizedAt: new Date() }, $unset: { cancelTokenHash: 1, reason: 1 } },
    );
    await PlatformAuditLog.create({
      publicId: await nextPublicId('audit'),
      actorType: 'system',
      actorId: 'account-erasure',
      action: 'account.erased',
      entityType: 'user',
      entityId: userId,
      after: { requestId: String(request._id), steps: [...done] },
      requestId: `erasure:${randomUUID()}`,
    } as any);
    return 'erased';
  }

  /** Unpaid orders can never complete once the customer is gone: cancel them and free any coupon. */
  private async cancelUnpaidOrders(userId: string) {
    const unpaid: any[] = await Order.find({
      userId,
      commerceStatus: { $in: ['AWAITING_PAYMENT', 'PENDING'] },
      commercePaymentStatus: { $nin: ['CONFIRMED', 'PAID', 'PROCESSING', 'DUE_AT_HANDOVER'] },
    } as any).select('_id').lean();
    for (const { _id } of unpaid) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const cancelled = await Order.updateOne(
            { _id, commerceStatus: { $in: ['AWAITING_PAYMENT', 'PENDING'] } } as any,
            {
              $set: { status: OrderStatus.CANCELLED, commerceStatus: 'CANCELLED', cancelledAt: new Date(), cancellationReason: 'Account deleted' },
              $push: { timeline: timelineEntry('CANCELLED', 'SYSTEM', { actorType: 'account_deletion' }) },
            },
            { session },
          );
          if (!cancelled.modifiedCount) return;
          await restoreOrderIncentives(String(_id), session);
          await PaymentLink.updateMany(
            { orderId: String(_id), status: { $in: ['active', 'processing'] } },
            { $set: { status: 'cancelled', cancelledAt: new Date() } },
            { session },
          );
        });
      } finally {
        await session.endSession();
      }
    }
  }

  private async deletePersonalRecords(userId: string) {
    const user: any = await User.findById(userId).select('email').lean();
    const carts: any[] = await Cart.find({ $or: [{ customerId: userId }, { userId }] } as any).select('_id').lean();
    await Promise.all([
      CartItem.deleteMany({ cartId: { $in: carts.map((cart) => String(cart._id)) } }),
      CustomerAddress.deleteMany({ customerId: userId }),
      DeviceToken.deleteMany({ userId }),
      Notification.deleteMany({ userId }),
      ProductLike.deleteMany({ userId }),
      CheckoutPreview.deleteMany({ customerId: userId }),
      CommerceImport.deleteMany({ customerId: userId }),
      AccountSession.deleteMany({ accountId: userId }),
      user?.email ? Otp.deleteMany({ email: String(user.email).toLowerCase() }) : Promise.resolve(),
      // A paid link is a payment record and stays; every other link stops working.
      PaymentLink.updateMany({ customerId: userId, status: { $in: ['active', 'processing'] } }, { $set: { status: 'revoked', revokedAt: new Date() } }),
    ]);
    await Cart.deleteMany({ $or: [{ customerId: userId }, { userId }] } as any);
  }

  /** Orders stay for financial records; who they were for and where they went do not. */
  private async scrubOrders(userId: string) {
    // A $set of an object literal merges into the existing sub-document, so build clean versions into temp fields, drop the originals, then move them back.
    await Order.updateMany({ userId } as any, [
      {
        $set: {
          _scrubCustomer: { $literal: { name: 'Deleted customer', anonymized: true } },
          _scrubAddress: {
            $cond: [
              { $eq: [{ $type: '$addressSnapshot' }, 'object'] },
              {
                stateId: '$addressSnapshot.stateId',
                stateCode: '$addressSnapshot.stateCode',
                stateName: '$addressSnapshot.stateName',
                cityName: '$addressSnapshot.cityName',
                localGovernmentArea: '$addressSnapshot.localGovernmentArea',
              },
              '$$REMOVE',
            ],
          },
          _scrubDelivery: {
            street: { $literal: '' },
            phone: { $literal: '' },
            city: { $ifNull: ['$deliveryAddress.city', ''] },
            state: { $ifNull: ['$deliveryAddress.state', ''] },
          },
        },
      },
      { $unset: ['customerSnapshot', 'addressSnapshot', 'deliveryAddress'] },
      { $set: { customerSnapshot: '$_scrubCustomer', addressSnapshot: '$_scrubAddress', deliveryAddress: '$_scrubDelivery' } },
      { $unset: ['_scrubCustomer', '_scrubAddress', '_scrubDelivery'] },
    ] as any, { updatePipeline: true });
  }

  private async scrubNegotiations(userId: string) {
    await Negotiation.updateMany({ customerId: userId } as any, [
      {
        $set: {
          transcript: {
            $map: {
              input: { $ifNull: ['$transcript', []] },
              as: 'entry',
              in: {
                $cond: [
                  { $eq: ['$$entry.role', 'customer'] },
                  { $mergeObjects: ['$$entry', { message: '[removed]' }] },
                  '$$entry',
                ],
              },
            },
          },
        },
      },
    ] as any, { updatePipeline: true });
  }

  private async anonymizeUser(userId: string) {
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          email: anonymizedEmail(userId),
          firstName: 'Deleted',
          lastName: 'User',
          isActive: false,
          isEmailVerified: false,
          isPhoneVerified: false,
          podEligible: false,
          accountStatus: AccountStatus.ANONYMIZED,
          deletedAt: new Date(),
        },
        $unset: {
          phone: 1, password: 1, googleId: 1, appleId: 1, avatarUrl: 1, address: 1, preferences: 1,
          refreshToken: 1, referralCode: 1, originatingGuestId: 1, migratedFrom: 1, lockedUntil: 1,
        },
      },
    );
  }
}
