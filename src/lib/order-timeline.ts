import { Order } from '@models/orders/order.model';

/** The single way to append an order timeline entry, replacing the two divergent idioms transition sites used to write inline. */

export type TimelineActor = string | { accountId?: string; id?: string } | undefined;

function actorId(actor: TimelineActor) {
  if (!actor) return 'SYSTEM';
  if (typeof actor === 'string') return actor;
  return String(actor.accountId || actor.id || 'SYSTEM');
}

/** Builds an entry for callers that will persist the document themselves. */
export function timelineEntry(status: string, actor?: TimelineActor, extra?: Record<string, unknown>) {
  return { status: String(status).toUpperCase(), actor: actorId(actor), at: new Date(), ...(extra || {}) };
}

/** Appends to a document already in memory, returning the new array, for the reassignment idiom `order.timeline = appendTimeline(order, ...)`. */
export function appendTimeline(order: { timeline?: Array<Record<string, unknown>> }, status: string, actor?: TimelineActor, extra?: Record<string, unknown>) {
  return [...(order.timeline || []), timelineEntry(status, actor, extra)];
}

/** Writes the entry directly for callers holding only an order id, and returns it so timestamps match exactly downstream. */
export async function pushOrderTimeline(orderId: unknown, status: string, actor?: TimelineActor, extra?: Record<string, unknown>) {
  const entry = timelineEntry(status, actor, extra);
  await Order.updateOne({ _id: orderId }, { $push: { timeline: entry } });
  await notifyStatus(orderId, entry.status);
  return entry;
}

/** Emails the customer about a transition; imported lazily to avoid a require cycle through every service that writes a timeline. */
export async function notifyStatus(orderId: unknown, status: string) {
  await pushOrderStatus(orderId, status);
  try {
    const { sendOrderStatusEmail } = await import('@modules/notifications/order-status-email.service');
    await sendOrderStatusEmail(orderId, status);
  } catch {
    // Fire-and-forget: a mail failure must never block a status transition.
  }
}

/** What the customer is told, by order or shipment status. Statuses not listed send no push. */
const STATUS_PUSH: Record<string, { type: string; key: string; title: string; body: string }> = {
  IN_FULFILMENT: { type: 'order_in_fulfilment', key: 'sourcing', title: "We're sourcing your order", body: 'Our team is collecting your items from the market now.' },
  READY_FOR_DISPATCH: { type: 'order_packed', key: 'packed', title: 'Your order is packed', body: 'It is sealed and ready for its courier.' },
  PICKED_UP: { type: 'order_shipped', key: 'shipped', title: 'Your order is on its way', body: 'The courier has collected your parcel.' },
  IN_TRANSIT: { type: 'order_shipped', key: 'shipped', title: 'Your order is on its way', body: 'Your parcel is moving to you.' },
  PARTIALLY_IN_TRANSIT: { type: 'order_shipped', key: 'shipped', title: 'Part of your order is on its way', body: 'The rest will follow.' },
  OUT_FOR_DELIVERY: { type: 'order_out_for_delivery', key: 'out-for-delivery', title: 'Out for delivery', body: 'Your parcel arrives today. Keep your phone close.' },
  DELIVERED: { type: 'order_delivered', key: 'delivered', title: 'Your order was delivered', body: 'Enjoy your purchase. Tell us how it went.' },
  ON_HOLD: { type: 'order_updated', key: 'on-hold', title: 'Your order is on hold', body: 'Open the order to see what we need from you.' },
  RETURN_IN_PROGRESS: { type: 'return_update', key: 'return', title: 'Your return is in progress', body: 'We will keep you updated.' },
  REFUNDED: { type: 'refund_processed', key: 'refunded', title: 'Your refund was issued', body: 'It is on its way back to you.' },
  DELIVERY_FAILED: { type: 'order_delayed', key: 'delivery-failed', title: 'A delivery attempt failed', body: 'Our team is arranging another attempt and will update you shortly.' },
};

/** A partner-facing rendering for a subset of the same statuses, since their copy talks to a counter operator, not the end customer. */
const PARTNER_STATUS_PUSH: Record<string, { title: string; body: string }> = {
  IN_FULFILMENT: { title: 'Sourcing started', body: 'Hook is sourcing the items for this order now.' },
  READY_FOR_DISPATCH: { title: 'Order packed', body: 'This order is sealed and ready for its courier.' },
  PICKED_UP: { title: 'Order shipped', body: 'The courier has collected this order.' },
  IN_TRANSIT: { title: 'Order in transit', body: 'This order is moving to the customer.' },
  OUT_FOR_DELIVERY: { title: 'Out for delivery', body: 'This order arrives today.' },
  DELIVERED: { title: 'Order delivered', body: 'This order has been delivered.' },
  DELIVERY_FAILED: { title: 'Delivery attempt failed', body: 'A delivery attempt on this order failed. Hook is arranging another attempt.' },
  ON_HOLD: { title: 'Order on hold', body: 'This order needs attention — open it to see what Hook needs.' },
  RETURN_IN_PROGRESS: { title: 'Return in progress', body: 'A return is being processed for this order.' },
  REFUNDED: { title: 'Order refunded', body: 'This order was refunded.' },
};

function partnerRecordIdentity(value: string) {
  return /^[a-f\d]{24}$/i.test(value) ? { $or: [{ _id: value }, { publicId: value }] } : { publicId: value };
}

/**
 * The customer's phone hears about each meaningful status. The event key is
 * per order and per kind of update (all transit statuses share one), so a
 * status that repeats, or is reached by two code paths, never buzzes twice.
 */
async function pushOrderStatus(orderId: unknown, status: string) {
  const entry = STATUS_PUSH[status];
  if (!entry) return;
  try {
    const order = (await Order.findById(orderId).select('publicId userId initiatingPartnerId').lean()) as { publicId?: string; userId?: string; initiatingPartnerId?: string } | null;
    if (!order?.publicId) return;
    const { createCommerceNotification } = await import('@modules/notifications/commerce-notification.service');
    if (order.userId) {
      await createCommerceNotification({
        // DELIVERED reuses the key the manual delivery path already writes.
        eventKey: `order:${order.publicId}:${entry.key}`,
        userId: order.userId,
        title: entry.title,
        body: entry.body,
        type: entry.type,
        data: { orderId: order.publicId },
      });
    }
    // Assisted-checkout orders have a Partner with their own stake in this order's progress — tell them too, in their own words.
    if (order.initiatingPartnerId) {
      const partnerCopy = PARTNER_STATUS_PUSH[status];
      if (partnerCopy) {
        const { HookPartner } = await import('@models/platform/operations-accounts.model');
        const partner = await HookPartner.findOne(partnerRecordIdentity(String(order.initiatingPartnerId))).select('accountId').lean() as { accountId?: string } | null;
        if (partner?.accountId) {
          await createCommerceNotification({
            eventKey: `order:${order.publicId}:${entry.key}:partner:${partner.accountId}`,
            userId: partner.accountId,
            title: partnerCopy.title,
            body: partnerCopy.body,
            type: entry.type,
            data: { orderId: order.publicId },
          });
        }
      }
    }
  } catch {
    // A push must never block a status transition.
  }
}
