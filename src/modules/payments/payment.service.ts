import { createHash } from "crypto";
import mongoose, { isValidObjectId, type ClientSession } from "mongoose";
import {
  CommerceOrderStatus,
  CommercePaymentStatus,
  OrderStatus,
  PaymentStatus,
  ShipmentStatus,
} from "@lib/constants";
import type { MongoRepository as Repository } from "@lib/mongo-repository";
import { IntegrationException, PaymentWebhookEvent } from "@models/commerce/commerce.model";
import { CommerceOutboxEvent } from "@modules/platform";
import { Order } from "@models/orders/order.model";
import { OrderFulfilmentGroup } from "@models/orders/order-fulfilment-group.model";
import { Payment } from "@models/payments/payment.model";
import { Shipment } from "@models/fulfilment/fulfilment.model";
import { EscrowLedger } from "@models/payments/escrow-ledger.model";
import { User } from "@models/users/user.model";
import { nextPublicId } from "@modules/platform";
import { createCommerceNotification } from "@modules/notifications";
import { EmailService } from "@emails/email.service";
import { ReferralService } from "@modules/orders";
import { CreditService } from "@modules/orders";
import { CreditLedger } from "@models/promotions/credit-ledger.model";
import { HttpError, isDuplicateKeyError } from "@utils/http";
import { defaultProviderName, paymentProvider, type ProviderName } from "@modules/payments/providers/provider-registry";
import { PaymentAttempt, PaymentLink } from "@models/payments/payment-link.model";
import { publishRealtime } from "@modules/platform";
import { timelineEntry } from "@lib/order-timeline";
import { emitOutbox } from "@modules/platform";
import { wakeOutbox } from "../../jobs/wake";
import { notifyStaffByPermission } from "@modules/notifications";

/** True when the provider may have acted on the request even though it failed. */
export function isAmbiguousProviderError(error: unknown) {
  const err = error as { code?: string; details?: { httpStatus?: number } };
  if (err?.code === 'PAYMENT_PROVIDER_UNAVAILABLE') return true;
  return err?.code === 'PAYMENT_PROVIDER_ERROR' && Number(err.details?.httpStatus || 0) >= 500;
}

function identity(value: string) {
  return isValidObjectId(value)
    ? { $or: [{ _id: value }, { publicId: value }] }
    : { publicId: value };
}

export class PaymentService {
  private email = new EmailService();
  private referrals = new ReferralService();
  private credits = new CreditService();
  constructor(
    _payments?: Repository<Payment>,
    _orders?: Repository<Order>,
    _ledger?: Repository<EscrowLedger>,
  ) {}

  async initialize(customerId: string, orderIdentifier: string, fulfilmentGroupIdentifier?: string) {
    const order = await Order.findOne({
      ...identity(orderIdentifier),
      userId: customerId,
    });
    if (!order || !["PREPAID", "PAY_AT_HANDOVER"].includes(String(order.commercePaymentMethod))) throw new HttpError(404, "Order not found");
    // A Pay on Delivery order first asks for its delivery fee online; the balance is due at the door afterwards.
    const awaitingFee = order.commercePaymentMethod === "PAY_AT_HANDOVER"
      && order.commerceStatus === CommerceOrderStatus.AWAITING_DELIVERY_FEE
      && !fulfilmentGroupIdentifier;
    if (order.commercePaymentMethod === "PAY_AT_HANDOVER" && !awaitingFee) {
      const shipment = await Shipment.findOne({ orderId: order.id, status: ShipmentStatus.AWAITING_HANDOVER_PAYMENT, releaseStatus: "AWAITING_HANDOVER_PAYMENT" }).lean();
      if (!shipment) throw new HttpError(409, "Pay-at-Handover payment is not due for this Order yet", undefined, "PAYMENT_INITIALIZATION_NOT_ALLOWED");
    }
    return this.initializeOrder(order, customerId, fulfilmentGroupIdentifier);
  }

  async initializeForPartner(partnerId: string, orderIdentifier: string) {
    const order = await Order.findOne({
      ...identity(orderIdentifier),
      initiatingPartnerId: partnerId,
      channel: "PARTNER_ASSISTED",
      commercePaymentMethod: "PREPAID",
    });
    if (!order) throw new HttpError(404, "Order not found");
    if (!order.userId)
      throw new HttpError(
        409,
        "Order customer is missing",
        undefined,
        "PAYMENT_INITIALIZATION_NOT_ALLOWED",
      );
    return this.initializeOrder(order, order.userId);
  }

  private async initializeOrder(order: any, customerId: string, fulfilmentGroupIdentifier?: string) {
    if (order.commercePaymentStatus === CommercePaymentStatus.CONFIRMED)
      return this.status(customerId, order.publicId || order.id);
    if (order.commerceStatus === CommerceOrderStatus.CANCELLED)
      throw new HttpError(
        409,
        "Cancelled Order cannot be paid",
        undefined,
        "PAYMENT_INITIALIZATION_NOT_ALLOWED",
      );
    const customer = await User.findById(customerId).lean();
    if (!customer?.email)
      throw new HttpError(409, "Customer email is required for payment");
    const payment = await Payment.findOne({
      orderId: order.id,
      // A substitution top-up's Payment also has no fulfilmentGroupId, so it must be excluded explicitly here — otherwise this could match the wrong Payment.
      itemResolutionId: { $exists: false },
      ...(fulfilmentGroupIdentifier ? { fulfilmentGroupId: fulfilmentGroupIdentifier } : { fulfilmentGroupId: { $exists: false } }),
    });
    if (!payment)
      throw new HttpError(
        409,
        "Order payment record is missing",
        undefined,
        "PAYMENT_RECORD_MISSING",
      );
    if (
      payment.authorizationUrl &&
      payment.commerceStatus === CommercePaymentStatus.PROCESSING
    )
      return this.publicPayment(payment);
    // Honour the gateway already stored on the payment rather than re-resolving the default, so it initializes against the provider it was created against.
    const providerName = (payment.gateway || "paystack") as ProviderName;
    const initialized = await paymentProvider(providerName).initialize({
      reference: payment.transactionRef,
      amountMinor: Number(payment.amountMinor),
      currency: order.currency || "NGN",
      email: customer.email,
      callbackUrl: (() => {
        const envVar = providerName === "monnify" ? "MONNIFY_CALLBACK_URL" : "PAYSTACK_CALLBACK_URL";
        const callbackPath = providerName === "monnify" ? "monnify" : "paystack";
        const url = process.env[envVar] ||
          `${String(process.env.APP_URL || "http://localhost:4000").replace(/\/$/, "")}/api/v1/payments/${callbackPath}/callback`;
        // The provider must be able to send the customer back: a localhost or plain-http address only works on a dev machine.
        if (process.env.NODE_ENV === "production" && !/^https:\/\//i.test(url)) {
          throw new HttpError(503, "Card payments are not configured. Please try again later.", undefined, "SERVICE_UNAVAILABLE" as any);
        }
        return url;
      })(),
      metadata: {
        orderId: order.publicId,
        paymentId: payment.publicId,
        fulfilmentGroupId: payment.fulfilmentGroupId,
        customerId: customer.publicId,
        channel: order.channel,
      },
    });
    payment.authorizationUrl = initialized.authorizationUrl;
    payment.accessCode = initialized.accessCode;
    payment.commerceStatus = CommercePaymentStatus.PROCESSING;
    payment.status = PaymentStatus.PENDING;
    payment.gatewayResponse = {
      initializedAt: new Date(),
      reference: initialized.reference,
    };
    // Payment and order move to PROCESSING together, and only from a non-confirmed state, so a concurrent webhook can't be overwritten.
    const session = await mongoose.startSession();
    let moved = false;
    try {
      await session.withTransaction(async () => {
        const paymentUpdate = await Payment.updateOne(
          { _id: payment._id, commerceStatus: { $ne: CommercePaymentStatus.CONFIRMED } },
          {
            $set: {
              authorizationUrl: payment.authorizationUrl,
              accessCode: payment.accessCode,
              commerceStatus: CommercePaymentStatus.PROCESSING,
              status: PaymentStatus.PENDING,
              gatewayResponse: payment.gatewayResponse,
            },
          },
          { session },
        );
        moved = paymentUpdate.modifiedCount > 0;
        if (!moved) return;
        await Order.updateOne(
          { _id: order._id, commercePaymentStatus: { $ne: CommercePaymentStatus.CONFIRMED } },
          { $set: { commercePaymentStatus: CommercePaymentStatus.PROCESSING } },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
    if (!moved) return this.status(customerId, order.publicId || order.id);
    order.commercePaymentStatus = CommercePaymentStatus.PROCESSING;
    this.publishOrderUpdate(order);
    return this.publicPayment(payment);
  }

  async status(customerId: string, paymentOrOrderIdentifier: string) {
    let payment = await Payment.findOne({
      ...identity(paymentOrOrderIdentifier),
    });
    if (!payment) {
      const order = await Order.findOne({
        ...identity(paymentOrOrderIdentifier),
        userId: customerId,
      }).lean({ virtuals: true });
      if (!order) throw new HttpError(404, "Payment not found");
      payment = await Payment.findOne({ orderId: order._id.toString(), itemResolutionId: { $exists: false } });
    }
    if (!payment?.orderId) throw new HttpError(404, "Payment not found");
    if (payment.commerceStatus === CommercePaymentStatus.PROCESSING) {
      await this.verifyByReference(payment).catch(() => undefined);
      payment = (await Payment.findById(payment._id)) || payment;
    }
    const order = await Order.findOne({
      _id: payment.orderId,
      userId: customerId,
    }).lean({ virtuals: true });
    if (!order) throw new HttpError(404, "Payment not found");
    // Return payment, earnings and delivery estimate together so the success screen doesn't need a separate order fetch.
    const earned = order.userId
      ? await CreditLedger.findOne({
          userId: String(order.userId),
          orderId: String(order.publicId || order._id),
          type: 'order_earn',
          amountMinor: { $gt: 0 },
        }).select('amountMinor').lean()
      : null;
    return {
      payment: this.publicPayment(payment),
      order: {
        id: order.publicId,
        status: order.commerceStatus,
        paymentStatus: order.commercePaymentStatus,
        totalMinor: Number(order.totalMinor ?? Math.round(Number(order.total || 0) * 100)),
        currency: order.currency || 'NGN',
        estimatedDeliveryAt: order.scheduledDeliveryAt,
        creditsEarnedMinor: Number(earned?.amountMinor || 0),
      },
    };
  }

  /** Self-heal fallback that re-verifies a still-PROCESSING payment against the provider so confirmation doesn't depend solely on the webhook; never throws. */
  private async verifyByReference(payment: any): Promise<{ confirmed: boolean }> {
    if (payment.commerceStatus === CommercePaymentStatus.CONFIRMED) return { confirmed: true };
    if (!payment.transactionRef) return { confirmed: false };
    const attempt = await PaymentAttempt.findOne({ reference: payment.transactionRef });
    const providerName = (attempt?.provider || payment.gateway || "paystack") as ProviderName;
    const verified = await paymentProvider(providerName)
      .verify(payment.transactionRef)
      .catch(() => undefined);
    if (!verified || verified.status !== "success") return { confirmed: false };
    if (
      verified.reference !== payment.transactionRef ||
      verified.amountMinor !== payment.amountMinor ||
      verified.currency !== payment.currency
    )
      return { confirmed: false };
    await this.confirmPayment(payment, verified.providerId, verified.paidAt);
    if (attempt) {
      attempt.status = "confirmed";
      attempt.providerReference = verified.providerId;
      attempt.completedAt = new Date();
      await attempt.save();
    }
    return { confirmed: true };
  }

  /** Safety net for a missing webhook: finds payments still PROCESSING after a grace period and re-verifies them with the provider. */
  async reconcileStalePayments(limit = 20) {
    const stale = await Payment.find({
      commerceStatus: CommercePaymentStatus.PROCESSING,
      updatedAt: { $lt: new Date(Date.now() - 2 * 60_000), $gt: new Date(Date.now() - 48 * 60 * 60_000) },
    }).sort({ updatedAt: 1 }).limit(limit);
    let confirmed = 0;
    for (const payment of stale) {
      const result = await this.verifyByReference(payment).catch(() => ({ confirmed: false }));
      if (result.confirmed) confirmed += 1;
    }
    return { checked: stale.length, confirmed };
  }

  async webhook(providerName: ProviderName, rawBody: Buffer, signature: string, requestId?: string) {
    const provider = paymentProvider(providerName);
    const parsed = provider.parseWebhook(rawBody, signature);
    const payloadHash = createHash("sha256").update(rawBody).digest("hex");
    let event;
    try {
      event = await PaymentWebhookEvent.create({
        provider: providerName,
        providerEventId: parsed.providerEventId,
        payloadHash,
        eventType: parsed.eventType,
        reference: parsed.reference,
        signatureVerified: true,
        processingStatus: "received",
      });
    } catch (error: any) {
      if (!isDuplicateKeyError(error)) throw error;
      // Only a fully handled delivery is a true duplicate; one that failed or died mid-way must be reprocessed, which is safe since confirmPayment is idempotent.
      const previous = await PaymentWebhookEvent.findOne({ provider: providerName, providerEventId: parsed.providerEventId });
      if (!previous || ["processed", "ignored"].includes(previous.processingStatus)) return { received: true, duplicate: true };
      event = previous;
    }
    if (!provider.isSuccessEvent(parsed.eventType) || !parsed.reference) {
      event.processingStatus = "ignored";
      event.processedAt = new Date();
      await event.save();
      return { received: true, ignored: true };
    }
    const attempt = await PaymentAttempt.findOne({ reference: parsed.reference });
    const payment = attempt ? await Payment.findById(attempt.paymentId) : await Payment.findOne({ transactionRef: parsed.reference });
    if (!payment?.orderId) {
      event.processingStatus = "ignored";
      event.failureCode = "PAYMENT_NOT_FOUND";
      await event.save();
      return { received: true, matched: false };
    }
    try {
      const verified = await provider.verify(parsed.reference);
      if (verified.reference !== parsed.reference)
        throw new HttpError(
          409,
          "Provider reference mismatch",
          undefined,
          "PAYMENT_EVIDENCE_MISMATCH",
        );
      if (verified.amountMinor !== payment.amountMinor)
        throw new HttpError(
          409,
          "Provider amount mismatch",
          undefined,
          "PAYMENT_EVIDENCE_MISMATCH",
        );
      if (verified.currency !== payment.currency)
        throw new HttpError(
          409,
          "Provider currency mismatch",
          undefined,
          "PAYMENT_EVIDENCE_MISMATCH",
        );
      if (verified.status !== "success")
        throw new HttpError(
          409,
          "Provider status is not successful",
          undefined,
          "PAYMENT_EVIDENCE_MISMATCH",
        );
      await this.confirmPayment(
        payment,
        verified.providerId,
        verified.paidAt,
        parsed.providerEventId,
      );
      if (attempt) {
        attempt.status = "confirmed";
        attempt.providerReference = verified.providerId;
        attempt.completedAt = new Date();
        await attempt.save();
      }
      event.processingStatus = "processed";
      event.processedAt = new Date();
      await event.save();
      return { received: true, processed: true };
    } catch (error: any) {
      event.processingStatus = "failed";
      event.failureCode = error?.code || "PAYMENT_EVIDENCE_MISMATCH";
      await event.save();
      // One open exception per (reference, type): Paystack retries a failing
      // webhook, and each retry used to write another row.
      const exceptionType = error?.message?.toLowerCase().includes("amount") ? "amount" : "status";
      const exceptionResult = await IntegrationException.updateOne(
        { provider: providerName, reference: parsed.reference, type: exceptionType, status: "open" },
        {
          $set: { requestId, details: { code: error?.code, message: error?.message } },
          $setOnInsert: { paymentId: payment.id, orderId: payment.orderId },
        },
        { upsert: true },
      ).catch(() => undefined);
      // Only alert on the row actually being created — a retried webhook hitting
      // the same open exception must not re-notify finance every time.
      if (exceptionResult?.upsertedCount) {
        const order = await Order.findById(payment.orderId).select("publicId sourceStateId").lean() as any;
        await notifyStaffByPermission({
          permission: "finance.refunds.view", stateId: order?.sourceStateId,
          eventKeyPrefix: `payment-exception:${providerName}:${parsed.reference}:${exceptionType}`,
          title: `Payment ${exceptionType} mismatch`, body: `${order?.publicId || payment.id} — ${providerName} webhook could not be reconciled: ${error?.message || 'unknown error'}`,
          type: "order_updated", data: { orderId: order?.publicId, href: order?.publicId ? `/dashboard/orders/${order.publicId}` : undefined },
        });
      }
      throw error;
    }
  }

  /** Refunds a Pay on Delivery customer's online delivery fee if the order is cancelled before dispatch; safe to call twice. */
  async refundDeliveryFee(orderId: string) {
    try {
      const shipmentStarted = await Shipment.exists({ orderId, status: { $nin: [ShipmentStatus.CANCELLED] } } as any);
      if (shipmentStarted) return { refunded: false, reason: "dispatched" as const };
      const payment = await Payment.findOne({ orderId, fulfilmentGroupId: { $exists: false }, itemResolutionId: { $exists: false }, commerceStatus: CommercePaymentStatus.CONFIRMED });
      if (!payment) return { refunded: false, reason: "no_fee_paid" as const };
      const amountMinor = Number(payment.amountMinor || 0) - Number(payment.refundedAmount || 0);
      if (amountMinor < 1) return { refunded: false, reason: "already_refunded" as const };
      await this.refund(String(payment._id), amountMinor, `delivery-fee-refund:${orderId}`);
      return { refunded: true, amountMinor };
    } catch (error) {
      console.error("[pod] delivery fee refund failed", orderId, error);
      return { refunded: false, reason: "failed" as const };
    }
  }

  async approvePodPayment(orderId: string) {
    const payment = await Payment.findOne({ orderId, itemResolutionId: { $exists: false } });
    if (!payment) throw new HttpError(409, "Payment record is missing");
    payment.commerceStatus = CommercePaymentStatus.DUE_AT_HANDOVER;
    await payment.save();
  }

  async verifyAttempt(attemptIdentifier: string) {
    const attempt = await PaymentAttempt.findOne(
      isValidObjectId(attemptIdentifier)
        ? { $or: [{ publicId: attemptIdentifier }, { _id: attemptIdentifier }] }
        : { publicId: attemptIdentifier },
    );
    if (!attempt) throw new HttpError(404, "Payment attempt not found");
    const payment = await Payment.findById(attempt.paymentId);
    if (!payment) throw new HttpError(404, "Payment record not found");
    if (payment.commerceStatus === CommercePaymentStatus.CONFIRMED) return { confirmed: true };
    const verified = await paymentProvider(attempt.provider).verify(attempt.reference);
    if (verified.status !== "success") return { confirmed: false, status: verified.status };
    if (verified.reference !== attempt.reference || verified.amountMinor !== payment.amountMinor || verified.currency !== payment.currency) {
      throw new HttpError(409, "Payment evidence does not match this Order", undefined, "PAYMENT_EVIDENCE_MISMATCH");
    }
    await this.confirmPayment(payment, verified.providerId, verified.paidAt);
    attempt.status = "confirmed";
    attempt.providerReference = verified.providerId;
    attempt.completedAt = new Date();
    await attempt.save();
    return { confirmed: true };
  }

  /** The single place a payment becomes confirmed; core writes commit in one transaction and side effects go through the outbox, replay-safe against races. */
  private async confirmPayment(
    payment: any,
    providerId?: string,
    paidAt?: Date,
    providerEventId?: string,
  ) {
    // A replacement-item top-up is a Payment like any other for checkout purposes, but confirming
    // it must never run the order-activation machinery below — it adjusts one item, not the order.
    if (payment.itemResolutionId) {
      await this.confirmSubstitutionPayment(payment, paidAt || new Date(), providerId, providerEventId);
      return;
    }
    const order = await Order.findById(payment.orderId);
    if (!order || !["PREPAID", "PAY_AT_HANDOVER"].includes(String(order.commercePaymentMethod)))
      throw new HttpError(409, "Payment cannot activate this Order");
    const handover = order.commercePaymentMethod === "PAY_AT_HANDOVER";
    const group = handover && payment.fulfilmentGroupId
      ? await OrderFulfilmentGroup.findOne({ publicId: payment.fulfilmentGroupId }).lean()
      : undefined;
    const orderKey = String(order.publicId || order.id);
    const paymentKey = String(payment.publicId || payment._id);
    const confirmedAt = paidAt || new Date();
    const actorId = payment.gateway === "monnify" ? "MONNIFY_WEBHOOK" : "PAYSTACK_WEBHOOK";
    let activated = false;
    let paidAfterCancelled = false;

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        activated = false;
        const transition = await Payment.updateOne(
          { _id: payment._id, commerceStatus: { $ne: CommercePaymentStatus.CONFIRMED } },
          {
            $set: {
              commerceStatus: CommercePaymentStatus.CONFIRMED,
              status: PaymentStatus.SUCCESSFUL,
              gatewayRef: providerId,
              ...(providerEventId ? { providerEventId } : {}),
              paidAt: confirmedAt,
              amountSettled: payment.amount,
            },
          },
          { session },
        );
        const transitioned = transition.modifiedCount > 0;
        await PaymentLink.updateMany(
          { paymentId: String(payment._id), status: { $in: ["active", "processing"] } },
          { $set: { status: "paid", usedAt: new Date() } },
          { session },
        );

        // Pay on Delivery's first step, the online delivery fee, moves the order into review or straight to approval if eligible.
        if (handover && !payment.fulfilmentGroupId) {
          if (!transitioned) return;
          const review = (order.podReview as any) || {};
          const customer = order.userId ? await User.findById(order.userId).select("podEligible").session(session).lean() as any : null;
          const autoApprove = review.autoApprove === true && customer?.podEligible !== false;
          const nextStatus = autoApprove
            ? CommerceOrderStatus.APPROVED_FOR_FULFILMENT
            : review.highValue ? CommerceOrderStatus.VERIFICATION_PENDING : CommerceOrderStatus.OPERATIONS_REVIEW;
          const nextLegacy = autoApprove
            ? OrderStatus.APPROVED_FOR_FULFILMENT
            : review.highValue ? OrderStatus.VERIFICATION_PENDING : OrderStatus.OPERATIONS_REVIEW;
          const moved = await Order.updateOne(
            { _id: order._id, commerceStatus: CommerceOrderStatus.AWAITING_DELIVERY_FEE },
            {
              $set: { podFeePaid: true, commerceStatus: nextStatus, status: nextLegacy, commercePaymentStatus: CommercePaymentStatus.DUE_AT_HANDOVER },
              $push: { timeline: timelineEntry(nextStatus, actorId, { note: autoApprove ? "Delivery fee paid; approved automatically" : "Delivery fee paid; awaiting review" }) },
            },
            { session },
          );
          if (moved.modifiedCount) {
            if (autoApprove) await this.emitOrderApproved(order as any, session);
            await emitOutbox([{
              aggregateType: "payment",
              aggregateId: String(payment._id),
              eventType: "PAYMENT_CONFIRMED_EFFECTS",
              payload: { paymentId: paymentKey, orderId: orderKey, flow: autoApprove ? "delivery_fee_approved" : "delivery_fee" },
            }], session);
            activated = true;
          }
          return;
        }

        if (handover) {
          // Nothing to repair for handover payments: only the first transition acts.
          if (!transitioned) return;
          const outstanding = await Payment.countDocuments({
            orderId: String(order._id),
            _id: { $ne: payment._id },
            commerceStatus: { $ne: CommercePaymentStatus.CONFIRMED },
          }).session(session);
          await Order.updateOne(
            { _id: order._id },
            {
              $set: {
                commercePaymentStatus: outstanding ? CommercePaymentStatus.DUE_AT_HANDOVER : CommercePaymentStatus.CONFIRMED,
                paymentStatus: outstanding ? PaymentStatus.PENDING : PaymentStatus.SUCCESSFUL,
              },
              $push: { timeline: timelineEntry("HANDOVER_PAYMENT_CONFIRMED", actorId) },
            },
            { session },
          );
          await Shipment.findOneAndUpdate(
            {
              orderId: order.id,
              ...(group?.sourceStateId ? { sourceStateId: group.sourceStateId } : {}),
              status: ShipmentStatus.AWAITING_HANDOVER_PAYMENT,
              releaseStatus: "AWAITING_HANDOVER_PAYMENT",
            },
            {
              $set: { status: ShipmentStatus.RELEASE_APPROVED, releaseStatus: "RELEASE_APPROVED" },
              $push: { trackingEvents: { status: ShipmentStatus.RELEASE_APPROVED, at: new Date(), actorId, note: "Verified handover payment" } },
              $inc: { version: 1 },
            },
            { session },
          );
          await emitOutbox([{
            aggregateType: "payment",
            aggregateId: String(payment._id),
            eventType: "PAYMENT_CONFIRMED_EFFECTS",
            payload: { paymentId: paymentKey, orderId: orderKey, flow: "handover" },
          }], session);
          activated = true;
          return;
        }

        // Prepaid: activate the order the first time, or repair one left inactive by an earlier confirmation.
        const activate = await Order.updateOne(
          // A cancelled order must never be brought back to life by a payment that lands late.
          { _id: order._id, commercePaymentStatus: { $ne: CommercePaymentStatus.CONFIRMED }, commerceStatus: { $ne: CommerceOrderStatus.CANCELLED } },
          {
            $set: {
              commercePaymentStatus: CommercePaymentStatus.CONFIRMED,
              commerceStatus: CommerceOrderStatus.APPROVED_FOR_FULFILMENT,
              paymentStatus: PaymentStatus.SUCCESSFUL,
              status: OrderStatus.APPROVED_FOR_FULFILMENT,
            },
            $push: { timeline: timelineEntry(CommerceOrderStatus.APPROVED_FOR_FULFILMENT, actorId) },
          },
          { session },
        );
        if (!activate.modifiedCount && order.commerceStatus === CommerceOrderStatus.CANCELLED) {
          // The order was already cancelled when payment landed, so open a refund exception for finance instead of silently keeping the money.
          const exceptionResult = await IntegrationException.updateOne(
            { provider: payment.gateway || 'paystack', reference: String(payment.transactionRef || paymentKey), type: 'status', status: 'open' },
            { $setOnInsert: { paymentId: String(payment._id), orderId: orderKey, details: { message: 'Payment confirmed after the order was cancelled. Refund the customer.' } } },
            { upsert: true, session },
          ).catch(() => undefined);
          if (exceptionResult?.upsertedCount) paidAfterCancelled = true;
          return;
        }
        if (!transitioned && !activate.modifiedCount) return;
        if (order.userId) {
          // Hook credit is pure DB work keyed on the order, so it commits with the payment and shows immediately.
          await this.credits.earnOnOrder({
            userId: order.userId,
            orderId: orderKey,
            subtotalMinor: Number(order.subtotalMinor ?? Math.round(Number(order.subtotal || 0) * 100)),
          }, session);
        }
        await emitOutbox([
          {
            aggregateType: "order",
            aggregateId: order.id,
            eventType: "ORDER_APPROVED_FOR_FULFILMENT",
            payload: this.approvedPayload(order),
          },
          {
            aggregateType: "payment",
            aggregateId: String(payment._id),
            eventType: "PAYMENT_CONFIRMED_EFFECTS",
            payload: { paymentId: paymentKey, orderId: orderKey, flow: "prepaid" },
          },
        ], session);
        activated = true;
      });
    } finally {
      await session.endSession();
    }

    // Best-effort immediacy only; the outbox consumer delivers the same update if this process dies here.
    if (activated) {
      wakeOutbox();
      const fresh = await Order.findById(order._id).lean({ virtuals: true });
      if (fresh) this.publishOrderUpdate(fresh);
      if (fresh?.commerceStatus === CommerceOrderStatus.OPERATIONS_REVIEW) {
        await notifyStaffByPermission({
          permission: 'orders.edit', stateId: fresh.sourceStateId,
          eventKeyPrefix: `order:${fresh.publicId}:operations-review`,
          title: 'Order needs operations review', body: `${fresh.publicId} is awaiting review before it can be approved for fulfilment.`,
          type: 'order_operations_review', data: { orderId: fresh.publicId, href: `/dashboard/orders/${fresh.publicId}` },
        });
      }
    }
    if (paidAfterCancelled) {
      await notifyStaffByPermission({
        permission: 'finance.refunds.view', stateId: order.sourceStateId,
        eventKeyPrefix: `payment-exception:${payment.gateway || 'paystack'}:${paymentKey}:paid-after-cancel`,
        title: 'Payment landed on a cancelled order', body: `${orderKey} was already cancelled when this payment confirmed. Refund the customer.`,
        type: 'order_updated', data: { orderId: orderKey, href: `/dashboard/orders/${orderKey}` },
      });
    }
  }

  /** Marks a replacement top-up's Payment CONFIRMED and applies the substitution — no order-activation transaction, since the order is already active. */
  private async confirmSubstitutionPayment(payment: any, confirmedAt: Date, providerId?: string, providerEventId?: string) {
    const transition = await Payment.updateOne(
      { _id: payment._id, commerceStatus: { $ne: CommercePaymentStatus.CONFIRMED } },
      {
        $set: {
          commerceStatus: CommercePaymentStatus.CONFIRMED,
          status: PaymentStatus.SUCCESSFUL,
          gatewayRef: providerId,
          ...(providerEventId ? { providerEventId } : {}),
          paidAt: confirmedAt,
          amountSettled: payment.amount,
        },
      },
    );
    if (!transition.modifiedCount) return;
    await PaymentLink.updateMany(
      { paymentId: String(payment._id), status: { $in: ["active", "processing"] } },
      { $set: { status: "paid", usedAt: new Date() } },
    );
    const { fulfilmentService } = await import('@modules/fulfilment');
    await fulfilmentService.confirmSubstitutionAdjustment(payment.itemResolutionId, providerId || providerEventId, confirmedAt);
  }

  private approvedPayload(order: any) {
    return {
      orderId: order.publicId,
      stateId: order.sourceStateId,
      channel: order.channel,
      deliveryMethod: order.deliveryMethod,
      paymentMethod: order.commercePaymentMethod,
      approvedAt: new Date().toISOString(),
    };
  }

  /** Outbox consumer for PAYMENT_CONFIRMED_EFFECTS: referral bonus, notification and email, each keyed so a replay is harmless. */
  async deliverPaymentConfirmedEffects(event: { payload: Record<string, any> }) {
    const { orderId, paymentId, flow } = event.payload;
    const order = await Order.findOne(identity(String(orderId))).lean({ virtuals: true }) as any;
    if (!order) return;
    this.publishOrderUpdate(order);
    if (!order.userId) return;
    if (flow === "delivery_fee" || flow === "delivery_fee_approved") {
      await createCommerceNotification({
        eventKey: `order:${order.publicId}:delivery-fee-paid`,
        userId: order.userId,
        title: "Delivery fee received",
        body: flow === "delivery_fee_approved"
          ? "Thank you. Your order is approved and we are sourcing it now. You pay the rest when it arrives."
          : "Thank you. Our team will confirm your order shortly. You pay the rest when it arrives.",
        type: "payment_confirmed",
        data: { orderId: order.publicId, paymentId },
      });
      return;
    }
    if (flow === "handover") {
      await createCommerceNotification({
        eventKey: `order:${order.publicId}:handover-payment-confirmed`,
        userId: order.userId,
        title: "Handover payment confirmed",
        body: "Your payment was verified. Your delivery can now be released.",
        type: "payment_confirmed",
        data: { orderId: order.publicId, paymentId },
      });
      return;
    }
    // A referrer's bonus is only released once the referred person has actually paid, which prevents signup farming.
    if (await this.referrals.isFirstPaidOrder(order.userId, String(order._id))) {
      await this.referrals.qualify(order.userId, String(order.publicId || order._id));
    }
    const earned = await CreditLedger.findOne({
      userId: String(order.userId),
      orderId: String(order.publicId || order._id),
      type: "order_earn",
      amountMinor: { $gt: 0 },
    }).select("amountMinor").lean();
    if (earned) await this.credits.announceEarn(String(order.userId), String(order.publicId || order._id), Number(earned.amountMinor));
    await createCommerceNotification({
      eventKey: `order:${order.publicId}:payment-confirmed`,
      userId: order.userId,
      title: "Payment confirmed",
      body: "Your payment was verified and your Order is approved for fulfilment.",
      type: "payment_confirmed",
      data: { orderId: order.publicId, paymentId },
    });
    const customer = await User.findById(order.userId).select("email firstName").lean() as any;
    if (customer?.email) {
      await this.email.sendPaymentConfirmed({
        to: customer.email,
        name: customer.firstName,
        orderCode: order.publicId || String(order._id),
        amount: Number(order.totalMinor || 0) / 100,
      });
    }
  }

  /** Kept for callers outside a transaction (e.g. pay-on-delivery approval). */
  async emitOrderApproved(order: Order, session?: ClientSession) {
    await emitOutbox([{
      aggregateType: "order",
      aggregateId: order.id,
      eventType: "ORDER_APPROVED_FOR_FULFILMENT",
      payload: this.approvedPayload(order),
    }], session);
  }

  private publishOrderUpdate(order: any) {
    publishRealtime({
      type: "order.updated",
      entityId: order.publicId || order._id?.toString() || order.id,
      version: Number(order.version || 1),
      scope: order.sourceStateId ? { stateId: String(order.sourceStateId) } : undefined,
    }, order.userId ? { accountId: String(order.userId), admin: true } : { admin: true });
  }

  async capability() {
    const provider = await defaultProviderName();
    return {
      provider,
      prepaid: paymentProvider(provider).readiness().configured,
      payAtHandover: true,
      tokenization: false,
    };
  }

  /** Issues a provider refund exactly once per idempotency key, reserving the amount atomically first so concurrent refunds can't double-spend the balance. */
  async refund(
    paymentIdentifier: string,
    amountMinor: number,
    idempotencyKey: string,
    options: { alreadyReserved?: boolean } = {},
  ): Promise<{ providerReference?: string }> {
    const payment = await Payment.findOne({
      ...identity(paymentIdentifier),
    });
    if (!payment) throw new HttpError(404, 'Payment record not found', undefined, 'PAYMENT_RECORD_MISSING');
    const captured = Number(payment.amountMinor || Math.round(Number(payment.amount || 0) * 100));
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 1 || amountMinor > captured) {
      throw new HttpError(409, 'Refund exceeds the captured payment balance', undefined, 'REFUND_LIMIT_EXCEEDED');
    }
    if (!payment.transactionRef || !['paystack', 'monnify'].includes(String(payment.gateway))) {
      throw new HttpError(409, 'This captured payment cannot be refunded through its provider', undefined, 'PAYMENT_METHOD_NOT_ALLOWED');
    }
    if (!options.alreadyReserved) {
      const reserved = await Payment.updateOne(
        {
          _id: payment._id,
          $expr: { $lte: [{ $add: [{ $ifNull: ['$refundedAmount', 0] }, amountMinor] }, captured] },
        },
        { $inc: { refundedAmount: amountMinor } },
      );
      if (!reserved.modifiedCount) {
        throw new HttpError(409, 'Refund exceeds the captured payment balance', undefined, 'REFUND_LIMIT_EXCEEDED');
      }
    }
    let result: { providerReference: string };
    try {
      result = await paymentProvider(payment.gateway as ProviderName).refund({
        reference: payment.transactionRef,
        amountMinor,
        reason: 'Refund from Hook',
        idempotencyKey,
      });
    } catch (error) {
      if (isAmbiguousProviderError(error)) {
        throw new HttpError(
          503,
          'The refund outcome is unknown. It will be verified before any retry.',
          { unknown: true },
          'PROVIDER_OUTCOME_UNKNOWN',
        );
      }
      await this.releaseRefundReservation(String(payment._id), amountMinor);
      throw error;
    }
    await this.settleRefund(String(payment._id), captured, result.providerReference);
    return result;
  }

  /** Asks the provider whether a refund with this key was actually created. */
  async reconcileRefund(paymentIdentifier: string, amountMinor: number, idempotencyKey: string) {
    const payment = await Payment.findOne({ ...identity(paymentIdentifier) }).lean();
    if (!payment?.transactionRef) throw new HttpError(404, 'Payment record not found', undefined, 'PAYMENT_RECORD_MISSING');
    const found = await paymentProvider(payment.gateway as ProviderName).lookupRefund({
      reference: payment.transactionRef,
      amountMinor,
      idempotencyKey,
    });
    if (found) {
      const captured = Number(payment.amountMinor || Math.round(Number(payment.amount || 0) * 100));
      await this.settleRefund(String(payment._id), captured, found.providerReference);
    }
    return found;
  }

  /** Gives back an amount reserved for a refund the provider definitively rejected. */
  async releaseRefundReservation(paymentId: string, amountMinor: number) {
    await Payment.updateOne(
      { _id: paymentId, refundedAmount: { $gte: amountMinor } },
      { $inc: { refundedAmount: -amountMinor } },
    );
  }

  private async settleRefund(paymentId: string, captured: number, providerReference?: string) {
    const current = await Payment.findById(paymentId).select('refundedAmount').lean();
    const full = Number(current?.refundedAmount || 0) >= captured;
    await Payment.updateOne(
      { _id: paymentId },
      {
        $set: {
          commerceStatus: full ? CommercePaymentStatus.REFUNDED : CommercePaymentStatus.REFUND_PENDING,
          status: full ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED,
          refundedAt: new Date(),
          'gatewayResponse.lastRefundReference': providerReference,
          'gatewayResponse.lastRefundAt': new Date(),
        },
      },
    );
  }

  private publicPayment(payment: any) {
    return {
      id: payment.publicId || payment.id,
      orderId: payment.orderId,
      provider: payment.gateway || "paystack",
      reference: payment.transactionRef,
      status: payment.commerceStatus,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      authorizationUrl: payment.authorizationUrl,
      accessCode: payment.accessCode,
      paidAt: payment.paidAt,
    };
  }
}
