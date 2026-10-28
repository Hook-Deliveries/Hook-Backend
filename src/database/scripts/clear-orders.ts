import mongoose, { Model } from 'mongoose';
import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { CheckoutPreview, IntegrationException, PaymentWebhookEvent, PodCallRecord, PodOverride } from '@models/commerce/commerce.model';
import { CommerceOutboxEvent } from '@modules/platform/outbox.model';
import { Consolidation, FulfilmentRefund, FulfilmentTask, HubPackage, LogisticsWebhookEvent, PartnerCustody, PickupManifest, ReturnRequest, RunnerPackage, Shipment } from '@models/fulfilment/fulfilment.model';
import { Logistics } from '@models/logistics/logistics.model';
import { OrderFulfilmentGroup } from '@models/orders/order-fulfilment-group.model';
import { OrderItem } from '@models/orders/order-item.model';
import { Order } from '@models/orders/order.model';
import { RefundRequest } from '@models/orders/refund-request.model';
import { VendorFulfilment } from '@models/orders/vendor-fulfilment.model';
import { EscrowLedger } from '@models/payments/escrow-ledger.model';
import { PaymentAttempt, PaymentLink } from '@models/payments/payment-link.model';
import { Payment } from '@models/payments/payment.model';

type AnyModel = Model<any>;
type Target = { label: string; model: AnyModel; filter: Record<string, unknown> };

const execute = process.argv.includes('--execute');

function unique(values: unknown[]) {
  return [...new Set(values.filter(Boolean).map(String))];
}

async function main() {
  await connectDatabase();

  const orders = await Order.find({}).select('_id publicId orderCode checkoutPreviewId').lean();
  const orderRefs = unique(orders.flatMap((order) => [order._id, order.publicId, order.orderCode]));
  const checkoutRefs = unique(orders.map((order) => order.checkoutPreviewId));
  const payments = await Payment.find({ orderId: { $in: orderRefs } })
    .select('_id publicId transactionRef gatewayRef')
    .lean();
  const paymentRefs = unique(payments.flatMap((payment) => [payment._id, payment.publicId, payment.transactionRef, payment.gatewayRef]));
  const tasks = await FulfilmentTask.find({ orderId: { $in: orderRefs } }).select('_id publicId').lean();
  const taskRefs = unique(tasks.flatMap((task) => [task._id, task.publicId]));
  const shipments = await Shipment.find({ orderId: { $in: orderRefs } }).select('_id publicId').lean();
  const shipmentRefs = unique(shipments.flatMap((shipment) => [shipment._id, shipment.publicId]));

  const targets: Target[] = [
    { label: 'Payment attempts', model: PaymentAttempt, filter: { $or: [{ orderId: { $in: orderRefs } }, { paymentId: { $in: paymentRefs } }] } },
    { label: 'Payment links', model: PaymentLink, filter: { $or: [{ orderId: { $in: orderRefs } }, { paymentId: { $in: paymentRefs } }] } },
    { label: 'Payment webhooks', model: PaymentWebhookEvent, filter: { reference: { $in: paymentRefs } } },
    { label: 'Integration exceptions', model: IntegrationException, filter: { $or: [{ orderId: { $in: orderRefs } }, { paymentId: { $in: paymentRefs } }, { reference: { $in: paymentRefs } }] } },
    { label: 'Escrow ledger entries', model: EscrowLedger, filter: { $or: [{ orderId: { $in: orderRefs } }, { paymentId: { $in: paymentRefs } }] } },
    { label: 'Fulfilment refunds', model: FulfilmentRefund, filter: { orderId: { $in: orderRefs } } },
    { label: 'Return requests', model: ReturnRequest, filter: { orderId: { $in: orderRefs } } },
    { label: 'Partner custody', model: PartnerCustody, filter: { orderId: { $in: orderRefs } } },
    { label: 'Logistics webhooks', model: LogisticsWebhookEvent, filter: { shipmentId: { $in: shipmentRefs } } },
    { label: 'Pickup manifests', model: PickupManifest, filter: { shipmentIds: { $in: shipmentRefs } } },
    { label: 'Shipments', model: Shipment, filter: { orderId: { $in: orderRefs } } },
    { label: 'Consolidations', model: Consolidation, filter: { orderId: { $in: orderRefs } } },
    { label: 'Hub packages', model: HubPackage, filter: { orderId: { $in: orderRefs } } },
    { label: 'Runner packages', model: RunnerPackage, filter: { orderId: { $in: orderRefs } } },
    { label: 'Fulfilment tasks', model: FulfilmentTask, filter: { orderId: { $in: orderRefs } } },
    { label: 'Legacy logistics', model: Logistics, filter: { orderId: { $in: orderRefs } } },
    { label: 'POD overrides', model: PodOverride, filter: { orderId: { $in: orderRefs } } },
    { label: 'POD call records', model: PodCallRecord, filter: { orderId: { $in: orderRefs } } },
    { label: 'Commerce outbox events', model: CommerceOutboxEvent, filter: { aggregateId: { $in: orderRefs } } },
    { label: 'Legacy refund requests', model: RefundRequest, filter: { orderId: { $in: orderRefs } } },
    { label: 'Legacy vendor fulfilments', model: VendorFulfilment, filter: { orderId: { $in: orderRefs } } },
    { label: 'Order fulfilment groups', model: OrderFulfilmentGroup, filter: { orderId: { $in: orderRefs } } },
    { label: 'Order items', model: OrderItem, filter: { orderId: { $in: orderRefs } } },
    { label: 'Consumed checkout previews', model: CheckoutPreview, filter: { $or: [{ orderId: { $in: orderRefs } }, { _id: { $in: checkoutRefs.filter(mongoose.isValidObjectId) } }] } },
    { label: 'Order payments', model: Payment, filter: { orderId: { $in: orderRefs } } },
    { label: 'Orders', model: Order, filter: { _id: { $in: orders.map((order) => order._id) } } },
  ];

  console.log(`${execute ? 'Clearing' : 'Dry run for'} ${orders.length} order(s) in ${mongoose.connection.name}`);
  for (const target of targets) {
    const count = await target.model.countDocuments(target.filter);
    if (!count) continue;
    if (execute) await target.model.deleteMany(target.filter);
    console.log(`${execute ? 'Deleted' : 'Would delete'} ${count} ${target.label}`);
  }

  if (!execute) console.log('No data changed. Run with --execute to apply this cleanup.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
