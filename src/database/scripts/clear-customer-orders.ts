import { Model } from 'mongoose';
import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { CheckoutPreview } from '@models/commerce/commerce.model';
import {
  FulfilmentTask,
  HubPackage,
  ReturnRequest,
  RunnerPackage,
  Shipment,
} from '@models/fulfilment/fulfilment.model';
import { Logistics } from '@models/logistics/logistics.model';
import { OrderFulfilmentGroup } from '@models/orders/order-fulfilment-group.model';
import { OrderItem } from '@models/orders/order-item.model';
import { Order } from '@models/orders/order.model';
import { RefundRequest } from '@models/orders/refund-request.model';
import { EscrowLedger } from '@models/payments/escrow-ledger.model';
import { PaymentLink } from '@models/payments/payment-link.model';
import { Payment } from '@models/payments/payment.model';
import { CouponRedemption } from '@models/promotions/coupon-redemption.model';
import { CreditLedger } from '@models/promotions/credit-ledger.model';
import { User } from '@models/users/user.model';

type AnyModel = Model<any>;
type Target = { label: string; model: AnyModel; filter: Record<string, unknown> };

const execute = process.argv.includes('--execute');
const EMAIL = process.argv.find((arg) => arg.includes('@')) || 'muhammedabiodun42@gmail.com';

/**
 * Clears one customer's order history everywhere it surfaces — the customer's
 * own Orders list, Admin order management, and the Market Associate fulfilment
 * queue (tasks, runner packages, hub packages).
 *
 * The account itself is kept. Hook credit is preserved: only the ledger entries
 * tied to the deleted orders are removed, and because a spend and its
 * cancellation refund cancel each other out, the balance is unchanged.
 */
async function main() {
  await connectDatabase();

  const user = await User.findOne({ email: EMAIL }).lean();
  if (!user) {
    console.log(`No account found for ${EMAIL}. Nothing to do.`);
    return;
  }
  const userId = String(user._id);

  const orders = await Order.find({ userId })
    .select('_id publicId orderCode status commerceStatus totalMinor createdAt')
    .lean();
  if (!orders.length) {
    console.log(`${EMAIL} has no orders. Nothing to do.`);
    return;
  }

  // Order references are stored inconsistently across collections — some hold
  // the ObjectId, others the publicId or orderCode — so match on all of them.
  const orderRefs = [...new Set(
    orders.flatMap((order) => [order._id, order.publicId, order.orderCode]).filter(Boolean).map(String),
  )];
  const orderIds = orders.map((order) => order._id);

  console.log(`${EMAIL} — ${orders.length} order(s):`);
  for (const order of orders) {
    console.log(`  ${order.publicId || order.orderCode}  ${order.status}/${order.commerceStatus}  ₦${(Number(order.totalMinor || 0) / 100).toLocaleString()}`);
  }

  const targets: Target[] = [
    // Market Associate + hub fulfilment trail
    { label: 'Fulfilment tasks (Market Associate)', model: FulfilmentTask, filter: { orderId: { $in: orderRefs } } },
    { label: 'Runner packages (Market Associate)', model: RunnerPackage, filter: { orderId: { $in: orderRefs } } },
    { label: 'Hub packages', model: HubPackage, filter: { orderId: { $in: orderRefs } } },
    { label: 'Return requests', model: ReturnRequest, filter: { orderId: { $in: orderRefs } } },
    { label: 'Shipments', model: Shipment, filter: { orderId: { $in: orderRefs } } },
    { label: 'Logistics records', model: Logistics, filter: { orderId: { $in: orderRefs } } },
    // Money trail
    { label: 'Escrow ledger entries', model: EscrowLedger, filter: { orderId: { $in: orderRefs } } },
    { label: 'Payment links', model: PaymentLink, filter: { orderId: { $in: orderRefs } } },
    { label: 'Payments', model: Payment, filter: { orderId: { $in: orderRefs } } },
    { label: 'Refund requests', model: RefundRequest, filter: { orderId: { $in: orderRefs } } },
    // Hook credit entries for these orders only — the welcome bonus has no
    // orderId, so it survives and the balance stays put.
    { label: 'Hook credit entries for these orders', model: CreditLedger, filter: { orderId: { $in: orderRefs } } },
    { label: 'Coupon redemptions for these orders', model: CouponRedemption, filter: { orderId: { $in: orderRefs } } },
    // Order records themselves
    { label: 'Order fulfilment groups', model: OrderFulfilmentGroup, filter: { orderId: { $in: orderRefs } } },
    { label: 'Order items', model: OrderItem, filter: { orderId: { $in: orderRefs } } },
    { label: 'Checkout previews', model: CheckoutPreview, filter: { customerId: userId } },
    { label: 'Orders', model: Order, filter: { _id: { $in: orderIds } } },
  ];

  console.log(`\n${execute ? 'Clearing' : 'Dry run for'} the records above:`);
  for (const target of targets) {
    const count = await target.model.countDocuments(target.filter);
    if (!count) continue;
    if (execute) await target.model.deleteMany(target.filter);
    console.log(`  ${execute ? 'Deleted' : 'Would delete'} ${count} ${target.label}`);
  }

  // On a dry run the order-linked rows still exist, so project what the
  // balance will be rather than reading the current (pre-cleanup) total.
  const ledgerRows = await CreditLedger.find({ userId, deletedAt: { $exists: false } })
    .select('amountMinor orderId')
    .lean();
  const surviving = execute
    ? ledgerRows
    : ledgerRows.filter((row) => !row.orderId || !orderRefs.includes(String(row.orderId)));
  const balance = Math.max(0, surviving.reduce((sum, row) => sum + Number(row.amountMinor), 0));
  console.log(`\nHook credit balance ${execute ? 'is now' : 'will be'} ₦${(balance / 100).toLocaleString()} (account kept).`);

  if (!execute) console.log('\nNo data changed. Run with --execute to apply this cleanup.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
