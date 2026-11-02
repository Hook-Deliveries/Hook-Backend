/**
 * The single source of customer-facing order status wording.
 *
 * This lives outside order.service.ts because emails need it too — before the
 * extraction, order-status emails rendered the raw enum ("IN_FULFILMENT") to
 * customers while the app showed a friendly label for the same status.
 *
 * Copy rule: customers deal with Hook, not with the individual people
 * fulfilling their order. Say "Hook is sourcing your items", never name the
 * Market Associate. Internal staff surfaces may name them.
 */
const CUSTOMER_STATUS_LABELS: Record<string, string> = {
  AWAITING_PAYMENT: 'Awaiting payment',
  VERIFICATION_PENDING: 'Payment review',
  OPERATIONS_REVIEW: 'Order confirmed',
  APPROVED_FOR_FULFILMENT: 'Preparing your order',
  IN_FULFILMENT: 'Hook is sourcing your items',
  PARTIALLY_RECEIVED: 'Some items reached Hook Hub',
  READY_FOR_CONSOLIDATION: 'Checked at Hook Hub',
  READY_FOR_DISPATCH: 'Packed for delivery',
  BOOKED_WITH_PROVIDER: 'Delivery is being arranged',
  AWAITING_PICKUP: 'Ready to leave Hook Hub',
  PICKED_UP: 'Dispatched from Hook Hub',
  OUT_FOR_DELIVERY: 'Out for delivery',
  IN_TRANSIT: 'On the way',
  PARTIALLY_IN_TRANSIT: 'Some deliveries are on the way',
  PARTIALLY_DELIVERED: 'Partially delivered',
  DELIVERED: 'Delivered',
  COLLECTED: 'Collected',
  COMPLETED: 'Completed',
  ON_HOLD: 'We are resolving an issue',
  RETURN_IN_PROGRESS: 'Return in progress',
  REFUNDED: 'Refunded',
  CANCELLED: 'Cancelled',
};

export function customerStatusLabel(status: unknown) {
  return CUSTOMER_STATUS_LABELS[String(status || '').toUpperCase()] || 'Order received';
}

/**
 * One line of reassurance per status, used as the email body so each
 * transition explains what is actually happening rather than restating the
 * status. Falls back to undefined so callers can omit the line entirely.
 */
const CUSTOMER_STATUS_DETAIL: Record<string, string> = {
  AWAITING_PAYMENT: 'Complete your payment and we will start sourcing right away.',
  VERIFICATION_PENDING: 'We are reviewing your payment. This is usually quick.',
  OPERATIONS_REVIEW: 'Your order is confirmed and queued for sourcing.',
  APPROVED_FOR_FULFILMENT: 'Payment is settled. We are getting your order ready.',
  IN_FULFILMENT: 'Hook is sourcing your items from our trusted market vendors.',
  PARTIALLY_RECEIVED: 'Some of your items have arrived at the Hook Hub.',
  READY_FOR_CONSOLIDATION: 'Your items are at the Hook Hub and being checked.',
  READY_FOR_DISPATCH: 'Everything is packed and ready to leave our hub.',
  BOOKED_WITH_PROVIDER: 'We have booked your delivery and are arranging pickup.',
  AWAITING_PICKUP: 'Your parcel is waiting for the courier at our hub.',
  PICKED_UP: 'Your parcel has left the Hook Hub.',
  OUT_FOR_DELIVERY: 'Your order is out for delivery today.',
  IN_TRANSIT: 'Your order is on its way to you.',
  PARTIALLY_DELIVERED: 'Part of your order has been delivered.',
  DELIVERED: 'Your order has been delivered. Thanks for shopping with Hook.',
  COLLECTED: 'Your order has been collected.',
  COMPLETED: 'This order is complete. Thanks for shopping with Hook.',
  ON_HOLD: 'We have paused this order while we resolve an issue and will update you shortly.',
  RETURN_IN_PROGRESS: 'Your return is being processed.',
  REFUNDED: 'Your refund has been issued.',
  CANCELLED: 'This order has been cancelled.',
};

export function customerStatusDetail(status: unknown) {
  return CUSTOMER_STATUS_DETAIL[String(status || '').toUpperCase()];
}

/**
 * Statuses worth emailing about. Intermediate machine states (and anything
 * the customer cannot act on) stay silent so a single order does not produce
 * a dozen near-identical mails.
 */
const EMAILABLE_STATUSES = new Set([
  'IN_FULFILMENT',
  'READY_FOR_CONSOLIDATION',
  'READY_FOR_DISPATCH',
  'BOOKED_WITH_PROVIDER',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'IN_TRANSIT',
  'PARTIALLY_DELIVERED',
  'DELIVERED',
  'COLLECTED',
  'COMPLETED',
  'ON_HOLD',
  'RETURN_IN_PROGRESS',
  'REFUNDED',
  'CANCELLED',
]);

export function shouldEmailStatus(status: unknown) {
  return EMAILABLE_STATUSES.has(String(status || '').toUpperCase());
}
