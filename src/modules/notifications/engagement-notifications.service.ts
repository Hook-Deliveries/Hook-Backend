import { Cart } from '@models/cart/cart.model';
import { CartItem } from '@models/cart/cart-item.model';
import { NegotiatedQuote } from '@models/catalog/catalog.model';
import { CustomerAddress } from '@models/commerce/commerce.model';
import { Negotiation } from '@models/negotiations/negotiation.model';
import { DeviceToken } from '@models/notifications/device-token.model';
import { Order } from '@models/orders/order.model';
import { Product } from '@models/products/product.model';
import { ProductLike } from '@models/products/product-like.model';
import { User } from '@models/users/user.model';
import { CommerceOrderStatus, NegotiatedQuoteStatus, NegotiationStatus, ProductStatus } from '@lib/constants';
import { dispatchNotification, type DispatchResult } from '@modules/notifications/notification-dispatch.service';

/**
 * Scheduled nudges. Each scan is safe to run repeatedly: every notification
 * carries a deterministic event key, so it is sent at most once per moment
 * that matters, and the dispatcher applies preferences, quiet hours and caps.
 * A scan reports how many it sent, deferred (quiet hours) or held back.
 */
const HOUR = 3_600_000;
const MINUTE = 60_000;

export type ScanReport = Record<DispatchResult | 'considered', number>;
const emptyReport = (): ScanReport => ({ considered: 0, sent: 0, deduped: 0, deferred: 0, suppressed: 0, disabled: 0 });

async function send(report: ScanReport, input: Parameters<typeof dispatchNotification>[0]) {
  report.considered += 1;
  report[await dispatchNotification(input)] += 1;
}

async function firstNames(userIds: string[]) {
  const users = userIds.length ? ((await User.find({ _id: { $in: userIds } }).select('firstName').lean()) as Array<{ _id: { toString(): string }; firstName?: string }>) : [];
  return new Map(users.map((user) => [user._id.toString(), user.firstName?.trim() || undefined]));
}

/** Customers with an active cart left untouched for 3 hours, then 24 hours, then 72 hours. */
export async function scanAbandonedCarts(now = new Date()): Promise<ScanReport> {
  const report = emptyReport();
  const oldest = new Date(now.getTime() - 10 * 24 * HOUR);
  const newest = new Date(now.getTime() - 3 * HOUR);
  const carts = (await Cart.find({
    status: 'active',
    ownerType: { $ne: 'partner_assisted' },
    boothId: { $exists: false },
    userId: { $exists: true },
    updatedAt: { $gte: oldest, $lte: newest },
  }).limit(500).lean()) as Array<{ _id: { toString(): string }; userId?: string; updatedAt: Date }>;
  if (!carts.length) return report;

  const cartIds = carts.map((cart) => cart._id.toString());
  const items = (await CartItem.find({ cartId: { $in: cartIds } }).select('cartId productId').lean()) as Array<{ cartId: string; productId: string }>;
  const itemsByCart = new Map<string, string[]>();
  for (const item of items) itemsByCart.set(item.cartId, [...(itemsByCart.get(item.cartId) || []), item.productId]);
  const products = (await Product.find({ _id: { $in: [...new Set(items.map((item) => item.productId))].filter((id) => /^[a-f\d]{24}$/i.test(id)) } }).select('title').lean()) as Array<{ _id: { toString(): string }; title?: string }>;
  const titles = new Map(products.map((product) => [product._id.toString(), product.title]));
  const names = await firstNames([...new Set(carts.map((cart) => String(cart.userId)))]);

  for (const cart of carts) {
    const productIds = itemsByCart.get(cart._id.toString());
    if (!productIds?.length || !cart.userId) continue;
    const idleHours = (now.getTime() - new Date(cart.updatedAt).getTime()) / HOUR;
    const stage = idleHours >= 72 ? 3 : idleHours >= 24 ? 2 : 1;
    // Someone who bought since leaving the cart does not need reminding.
    const boughtSince = await Order.exists({ userId: cart.userId, createdAt: { $gt: cart.updatedAt }, commerceStatus: { $nin: [CommerceOrderStatus.CANCELLED, CommerceOrderStatus.AWAITING_PAYMENT] } });
    if (boughtSince) continue;
    await send(report, {
      type: `cart_abandoned_${stage}`,
      userId: cart.userId,
      // Tied to the cart's last change: any edit starts a fresh reminder sequence.
      eventKey: `cart:${cart._id}:${new Date(cart.updatedAt).getTime()}:s${stage}`,
      params: { firstName: names.get(cart.userId), title: titles.get(productIds[0]), count: productIds.length },
      now,
    });
  }
  return report;
}

/** Idle negotiations, and agreed prices that are about to expire or just did. */
export async function scanNegotiations(now = new Date()): Promise<ScanReport> {
  const report = emptyReport();

  const idle = (await Negotiation.find({
    status: NegotiationStatus.ACTIVE,
    customerId: { $exists: true },
    updatedAt: { $gte: new Date(now.getTime() - 24 * HOUR), $lte: new Date(now.getTime() - 30 * MINUTE) },
  }).select('customerId productId updatedAt').limit(500).lean()) as Array<{ _id: { toString(): string }; customerId?: string; productId: string }>;
  const idleProducts = (await Product.find({ _id: { $in: idle.map((row) => row.productId).filter((id) => /^[a-f\d]{24}$/i.test(id)) } }).select('title').lean()) as Array<{ _id: { toString(): string }; title?: string }>;
  const idleTitles = new Map(idleProducts.map((product) => [product._id.toString(), product.title]));
  for (const session of idle) {
    if (!session.customerId) continue;
    await send(report, { type: 'negotiation_idle', userId: session.customerId, eventKey: `neg:${session._id}:idle`, params: { title: idleTitles.get(session.productId) }, data: { negotiationId: session._id.toString(), productId: session.productId }, now });
  }

  const soon = (await NegotiatedQuote.find({
    status: NegotiatedQuoteStatus.ACTIVE,
    expiresAt: { $gt: now, $lte: new Date(now.getTime() + 60 * MINUTE) },
  }).select('customerId productId variantId quantity expiresAt').limit(500).lean()) as Array<{ _id: { toString(): string }; customerId: string; productId: string; variantId?: string; quantity?: number; expiresAt: Date }>;
  for (const quote of soon) {
    const minutes = Math.max(1, Math.round((new Date(quote.expiresAt).getTime() - now.getTime()) / MINUTE));
    const bucket = minutes <= 15 ? 15 : 60;
    await send(report, { type: 'negotiation_expiring', userId: quote.customerId, eventKey: `quote:${quote._id}:exp${bucket}`, params: { minutes }, data: { productId: quote.productId, variantId: quote.variantId, quantity: quote.quantity }, now });
  }

  const expired = (await NegotiatedQuote.find({
    status: NegotiatedQuoteStatus.EXPIRED,
    expiresAt: { $gte: new Date(now.getTime() - 3 * HOUR), $lte: now },
  }).select('customerId productId variantId quantity').limit(500).lean()) as Array<{ _id: { toString(): string }; customerId: string; productId: string; variantId?: string; quantity?: number }>;
  for (const quote of expired) {
    await send(report, { type: 'negotiation_expired', userId: quote.customerId, eventKey: `quote:${quote._id}:expired`, data: { productId: quote.productId, variantId: quote.variantId, quantity: quote.quantity }, now });
  }
  return report;
}

/** Prepaid orders still waiting for payment after 30 minutes and after 3 hours. */
export async function scanPaymentReminders(now = new Date()): Promise<ScanReport> {
  const report = emptyReport();
  const orders = (await Order.find({
    commerceStatus: CommerceOrderStatus.AWAITING_PAYMENT,
    commercePaymentMethod: 'PREPAID',
    createdAt: { $gte: new Date(now.getTime() - 6 * HOUR), $lte: new Date(now.getTime() - 30 * MINUTE) },
  }).select('publicId userId createdAt').limit(500).lean()) as Array<{ _id: { toString(): string }; publicId: string; userId?: string; createdAt: Date }>;
  for (const order of orders) {
    if (!order.userId) continue;
    const stage = now.getTime() - new Date(order.createdAt).getTime() >= 3 * HOUR ? 'pay180' : 'pay30';
    await send(report, { type: 'payment_pending', userId: order.userId, eventKey: `order:${order.publicId}:${stage}`, params: { orderRef: order.publicId }, data: { orderId: order.publicId }, now });
  }
  return report;
}

/** People whose app has not been opened for 14 days, then 30. */
export async function scanWinback(now = new Date()): Promise<ScanReport> {
  const report = emptyReport();
  const seen = (await DeviceToken.aggregate([
    { $match: { isActive: true, lastSeenAt: { $lte: new Date(now.getTime() - 14 * 24 * HOUR), $gte: new Date(now.getTime() - 90 * 24 * HOUR) } } },
    { $group: { _id: '$userId', lastSeenAt: { $max: '$lastSeenAt' } } },
    { $limit: 500 },
  ])) as Array<{ _id: string; lastSeenAt: Date }>;
  const names = await firstNames(seen.map((row) => row._id));
  for (const row of seen) {
    const days = (now.getTime() - new Date(row.lastSeenAt).getTime()) / (24 * HOUR);
    const stage = days >= 30 ? 30 : 14;
    await send(report, { type: `winback_${stage}`, userId: row._id, eventKey: `winback:${row._id}:${stage}:${new Date(row.lastSeenAt).toISOString().slice(0, 10)}`, params: { firstName: names.get(row._id) }, now });
  }
  return report;
}

/** State a customer shops in: their default delivery address. */
async function customerStates(userIds: string[]) {
  const addresses = (await CustomerAddress.find({ customerId: { $in: userIds }, status: 'active' }).sort({ isDefault: -1 }).select('customerId stateId').lean()) as Array<{ customerId: string; stateId: string }>;
  const map = new Map<string, string>();
  for (const address of addresses) if (!map.has(address.customerId)) map.set(address.customerId, address.stateId);
  return map;
}

/** Customers with a phone registered, optionally only those in one State. */
export async function audienceFor(stateId?: string, limit = 5000): Promise<Array<{ userId: string; stateId?: string }>> {
  const tokens = (await DeviceToken.distinct('userId', { isActive: true })) as string[];
  const ids = tokens.slice(0, limit);
  const states = await customerStates(ids);
  return ids
    .map((userId) => ({ userId, stateId: states.get(userId) }))
    .filter((entry) => !stateId || entry.stateId === stateId);
}

/**
 * Tell customers something new exists: a market, a delivery State, a category.
 * One notification per customer per announcement; caps and quiet hours apply,
 * so a customer may miss it rather than be spammed. Runs in the background.
 */
export async function announce(type: 'new_market' | 'new_state' | 'new_category', key: string, params: Record<string, string | number | undefined>, options: { stateId?: string; data?: Record<string, unknown> } = {}): Promise<ScanReport> {
  const report = emptyReport();
  const audience = await audienceFor(options.stateId);
  for (const entry of audience) await send(report, { type, userId: entry.userId, eventKey: `${type}:${key}:${entry.userId}`, params, data: options.data });
  return report;
}

/**
 * The daily 10:00 digest: one push per customer summarising what was published
 * in their State in the last day, instead of one push per product.
 */
export async function sendNewArrivalsDigest(now = new Date()): Promise<ScanReport> {
  const report = emptyReport();
  const since = new Date(now.getTime() - 24 * HOUR);
  const fresh = (await Product.find({ status: ProductStatus.PUBLISHED, publishedAt: { $gte: since, $lte: now } }).select('sourceStateId title').lean()) as Array<{ sourceStateId?: string; title?: string }>;
  if (!fresh.length) return report;
  const byState = new Map<string, { count: number; title?: string }>();
  for (const product of fresh) {
    const key = product.sourceStateId || 'all';
    const entry = byState.get(key) || { count: 0, title: product.title };
    entry.count += 1;
    byState.set(key, entry);
  }
  const day = now.toISOString().slice(0, 10);
  const audience = await audienceFor();
  const names = await firstNames(audience.map((entry) => entry.userId));
  for (const entry of audience) {
    const local = entry.stateId ? byState.get(entry.stateId) : undefined;
    const summary = local || (byState.size === 1 ? [...byState.values()][0] : { count: fresh.length, title: undefined });
    await send(report, { type: 'new_products', userId: entry.userId, eventKey: `digest:${entry.userId}:${day}`, params: { count: summary.count, title: summary.title, firstName: names.get(entry.userId) }, now });
  }
  return report;
}

/**
 * Tell people who liked a product when it gets cheaper, comes back, or is nearly
 * gone. Called after an admin edits a product; each signal is keyed by the new
 * value so the same change never notifies twice.
 */
export async function notifyLikersOfProductChange(
  before: { quantity?: number; sellingPriceMinor?: number },
  after: { publicId?: string; title?: string; quantity?: number; sellingPriceMinor?: number; status?: string; _id?: { toString(): string } },
): Promise<ScanReport> {
  const report = emptyReport();
  if (after.status !== ProductStatus.PUBLISHED) return report;
  const oldPrice = Number(before.sellingPriceMinor || 0);
  const newPrice = Number(after.sellingPriceMinor || 0);
  const oldQty = Number(before.quantity || 0);
  const newQty = Number(after.quantity || 0);
  const signals: Array<{ type: string; key: string; params: Record<string, string | number> }> = [];
  if (oldPrice > 0 && newPrice > 0 && newPrice <= oldPrice * 0.95) {
    signals.push({ type: 'price_drop', key: `price:${newPrice}`, params: { title: after.title || 'An item', price: `₦${(newPrice / 100).toLocaleString('en-NG')}` } });
  }
  if (oldQty <= 0 && newQty > 0) signals.push({ type: 'back_in_stock', key: `restock:${newQty}`, params: { title: after.title || 'An item' } });
  else if (oldQty > 3 && newQty > 0 && newQty <= 3) signals.push({ type: 'low_stock', key: `low:${newQty}`, params: { title: after.title || 'An item', count: newQty } });
  if (!signals.length || !after._id) return report;
  const likes = (await ProductLike.find({ productId: after._id.toString(), deletedAt: { $exists: false } }).select('userId').limit(2000).lean()) as Array<{ userId: string }>;
  for (const like of likes) {
    for (const signal of signals) {
      await send(report, { type: signal.type, userId: like.userId, eventKey: `${signal.type}:${after.publicId}:${signal.key}:${like.userId}`, params: signal.params, data: { productId: after.publicId } });
    }
  }
  return report;
}
