import { CommerceOrderStatus, CommercePaymentStatus, HubPackageStatus, ProductSubmissionStatus, ShipmentStatus } from '@lib/constants';
import { FulfilmentRefund, FulfilmentTask, HubPackage, ReturnRequest, Shipment } from '@models/fulfilment/fulfilment.model';
import { MarketAssociateProfile } from '@models/platform/operations-accounts.model';
import { User } from '@models/users/user.model';
import { Order } from '@models/orders/order.model';
import { Payment } from '@models/payments/payment.model';
import { ProductSubmission } from '@models/catalog/catalog.model';
import { DispatchHub, Market } from '@models/platform/network.model';

/** One thing staff should hear about: who may see it, where it happened, and what to say. */
export type StaffEvent = {
  /** Same prefix the live alert uses, so catching up never doubles a notification the admin already got. */
  eventKeyPrefix: string;
  stateId?: string;
  hubId?: string;
  title: string;
  body: string;
  type: string;
  data: Record<string, unknown>;
  at: Date;
};

export type StaffRule = {
  key: string;
  label: string;
  category: 'orders' | 'shipping' | 'fulfilment' | 'returns' | 'catalog' | 'finance';
  /** The permission that decides who is told (holding any one is enough). SUPER_ADMIN is told everything. */
  permission: string | string[];
  /** Events since `since` that matching staff should have been told about. */
  collect(since: Date): Promise<StaffEvent[]>;
};

const LIMIT = 50;
const naira = (minor?: number) => `₦${Math.round(Number(minor || 0) / 100).toLocaleString('en-NG')}`;
const place = (order: { addressSnapshot?: Record<string, any>; deliveryAddress?: Record<string, any> }) => {
  const address = order.addressSnapshot || order.deliveryAddress || {};
  return [address.cityName || address.city, address.stateName || address.state].filter(Boolean).join(', ');
};

/** "New paid order" as staff see it, used by the live alert when payment lands and by the catch-up. */
export function paidOrderEvent(order: any, at: Date): StaffEvent {
  const where = place(order);
  return {
    eventKeyPrefix: `order:${order.publicId}:paid`,
    stateId: order.sourceStateId,
    title: 'New paid order',
    body: `${order.publicId} · ${naira(order.totalMinor)}${where ? ` · delivering to ${where}` : ''}`,
    type: 'order_paid',
    data: { orderId: order.publicId, category: 'orders', href: `/dashboard/orders/${order.publicId}` },
    at,
  };
}

/** "Package received at the hub, ready to ship": the live alert and the catch-up share this. */
export function readyToShipEvent(pack: any, order: any, hubName: string | undefined, at: Date): StaffEvent {
  return {
    eventKeyPrefix: `ready-to-ship:${pack.publicId}`,
    stateId: order?.sourceStateId,
    hubId: String(pack.hubId),
    title: 'Ready to ship',
    body: `${order?.publicId || 'An order'} has a package at ${hubName || 'the hub'}. Book it with the courier.`,
    type: 'ready_to_ship',
    data: { orderId: order?.publicId, hubPackageId: pack.publicId, category: 'shipping', href: '/dashboard/shipping' },
    at,
  };
}


const idMatch = (id: string) => (/^[a-f\d]{24}$/i.test(id) ? { _id: id } : { publicId: id });
const moment = (value: Date | undefined) => value || new Date();

/** Order reference, market and associate names for a batch of tasks, in four queries. */
export async function describeTasks(tasks: any[]) {
  const orders = await Order.find({ _id: { $in: [...new Set(tasks.map((task) => String(task.orderId)))] } }).select('publicId').lean() as any[];
  const marketRefs = [...new Set(tasks.map((task) => String(task.marketId)).filter((id) => id && id !== 'UNASSIGNED'))];
  const markets = marketRefs.length ? await Market.find({ $or: marketRefs.map(idMatch) }).select('publicId name').lean() as any[] : [];
  const profileIds = [...new Set(tasks.map((task) => task.marketAssociateId).filter(Boolean).map(String))];
  const profiles = profileIds.length ? await MarketAssociateProfile.find({ _id: { $in: profileIds } }).select('accountId').lean() as any[] : [];
  const accounts = profiles.length ? await User.find({ _id: { $in: profiles.map((profile) => profile.accountId) } }).select('firstName lastName').lean() as any[] : [];
  const orderRef = new Map(orders.map((order) => [String(order._id), order.publicId as string]));
  const nameByAccount = new Map(accounts.map((account) => [String(account._id), `${account.firstName || ''} ${account.lastName || ''}`.trim()]));
  const nameByProfile = new Map(profiles.map((profile) => [String(profile._id), nameByAccount.get(String(profile.accountId))]));
  return (task: any) => ({
    orderPublicId: orderRef.get(String(task.orderId)),
    marketName: markets.find((market) => String(market._id) === String(task.marketId) || market.publicId === task.marketId)?.name as string | undefined,
    associateName: nameByProfile.get(String(task.marketAssociateId)),
  });
}

export type TaskMilestone = 'accepted' | 'secured' | 'submitted';
const MILESTONES: Record<TaskMilestone, { title: string; verb: string; field: string }> = {
  accepted: { title: 'Associate accepted the order', verb: 'accepted', field: 'acceptedAt' },
  secured: { title: 'Items secured at the market', verb: 'secured the items for', field: 'productSecuredAt' },
  submitted: { title: 'Order fulfilled — on its way to the hub', verb: 'finished sourcing and packed', field: 'packedAt' },
};

/** A Market Associate moved a task forward. `submitted` is the moment they say the order is fulfilled. */
export function taskMilestoneEvent(kind: TaskMilestone, task: any, ctx: { orderPublicId?: string; marketName?: string; associateName?: string }, at?: Date): StaffEvent {
  const meta = MILESTONES[kind];
  return {
    eventKeyPrefix: `task:${task.publicId}:${kind}`, stateId: task.sourceStateId, hubId: task.hubId,
    title: meta.title,
    body: `${ctx.associateName || 'An associate'} ${meta.verb} ${ctx.orderPublicId || 'an order'}${ctx.marketName ? ` at ${ctx.marketName}` : ''}.`,
    type: 'order_updated',
    data: { taskId: task.publicId, orderId: ctx.orderPublicId, category: 'fulfilment', href: `/dashboard/fulfilment/tasks/${task.publicId}` },
    at: moment(at),
  };
}

export type ShipmentMoment = 'booked' | 'picked_up' | 'out_for_delivery' | 'delivered' | 'cancelled';
const SHIPMENT: Record<ShipmentMoment, { title: string; body: (ref: string, shipment: any) => string }> = {
  booked: { title: 'Shipment booked', body: (ref, s) => `${ref} is booked with ${s.courierName || s.provider || 'the courier'}${s.trackingNumber ? ` · tracking ${s.trackingNumber}` : ''}.` },
  picked_up: { title: 'Picked up by the courier', body: (ref, s) => `${ref} was collected by ${s.courierName || 'the courier'} and is on its way.` },
  out_for_delivery: { title: 'Out for delivery', body: (ref) => `${ref} is out for delivery today.` },
  delivered: { title: 'Order delivered', body: (ref) => `${ref} was delivered to the customer.` },
  cancelled: { title: 'Shipment cancelled', body: (ref) => `The booking for ${ref} was cancelled. Its packages are ready to ship again.` },
};

export function shipmentMomentEvent(kind: ShipmentMoment, shipment: any, orderPublicId: string | undefined, at?: Date): StaffEvent {
  const ref = orderPublicId || shipment.publicId;
  return {
    eventKeyPrefix: `shipment:${shipment.publicId}:${kind}`, stateId: shipment.sourceStateId, hubId: shipment.hubId,
    title: SHIPMENT[kind].title, body: SHIPMENT[kind].body(ref, shipment),
    type: kind === 'delivered' ? 'order_delivered' : 'order_updated',
    data: { orderId: orderPublicId, shipmentId: shipment.publicId, category: 'shipping', href: orderPublicId ? `/dashboard/orders/${orderPublicId}` : '/dashboard/shipping' },
    at: moment(at),
  };
}

export function orderCancelledEvent(order: any, reason: string | undefined, at?: Date): StaffEvent {
  return {
    eventKeyPrefix: `order:${order.publicId}:cancelled-notice`, stateId: order.sourceStateId,
    title: 'Order cancelled', body: `${order.publicId} was cancelled${reason ? `: ${reason}` : '.'}`,
    type: 'order_cancelled', data: { orderId: order.publicId, category: 'orders', href: `/dashboard/orders/${order.publicId}` }, at: moment(at),
  };
}

const naira2 = (minor?: number) => `₦${Math.round(Number(minor || 0) / 100).toLocaleString('en-NG')}`;
export function refundEvent(kind: 'requested' | 'processed', refund: any, order: any, at?: Date): StaffEvent {
  return {
    eventKeyPrefix: `refund:${refund.publicId}:${kind}-notice`, stateId: order?.sourceStateId,
    title: kind === 'requested' ? 'Refund requested' : 'Refund processed',
    body: `${naira2(refund.amountMinor)} for ${order?.publicId || 'an order'}${kind === 'requested' ? ' is waiting to be processed.' : ' was sent back to the customer.'}`,
    type: 'order_updated', data: { orderId: order?.publicId, refundId: refund.publicId, category: 'finance', href: order?.publicId ? `/dashboard/orders/${order.publicId}` : '/dashboard/fulfilment/refunds' }, at: moment(at),
  };
}

export const STAFF_RULES: StaffRule[] = [
  {
    key: 'order_paid', label: 'New paid orders', category: 'orders', permission: 'orders.view',
    async collect(since) {
      const payments = await Payment.find({ commerceStatus: CommercePaymentStatus.CONFIRMED, paidAt: { $gte: since }, orderId: { $exists: true } }).sort({ paidAt: -1 }).limit(LIMIT).select('orderId paidAt').lean() as any[];
      const paidAt = new Map(payments.map((payment) => [String(payment.orderId), payment.paidAt as Date]));
      if (!paidAt.size) return [];
      const orders = await Order.find({ _id: { $in: [...paidAt.keys()] } }).select('publicId totalMinor sourceStateId addressSnapshot deliveryAddress').lean() as any[];
      return orders.map((order) => paidOrderEvent(order, paidAt.get(String(order._id)) || new Date()));
    },
  },
  {
    key: 'operations_review', label: 'Orders needing review', category: 'orders', permission: 'orders.edit',
    async collect(since) {
      const orders = await Order.find({ commerceStatus: CommerceOrderStatus.OPERATIONS_REVIEW, updatedAt: { $gte: since } }).sort({ updatedAt: -1 }).limit(LIMIT).select('publicId sourceStateId updatedAt').lean() as any[];
      return orders.map((order) => ({
        eventKeyPrefix: `order:${order.publicId}:operations-review`, stateId: order.sourceStateId,
        title: 'Order needs operations review', body: `${order.publicId} is awaiting review before it can be approved for fulfilment.`,
        type: 'order_operations_review', data: { orderId: order.publicId, category: 'orders', href: `/dashboard/orders/${order.publicId}` }, at: order.updatedAt,
      }));
    },
  },
  {
    key: 'partner_order', label: 'Partner-created orders', category: 'orders', permission: 'orders.edit',
    async collect(since) {
      const orders = await Order.find({ channel: 'PARTNER_ASSISTED', createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(LIMIT).select('publicId sourceStateId createdAt').lean() as any[];
      return orders.map((order) => ({
        eventKeyPrefix: `partner-order:${order.publicId}:created`, stateId: order.sourceStateId,
        title: 'Partner created an order', body: `A Hook Partner started order ${order.publicId} for a customer`,
        type: 'order_updated', data: { orderId: order.publicId, category: 'orders', href: `/dashboard/orders/${order.publicId}` }, at: order.createdAt,
      }));
    },
  },
  {
    key: 'ready_to_ship', label: 'Packages ready to ship', category: 'shipping', permission: ['logistics.book', 'fulfilment.view'],
    async collect(since) {
      const packs = await HubPackage.find({ status: HubPackageStatus.QC_PASSED, receivedAt: { $gte: since } }).sort({ receivedAt: -1 }).limit(LIMIT).lean({ virtuals: true }) as any[];
      if (!packs.length) return [];
      const [orders, hubs] = await Promise.all([
        Order.find({ _id: { $in: [...new Set(packs.map((pack) => String(pack.orderId)))] } }).select('publicId sourceStateId').lean() as Promise<any[]>,
        DispatchHub.find({ $or: [...new Set(packs.map((pack) => String(pack.hubId)))].map((id) => (/^[a-f\d]{24}$/i.test(id) ? { _id: id } : { publicId: id })) }).select('publicId name').lean() as Promise<any[]>,
      ]);
      const orderById = new Map(orders.map((order) => [String(order._id), order]));
      const hubName = (id: string) => hubs.find((hub) => String(hub._id) === id || hub.publicId === id)?.name as string | undefined;
      return packs.map((pack) => readyToShipEvent(pack, orderById.get(String(pack.orderId)), hubName(String(pack.hubId)), pack.receivedAt));
    },
  },
  {
    key: 'delivery_failed', label: 'Failed deliveries', category: 'shipping', permission: 'fulfilment.manage',
    async collect(since) {
      const shipments = await Shipment.find({ status: ShipmentStatus.DELIVERY_FAILED, updatedAt: { $gte: since } }).sort({ updatedAt: -1 }).limit(LIMIT).lean({ virtuals: true }) as any[];
      if (!shipments.length) return [];
      const orders = await Order.find({ _id: { $in: shipments.map((shipment) => shipment.orderId) } }).select('publicId').lean() as any[];
      const publicId = new Map(orders.map((order) => [String(order._id), order.publicId as string]));
      return shipments.map((shipment) => {
        const ref = publicId.get(String(shipment.orderId));
        return {
          eventKeyPrefix: `shipment:${shipment.publicId}:delivery-failed:${shipment.version}`, stateId: shipment.sourceStateId, hubId: shipment.hubId,
          title: 'Delivery attempt failed', body: `${ref || shipment.publicId} needs a redelivery or return decision.`,
          type: 'order_delayed', data: { orderId: ref, shipmentId: shipment.publicId, category: 'shipping', href: ref ? `/dashboard/orders/${ref}` : '/dashboard/shipping' }, at: shipment.updatedAt,
        };
      });
    },
  },
  {
    key: 'return_requested', label: 'Return requests', category: 'returns', permission: 'fulfilment.manage',
    async collect(since) {
      const returns = await ReturnRequest.find({ status: 'REQUESTED', createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(LIMIT).lean({ virtuals: true }) as any[];
      if (!returns.length) return [];
      const orders = await Order.find({ _id: { $in: returns.map((record) => record.orderId) } }).select('publicId sourceStateId').lean() as any[];
      const byId = new Map(orders.map((order) => [String(order._id), order]));
      return returns.flatMap((record) => {
        const order = byId.get(String(record.orderId));
        if (!order) return [];
        return [{
          eventKeyPrefix: `return:${record.publicId}:requested`, stateId: order.sourceStateId,
          title: 'New return request', body: `${order.publicId} — a return was requested: ${String(record.reason || record.reasonType || '')}`.trim(),
          type: 'return_update', data: { orderId: order.publicId, returnRequestId: record.publicId, category: 'returns', href: `/dashboard/orders/${order.publicId}` }, at: record.createdAt,
        }];
      });
    },
  },
  {
    key: 'submission_review', label: 'Submissions to review', category: 'catalog', permission: 'catalog.submission.review',
    async collect(since) {
      const submissions = await ProductSubmission.find({ status: ProductSubmissionStatus.SUBMITTED, updatedAt: { $gte: since } }).sort({ updatedAt: -1 }).limit(LIMIT).lean({ virtuals: true }) as any[];
      return submissions.map((submission) => ({
        eventKeyPrefix: `submission:${submission.publicId}:submitted`, stateId: submission.sourceStateId,
        title: 'New submission for review', body: `${submission.basicTitle || 'A product'} was submitted by a Market Associate`,
        type: 'order_updated', data: { submissionId: submission.publicId, category: 'catalog', href: `/dashboard/catalog/submissions/${submission.publicId}` }, at: submission.updatedAt,
      }));
    },
  },
  ...(['accepted', 'secured', 'submitted'] as TaskMilestone[]).map((kind): StaffRule => ({
    key: `task_${kind}`, label: kind === 'submitted' ? 'Orders fulfilled by associates' : kind === 'accepted' ? 'Associates accepting orders' : 'Items secured', category: 'fulfilment', permission: ['fulfilment.view', 'fulfilment.manage'],
    async collect(since) {
      const field = MILESTONES[kind].field;
      const tasks = await FulfilmentTask.find({ [field]: { $gte: since } }).sort({ [field]: -1 }).limit(LIMIT).lean({ virtuals: true }) as any[];
      if (!tasks.length) return [];
      const describe = await describeTasks(tasks);
      return tasks.map((task) => taskMilestoneEvent(kind, task, describe(task), task[field]));
    },
  })),
  ...([['booked', 'bookedAt'], ['picked_up', 'pickedUpAt'], ['delivered', 'deliveredAt']] as Array<[ShipmentMoment, string]>).map(([kind, field]): StaffRule => ({
    key: `shipment_${kind}`, label: kind === 'booked' ? 'Shipments booked' : kind === 'picked_up' ? 'Courier pickups' : 'Deliveries', category: 'shipping', permission: ['logistics.view', 'fulfilment.view'],
    async collect(since) {
      const shipments = await Shipment.find({ [field]: { $gte: since } }).sort({ [field]: -1 }).limit(LIMIT).lean({ virtuals: true }) as any[];
      if (!shipments.length) return [];
      const orders = await Order.find({ _id: { $in: shipments.map((shipment) => shipment.orderId) } }).select('publicId').lean() as any[];
      const ref = new Map(orders.map((order) => [String(order._id), order.publicId as string]));
      return shipments.map((shipment) => shipmentMomentEvent(kind, shipment, ref.get(String(shipment.orderId)), shipment[field]));
    },
  })),
  {
    key: 'order_cancelled', label: 'Cancelled orders', category: 'orders', permission: 'orders.view',
    async collect(since) {
      const orders = await Order.find({ commerceStatus: CommerceOrderStatus.CANCELLED, commercePaymentStatus: { $in: [CommercePaymentStatus.CONFIRMED, CommercePaymentStatus.REFUND_PENDING, CommercePaymentStatus.REFUNDED] }, updatedAt: { $gte: since } }).sort({ updatedAt: -1 }).limit(LIMIT).select('publicId sourceStateId updatedAt').lean() as any[];
      return orders.map((order) => orderCancelledEvent(order, undefined, order.updatedAt));
    },
  },
  {
    key: 'refund_requested', label: 'Refund requests', category: 'finance', permission: 'finance.refunds.view',
    async collect(since) {
      const refunds = await FulfilmentRefund.find({ createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(LIMIT).lean({ virtuals: true }) as any[];
      if (!refunds.length) return [];
      const orders = await Order.find({ _id: { $in: refunds.map((refund) => refund.orderId) } }).select('publicId sourceStateId').lean() as any[];
      const byId = new Map(orders.map((order) => [String(order._id), order]));
      return refunds.map((refund) => refundEvent('requested', refund, byId.get(String(refund.orderId)), refund.createdAt));
    },
  },
  {
    key: 'refund_processed', label: 'Refunds sent', category: 'finance', permission: 'finance.refunds.view',
    async collect(since) {
      const refunds = await FulfilmentRefund.find({ status: 'REFUNDED', processedAt: { $gte: since } }).sort({ processedAt: -1 }).limit(LIMIT).lean({ virtuals: true }) as any[];
      if (!refunds.length) return [];
      const orders = await Order.find({ _id: { $in: refunds.map((refund) => refund.orderId) } }).select('publicId sourceStateId').lean() as any[];
      const byId = new Map(orders.map((order) => [String(order._id), order]));
      return refunds.map((refund) => refundEvent('processed', refund, byId.get(String(refund.orderId)), refund.processedAt));
    },
  },
];
