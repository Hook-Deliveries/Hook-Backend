import { createHash, randomBytes } from "crypto";
import mongoose, { isValidObjectId } from "mongoose";
import { CommercePaymentStatus, PaymentStatus } from "@lib/constants";
import { CommerceSettings } from "@models/commerce/commerce.model";
import { ItemResolution } from "@models/fulfilment/item-resolution.model";
import { OrderItem } from "@models/orders/order-item.model";
import { Order } from "@models/orders/order.model";
import { OrderFulfilmentGroup } from "@models/orders/order-fulfilment-group.model";
import { PaymentAttempt, PaymentLink } from "@models/payments/payment-link.model";
import { Payment } from "@models/payments/payment.model";
import { nextPublicId } from "@modules/platform/public-id.service";
import { paymentProvider, paymentProviderReadiness, type ProviderName } from "@services/payments/provider-registry";
import { HttpError, isDuplicateKeyError } from "@utils/http";
import { PaymentService } from "@services/payment.service";

const ACTIVE_ATTEMPT_STATUSES: Array<"initializing" | "processing"> = ["initializing", "processing"];

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function paymentOrigin() {
  const configured = String(process.env.PAYMENT_WEB_ORIGIN || "https://hook-africa.vercel.app").replace(/\/$/, "");
  if (process.env.NODE_ENV === "production" && !configured.startsWith("https://")) {
    throw new HttpError(503, "Hosted payments are not configured", undefined, "PAYMENT_CONFIGURATION_ERROR");
  }
  return configured;
}

export class PaymentLinkService {
  async create(customerId: string, orderIdentifier: string, fulfilmentGroupId?: string) {
    const order = await Order.findOne({
      ...(isValidObjectId(orderIdentifier) ? { $or: [{ _id: orderIdentifier }, { publicId: orderIdentifier }] } : { publicId: orderIdentifier }),
      userId: customerId,
    }).lean({ virtuals: true });
    if (!order) throw new HttpError(404, "Order not found");
    if (order.commerceStatus === "CANCELLED" || order.commercePaymentStatus === CommercePaymentStatus.CONFIRMED) {
      throw new HttpError(409, "This Order no longer requires payment", undefined, "PAYMENT_INITIALIZATION_NOT_ALLOWED");
    }
    // The online delivery fee of a Pay on Delivery order belongs to the order, so it needs no delivery selected.
    if (order.commercePaymentMethod === "PAY_AT_HANDOVER" && !fulfilmentGroupId && order.commerceStatus !== "AWAITING_DELIVERY_FEE") {
      throw new HttpError(400, "A delivery payment must be selected", undefined, "FULFILMENT_GROUP_REQUIRED");
    }
    const payment = await Payment.findOne({
      orderId: String(order._id),
      // A substitution top-up's Payment also has no fulfilmentGroupId, so it must be excluded explicitly here — otherwise this could match the wrong Payment.
      itemResolutionId: { $exists: false },
      ...(fulfilmentGroupId ? { fulfilmentGroupId } : { fulfilmentGroupId: { $exists: false } }),
    });
    if (!payment) throw new HttpError(409, "Order payment record is missing", undefined, "PAYMENT_RECORD_MISSING");
    if (payment.commerceStatus === CommercePaymentStatus.CONFIRMED) {
      throw new HttpError(409, "This payment is already complete", undefined, "PAYMENT_ALREADY_CONFIRMED");
    }

    await PaymentLink.updateMany(
      { paymentId: String(payment._id), status: { $in: ["active", "processing"] } },
      { $set: { status: "revoked", revokedAt: new Date() } },
    );
    const token = randomBytes(32).toString("base64url");
    const link = await PaymentLink.create({
      publicId: await nextPublicId("paymentLink"),
      tokenHash: hash(token),
      paymentId: String(payment._id),
      orderId: String(order._id),
      fulfilmentGroupId: payment.fulfilmentGroupId,
      customerId,
      provider: "paystack",
      amountMinor: Number(payment.amountMinor || 0),
      currency: payment.currency || order.currency || "NGN",
      status: "active",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      createdBy: customerId,
    });
    const url = `${paymentOrigin()}/payment/${token}`;
    // Fire-and-forget: the customer must still get their link back even if the mail fails.
    void this.emailAwaitingPayment(order, customerId, url, Number(payment.amountMinor || 0));
    return {
      id: link.publicId,
      url,
      token,
      expiresAt: link.expiresAt,
      status: link.status,
    };
  }

  /**
   * The replacement-item top-up flow's equivalent of `create()`: same hosted
   * page (/payment/{token}), same provider-choice and share/revoke semantics,
   * just anchored to a synthetic Payment scoped by itemResolutionId instead
   * of a fulfilmentGroupId — so the customer never sees a different checkout.
   */
  async createForSubstitution(customerId: string, issue: { publicId: string; adjustmentMinor: number }, order: { _id: unknown; currency?: string }) {
    let payment = await Payment.findOne({ itemResolutionId: issue.publicId });
    if (payment?.commerceStatus === CommercePaymentStatus.CONFIRMED) {
      throw new HttpError(409, "This payment is already complete", undefined, "PAYMENT_ALREADY_CONFIRMED");
    }
    if (!payment) {
      const paymentPublicId = await nextPublicId("payment");
      payment = await Payment.create({
        publicId: paymentPublicId,
        orderId: String(order._id),
        itemResolutionId: issue.publicId,
        resourceType: "order",
        transactionRef: `SUB-${paymentPublicId}`,
        gateway: "paystack",
        paymentMethod: "card",
        amount: Number(issue.adjustmentMinor) / 100,
        amountMinor: Number(issue.adjustmentMinor),
        currency: order.currency || "NGN",
        gatewayFee: 0,
        amountSettled: 0,
        status: PaymentStatus.PENDING,
        commerceStatus: CommercePaymentStatus.PENDING,
        refundedAmount: 0,
      });
    }
    await PaymentLink.updateMany(
      { paymentId: String(payment._id), status: { $in: ["active", "processing"] } },
      { $set: { status: "revoked", revokedAt: new Date() } },
    );
    const token = randomBytes(32).toString("base64url");
    const link = await PaymentLink.create({
      publicId: await nextPublicId("paymentLink"),
      tokenHash: hash(token),
      paymentId: String(payment._id),
      orderId: String(order._id),
      itemResolutionId: issue.publicId,
      customerId,
      provider: "paystack",
      amountMinor: Number(issue.adjustmentMinor),
      currency: payment.currency || order.currency || "NGN",
      status: "active",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      createdBy: customerId,
    });
    return {
      id: link.publicId,
      url: `${paymentOrigin()}/payment/${token}`,
      token,
      expiresAt: link.expiresAt,
      status: link.status,
    };
  }

  /**
   * Puts the payment link in the customer's inbox, so abandoning checkout does
   * not strand the order behind a link that only existed in that app session.
   */
  private async emailAwaitingPayment(order: any, customerId: string, paymentUrl: string, amountMinor: number) {
    try {
      const { EmailService } = await import('@emails/email.service');
      const { User } = await import('@models/users/user.model');
      const customer = await User.findById(customerId).select('email firstName').lean() as any;
      const to = customer?.email || order.guestEmail;
      if (!to) return;
      const items = await OrderItem.find({ orderId: String(order._id) })
        .select('productTitle productImage quantity totalPriceMinor')
        .lean() as any[];
      await new EmailService().sendOrderAwaitingPayment({
        to,
        name: customer?.firstName || order.guestName,
        orderCode: order.publicId || order.orderCode,
        amount: amountMinor / 100,
        paymentUrl,
        lines: items.map((item) => ({
          title: item.productTitle || 'Product',
          quantity: Number(item.quantity || 0),
          amount: Number(item.totalPriceMinor || 0) / 100,
          imageUrl: item.productImage,
        })),
      });
    } catch {
      // Never let a mail failure break payment-link creation.
    }
  }

  async detail(token: string) {
    const link = await this.resolve(token);
    const isSubstitution = Boolean(link.itemResolutionId);
    const [order, payment, items, settings, group, substitution] = await Promise.all([
      Order.findById(link.orderId).select("publicId orderCode commerceStatus commercePaymentStatus subtotalMinor vatRate vatMinor deliveryFeeMinor couponCode couponDiscountMinor creditsAppliedMinor totalMinor currency").lean(),
      Payment.findById(link.paymentId).select("publicId commerceStatus paidAt gateway amountMinor currency").lean(),
      isSubstitution
        ? Promise.resolve([])
        : OrderItem.find({ orderId: link.orderId, ...(link.fulfilmentGroupId ? { fulfilmentGroupId: link.fulfilmentGroupId } : {}) })
          .select("publicId productTitle productImage quantity selectedVariants unitPriceMinor totalPriceMinor currency")
          .lean({ virtuals: true }),
      CommerceSettings.findOne({ key: "commerce" }).select("paymentProviders").lean(),
      link.fulfilmentGroupId
        ? OrderFulfilmentGroup.findOne({ publicId: link.fulfilmentGroupId }).select("subtotalMinor vatShareMinor deliveryFeeShareMinor").lean()
        : Promise.resolve(null),
      isSubstitution
        ? ItemResolution.findOne({ publicId: link.itemResolutionId }).select("proposal originalSnapshot").lean()
        : Promise.resolve(null),
    ]);
    if (!order || !payment) throw new HttpError(404, "Payment link not found");
    await PaymentLink.updateOne({ _id: link._id }, { $set: { lastAccessedAt: new Date() } });
    const readiness = Object.fromEntries(paymentProviderReadiness().map((entry) => [entry.provider, entry]));
    const configured = settings?.paymentProviders?.length ? settings.paymentProviders : [
      { provider: "paystack" as const, enabled: true, displayOrder: 1, isDefault: true },
    ];
    const providers = configured
      .filter((entry) => entry.enabled && readiness[entry.provider]?.configured)
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((entry) => ({ provider: entry.provider, isDefault: entry.isDefault, mode: readiness[entry.provider].mode }));
    const substitutionProposal = substitution?.proposal as Record<string, unknown> | undefined;
    const substitutionItems = substitutionProposal ? [{
      id: link.itemResolutionId,
      title: String(substitutionProposal.productTitle || (substitution?.originalSnapshot as any)?.title || "Replacement item"),
      imageUrl: (substitution?.originalSnapshot as any)?.image,
      quantity: Number(substitutionProposal.quantity || 1),
      selectedVariants: substitutionProposal.selectedVariants,
      unitPriceMinor: link.amountMinor,
      totalPriceMinor: link.amountMinor,
    }] : [];
    return {
      id: link.publicId,
      status: payment.commerceStatus === CommercePaymentStatus.CONFIRMED ? "paid" : link.status,
      expiresAt: link.expiresAt,
      purpose: isSubstitution ? "Item replacement" : link.fulfilmentGroupId ? "Delivery payment" : "Order payment",
      order: {
        id: order.publicId,
        reference: order.orderCode || order.publicId,
        subtotalMinor: isSubstitution ? link.amountMinor : link.fulfilmentGroupId ? Number(group?.subtotalMinor || items.reduce((sum, item) => sum + Number(item.totalPriceMinor || 0), 0)) : Number(order.subtotalMinor || 0),
        vatRate: isSubstitution ? 0 : Number(order.vatRate || 0),
        vatMinor: isSubstitution ? 0 : link.fulfilmentGroupId ? Number(group?.vatShareMinor || 0) : Number(order.vatMinor || 0),
        deliveryFeeMinor: isSubstitution ? 0 : link.fulfilmentGroupId ? Number(group?.deliveryFeeShareMinor || 0) : Number(order.deliveryFeeMinor || 0),
        couponCode: isSubstitution || link.fulfilmentGroupId ? undefined : order.couponCode,
        couponDiscountMinor: isSubstitution || link.fulfilmentGroupId ? 0 : Number(order.couponDiscountMinor || 0),
        creditsAppliedMinor: isSubstitution || link.fulfilmentGroupId ? 0 : Number(order.creditsAppliedMinor || 0),
        totalMinor: link.amountMinor,
        currency: link.currency,
        items: isSubstitution ? substitutionItems : items.map((item) => ({
          id: item.publicId,
          title: item.productTitle,
          imageUrl: item.productImage,
          quantity: item.quantity,
          selectedVariants: item.selectedVariants,
          unitPriceMinor: item.unitPriceMinor,
          totalPriceMinor: item.totalPriceMinor,
        })),
      },
      providers,
      paidAt: payment.paidAt,
    };
  }

  async initialize(token: string, providerName: ProviderName, idempotencyKey: string, appReturn = false) {
    if (!idempotencyKey || idempotencyKey.length > 160) throw new HttpError(400, "Idempotency-Key is required");
    const link = await this.resolve(token);
    const existing = await PaymentAttempt.findOne({ paymentLinkId: String(link._id), idempotencyKey });
    if (existing) return this.publicAttempt(existing);

    const [settings, payment, order] = await Promise.all([
      CommerceSettings.findOne({ key: "commerce" }).select("paymentProviders").lean(),
      Payment.findById(link.paymentId),
      Order.findById(link.orderId).lean(),
    ]);
    if (!payment || !order) throw new HttpError(404, "Payment link not found");
    const configuration = settings?.paymentProviders?.find((entry) => entry.provider === providerName);
    const provider = paymentProvider(providerName);
    if (!configuration?.enabled || !provider.readiness().configured) {
      throw new HttpError(503, "Selected payment provider is unavailable", undefined, "PAYMENT_PROVIDER_UNAVAILABLE");
    }
    if (payment.commerceStatus === CommercePaymentStatus.CONFIRMED) {
      throw new HttpError(409, "This payment is already complete", undefined, "PAYMENT_ALREADY_CONFIRMED");
    }
    // An unexpired attempt already holds a valid provider checkout URL, so
    // hand the customer straight back to it rather than refusing. Blocking
    // here stranded anyone who opened the page and came back — including
    // after a dropped connection — until the 15 minute window elapsed.
    const active = await PaymentAttempt.findOne({
      paymentId: String(payment._id),
      status: { $in: ACTIVE_ATTEMPT_STATUSES },
      expiresAt: { $gt: new Date() },
    });
    if (active?.authorizationUrl) return this.publicAttempt(active);
    // An attempt with no URL never reached the provider, so it is dead weight;
    // retire it and start cleanly instead of making the customer wait it out.
    if (active) {
      await PaymentAttempt.updateOne(
        { _id: active._id },
        { $set: { status: "cancelled", completedAt: new Date() } },
      );
    }
    await PaymentAttempt.updateMany(
      { paymentId: String(payment._id), status: { $in: ACTIVE_ATTEMPT_STATUSES }, expiresAt: { $lte: new Date() } },
      { $set: { status: "expired", completedAt: new Date() } },
    );

    const publicId = await nextPublicId("paymentAttempt");
    const reference = `HK-${publicId.replaceAll("-", "")}`;
    const requestHash = hash(`${link.publicId}:${providerName}:${link.amountMinor}:${idempotencyKey}`);
    let attempt;
    try {
      attempt = await PaymentAttempt.create({
        publicId,
        paymentLinkId: String(link._id),
        paymentId: String(payment._id),
        orderId: String(order._id),
        provider: providerName,
        reference,
        idempotencyKey,
        requestHash,
        status: "initializing",
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });
    } catch (error) {
      // A concurrent request with the same key won the unique index: return its attempt.
      if (!isDuplicateKeyError(error)) throw error;
      const winner = await PaymentAttempt.findOne({ paymentLinkId: String(link._id), idempotencyKey });
      if (!winner) throw error;
      return this.publicAttempt(winner);
    }
    const returnUrl = new URL(`${paymentOrigin()}/payment/${token}/processing`);
    returnUrl.searchParams.set("provider", providerName);
    if (appReturn) returnUrl.searchParams.set("appReturn", "1");
    try {
      const initialized = await provider.initialize({
        reference,
        amountMinor: link.amountMinor,
        currency: link.currency,
        email: String((order.customerSnapshot as any)?.email || "payments@hook.africa"),
        callbackUrl: returnUrl.toString(),
        metadata: { orderId: order.publicId, paymentId: payment.publicId, paymentLinkId: link.publicId },
      });
      // All three records move together, and only forward: a webhook that
      // confirmed the payment while the provider call was in flight must not be
      // reverted to PROCESSING by these writes (the old code saved whole
      // documents loaded before that call).
      const session = await mongoose.startSession();
      let moved = false;
      try {
        await session.withTransaction(async () => {
          moved = (await Payment.updateOne(
            { _id: payment._id, commerceStatus: { $ne: CommercePaymentStatus.CONFIRMED } },
            {
              $set: {
                gateway: providerName,
                transactionRef: reference,
                authorizationUrl: initialized.authorizationUrl,
                accessCode: initialized.accessCode,
                activeAttemptId: attempt.publicId,
                commerceStatus: CommercePaymentStatus.PROCESSING,
              },
            },
            { session },
          )).modifiedCount > 0;
          await PaymentAttempt.updateOne(
            { _id: attempt._id },
            moved
              ? { $set: { authorizationUrl: initialized.authorizationUrl, status: "processing" } }
              : { $set: { status: "cancelled", completedAt: new Date() } },
            { session },
          );
          if (moved) {
            await PaymentLink.updateOne({ _id: link._id, status: { $in: ["active", "processing"] } }, { $set: { status: "processing" } }, { session });
          }
        });
      } finally {
        await session.endSession();
      }
      if (!moved) throw new HttpError(409, "This payment is already complete", undefined, "PAYMENT_ALREADY_CONFIRMED");
      attempt.authorizationUrl = initialized.authorizationUrl;
      attempt.status = "processing";
      return this.publicAttempt(attempt);
    } catch (error: any) {
      if (error?.code === "PAYMENT_ALREADY_CONFIRMED") throw error;
      await PaymentAttempt.updateOne(
        { _id: attempt._id, status: "initializing" },
        { $set: { status: "failed", errorCode: error?.code || "PAYMENT_PROVIDER_ERROR", completedAt: new Date() } },
      );
      await PaymentLink.updateOne({ _id: link._id, status: "processing" }, { $set: { status: "active" } });
      throw error;
    }
  }

  async status(token: string) {
    const link = await this.resolve(token);
    const currentAttempt = await PaymentAttempt.findOne({ paymentLinkId: String(link._id) }).sort({ createdAt: -1 });
    if (currentAttempt?.status === "processing") {
      await new PaymentService().verifyAttempt(currentAttempt.publicId).catch(() => undefined);
    }
    const detail = await this.detail(token);
    const attempt = await PaymentAttempt.findOne({ paymentLinkId: String(link._id) }).sort({ createdAt: -1 }).lean();
    return { status: detail.status, paidAt: detail.paidAt, attempt: attempt ? { provider: attempt.provider, status: attempt.status } : undefined };
  }

  async revoke(customerId: string, identifier: string) {
    const link = await PaymentLink.findOne({
      ...(isValidObjectId(identifier) ? { $or: [{ publicId: identifier }, { _id: identifier }] } : { publicId: identifier }),
      customerId,
    });
    if (!link) throw new HttpError(404, "Payment link not found");
    if (["paid", "revoked", "expired", "cancelled"].includes(link.status)) return { id: link.publicId, status: link.status };
    link.status = "revoked";
    link.revokedAt = new Date();
    await link.save();
    await PaymentAttempt.updateMany({ paymentLinkId: String(link._id), status: { $in: ACTIVE_ATTEMPT_STATUSES } }, { $set: { status: "cancelled", completedAt: new Date() } });
    return { id: link.publicId, status: link.status };
  }

  private async resolve(token: string) {
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw new HttpError(404, "Payment link not found");
    const link = await PaymentLink.findOne({ tokenHash: hash(token) }).select("+tokenHash");
    if (!link) throw new HttpError(404, "Payment link not found");
    if (link.expiresAt <= new Date() && ["active", "processing"].includes(link.status)) {
      // Guarded: a payment that just confirmed must stay "paid".
      const expired = await PaymentLink.updateOne({ _id: link._id, status: { $in: ["active", "processing"] } }, { $set: { status: "expired" } });
      if (expired.modifiedCount) link.status = "expired";
      else return (await PaymentLink.findById(link._id).select("+tokenHash")) || link;
    }
    if (["expired", "revoked", "cancelled"].includes(link.status)) {
      throw new HttpError(410, "This payment link is no longer available", { status: link.status }, "PAYMENT_LINK_EXPIRED");
    }
    return link;
  }

  private publicAttempt(attempt: any) {
    return {
      id: attempt.publicId,
      provider: attempt.provider,
      status: attempt.status,
      authorizationUrl: attempt.authorizationUrl,
      expiresAt: attempt.expiresAt,
    };
  }
}
