/** Every notification Hook can send, defined once, with copy kept here for consistent wording; transactional notifications are never limited or switched off, unlike engagement ones. */
export type NotificationGroup = 'orders' | 'account' | 'credit' | 'reminders' | 'discovery';
export type NotificationPriority = 'transactional' | 'engagement';

/** Screens the customer app can open from a notification. */
export type NotificationScreen =
  | 'home' | 'order' | 'orders' | 'cart' | 'checkout' | 'product' | 'shop' | 'market' | 'states'
  | 'credits' | 'referrals' | 'negotiation' | 'notifications' | 'devices' | 'security' | 'update' | 'addresses';

export interface NotificationDefinition {
  group: NotificationGroup;
  priority: NotificationPriority;
  screen: NotificationScreen;
  /** Minimum hours before the same engagement type may reach the same customer again. */
  cooldownHours?: number;
  /** Seconds a push may wait for an offline phone before Expo drops it. */
  ttlSeconds?: number;
}

const T = (group: NotificationGroup, screen: NotificationScreen, extra: Partial<NotificationDefinition> = {}): NotificationDefinition => ({ group, priority: 'transactional', screen, ...extra });
const E = (group: NotificationGroup, screen: NotificationScreen, cooldownHours: number, extra: Partial<NotificationDefinition> = {}): NotificationDefinition => ({ group, priority: 'engagement', screen, cooldownHours, ...extra });

export const NOTIFICATION_CATALOG: Record<string, NotificationDefinition> = {
  // Onboarding and account
  welcome: T('account', 'home'),
  welcome_back: T('account', 'home'),
  account_activated: T('account', 'home'),
  security_new_device: T('account', 'devices'),
  password_changed: T('account', 'security'),
  // Admin-composed messages, treated as transactional so an important announcement is never suppressed by a cooldown.
  admin_broadcast: T('account', 'notifications'),
  address_missing: E('reminders', 'addresses', 24 * 14),

  // Discovery
  new_products: E('discovery', 'shop', 20),
  new_market: E('discovery', 'market', 24 * 3),
  new_state: E('discovery', 'states', 24 * 7),
  new_category: E('discovery', 'shop', 24 * 3),
  price_drop: E('discovery', 'product', 24 * 2),
  back_in_stock: E('discovery', 'product', 24),
  low_stock: E('discovery', 'product', 24 * 2),
  coupon_expiring: E('discovery', 'cart', 24 * 2),

  // Cart and checkout
  cart_abandoned_1: E('reminders', 'cart', 24),
  cart_abandoned_2: E('reminders', 'cart', 24),
  cart_abandoned_3: E('reminders', 'cart', 24 * 7),
  payment_pending: T('orders', 'order'),

  // Negotiation
  negotiation_idle: E('reminders', 'negotiation', 6),
  negotiation_agreed: T('orders', 'negotiation'),
  negotiation_expiring: T('orders', 'negotiation'),
  negotiation_expired: E('reminders', 'negotiation', 6),

  // Orders, payment and delivery
  order_created: T('orders', 'order'),
  payment_confirmed: T('orders', 'order'),
  pod_approved: T('orders', 'order'),
  prepayment_required: T('orders', 'order'),
  order_updated: T('orders', 'order'),
  order_in_fulfilment: T('orders', 'order'),
  hub_qc_passed: T('orders', 'order'),
  hub_qc_failed: T('orders', 'order'),
  order_packed: T('orders', 'order'),
  order_shipped: T('orders', 'order'),
  order_out_for_delivery: T('orders', 'order'),
  order_delayed: T('orders', 'order'),
  order_delivered: T('orders', 'order'),
  order_cancelled: T('orders', 'order'),
  refund_requested: T('orders', 'order'),
  refund_processed: T('orders', 'order'),
  return_update: T('orders', 'order'),
  rate_order: E('reminders', 'order', 24 * 30),

  // Hook credit and referrals
  hook_coin: T('credit', 'credits'),
  referral_joined: T('credit', 'referrals'),
  credit_unused: E('credit', 'credits', 24 * 30),

  // Win-back and platform
  winback_14: E('reminders', 'home', 24 * 21),
  winback_30: E('reminders', 'home', 24 * 45),
  update_available: E('discovery', 'update', 24 * 7),
};

/** Definition for a type. Unknown types are treated as transactional order updates so nothing is ever dropped. */
export function definitionFor(type: string): NotificationDefinition {
  return NOTIFICATION_CATALOG[type] || { group: 'orders', priority: 'transactional', screen: 'notifications' };
}

export interface RenderedNotification { title: string; body: string }
type Params = Record<string, string | number | undefined>;

const name = (params: Params) => (params.firstName ? `${params.firstName}, ` : '');
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Copy for the notifications that are generated on a schedule or by catalogue events. */
const TEMPLATES: Record<string, (params: Params) => RenderedNotification> = {
  address_missing: (p) => ({ title: 'Add your delivery address', body: `${name(p)}add an address now and checkout is one tap faster.` }),
  new_products: (p) => ({
    title: p.categoryName ? `New in ${p.categoryName}` : 'New arrivals on Hook',
    body: Number(p.count) > 1 ? `${plural(Number(p.count), 'new item')} just landed${p.stateName ? ` near ${p.stateName}` : ''}. Take a look.` : `${p.title || 'A new item'} just landed. Take a look.`,
  }),
  new_market: (p) => ({ title: `${p.marketName} is now on Hook`, body: `Shop ${p.marketName}${p.stateName ? ` in ${p.stateName}` : ''} without leaving home.` }),
  new_state: (p) => ({ title: `Hook now delivers to ${p.stateName}`, body: 'Browse markets near you and order today.' }),
  new_category: (p) => ({ title: `${p.categoryName} is now on Hook`, body: 'Have a look at what is new.' }),
  price_drop: (p) => ({ title: 'Price drop on something you liked', body: `${p.title} is now ${p.price}.` }),
  back_in_stock: (p) => ({ title: 'Back in stock', body: `${p.title} is available again.` }),
  low_stock: (p) => ({ title: `Only ${p.quantity} left`, body: `${p.title} is running low.` }),
  coupon_expiring: (p) => ({ title: 'Your coupon ends soon', body: `${p.code} expires ${p.when || 'soon'}. Use it before it goes.` }),
  cart_abandoned_1: (p) => ({ title: 'You left something in your cart', body: `${name(p)}${p.title ? `${p.title}${Number(p.count) > 1 ? ` and ${plural(Number(p.count) - 1, 'other item')}` : ''} is waiting.` : 'your items are waiting.'}` }),
  cart_abandoned_2: (p) => ({ title: 'Still thinking it over?', body: `${p.title ? `${p.title} is` : 'Your items are'} still in your cart. Stock can change, so check out when you are ready.` }),
  cart_abandoned_3: () => ({ title: 'Your cart is about to go quiet', body: 'We are holding your items a little longer. Finish checkout whenever you are ready.' }),
  payment_pending: (p) => ({ title: 'Complete your payment', body: `Order ${p.orderRef} is waiting for payment.` }),
  negotiation_idle: (p) => ({ title: 'Your negotiation is waiting', body: `Pick up where you left off on ${p.title || 'your item'}.` }),
  negotiation_expiring: (p) => ({ title: 'Your agreed price expires soon', body: `Your price for ${p.title || 'your item'} ends in ${p.minutes} minutes.` }),
  negotiation_expired: (p) => ({ title: 'Your agreed price has expired', body: `Negotiate again for ${p.title || 'your item'} to get a new price.` }),
  credit_unused: (p) => ({ title: `You have ${p.amount} Hook credit`, body: 'Use it on your next order.' }),
  winback_14: (p) => ({ title: `${name(p)}we miss you`, body: 'See what is new on Hook since you were last here.' }),
  winback_30: (p) => ({ title: 'A lot has landed on Hook', body: 'Come back and have a look.' }),
  update_available: () => ({ title: 'A new version of Hook is ready', body: 'Update for the latest features and fixes.' }),
  rate_order: (p) => ({ title: 'How was your order?', body: `Tell us about order ${p.orderRef}.` }),
};

export function renderNotification(type: string, params: Params = {}): RenderedNotification {
  const template = TEMPLATES[type];
  if (!template) return { title: String(params.title || 'Hook'), body: String(params.body || '') };
  return template(params);
}
