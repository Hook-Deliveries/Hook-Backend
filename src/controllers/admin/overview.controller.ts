import { Request, Response } from 'express';
import { CommerceOrderStatus } from '@lib/constants';
import { sendSuccess } from '@utils/http';
import { Order } from '@models/orders/order.model';
import { User } from '@models/users/user.model';
import { FulfilmentRefund, ReturnRequest } from '@models/fulfilment/fulfilment.model';
import { fulfilmentService } from '@modules/fulfilment/fulfilment.service';

const TZ = 'Africa/Lagos';
const UNPAID: CommerceOrderStatus[] = [CommerceOrderStatus.AWAITING_PAYMENT, CommerceOrderStatus.CANCELLED];
const IN_FULFILMENT: CommerceOrderStatus[] = [
  CommerceOrderStatus.APPROVED_FOR_FULFILMENT, CommerceOrderStatus.IN_FULFILMENT, CommerceOrderStatus.PARTIALLY_RECEIVED,
  CommerceOrderStatus.READY_FOR_CONSOLIDATION, CommerceOrderStatus.READY_FOR_DISPATCH, CommerceOrderStatus.IN_TRANSIT,
  CommerceOrderStatus.PARTIALLY_IN_TRANSIT, CommerceOrderStatus.PARTIALLY_DELIVERED,
];
const DELIVERED: CommerceOrderStatus[] = [CommerceOrderStatus.DELIVERED, CommerceOrderStatus.COLLECTED, CommerceOrderStatus.COMPLETED];

const delta = (current: number, previous: number) => ({
  value: current,
  previous,
  changePct: previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : current > 0 ? 100 : 0,
});

/**
 * One aggregated payload for the admin dashboard. Replaces the older
 * /dashboard summary (legacy order model) so every figure comes from the same
 * commerce order records the rest of the admin works with.
 */
export class AdminOverviewController {
  overview = async (req: Request, res: Response) => {
    const days = [7, 30, 90].includes(Number(req.query.range)) ? Number(req.query.range) : 30;
    const stateIds = (req.user?.assignedStateIds || []).map(String);
    const scope: Record<string, unknown> = stateIds.length ? { sourceStateId: { $in: stateIds } } : {};

    // Calendar days in Lagos time, ending today.
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - (days - 1));
    start.setHours(0, 0, 0, 0);
    const prevStart = new Date(start);
    prevStart.setDate(prevStart.getDate() - days);
    const paid = { ...scope, commerceStatus: { $nin: UNPAID } };

    const totals = (from: Date, to: Date) => Order.aggregate([
      { $match: { ...paid, createdAt: { $gte: from, $lt: to } } },
      { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: { $ifNull: ['$totalMinor', 0] } } } },
    ]);

    const [current, previous, daily, statuses, methods, topStates, recent, newCustomers, prevCustomers, deliveredNow, deliveredPrev, inFulfilment, pipeline, refundsOpen, returnsOpen, lastHour] = await Promise.all([
      totals(start, new Date(end.getTime() + 1)),
      totals(prevStart, start),
      Order.aggregate([
        { $match: { ...paid, createdAt: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TZ } }, orders: { $sum: 1 }, revenue: { $sum: { $ifNull: ['$totalMinor', 0] } } } },
      ]),
      Order.aggregate([{ $match: { ...scope, createdAt: { $gte: start } } }, { $group: { _id: '$commerceStatus', count: { $sum: 1 } } }]),
      Order.aggregate([
        { $match: { ...paid, createdAt: { $gte: start } } },
        { $group: { _id: '$commercePaymentMethod', count: { $sum: 1 }, revenue: { $sum: { $ifNull: ['$totalMinor', 0] } } } },
      ]),
      Order.aggregate([
        { $match: { ...paid, createdAt: { $gte: start }, 'addressSnapshot.stateName': { $exists: true } } },
        { $group: { _id: '$addressSnapshot.stateName', orders: { $sum: 1 }, revenue: { $sum: { $ifNull: ['$totalMinor', 0] } } } },
        { $sort: { orders: -1 } },
        { $limit: 6 },
      ]),
      Order.find({ ...scope, commerceStatus: { $ne: CommerceOrderStatus.AWAITING_PAYMENT } })
        .sort({ createdAt: -1 }).limit(8)
        .select('publicId commerceStatus commercePaymentMethod totalMinor createdAt customerSnapshot addressSnapshot')
        .lean(),
      User.countDocuments({ createdAt: { $gte: start } }),
      User.countDocuments({ createdAt: { $gte: prevStart, $lt: start } }),
      Order.countDocuments({ ...scope, commerceStatus: { $in: DELIVERED }, updatedAt: { $gte: start } }),
      Order.countDocuments({ ...scope, commerceStatus: { $in: DELIVERED }, updatedAt: { $gte: prevStart, $lt: start } }),
      Order.countDocuments({ ...scope, commerceStatus: { $in: IN_FULFILMENT } }),
      fulfilmentService.overview({ accountId: req.user!.sub, publicId: req.user!.publicId, accountType: req.user!.accountType, stateIds: req.user!.assignedStateIds, hubIds: req.user!.assignedHubIds } as never, {}),
      FulfilmentRefund.countDocuments({ status: { $in: ['REQUESTED', 'APPROVED', 'PROVIDER_PENDING'] } }),
      ReturnRequest.countDocuments({ status: { $in: ['REQUESTED', 'UNDER_REVIEW', 'APPROVED'] } }),
      Order.countDocuments({ ...paid, createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) } }),
    ]);

    // Fill every calendar day so the charts have no gaps.
    const byDay = new Map<string, { orders: number; revenue: number }>(daily.map((row: any) => [row._id, { orders: row.orders, revenue: row.revenue }]));
    const series: Array<{ date: string; orders: number; revenueMinor: number }> = [];
    for (let index = 0; index < days; index += 1) {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      const key = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(day);
      const row = byDay.get(key);
      series.push({ date: key, orders: row?.orders || 0, revenueMinor: row?.revenue || 0 });
    }

    const cur = current[0] || { orders: 0, revenue: 0 };
    const prev = previous[0] || { orders: 0, revenue: 0 };
    const p = pipeline as Record<string, number>;
    const attention = [
      { key: 'blocked', label: 'Blocked fulfilment tasks', count: p.blocked, href: '/dashboard/fulfilment', tone: 'danger' },
      { key: 'qc-failed', label: 'Packages failed quality check', count: p.failed, href: '/dashboard/fulfilment/hub', tone: 'danger' },
      { key: 'ready-to-book', label: 'Sealed parcels waiting for a courier', count: p.readyToBook, href: '/dashboard/fulfilment/shipments', tone: 'warning' },
      { key: 'exceptions', label: 'Delivery exceptions', count: p.exceptions, href: '/dashboard/fulfilment/shipments', tone: 'danger' },
      { key: 'refunds', label: 'Refunds to process', count: refundsOpen, href: '/dashboard/fulfilment/refunds', tone: 'warning' },
      { key: 'returns', label: 'Open return requests', count: returnsOpen, href: '/dashboard/fulfilment/returns', tone: 'warning' },
    ].filter((item) => item.count > 0);

    sendSuccess(res, {
      range: days,
      generatedAt: new Date().toISOString(),
      kpis: {
        revenue: delta(cur.revenue, prev.revenue),
        orders: delta(cur.orders, prev.orders),
        averageOrder: delta(cur.orders ? Math.round(cur.revenue / cur.orders) : 0, prev.orders ? Math.round(prev.revenue / prev.orders) : 0),
        delivered: delta(deliveredNow, deliveredPrev),
        customers: delta(newCustomers, prevCustomers),
        inFulfilment: { value: inFulfilment },
        lastHourOrders: { value: lastHour },
      },
      series,
      statuses: statuses.map((row: any) => ({ status: row._id || 'UNKNOWN', count: row.count })).sort((a: any, b: any) => b.count - a.count),
      paymentMethods: methods.map((row: any) => ({ method: row._id || 'PREPAID', count: row.count, revenueMinor: row.revenue })),
      topStates: topStates.map((row: any) => ({ name: row._id, orders: row.orders, revenueMinor: row.revenue })),
      pipeline: p,
      attention,
      recentOrders: (recent as any[]).map((order) => ({
        publicId: order.publicId,
        status: order.commerceStatus,
        paymentMethod: order.commercePaymentMethod,
        totalMinor: order.totalMinor,
        createdAt: order.createdAt,
        customer: order.customerSnapshot?.name || order.addressSnapshot?.recipientName,
        state: order.addressSnapshot?.stateName,
      })),
    });
  };
}
