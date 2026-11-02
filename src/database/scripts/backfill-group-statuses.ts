import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { Order } from '@models/orders/order.model';
import { OrderFulfilmentGroup } from '@models/orders/order-fulfilment-group.model';

const execute = process.argv.includes('--execute');

/**
 * A fulfilment group's status was only ever written once a shipment existed,
 * so groups on orders already in sourcing were stuck at PENDING. Every
 * delivery therefore reported "Order received" while the order itself said
 * "Hook is sourcing your items". The transition now advances them, but orders
 * that entered fulfilment before that fix still need correcting.
 */
async function main() {
  await connectDatabase();
  const orders = await Order.find({ commerceStatus: 'IN_FULFILMENT' }).select('_id publicId').lean() as any[];
  let total = 0;
  for (const order of orders) {
    const filter = { orderId: String(order._id), status: 'PENDING' };
    const count = await OrderFulfilmentGroup.countDocuments(filter);
    if (!count) continue;
    total += count;
    console.log(`  ${order.publicId}: ${count} group(s) stuck at PENDING.`);
    if (execute) await OrderFulfilmentGroup.updateMany(filter, { $set: { status: 'IN_FULFILMENT' } });
  }
  if (!total) {
    console.log('No fulfilment groups need correcting.');
    return;
  }
  console.log(execute ? `Advanced ${total} group(s) to IN_FULFILMENT.` : `\n${total} group(s) would be advanced. Run with --execute to apply.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => disconnectDatabase());
