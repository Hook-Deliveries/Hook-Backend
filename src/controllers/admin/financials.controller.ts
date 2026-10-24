import { Request, Response } from 'express';
import { EscrowEventType, PaymentStatus, SettlementStatus } from '@lib/constants';
import { HttpError, sendSuccess } from '@utils/http';
import { actor, adminRepos, getPagination, paginated, routeParam } from './admin.helpers';
import { PaymentService } from '@modules/payments/payment.service';
import { Order } from '@models/orders/order.model';
import { Payment } from '@models/payments/payment.model';
import { Settlement } from '@models/settlements/settlement.model';
import { EscrowLedger } from '@models/payments/escrow-ledger.model';
import { adminFinancialCache } from '@lib/ttl-cache';

export class AdminFinancialsController {
  private paymentsService = new PaymentService(adminRepos.payments(), adminRepos.orders(), adminRepos.escrowLedger());
  dashboard = async (req: Request, res: Response) => {
    const period = ['24h', '7d', '30d', 'ytd'].includes(String(req.query.period).toLowerCase()) ? String(req.query.period).toLowerCase() : '7d';
    const cacheKey = String(period);
    const cached = adminFinancialCache.get(cacheKey);
    if (cached) {
      sendSuccess(res, cached);
      return;
    }
    const now = new Date();
    const start = period === '24h' ? new Date(now.getTime() - 24 * 60 * 60 * 1000)
      : period === '30d' ? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
        : period === 'ytd' ? new Date(now.getFullYear(), 0, 1)
          : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const successfulFilter = { $or: [{ status: PaymentStatus.SUCCESSFUL }, { commerceStatus: 'CONFIRMED' }] };
    const trendFormat = period === '24h' ? '%Y-%m-%d %H:00' : period === 'ytd' ? '%Y-%m' : '%Y-%m-%d';
    const [paymentTotals, trendRows, settlementRows, ledgerRows, subsidyRows, recentPayments, recentSettlements] = await Promise.all([
      Payment.aggregate([{ $match: successfulFilter }, { $group: { _id: null, grossVolume: { $sum: '$amount' }, gatewayFees: { $sum: '$gatewayFee' } } }]),
      Payment.aggregate([
        { $match: { ...successfulFilter, createdAt: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: trendFormat, date: '$createdAt', timezone: 'Africa/Lagos' } }, volume: { $sum: '$amount' }, revenue: { $sum: { $ifNull: ['$splitData.commission', 0] } } } },
        { $sort: { _id: 1 } },
      ]),
      Settlement.aggregate([
        { $facet: {
          totals: [{ $group: { _id: null, platformRevenue: { $sum: '$commissionAmount' } } }],
          pending: [{ $match: { status: SettlementStatus.PENDING_ESCROW } }, { $group: { _id: null, amount: { $sum: '$netAmount' } } }],
        } },
      ]),
      EscrowLedger.aggregate([{ $group: { _id: '$type', amount: { $sum: '$amount' } } }]),
      Order.aggregate([{ $group: { _id: null, total: { $sum: { $ifNull: ['$deliverySubsidy', 0] } } } }]),
      Payment.find({}).select('publicId orderId transactionRef gateway paymentMethod amount gatewayFee amountSettled status commerceStatus currency amountMinor paidAt createdAt').sort({ createdAt: -1 }).limit(20).lean({ virtuals: true }),
      Settlement.find({}).select('orderId settlementRef itemTotal commissionAmount netAmount deliveryFeePortion status escrowReleaseAt escrowReleasedAt paidAt gatewayTransferRef createdAt').sort({ createdAt: -1 }).limit(20).lean({ virtuals: true }),
    ]);
    const ledgerTotals = new Map((ledgerRows as any[]).map((row) => [String(row._id), Number(row.amount || 0)]));
    const settlementFacet = (settlementRows as any[])[0] || {};
    const pendingAmount = Number(settlementFacet.pending?.[0]?.amount || 0);
    const response = {
      grossVolume: Number(paymentTotals[0]?.grossVolume || 0),
      platformRevenue: Number(settlementFacet.totals?.[0]?.platformRevenue || 0),
      escrowBalance: pendingAmount,
      pendingPayouts: pendingAmount,
      heldFunds: ledgerTotals.get(EscrowEventType.HELD) || 0,
      refundQueue: ledgerTotals.get(EscrowEventType.REFUND_PENDING) || 0,
      availablePayouts: ledgerTotals.get(EscrowEventType.ELIGIBLE_FOR_PAYOUT) || 0,
      gatewayFees: Number(paymentTotals[0]?.gatewayFees || 0),
      deliverySubsidy: Number(subsidyRows[0]?.total || 0),
      period,
      trend: (trendRows as any[]).map((row) => ({ label: row._id, volume: Number(row.volume || 0), revenue: Number(row.revenue || 0) })),
      recentPayments,
      recentSettlements,
    };
    adminFinancialCache.set(cacheKey, response);
    sendSuccess(res, response);
  };

  settlements = async (req: Request, res: Response) => {
    const { page, limit, skip } = getPagination(req.query);
    const where = typeof req.query.status === 'string' ? { status: req.query.status as SettlementStatus } : {};
    const [data, total] = await adminRepos.settlements().findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });
    sendSuccess(res, paginated(data, total, page, limit));
  };

  settlementDetail = async (req: Request, res: Response) => {
    const settlement = await adminRepos.settlements().findOne({
      where: { id: routeParam(req.params.id) },
    });
    if (!settlement) throw new HttpError(404, 'Settlement not found');
    sendSuccess(res, settlement);
  };

  audit = async (req: Request, res: Response) => {
    const { page, limit, skip } = getPagination(req.query);
    const [data, total] = await adminRepos.auditLogs().findAndCount({ order: { createdAt: 'DESC' }, skip, take: limit });
    sendSuccess(res, paginated(data, total, page, limit));
  };

  payments = async (req: Request, res: Response) => {
    const { page, limit, skip } = getPagination(req.query);
    const where: Record<string, unknown> = {};
    if (typeof req.query.status === 'string') where.status = req.query.status;
    const [data, total] = await adminRepos.payments().findAndCount({ where, order: { createdAt: 'DESC' }, skip, take: limit, relations: { order: true } });
    sendSuccess(res, paginated(data, total, page, limit));
  };

  escrow = async (req: Request, res: Response) => {
    const { page, limit, skip } = getPagination(req.query);
    const [data, total] = await adminRepos.escrowLedger().findAndCount({ order: { createdAt: 'DESC' }, skip, take: limit });
    sendSuccess(res, paginated(data, total, page, limit));
  };

  refund = async (req: Request, res: Response) => {
    const result = await this.paymentsService.refund(routeParam(req.params.paymentId), req.body.amount, req.body.idempotencyKey);
    await adminRepos.auditLogs().save(adminRepos.auditLogs().create({
      action: 'payment.refund', resourceType: 'payment', resourceId: routeParam(req.params.paymentId),
      ...actor(req), metadata: JSON.stringify({ amount: req.body.amount, reason: req.body.reason }), status: 'success',
    }));
    sendSuccess(res, result);
  };

  reconciliation = async (_req: Request, res: Response) => {
    const [successful, receivedRows] = await Promise.all([
      Payment.find({ $or: [{ status: PaymentStatus.SUCCESSFUL }, { commerceStatus: 'CONFIRMED' }] })
        .select('publicId orderId transactionRef amount status commerceStatus createdAt')
        .sort({ createdAt: -1 })
        .limit(500)
        .lean({ virtuals: true }),
      EscrowLedger.find({ type: EscrowEventType.PAYMENT_RECEIVED }).select('paymentId').lean(),
    ]);
    const receivedIds = new Set((receivedRows as any[]).map((row) => row.paymentId));
    sendSuccess(res, {
      checked: successful.length,
      unmatched: (successful as any[]).filter((payment) => !receivedIds.has(payment.id || payment.publicId || payment._id?.toString())),
      generatedAt: new Date(),
    });
  };
}
