import {
  CommerceOrderStatus,
  CommercePaymentStatus,
  OrderStatus,
} from "@lib/constants";
import {
  CommerceSettings,
  PodCallRecord,
  PodOverride,
} from "@models/commerce/commerce.model";
import { Order } from "@models/orders/order.model";
import { Payment } from "@models/payments/payment.model";
import { User } from "@models/users/user.model";
import { PaymentService } from "@modules/payments/payment.service";
import { HttpError } from "@utils/http";
import mongoose, { isValidObjectId } from "mongoose";
import { createCommerceNotification } from "@modules/notifications";
import { restoreOrderIncentives } from "@modules/orders";
import { appendTimeline, notifyStatus, timelineEntry } from "@lib/order-timeline";
import { defaultProviderName } from "@modules/payments/providers/provider-registry";

function orderIdentity(value: string) {
  return isValidObjectId(value)
    ? { $or: [{ _id: value }, { publicId: value }] }
    : { publicId: value };
}

export class PodService {
  private payments = new PaymentService();

  async recordCall(
    orderId: string,
    actorId: string,
    outcome: PodCallRecord["outcome"],
    notes?: string,
  ) {
    const order = await Order.findOne(orderIdentity(orderId));
    if (!order || order.commercePaymentMethod !== "PAY_AT_HANDOVER")
      throw new HttpError(404, "Pay-at-Handover Order not found");
    if (
      ![
        CommerceOrderStatus.OPERATIONS_REVIEW,
        CommerceOrderStatus.VERIFICATION_PENDING,
      ].includes(order.commerceStatus as any)
    )
      throw new HttpError(
        409,
        "Order is not awaiting POD verification",
        undefined,
        "INVALID_STATE_TRANSITION",
      );
    const record = await PodCallRecord.create({
      orderId: order.id,
      actorId,
      outcome,
      notes,
      calledAt: new Date(),
    });
    order.podReview = {
      ...(order.podReview || {}),
      lastCallId: record.id,
      callOutcome: outcome,
      callRecordedAt: record.calledAt,
      callActorId: actorId,
    };
    await order.save();
    return record;
  }

  async override(orderId: string, actorId: string, reason: string) {
    const order = await Order.findOne(orderIdentity(orderId));
    if (!order || order.commercePaymentMethod !== "PAY_AT_HANDOVER")
      throw new HttpError(404, "Pay-at-Handover Order not found");
    if (!(order.podReview as any)?.requiresOverride)
      throw new HttpError(
        409,
        "This Order does not require a high-value override",
      );
    const override = await PodOverride.findOneAndUpdate(
      { orderId: order.id },
      {
        $setOnInsert: {
          orderId: order.id,
          actorId,
          reason,
          amountMinor: order.totalMinor,
          approvedAt: new Date(),
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );
    order.podReview = {
      ...(order.podReview || {}),
      overrideId: override.id,
      overrideApproved: true,
      overrideApprovedAt: override.approvedAt,
      overrideActorId: actorId,
    };
    await order.save();
    return override;
  }

  async decide(
    orderId: string,
    actorId: string,
    decision: "APPROVE" | "PREPAYMENT_REQUIRED" | "CANCELLED",
    reason: string,
  ) {
    const order = await Order.findOne(orderIdentity(orderId));
    if (!order || order.commercePaymentMethod !== "PAY_AT_HANDOVER")
      throw new HttpError(404, "Pay-at-Handover Order not found");
    if (![CommerceOrderStatus.VERIFICATION_PENDING, CommerceOrderStatus.OPERATIONS_REVIEW].includes(order.commerceStatus as any))
      throw new HttpError(409, "This Order was already decided", undefined, "INVALID_STATE_TRANSITION");
    const pod = (order.podReview as any) || {};
    if (decision === "APPROVE") {
      if (pod.callOutcome !== "CONFIRMED")
        throw new HttpError(
          409,
          "A successful customer confirmation call is required",
          undefined,
          "POD_CONFIRMATION_REQUIRED",
        );
      if (pod.requiresOverride && !pod.overrideApproved)
        throw new HttpError(
          409,
          "Super Admin high-value override is required",
          undefined,
          "POD_OVERRIDE_REQUIRED",
        );
      const customer = await User.findById(order.userId).lean();
      if (!customer?.podEligible)
        throw new HttpError(
          409,
          "Customer is not eligible for Pay at Handover",
          undefined,
          "POD_NOT_ELIGIBLE",
        );
      await this.transition(order, async (session, guard) => {
        const moved = await Order.updateOne(guard, {
          $set: {
            commerceStatus: CommerceOrderStatus.APPROVED_FOR_FULFILMENT,
            commercePaymentStatus: CommercePaymentStatus.DUE_AT_HANDOVER,
            status: OrderStatus.APPROVED_FOR_FULFILMENT,
          },
          $push: { timeline: timelineEntry(CommerceOrderStatus.APPROVED_FOR_FULFILMENT, "POD_OPERATIONS", { actorId, reason }) },
        }, { session });
        if (!moved.modifiedCount) return false;
        const payment = await Payment.updateOne({ orderId: order.id }, { $set: { commerceStatus: CommercePaymentStatus.DUE_AT_HANDOVER } }, { session });
        if (!payment.matchedCount) throw new HttpError(409, "Payment record is missing");
        // Written with the approval so an approved order can never be left without the event that starts fulfilment.
        await this.payments.emitOrderApproved(order, session);
        return true;
      });
    } else if (decision === "PREPAYMENT_REQUIRED") {
      // Already paid the delivery fee at this point, so it can't be turned into a fully prepaid order without splitting money already paid.
      if ((order as any).podFeePaid)
        throw new HttpError(409, "The delivery fee is already paid. Approve this order, or cancel it to refund the fee.", undefined, "INVALID_STATE_TRANSITION");
      await this.transition(order, async (session, guard) => {
        const moved = await Order.updateOne(guard, {
          $set: {
            commercePaymentMethod: "PREPAID",
            commercePaymentStatus: CommercePaymentStatus.PENDING,
            commerceStatus: CommerceOrderStatus.AWAITING_PAYMENT,
            status: OrderStatus.AWAITING_PAYMENT,
          },
          $push: { timeline: timelineEntry("PREPAYMENT_REQUIRED", actorId, { reason }) },
        }, { session });
        if (!moved.modifiedCount) return false;
        await Payment.updateOne(
          { orderId: order.id },
          { $set: { paymentMethod: "card", gateway: await defaultProviderName(), commerceStatus: CommercePaymentStatus.PENDING } },
          { session },
        );
        return true;
      });
    } else {
      const cancelled = await this.transition(order, async (session, guard) => {
        const moved = await Order.updateOne(guard, {
          $set: {
            commerceStatus: CommerceOrderStatus.CANCELLED,
            status: OrderStatus.CANCELLED,
            cancelledAt: new Date(),
            cancellationReason: reason,
          },
          $push: { timeline: timelineEntry(CommerceOrderStatus.CANCELLED, actorId, { reason }) },
        }, { session });
        if (!moved.modifiedCount) return false;
        // Same restoration as a customer-initiated cancellation, inside the same transaction so a failure cannot leave credits spent.
        await restoreOrderIncentives(String(order._id), session);
        return true;
      });
      // A customer-initiated cancellation has its own dedicated email; an operations rejection had none until now.
      if (cancelled) {
        await notifyStatus(String(order._id), CommerceOrderStatus.CANCELLED);
        // Cancelled before dispatch: the online delivery fee goes back to the customer.
        await this.payments.refundDeliveryFee(String(order._id));
      }
    }
    if (order.userId) {
      const copy =
        decision === "APPROVE"
          ? {
              title: "Order approved",
              body: "Your Pay-at-Handover Order is approved for fulfilment.",
              type: "pod_approved",
            }
          : decision === "PREPAYMENT_REQUIRED"
            ? {
                title: "Prepayment required",
                body: "Complete secure Paystack payment to continue this Order.",
                type: "prepayment_required",
              }
            : {
                title: "Order cancelled",
                body: "Your Pay-at-Handover request was declined. Review the Order for details.",
                type: "order_cancelled",
              };
      await createCommerceNotification({
        eventKey: `order:${order.publicId}:pod:${decision}`,
        userId: order.userId,
        ...copy,
        data: { orderId: order.publicId },
      }).catch(() => undefined);
    }
    const fresh = await Order.findById(order._id);
    return (fresh || order).toJSON();
  }

  /** Runs one decision in a transaction guarded on the prior status, so two operators can't both decide the same order. */
  private async transition(
    order: any,
    apply: (session: mongoose.ClientSession, guard: Record<string, unknown>) => Promise<boolean>,
  ) {
    const guard = { _id: order._id, commerceStatus: order.commerceStatus, commercePaymentMethod: order.commercePaymentMethod };
    const session = await mongoose.startSession();
    let done = false;
    try {
      await session.withTransaction(async () => {
        done = await apply(session, guard);
      });
    } finally {
      await session.endSession();
    }
    if (!done) throw new HttpError(409, "This Order was already decided", undefined, "INVALID_STATE_TRANSITION");
    return done;
  }

  async restoreCustomer(customerId: string, actorId: string, reason: string) {
    const customer = await User.findByIdAndUpdate(
      customerId,
      {
        $set: {
          podEligible: true,
          podDisabledReason: undefined,
          podEligibilityUpdatedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    ).lean({ virtuals: true });
    if (!customer) throw new HttpError(404, "Customer not found");
    return {
      id: customer.publicId,
      podEligible: customer.podEligible,
      updatedBy: actorId,
      reason,
    };
  }

  async getSettings() {
    return CommerceSettings.findOne({ key: "commerce" }).lean({
      virtuals: true,
    });
  }
  async updateSettings(actorId: string, update: Record<string, unknown>) {
    return CommerceSettings.findOneAndUpdate(
      { key: "commerce" },
      { $set: { ...update, updatedBy: actorId } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    ).lean({ virtuals: true });
  }
}
