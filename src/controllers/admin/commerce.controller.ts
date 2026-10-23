import { createHash } from 'crypto';
import { CheckoutService } from '@services/checkout.service';
import { Request, Response } from 'express';
import { publishConfigChanged } from '@modules/platform/realtime.service';
import { PaymentService } from '@services/payment.service';
import { AccountDeletionService } from '@services/account-deletion.service';
import { AccountErasureService } from '@services/account-erasure.service';
import { AccountDeletionRequest } from '@models/support/account-deletion-request.model';
import { HttpError, sendSuccess } from '@utils/http';
import { adminRepos, getPagination, paginated, routeParam } from './admin.helpers';
import { auditAdminAction } from '@lib/audit';
import { CommerceSettings, IntegrationException } from '@models/commerce/commerce.model';
import { CommerceOutboxEvent } from '@modules/platform/outbox.model';
import { DeadLetterEvent } from '@models/platform/dead-letter-event.model';
import { replayDeadLetter } from '@modules/platform/outbox.service';
import { Order } from '@models/orders/order.model';
import { Payment } from '@models/payments/payment.model';
import { PaymentAttempt } from '@models/payments/payment-link.model';
import { User } from '@models/users/user.model';
import { isValidObjectId } from 'mongoose';
import { PodService } from '@services/pod.service';
import { recordAudit } from '@modules/platform/platform-audit.service';
import { paymentProviderReadiness } from '@services/payments/provider-registry';
import { clearInventorySettingsCache } from '@services/inventory-settings.service';
import { publicCatalogCache } from '@lib/ttl-cache';
import { sharedCache } from '@modules/platform/cache.service';

export class AdminCommerceController {
  private paymentService = new PaymentService(adminRepos.payments(), adminRepos.orders(), adminRepos.escrowLedger());
  private pod = new PodService();

  deletionRequests = async (req: Request, res: Response) => {
    const { page, limit, skip } = getPagination(req.query);
    const [data, total] = await adminRepos.deletionRequests().findAndCount({ order: { createdAt: 'DESC' }, skip, take: limit, relations: { user: true } });
    sendSuccess(res, paginated(data, total, page, limit));
  };

  updateDeletion = async (req: Request, res: Response) => {
    const request = await adminRepos.deletionRequests().findOne({ where: { id: routeParam(req.params.id) } });
    if (!request) throw new HttpError(404, 'Deletion request not found');
    // Older admin builds send a status instead of an action.
    const action = req.body.action
      || (req.body.status === 'cancelled' ? 'cancel' : req.body.status === 'anonymized' ? 'erase_now' : undefined);
    const deletions = new AccountDeletionService();
    if (action === 'pause' || action === 'resume') {
      const paused = action === 'pause';
      const result = await AccountDeletionRequest.updateOne(
        { _id: request.id, status: { $in: ['requested', 'identity_verified', 'cooling_off', 'approved'] } },
        { $set: { paused } },
      );
      if (!result.modifiedCount && Boolean((request as any).paused) !== paused) throw new HttpError(409, 'Erasure has already started');
    } else if (action === 'cancel') {
      await deletions.cancelByAdmin(request.id);
    } else if (action === 'erase_now') {
      // The same claim the worker makes, so the two can never both erase.
      const claimed: any = await AccountDeletionRequest.findOneAndUpdate(
        { _id: request.id, status: 'cooling_off' },
        { $set: { status: 'erasing', erasureStartedAt: new Date(), paused: false } },
        { returnDocument: 'after' },
      ).lean();
      if (!claimed) throw new HttpError(409, 'This request cannot be erased right now');
      const outcome = await new AccountErasureService().erase(claimed);
      if (outcome === 'deferred') throw new HttpError(409, 'An order, refund or return is still in progress, so erasure was deferred', undefined, 'ACCOUNT_DELETION_BLOCKED');
    } else if (req.body.assignedTo) {
      await AccountDeletionRequest.updateOne({ _id: request.id }, { $set: { assignedTo: req.body.assignedTo } });
    }
    await auditAdminAction(req, 'account_deletion.update', 'account_deletion', request.id, { action });
    sendSuccess(res, await AccountDeletionRequest.findById(request.id).lean({ virtuals: true }));
  };

  refundRequests = async (req: Request, res: Response) => {
    const { page, limit, skip } = getPagination(req.query);
    const where: Record<string, unknown> = {};
    if (typeof req.query.status === 'string') where.status = req.query.status;
    const [data, total] = await adminRepos.refundRequests().findAndCount({ where, order: { createdAt: 'DESC' }, skip, take: limit });
    sendSuccess(res, paginated(data, total, page, limit));
  };

  reviewRefund = async (req: Request, res: Response) => {
    const request = await adminRepos.refundRequests().findOne({ where: { id: routeParam(req.params.id) } });
    if (!request) throw new HttpError(404, 'Refund request not found');
    if (!['requested', 'under_review'].includes(request.status)) throw new HttpError(409, 'This refund request has already been decided');
    request.status = req.body.status;
    request.assignedSupportUserId = req.body.assignedSupportUserId || req.user!.sub;
    request.decisionNote = req.body.decisionNote;
    request.decidedBy = req.body.status === 'rejected' ? req.user!.sub : undefined;
    request.auditHistory.push({ action: req.body.status, actorId: req.user!.sub, note: req.body.decisionNote, at: new Date() });
    await adminRepos.refundRequests().save(request);
    await auditAdminAction(req, `refund.${req.body.status}`, 'refund_request', request.id, { orderId: request.orderId });
    sendSuccess(res, request);
  };

  approveRefund = async (req: Request, res: Response) => {
    const request = await adminRepos.refundRequests().findOne({ where: { id: routeParam(req.params.id) } });
    if (!request) throw new HttpError(404, 'Refund request not found');
    if (!['requested', 'under_review', 'approved'].includes(request.status)) throw new HttpError(409, 'This refund request cannot be approved');
    if (!request.paymentId) throw new HttpError(409, 'The captured payment could not be resolved');
    request.status = 'provider_pending';
    request.decidedBy = req.user!.sub;
    request.decisionNote = req.body.reason;
    request.auditHistory.push({ action: 'approved', actorId: req.user!.sub, at: new Date() });
    await adminRepos.refundRequests().save(request);
    const event = await this.paymentService.refund(request.paymentId, request.amount, request.idempotencyKey);
    request.status = 'refunded';
    request.providerReference = event.providerReference;
    request.auditHistory.push({ action: 'refunded', actorId: req.user!.sub, at: new Date(), providerReference: event.providerReference });
    await adminRepos.refundRequests().save(request);
    await auditAdminAction(req, 'refund.approve', 'refund_request', request.id, { amount: request.amount, orderId: request.orderId });
    sendSuccess(res, request);
  };

  podQueue = async (req: Request, res: Response) => {
    const filter: Record<string, unknown> = {
      commercePaymentMethod: 'PAY_AT_HANDOVER',
      commerceStatus: { $in: ['VERIFICATION_PENDING', 'OPERATIONS_REVIEW'] },
    };
    if (req.user?.scopeType !== 'global')
      filter.sourceStateId = { $in: req.user?.assignedStateIds || [] };
    sendSuccess(
      res,
      await Order.find(filter)
        .sort({ createdAt: 1 })
        .limit(100)
        .lean({ virtuals: true }),
    );
  };
  recordCall = async (req: Request, res: Response) => {
    const result = await this.pod.recordCall(
      routeParam(req.params.id),
      req.user!.sub,
      req.body.outcome,
      req.body.notes,
    );
    await recordAudit(req, {
      action: 'commerce.pod.call',
      entityType: 'order',
      entityId: routeParam(req.params.id),
      after: req.body,
    });
    sendSuccess(res, result);
  };
  decide = async (req: Request, res: Response) => {
    const result = await this.pod.decide(
      routeParam(req.params.id),
      req.user!.sub,
      req.body.decision,
      req.body.reason,
    );
    await recordAudit(req, {
      action: `commerce.pod.${req.body.decision.toLowerCase()}`,
      entityType: 'order',
      entityId: routeParam(req.params.id),
      reason: req.body.reason,
    });
    sendSuccess(res, result);
  };
  override = async (req: Request, res: Response) => {
    const result = await this.pod.override(
      routeParam(req.params.id),
      req.user!.sub,
      req.body.reason,
    );
    await recordAudit(req, {
      action: 'commerce.pod.override',
      entityType: 'order',
      entityId: routeParam(req.params.id),
      reason: req.body.reason,
    });
    sendSuccess(res, result);
  };
  restoreEligibility = async (req: Request, res: Response) => {
    const result = await this.pod.restoreCustomer(
      routeParam(req.params.id),
      req.user!.sub,
      req.body.reason,
    );
    await recordAudit(req, {
      action: 'commerce.pod.eligibility_restore',
      entityType: 'customer',
      entityId: routeParam(req.params.id),
      reason: req.body.reason,
    });
    sendSuccess(res, result);
  };
  /** Paginated payments with the order and customer resolved, avoiding an N+1 fetch per row. */
  payments = async (req: Request, res: Response) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const query: Record<string, any> = {};
    if (req.query.status && req.query.status !== 'all') query.commerceStatus = req.query.status;
    if (req.query.provider && req.query.provider !== 'all') query.gateway = req.query.provider;
    if (typeof req.query.search === 'string' && req.query.search.trim()) {
      // Anchored and escaped: unanchored would scan the whole collection, and a stray "(" would throw.
      const safe = req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { publicId: new RegExp(`^${safe}`, 'i') },
        { reference: new RegExp(`^${safe}`, 'i') },
      ];
    }

    const [rows, total] = await Promise.all([
      Payment.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean({ virtuals: true }),
      Payment.countDocuments(query),
    ]);

    // Resolved in two batched queries rather than per row.
    const orderIds = [...new Set(rows.map((row: any) => String(row.orderId)).filter(Boolean))];
    const orders = await Order.find({ _id: { $in: orderIds } })
      .select('publicId orderCode userId commerceStatus')
      .lean() as any[];
    const orderById = new Map(orders.map((order) => [String(order._id), order]));
    const userIds = [...new Set(orders.map((order) => String(order.userId)).filter(Boolean))];
    const users = await User.find({ _id: { $in: userIds } })
      .select('firstName lastName email')
      .lean() as any[];
    const userById = new Map(users.map((user) => [String(user._id), user]));

    const data = rows.map((row: any) => {
      const order = orderById.get(String(row.orderId));
      const user = order ? userById.get(String(order.userId)) : undefined;
      return {
        ...row,
        order: order
          ? { id: order.publicId, reference: order.orderCode || order.publicId, status: order.commerceStatus }
          : undefined,
        customer: user
          ? { name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email, email: user.email }
          : undefined,
      };
    });

    sendSuccess(res, { data, total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) });
  };

  /** One payment with the order, the customer, and every provider attempt in time order. */
  paymentDetail = async (req: Request, res: Response) => {
    const identifier = routeParam(req.params.id);
    const payment = await Payment.findOne(
      isValidObjectId(identifier)
        ? { $or: [{ _id: identifier }, { publicId: identifier }, { reference: identifier }] }
        : { $or: [{ publicId: identifier }, { reference: identifier }] },
    ).lean({ virtuals: true }) as any;
    if (!payment) throw new HttpError(404, 'Payment not found', undefined, 'NOT_FOUND');

    const order = payment.orderId
      ? await Order.findById(payment.orderId)
          .select('publicId orderCode userId commerceStatus totalMinor currency createdAt timeline')
          .lean() as any
      : null;
    const customer = order?.userId
      ? await User.findById(order.userId).select('firstName lastName email phone').lean() as any
      : null;
    const attempts = await PaymentAttempt.find({ paymentId: String(payment._id) })
      .select('publicId provider status amountMinor reference failureReason createdAt')
      .sort({ createdAt: 1 })
      .lean({ virtuals: true });

    sendSuccess(res, {
      payment,
      order: order
        ? {
            id: order.publicId,
            reference: order.orderCode || order.publicId,
            status: order.commerceStatus,
            totalMinor: order.totalMinor,
            currency: order.currency,
            createdAt: order.createdAt,
          }
        : undefined,
      customer: customer
        ? {
            name: `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || customer.email,
            email: customer.email,
            phone: customer.phone,
          }
        : undefined,
      attempts,
      timeline: order?.timeline || [],
    });
  };
  exceptions = async (_req: Request, res: Response) =>
    sendSuccess(
      res,
      await IntegrationException.find({ status: 'open' })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean({ virtuals: true }),
    );
  outbox = async (req: Request, res: Response) => {
    const status = String(req.query.status || '');
    sendSuccess(
      res,
      await CommerceOutboxEvent.find((['pending', 'processing', 'published', 'dead_letter'].includes(status) ? { status } : {}) as any)
        .select('-payload')
        .sort({ createdAt: -1 })
        .limit(100)
        .lean({ virtuals: true }),
    );
  };

  /** Events that exhausted their retries. Payloads are never included. */
  deadLetters = async (req: Request, res: Response) => {
    const replayStatus = String(req.query.replayStatus || 'pending');
    const filter = (['pending', 'replayed'].includes(replayStatus) ? { replayStatus } : {}) as any;
    const [data, pendingCount] = await Promise.all([
      DeadLetterEvent.find(filter).sort({ lastFailedAt: -1 }).limit(100).lean({ virtuals: true }),
      DeadLetterEvent.countDocuments({ replayStatus: 'pending' }),
    ]);
    sendSuccess(res, { data, pendingCount });
  };

  replayDeadLetter = async (req: Request, res: Response) => {
    const id = routeParam(req.params.id);
    if (!isValidObjectId(id)) throw new HttpError(400, 'Invalid dead-letter id');
    const result = await replayDeadLetter(id, req.user!.sub);
    if (!result) throw new HttpError(404, 'Dead-letter event not found');
    await recordAudit(req, {
      action: 'commerce.outbox.replay',
      entityType: 'dead_letter_event',
      entityId: id,
      after: result,
    });
    // A second replay finds the event no longer dead-lettered: report, don't fail.
    sendSuccess(res, result);
  };
  podSettings = async (_req: Request, res: Response) =>
    sendSuccess(res, await this.pod.getSettings());
  updatePodSettings = async (req: Request, res: Response) => {
    const result = await this.pod.updateSettings(req.user!.sub, req.body);
    await recordAudit(req, {
      action: 'commerce.settings.update',
      entityType: 'commerce_settings',
      after: req.body,
    });
    sendSuccess(res, result);
  };

  paymentProviders = async (_req: Request, res: Response) => {
    const settings = await CommerceSettings.findOne({ key: 'commerce' }).select('paymentProviders updatedAt').lean();
    const readiness = paymentProviderReadiness();
    const saved = settings?.paymentProviders?.length ? settings.paymentProviders : [
      { provider: 'paystack' as const, enabled: true, displayOrder: 1, isDefault: true },
    ];
    // Every provider the backend knows about is shown, not only ones already in settings, so a newly registered one appears disabled rather than staying invisible.
    const configured = [
      ...saved,
      ...readiness
        .filter((item) => !saved.some((entry) => entry.provider === item.provider))
        .map((item, index) => ({ provider: item.provider, enabled: false, isDefault: false, displayOrder: saved.length + index + 1 })),
    ];
    sendSuccess(res, {
      providers: configured.map((entry) => ({ ...entry, ...readiness.find((item) => item.provider === entry.provider) })),
      updatedAt: settings?.updatedAt,
    });
  };

  updatePaymentProviders = async (req: Request, res: Response) => {
    const defaults = req.body.providers.filter((entry: any) => entry.enabled && entry.isDefault);
    if (defaults.length !== 1) throw new HttpError(400, 'Select one enabled default payment provider');
    const readiness = paymentProviderReadiness();
    for (const entry of req.body.providers) {
      if (entry.enabled && !readiness.find((item) => item.provider === entry.provider)?.configured) {
        throw new HttpError(409, `${entry.provider} is missing required configuration`, undefined, 'PAYMENT_PROVIDER_UNAVAILABLE');
      }
    }
    const updated = await CommerceSettings.findOneAndUpdate(
      { key: 'commerce' },
      { $set: { paymentProviders: req.body.providers, updatedBy: req.user!.sub } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean();
    await recordAudit(req, {
      action: 'commerce.payment_providers.update',
      entityType: 'commerce_settings',
      after: { providers: req.body.providers },
      reason: req.body.reason,
    });
    sendSuccess(res, { providers: updated?.paymentProviders, readiness });
  };

  inventorySettings = async (_req: Request, res: Response) => {
    const settings = await CommerceSettings.findOne({ key: 'commerce' }).select('lowStockThreshold updatedAt').lean();
    sendSuccess(res, { lowStockThreshold: settings?.lowStockThreshold ?? 5, updatedAt: settings?.updatedAt });
  };

  updateInventorySettings = async (req: Request, res: Response) => {
    const updated = await CommerceSettings.findOneAndUpdate(
      { key: 'commerce' },
      { $set: { lowStockThreshold: req.body.lowStockThreshold, updatedBy: req.user!.sub } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean();
    clearInventorySettingsCache();
    publicCatalogCache.clear();
    sharedCache.noteInvalidated('catalog');
    void sharedCache.bumpVersion('catalog');
    await recordAudit(req, {
      action: 'commerce.inventory_settings.update',
      entityType: 'commerce_settings',
      after: { lowStockThreshold: req.body.lowStockThreshold },
      reason: req.body.reason,
    });
    sendSuccess(res, { lowStockThreshold: updated?.lowStockThreshold });
  };

  podConfig = async (_req: Request, res: Response) => {
    const s = await CommerceSettings.findOne({ key: 'commerce' }).lean();
    sendSuccess(res, {
      podEnabled: s?.podEnabled ?? false,
      podMinimumOrderMinor: s?.podMinimumOrderMinor ?? 3000000,
      podSurchargeType: s?.podSurchargeType ?? 'flat',
      podSurchargeValue: s?.podSurchargeValue ?? 0,
      defaultPodLimitMinor: s?.defaultPodLimitMinor ?? 10000000,
      podAutoApproveEnabled: s?.podAutoApproveEnabled ?? true,
      podRefusalSuspendCount: s?.podRefusalSuspendCount ?? 2,
      vatRatePercent: s?.vatRatePercent ?? 7.5,
      defaultDeliveryFeeMinor: s?.defaultDeliveryFeeMinor ?? 300000,
      updatedAt: s?.updatedAt,
    });
  };

  updatePodConfig = async (req: Request, res: Response) => {
    const { reason, ...fields } = req.body as Record<string, unknown>;
    const changes = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    const before = await CommerceSettings.findOne({ key: 'commerce' }).lean();
    const updated = await CommerceSettings.findOneAndUpdate(
      { key: 'commerce' },
      { $set: { ...changes, updatedBy: req.user!.sub } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean();
    CheckoutService.clearSettingsCache();
    await recordAudit(req, {
      action: 'commerce.pod_config.update',
      entityType: 'commerce_settings',
      before: Object.fromEntries(Object.keys(changes).map((key) => [key, (before as Record<string, unknown> | null)?.[key]])),
      after: changes,
      reason: reason as string,
    });
    publishConfigChanged('commerce');
    sendSuccess(res, { ...changes, updatedAt: updated?.updatedAt });
  };

  checkoutSettings = async (_req: Request, res: Response) => {
    const settings = await CommerceSettings.findOne({ key: 'commerce' }).select('minimumCheckoutMinor updatedAt').lean();
    sendSuccess(res, { minimumCheckoutMinor: settings?.minimumCheckoutMinor ?? 1800000, updatedAt: settings?.updatedAt });
  };

  updateCheckoutSettings = async (req: Request, res: Response) => {
    const updated = await CommerceSettings.findOneAndUpdate(
      { key: 'commerce' },
      { $set: { minimumCheckoutMinor: req.body.minimumCheckoutMinor, updatedBy: req.user!.sub } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean();
    await recordAudit(req, {
      action: 'commerce.checkout_settings.update',
      entityType: 'commerce_settings',
      after: { minimumCheckoutMinor: req.body.minimumCheckoutMinor },
      reason: req.body.reason,
    });
    CheckoutService.clearSettingsCache();
    publishConfigChanged('commerce');
    sendSuccess(res, { minimumCheckoutMinor: updated?.minimumCheckoutMinor, updatedAt: updated?.updatedAt });
  };

  hookCoinSettings = async (_req: Request, res: Response) => {
    const settings = await CommerceSettings.findOne({ key: 'commerce' })
      .select('orderEarnEnabled orderEarnPercent orderEarnMaxMinor creditSpendCapPercent welcomeBonusMinor referralSignupBonusMinor referralReferrerBonusMinor updatedAt')
      .lean();
    sendSuccess(res, {
      orderEarnEnabled: settings?.orderEarnEnabled ?? true,
      orderEarnPercent: settings?.orderEarnPercent ?? 1,
      orderEarnMaxMinor: settings?.orderEarnMaxMinor ?? 0,
      creditSpendCapPercent: settings?.creditSpendCapPercent ?? 20,
      welcomeBonusMinor: settings?.welcomeBonusMinor ?? 30000,
      referralSignupBonusMinor: settings?.referralSignupBonusMinor ?? 30000,
      referralReferrerBonusMinor: settings?.referralReferrerBonusMinor ?? 100000,
      updatedAt: settings?.updatedAt,
    });
  };

  updateHookCoinSettings = async (req: Request, res: Response) => {
    // Only the keys actually sent are written, so a PATCH of one field cannot reset the others to their defaults.
    const { reason, ...fields } = req.body as Record<string, unknown>;
    const changes = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    const updated = await CommerceSettings.findOneAndUpdate(
      { key: 'commerce' },
      { $set: { ...changes, updatedBy: req.user!.sub } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean();
    await recordAudit(req, {
      action: 'commerce.hook_coin_settings.update',
      entityType: 'commerce_settings',
      after: changes,
      reason: reason as string,
    });
    publishConfigChanged('commerce');
    sendSuccess(res, {
      orderEarnEnabled: updated?.orderEarnEnabled,
      orderEarnPercent: updated?.orderEarnPercent,
      orderEarnMaxMinor: updated?.orderEarnMaxMinor,
      creditSpendCapPercent: updated?.creditSpendCapPercent,
      welcomeBonusMinor: updated?.welcomeBonusMinor,
      referralSignupBonusMinor: updated?.referralSignupBonusMinor,
      referralReferrerBonusMinor: updated?.referralReferrerBonusMinor,
    });
  };
}
