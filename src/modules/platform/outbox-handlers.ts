import type { OutboxEventType } from "@modules/platform/outbox.model";
import type { OutboxHandler } from "@modules/platform/outbox.service";

/**
 * The single registry of outbox consumers. Loaded lazily by the worker (and by
 * FulfilmentService.processOutboxBatch) so service modules never import each
 * other just to be dispatched to. Every handler must be idempotent: an event
 * can be delivered more than once.
 */
export function buildOutboxHandlers(): Record<OutboxEventType, OutboxHandler> {
  return {
    ORDER_APPROVED_FOR_FULFILMENT: async (event) => {
      const { fulfilmentService } = await import("@modules/fulfilment");
      return fulfilmentService.consumeApprovedOrder(event);
    },
    PAYMENT_CONFIRMED_EFFECTS: async (event) => {
      const { PaymentService } = await import("@modules/payments");
      return new PaymentService().deliverPaymentConfirmedEffects(event);
    },
    ORDER_CREATED_EFFECTS: async (event) => {
      const { CheckoutService } = await import("@modules/orders");
      return new CheckoutService().deliverOrderCreatedEffects(event);
    },
    REFUND_PROCESSED_EFFECTS: async (event) => {
      const { fulfilmentService } = await import("@modules/fulfilment");
      return fulfilmentService.deliverRefundEffects(event);
    },
  };
}
