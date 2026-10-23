import mongoose from 'mongoose';
import { Order } from '@models/orders/order.model';
import { OrderItem } from '@models/orders/order-item.model';
import { OrderFulfilmentGroup } from '@models/orders/order-fulfilment-group.model';
import { Shipment } from '@models/fulfilment/fulfilment.model';
import { nextPublicId } from '@modules/platform/public-id.service';
import { appendTimeline } from '@lib/order-timeline';
import { HttpError } from '@utils/http';

type SplitGroupInput = { orderItemIds: string[] };

/**
 * Splits one order into several deliveries, each with its own fulfilment
 * group, so items that are ready can ship without waiting for the rest.
 *
 * Until the index migration this was physically impossible: a unique
 * { orderId, sourceStateId } index meant a State could hold only one group.
 *
 * Every money line is re-prorated across the new groups by subtotal share with
 * the remainder on the last group, mirroring checkout.service.ts exactly — if
 * the per-group shares stopped summing to the order total, per-group
 * settlement would silently drift from what the customer actually paid.
 */
export async function splitOrderIntoGroups(
  orderIdentifier: string,
  groups: SplitGroupInput[],
  actorId: string,
  reason: string,
) {
  if (groups.length < 2) {
    throw new HttpError(400, 'A split needs at least two deliveries', undefined, 'VALIDATION_ERROR');
  }

  const order = await Order.findOne({
    $or: [{ _id: mongoose.isValidObjectId(orderIdentifier) ? orderIdentifier : undefined }, { publicId: orderIdentifier }, { orderCode: orderIdentifier }].filter(
      (clause) => Object.values(clause)[0] !== undefined,
    ) as any[],
  });
  if (!order) throw new HttpError(404, 'Order not found', undefined, 'NOT_FOUND');

  const status = String(order.commerceStatus || '').toUpperCase();
  if (['CANCELLED', 'DELIVERED', 'COMPLETED', 'REFUNDED'].includes(status)) {
    throw new HttpError(409, 'This order can no longer be split', undefined, 'INVALID_STATE_TRANSITION');
  }
  // Splitting after dispatch would strand a shipment pointing at a group that
  // no longer owns those items.
  const dispatched = await Shipment.countDocuments({ orderId: String(order._id) });
  if (dispatched) {
    throw new HttpError(409, 'This order has already been dispatched and cannot be split', undefined, 'INVALID_STATE_TRANSITION');
  }

  const items = await OrderItem.find({ orderId: String(order._id) })
    .select('publicId stateId totalPriceMinor totalPrice')
    .lean() as any[];
  const byPublicId = new Map(items.map((item) => [String(item.publicId), item]));

  // Every item must be assigned exactly once: a missing item would vanish from
  // fulfilment, and a duplicated one would be sourced and charged twice.
  const seen = new Set<string>();
  for (const group of groups) {
    if (!group.orderItemIds?.length) {
      throw new HttpError(400, 'Every delivery must contain at least one item', undefined, 'VALIDATION_ERROR');
    }
    for (const id of group.orderItemIds) {
      if (!byPublicId.has(String(id))) {
        throw new HttpError(400, `Unknown order item: ${id}`, undefined, 'VALIDATION_ERROR');
      }
      if (seen.has(String(id))) {
        throw new HttpError(400, `Item ${id} is assigned to more than one delivery`, undefined, 'VALIDATION_ERROR');
      }
      seen.add(String(id));
    }
  }
  if (seen.size !== items.length) {
    throw new HttpError(400, 'Every item must be assigned to a delivery', undefined, 'VALIDATION_ERROR');
  }

  const itemTotal = (item: any) => Number(item.totalPriceMinor ?? Math.round(Number(item.totalPrice || 0) * 100));
  const plans = groups.map((group) => {
    const groupItems = group.orderItemIds.map((id) => byPublicId.get(String(id)));
    return {
      orderItemIds: group.orderItemIds.map(String),
      // All items in one delivery must share a source State — a single group
      // is sourced and consolidated in one place.
      sourceStateId: String(groupItems[0]?.stateId || order.sourceStateId || ''),
      subtotalMinor: groupItems.reduce((sum, item) => sum + itemTotal(item), 0),
    };
  });

  const orderSubtotal = Math.max(
    Number(order.subtotalMinor ?? Math.round(Number(order.subtotal || 0) * 100)),
    1,
  );
  let allocatedFee = 0;
  let allocatedVat = 0;
  let allocatedDiscount = 0;
  let allocatedCredits = 0;
  const share = (total: number, groupSubtotal: number, allocated: number, isLast: boolean) =>
    isLast ? total - allocated : Math.floor((total * groupSubtotal) / orderSubtotal);

  const publicIds = await Promise.all(plans.map(() => nextPublicId('orderFulfilmentGroup')));

  const session = await mongoose.startSession();
  const created: string[] = [];
  try {
    await session.withTransaction(async () => {
      // Retire the old grouping wholesale rather than mutating it: the new
      // plan is authoritative and a partial overwrite could leave an orphan.
      await OrderFulfilmentGroup.deleteMany({ orderId: String(order._id) }, { session });

      for (const [index, plan] of plans.entries()) {
        const isLast = index === plans.length - 1;
        const feeShare = share(Number(order.deliveryFeeMinor || 0), plan.subtotalMinor, allocatedFee, isLast);
        allocatedFee += feeShare;
        const vatShare = share(Number(order.vatMinor || 0), plan.subtotalMinor, allocatedVat, isLast);
        allocatedVat += vatShare;
        const discountShare = share(Number(order.couponDiscountMinor || 0), plan.subtotalMinor, allocatedDiscount, isLast);
        allocatedDiscount += discountShare;
        const creditShare = share(Number(order.creditsAppliedMinor || 0), plan.subtotalMinor, allocatedCredits, isLast);
        allocatedCredits += creditShare;

        await OrderFulfilmentGroup.create([{
          publicId: publicIds[index],
          orderId: String(order._id),
          sourceStateId: plan.sourceStateId,
          orderItemIds: plan.orderItemIds,
          subtotalMinor: plan.subtotalMinor,
          vatShareMinor: vatShare,
          deliveryFeeShareMinor: feeShare,
          couponDiscountShareMinor: discountShare,
          creditsAppliedShareMinor: creditShare,
          status: status === 'IN_FULFILMENT' ? 'IN_FULFILMENT' : 'PENDING',
        }], { session });
        created.push(publicIds[index]);

        await OrderItem.updateMany(
          { orderId: String(order._id), publicId: { $in: plan.orderItemIds } },
          { $set: { fulfilmentGroupId: publicIds[index] } },
          { session },
        );
      }

      order.timeline = appendTimeline(order, 'SPLIT_INTO_DELIVERIES', actorId, {
        actorType: 'ADMIN',
        reason,
        deliveryCount: plans.length,
      });
      await order.save({ session });
    });
  } finally {
    await session.endSession();
  }

  return { deliveryCount: plans.length, groupIds: created };
}
