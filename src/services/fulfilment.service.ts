import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from 'crypto';
import {
  CommerceChannel,
  CommerceOrderStatus,
  CommercePaymentStatus,
  FulfilmentTaskStatus,
  HubPackageStatus,
  PaymentStatus,
  RunnerPackageStatus,
  ShipmentStatus,
} from '@lib/constants';
import mongoose from 'mongoose';
import { CommerceOutboxEvent } from '@modules/platform/outbox.model';
import { emitOutbox, processOutbox } from '@modules/platform/outbox.service';
import { wakeOutbox } from '../jobs/wake';
import { FulfilmentTask, RunnerPackage, HubPackage, Consolidation, Shipment, PartnerCustody, ReturnRequest, FulfilmentRefund, LogisticsWebhookEvent, type LogisticsProviderKey } from '@models/fulfilment/fulfilment.model';
import { Order } from '@models/orders/order.model';
import { CommerceSettings } from '@models/commerce/commerce.model';
import { LogisticsProviderService } from '@services/logistics-provider.service';
import { getPagination } from '@lib/api-utils';
import { OrderItem } from '@models/orders/order-item.model';
import { OrderFulfilmentGroup } from '@models/orders/order-fulfilment-group.model';
import { ItemResolution } from '@models/fulfilment/item-resolution.model';
import { Payment } from '@models/payments/payment.model';
import { Market, DispatchHub } from '@models/platform/network.model';
import { OperationState } from '@models/platform/geography.model';
import { HookPartner, MarketAssociateMarketAssignment, MarketAssociateProfile } from '@models/platform/operations-accounts.model';
import { User } from '@models/users/user.model';
import { PlatformAuditLog } from '@models/platform/audit-log.model';
import { nextPublicId } from '@modules/platform/public-id.service';
import { PaymentService } from '@services/payment.service';
import { PaymentLinkService } from '@services/payment-link.service';
import { createCommerceNotification } from '@services/commerce-notification.service';
import { isLogisticsSimulationEnabled, isFezLogisticsEnabled, logisticsProvider, logisticsReadiness } from '@services/logistics/logistics-provider';
import { publishRealtime } from '@modules/platform/realtime.service';
import { EmailService } from '@emails/email.service';
import { HttpError } from '@utils/http';
import { timelineEntry, notifyStatus } from '@lib/order-timeline';
import { notifyStaffByPermission } from '@services/staff-notifications.service';
import { encryptPackageCredential, tryDecryptPackageCredential } from '@lib/package-credential-crypto';

type Actor = { accountId: string; publicId?: string; stateIds?: string[]; hubIds?: string[]; accountType?: string };
type EvidenceInput = Array<{ type: string; url?: string; assetId?: string; note?: string }>;

const TASK_TRANSITIONS: Record<string, FulfilmentTaskStatus[]> = {
  accept: [FulfilmentTaskStatus.ALERTED, FulfilmentTaskStatus.UNASSIGNED],
  start_sourcing: [FulfilmentTaskStatus.ACCEPTED],
  secure: [FulfilmentTaskStatus.SOURCING],
  begin_packing: [FulfilmentTaskStatus.PRODUCT_SECURED],
  pack: [FulfilmentTaskStatus.PACKING],
  submit: [FulfilmentTaskStatus.ACCEPTED, FulfilmentTaskStatus.SOURCING, FulfilmentTaskStatus.PRODUCT_SECURED, FulfilmentTaskStatus.PACKING],
};

function identifier(identifier: string) {
  return /^[a-f\d]{24}$/i.test(identifier)
    ? { $or: [{ _id: identifier }, { publicId: identifier }] }
    : { publicId: identifier };
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function hint(value: string) {
  return value.slice(-4).padStart(4, '*');
}

function evidence(items: EvidenceInput = []) {
  return items.map((item) => ({ ...item, capturedAt: new Date() }));
}

function safeCustody(record: Record<string, any> | null | undefined) {
  if (!record) return record;
  const publicRecord = { ...record };
  delete publicRecord.collectionCodeHash;
  return publicRecord;
}

function isDuplicateKey(error: unknown) {
  return Boolean(error && typeof error === 'object' && (error as any).code === 11000);
}

function logisticsSignature(provider: string, payload: Record<string, unknown>, signature: string, timestamp?: string) {
  // Fez signs with the account's own secret-key (no separate webhook secret is issued), unlike other providers.
  const secret = provider === 'fez' ? process.env.FEZ_SECRET_KEY : process.env[`LOGISTICS_${provider.toUpperCase()}_WEBHOOK_SECRET`];
  if (!secret || !signature) return false;
  // Fez signs orderNo + orderStatus + timestamp, not the JSON body, so it needs its own scheme.
  const signedString = provider === 'fez' ? `${payload.orderNumber || ''}${payload.status || ''}${timestamp || ''}` : JSON.stringify(payload);
  const expected = createHmac('sha256', secret).update(signedString).digest('hex');
  const provided = signature.replace(/^sha256=/i, '').trim();
  if (!/^[a-f\d]{64}$/i.test(provided)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
}

async function audit(action: string, entityType: string, entityId: string | undefined, actorId: string, after?: unknown, reason?: string, stateId?: string, hubId?: string) {
  await PlatformAuditLog.create({
    publicId: await nextPublicId('audit'), actorType: 'system', actorId, action, entityType, entityId,
    after: after as Record<string, unknown> | undefined, reason, stateId, hubId, requestId: `fulfilment:${randomUUID()}`,
  });
}

async function taskByIdentifier(value: string) {
  const task = await FulfilmentTask.findOne(identifier(value)).lean({ virtuals: true });
  if (!task) throw new HttpError(404, 'Fulfilment task not found', undefined, 'NOT_FOUND');
  return task as any;
}

async function orderByIdentifier(value: string) {
  const order = await Order.findOne(identifier(value)).lean({ virtuals: true });
  if (!order) throw new HttpError(404, 'Order not found', undefined, 'NOT_FOUND');
  return order as any;
}

async function marketAssociateContext(accountId: string) {
  const marketAssociate = await MarketAssociateProfile.findOne({ accountId, status: 'active' }).lean({ virtuals: true });
  if (!marketAssociate) throw new HttpError(403, 'Active Market Associate profile required', undefined, 'ACCESS_DENIED');
  return marketAssociate as any;
}

async function assertStaffScope(actor: Actor, stateId?: string, hubId?: string) {
  if (actor.accountType !== 'staff') throw new HttpError(403, 'Operations account required', undefined, 'ACCESS_DENIED');
  if (stateId && actor.stateIds?.length && !actor.stateIds.includes(stateId)) throw new HttpError(403, 'The requested State is outside your scope', undefined, 'SCOPE_DENIED');
  if (hubId && actor.hubIds?.length && !actor.hubIds.includes(hubId)) throw new HttpError(403, 'The requested Hub is outside your scope', undefined, 'SCOPE_DENIED');
}

/** Batch-resolves market/hub/marketAssociate/order ids (stored as denormalized strings) into names, in three queries total, keyed by both _id and publicId. */
const QC_FAILURE_LABELS: Record<string, string> = { WRONG_PRODUCT: 'Wrong product', WRONG_SIZE: 'Wrong size', WRONG_COLOR: 'Wrong colour', DAMAGED: 'Damaged or defective', MISSING: 'Missing item', OTHER: 'Other' };

async function resolveFulfilmentNames(records: Array<{ marketId?: string; hubId?: string; marketAssociateId?: string; orderId?: string }>) {
  const marketIds = [...new Set(records.map((record) => record.marketId).filter(Boolean))] as string[];
  const hubIds = [...new Set(records.map((record) => record.hubId).filter(Boolean))] as string[];
  const marketAssociateIds = [...new Set(records.map((record) => record.marketAssociateId).filter(Boolean))] as string[];
  const orderIds = [...new Set(records.map((record) => record.orderId).filter(Boolean))] as string[];

  const [markets, hubs, marketAssociates, orders] = await Promise.all([
    marketIds.length ? Market.find({ $or: marketIds.map((id) => identifier(id)) }).select('publicId name imageUrl').lean() as Promise<any[]> : Promise.resolve([]),
    hubIds.length ? DispatchHub.find({ $or: hubIds.map((id) => identifier(id)) }).select('publicId name').lean() as Promise<any[]> : Promise.resolve([]),
    marketAssociateIds.length ? MarketAssociateProfile.find({ $or: marketAssociateIds.map((id) => identifier(id)) }).select('publicId accountId').lean() as Promise<any[]> : Promise.resolve([]),
    orderIds.length ? Order.find({ $or: orderIds.map((id) => identifier(id)) }).select('publicId').lean() as Promise<any[]> : Promise.resolve([]),
  ]);

  const accounts = marketAssociates.length
    ? await User.find({ _id: { $in: marketAssociates.map((profile) => profile.accountId) } }).select('firstName lastName email avatarUrl').lean() as any[]
    : [];
  const accountById = new Map(accounts.map((account) => [String(account._id), account]));

  function byBothIds<T extends { publicId?: string; _id: unknown }>(list: T[]) {
    const map = new Map<string, T>();
    for (const item of list) {
      map.set(String(item._id), item);
      if (item.publicId) map.set(item.publicId, item);
    }
    return map;
  }

  const marketById = byBothIds(markets);
  const hubById = byBothIds(hubs);
  const orderById = byBothIds(orders);
  const marketAssociateById = byBothIds(marketAssociates.map((profile) => {
    const account = accountById.get(String(profile.accountId));
    const name = account ? `${account.firstName} ${account.lastName}`.trim() : undefined;
    return { ...profile, name, avatarUrl: account?.avatarUrl, email: account?.email };
  }));

  return {
    market: (id?: string) => (id ? marketById.get(id) || null : null),
    hub: (id?: string) => (id ? hubById.get(id) || null : null),
    marketAssociate: (id?: string) => (id ? marketAssociateById.get(id) || null : null),
    order: (id?: string) => (id ? orderById.get(id) || null : null),
  };
}

/** "Capacity: 10,000 mAh" style lines for every ordered detail other than colour and size. */
function otherDetails(item: { selectedVariants?: Record<string, string>; variantSnapshot?: Record<string, string> }): string[] {
  const source = { ...(item.selectedVariants || {}), ...(item.variantSnapshot || {}) };
  return Object.entries(source)
    .filter(([key, value]) => key !== 'color' && key !== 'size' && value)
    .map(([key, value]) => `${key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}: ${value}`);
}

/** A failed/refused Pay on Delivery parcel counts against the customer; after the admin-set limit they lose the option until an admin restores it. */
async function recordPodRefusal(orderId: string, session?: import('mongoose').ClientSession) {
  const order = (await Order.findById(orderId).select('userId commercePaymentMethod').session(session ?? null).lean()) as { userId?: string; commercePaymentMethod?: string } | null;
  if (!order?.userId || order.commercePaymentMethod !== 'PAY_AT_HANDOVER') return;
  const settings = (await CommerceSettings.findOne({ key: 'commerce' }).select('podRefusalSuspendCount').lean()) as { podRefusalSuspendCount?: number } | null;
  const limit = Math.max(1, Number(settings?.podRefusalSuspendCount ?? 2));
  const user = (await User.findOneAndUpdate({ _id: order.userId }, { $inc: { podRefusals: 1 } }, { returnDocument: 'after', session, strict: false }).lean()) as { podRefusals?: number } | null;
  if (user && Number(user.podRefusals || 0) >= limit) await User.updateOne({ _id: order.userId }, { $set: { podEligible: false } }, { session });
}

/** Orders store the partner's internal id, older ones the public id: match both. */
const partnerIds = (partner: any) => [String(partner.publicId), String(partner.id || partner._id)].filter(Boolean);
function partnerIdentity(value: string) {
  return /^[a-f\d]{24}$/i.test(value) ? { $or: [{ _id: value }, { publicId: value }] } : { publicId: value };
}

export class FulfilmentService {
  private readonly payments = new PaymentService();
  private readonly logisticsProviders = new LogisticsProviderService();
  private readonly email = new EmailService();

  private async publishOrderUpdate(orderId: string, stateId?: string, hubId?: string) {
    const [order, assignedTasks] = await Promise.all([
      Order.findById(orderId)
        .select('publicId version userId sourceStateId')
        .lean() as Promise<any>,
      FulfilmentTask.find({ orderId, marketAssociateId: { $exists: true, $ne: null } })
        .select('marketAssociateId')
        .lean() as Promise<any[]>,
    ]);
    if (!order) return;
    const profileIds = [...new Set(assignedTasks.map((task) => String(task.marketAssociateId)).filter(Boolean))];
    const assignedProfiles = profileIds.length
      ? await MarketAssociateProfile.find({ _id: { $in: profileIds }, status: 'active' })
        .select('accountId')
        .lean() as any[]
      : [];
    const scopeStateId = stateId || order.sourceStateId;
    const targets = {
      ...(order.userId ? { accountId: String(order.userId) } : {}),
      admin: true,
      ...(scopeStateId ? { stateId: String(scopeStateId) } : {}),
      ...(hubId ? { hubId: String(hubId) } : {}),
    };
    const event = {
      entityId: order.publicId || String(order._id),
      version: Number(order.version || 1),
      ...(scopeStateId || hubId ? { scope: { ...(scopeStateId ? { stateId: String(scopeStateId) } : {}), ...(hubId ? { hubId: String(hubId) } : {}) } } : {}),
    };
    publishRealtime({ type: 'order.updated', ...event }, targets);
    publishRealtime({ type: 'admin.operations.updated', ...event }, targets);
    for (const profile of assignedProfiles) {
      if (!profile.accountId || String(profile.accountId) === String(order.userId || '')) continue;
      publishRealtime({ type: 'order.updated', ...event }, { accountId: String(profile.accountId) });
    }
  }

  /** Runs DB-only work in one transaction; the callback may be re-run on conflict, so email/events/provider calls must happen after this returns. */
  private async atomically<T>(work: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
    const session = await mongoose.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => { result = await work(session); });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async consumeApprovedOrder(event: any) {
    const order = await orderByIdentifier(event.aggregateId);
    if (order.commerceStatus !== CommerceOrderStatus.APPROVED_FOR_FULFILMENT && order.commerceStatus !== 'IN_FULFILMENT') return { skipped: true, reason: 'order_not_approved' };
    const items = await OrderItem.find({ orderId: order._id.toString(), resolutionState: { $ne: 'RESOLVED' } }).lean({ virtuals: true }) as any[];
    if (!items.length) return { skipped: true, reason: 'no_active_items' };

    const groups = new Map<string, any[]>();
    for (const item of items) {
      const key = `${item.marketId || 'unassigned'}:${item.stateId || order.sourceStateId || 'unassigned'}`;
      groups.set(key, [...(groups.get(key) || []), item]);
    }

    let blocked = false;
    for (const group of groups.values()) {
      const marketId = group[0].marketId;
      const stateId = group[0].stateId || order.sourceStateId;
      const assignment = marketId ? await MarketAssociateMarketAssignment.findOne({ marketId, stateId, status: 'active', isPrimary: true, activeFrom: { $lte: new Date() }, $or: [{ activeTo: { $exists: false } }, { activeTo: null }, { activeTo: { $gt: new Date() } }] }).sort({ priority: 1 }).lean({ virtuals: true }) : null;
      const market = marketId ? await Market.findOne(identifier(marketId)).lean({ virtuals: true }) : null;
      const hubId = (assignment as any)?.preferredHubId || (market as any)?.hubId;
      const hub = hubId ? await DispatchHub.findOne(identifier(hubId)).lean({ virtuals: true }) : null;
      const groupBlocked = !assignment || !hub || (hub as any).status !== 'active';
      if (groupBlocked) blocked = true;

      const idempotencyKey = `order:${order._id.toString()}:market:${marketId || 'unassigned'}`;
      const task = await FulfilmentTask.findOneAndUpdate(
        { idempotencyKey },
        {
          $setOnInsert: {
            publicId: await nextPublicId('fulfilment'), orderId: order._id.toString(), sourceStateId: stateId,
            marketId: marketId || 'UNASSIGNED', hubId: hub ? (hub as any).publicId || hub._id.toString() : undefined,
            marketAssociateId: assignment?.marketAssociateId,
            status: groupBlocked ? FulfilmentTaskStatus.BLOCKED : FulfilmentTaskStatus.ALERTED, version: 1, idempotencyKey,
            alertedAt: groupBlocked ? undefined : new Date(), evidence: [], assignmentHistory: [],
          },
          $set: { orderItemIds: group.map((item) => item._id.toString()) },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      ).lean({ virtuals: true });
      await OrderItem.updateMany({ _id: { $in: group.map((item) => item._id) } }, { $set: { fulfilmentTaskId: (task as any)._id.toString(), fulfilmentStatus: 'PENDING' } });
      if (!groupBlocked && assignment?.marketAssociateId && (task as any).status === FulfilmentTaskStatus.ALERTED) {
        const marketAssociateProfile = await MarketAssociateProfile.findById(assignment.marketAssociateId).select('accountId').lean();
        if (marketAssociateProfile?.accountId)
          await createCommerceNotification({
            eventKey: `fulfilment:${(task as any).publicId}:alerted`,
            userId: marketAssociateProfile.accountId,
            title: "New order to fulfil",
            body: `A new order needs pickup from ${market?.name || "your assigned Market"}. Accept within 15 minutes.`,
            type: "order_assigned",
            data: { taskId: (task as any).publicId, orderId: order.publicId, marketId },
          }).catch(() => undefined);
      }
    }
    // Only the delivery that actually moves the order forward writes the
    // timeline entry, emails the customer and audits. Outbox delivery is
    // at-least-once, so a replay must not repeat any of those.
    const advanced = await Order.updateOne(
      { _id: order._id, commerceStatus: CommerceOrderStatus.APPROVED_FOR_FULFILMENT },
      { $set: { commerceStatus: CommerceOrderStatus.IN_FULFILMENT, status: 'confirmed', fulfilmentSummary: { taskCount: groups.size, blocked }, customerProgress: [{ key: 'fulfilment', label: blocked ? 'Operations review required' : 'Hook is sourcing your items', at: new Date() }] }, $push: { timeline: timelineEntry('IN_FULFILMENT', 'SYSTEM', { blocked }) } },
    );
    // Advance the groups alongside the order. Until now a group's status was
    // only ever written once a shipment existed, so it sat at PENDING through
    // the whole sourcing phase and every delivery reported "Order received"
    // while the order itself said it was being sourced.
    await OrderFulfilmentGroup.updateMany(
      { orderId: order._id.toString(), status: 'PENDING' },
      { $set: { status: 'IN_FULFILMENT' } },
    );
    if (advanced.modifiedCount) {
      await notifyStatus(order._id, 'IN_FULFILMENT');
      await audit('fulfilment.tasks.created', 'order', order._id.toString(), 'SYSTEM', { taskCount: groups.size, blocked }, undefined, order.sourceStateId);
    }
    await this.publishOrderUpdate(order._id.toString(), order.sourceStateId);
    return { taskCount: groups.size, blocked };
  }

  /**
   * Drains due outbox events of every type (fulfilment, payment effects,
   * order-created and refund effects). Claiming, jittered backoff and
   * dead-lettering live in outbox.service; the handlers are wired in
   * outbox-handlers so this file does not import every consumer.
   */
  async processOutboxBatch(limit = 5) {
    const { buildOutboxHandlers } = await import('@modules/platform/outbox-handlers');
    return processOutbox(buildOutboxHandlers(), limit);
  }

  async marketAssociateTasks(accountId: string, query: Record<string, unknown>) {
    const marketAssociate = await marketAssociateContext(accountId);
    const filter: Record<string, unknown> = { marketAssociateId: (marketAssociate as any)._id.toString() };
    if (query.status) filter.status = query.status;
    if (String(query.active || "").toLowerCase() === "true") {
      filter.status = {
        $in: [
          FulfilmentTaskStatus.UNASSIGNED,
          FulfilmentTaskStatus.ALERTED,
          FulfilmentTaskStatus.ACCEPTED,
          FulfilmentTaskStatus.SOURCING,
          FulfilmentTaskStatus.PRODUCT_SECURED,
          FulfilmentTaskStatus.PACKING,
          FulfilmentTaskStatus.BLOCKED,
        ],
      };
    }
    const tasks = await FulfilmentTask.find(filter)
      .sort({ createdAt: 1 })
      .limit(Math.min(Number(query.limit || 50), 100))
      .lean({ virtuals: true }) as any[];
    const itemIds = [...new Set(tasks.flatMap((task) => task.orderItemIds || []).map(String))];
    const items = itemIds.length
      ? await OrderItem.find({ _id: { $in: itemIds } })
        .select('productTitle productImage productSnapshot quantity')
        .lean({ virtuals: true }) as any[]
      : [];
    const itemById = new Map(items.map((item) => [String(item._id), item]));
    const issueCounts = await ItemResolution.aggregate([
      { $match: { taskId: { $in: tasks.map((task: any) => String(task._id)) }, status: { $nin: ['RESOLVED', 'CANCELLED'] } } },
      { $group: { _id: '$taskId', count: { $sum: 1 } } },
    ]);
    const issuesByTask = new Map(issueCounts.map((entry: any) => [String(entry._id), Number(entry.count)]));
    const orderRows = await Order.find({ _id: { $in: [...new Set(tasks.map((task: any) => String(task.orderId)).filter(Boolean))] } }).select('publicId').lean() as any[];
    const orderRef = new Map(orderRows.map((order) => [String(order._id), order.publicId]));
    const data = tasks.map((task) => {
      const taskItems = (task.orderItemIds || [])
        .map((itemId: string) => itemById.get(String(itemId)))
        .filter(Boolean);
      const preview = taskItems[0];
      const snapshot = preview?.productSnapshot as { title?: string; images?: string[] } | undefined;
      return {
        ...task,
        orderPublicId: orderRef.get(String(task.orderId)),
        previewImage: preview?.productImage || snapshot?.images?.[0],
        previewTitle: preview?.productTitle || snapshot?.title,
        previewQuantity: preview?.quantity,
        itemCount: taskItems.length,
        verifiedCount: (task.itemVerifications || []).filter((entry: any) => entry.matched).length,
        exceptionCount: issuesByTask.get(String(task._id)) || 0,
      };
    });
    return { data, total: data.length };
  }

  async adminTaskDetail(actor: Actor, taskIdentifier: string) {
    const task = await taskByIdentifier(taskIdentifier);
    await assertStaffScope(actor, task.sourceStateId, task.hubId);
    const [order, items, names, issues] = await Promise.all([
      Order.findById(task.orderId)
        .select('publicId commerceStatus status sourceStateId customerProgress')
        .lean({ virtuals: true }),
      OrderItem.find({ _id: { $in: task.orderItemIds } })
        .select('publicId productTitle productImage productSnapshot quantity variantSnapshot fulfilmentStatus')
        .lean({ virtuals: true }),
      resolveFulfilmentNames([task]),
      ItemResolution.find({ taskId: String(task._id) }).sort({ createdAt: -1 }).lean({ virtuals: true }),
    ]);
    return {
      task: {
        ...task,
        market: names.market(task.marketId),
        hub: names.hub(task.hubId),
        marketAssociate: names.marketAssociate(task.marketAssociateId),
      },
      order,
      items,
      issues,
    };
  }

  async proposeItemResolution(actor: Actor, issueIdentifier: string, body: Record<string, any>) {
    const issue = await ItemResolution.findOne(identifier(issueIdentifier));
    if (!issue) throw new HttpError(404, 'Item issue not found', undefined, 'NOT_FOUND');
    const task = await taskByIdentifier(issue.taskId);
    await assertStaffScope(actor, task.sourceStateId, task.hubId);
    if (!['OPEN', 'ADMIN_REVIEW', 'DECLINED'].includes(issue.status)) throw new HttpError(409, 'This item issue cannot receive a proposal in its current state', undefined, 'INVALID_STATE_TRANSITION');
    if (Number(body.version) !== issue.version) throw new HttpError(409, 'This item issue changed. Refresh and try again.', undefined, 'STALE_VERSION');
    const item = await OrderItem.findById(issue.orderItemId).lean() as any;
    if (!item) throw new HttpError(404, 'Order item not found', undefined, 'NOT_FOUND');
    const quantity = Number(body.quantity || item.quantity);
    const unitPriceMinor = Number(body.unitPriceMinor);
    const originalTotal = Number(item.totalPriceMinor ?? Math.round(Number(item.totalPrice || 0) * 100));
    const proposedTotal = unitPriceMinor * quantity;
    issue.proposal = {
      productId: body.productId || item.productId,
      productTitle: body.productTitle || item.productTitle,
      productImage: body.productImage || item.productImage,
      selectedVariants: { color: body.color, size: body.size }, quantity, unitPriceMinor, totalPriceMinor: proposedTotal,
      reason: body.reason, proposedBy: actor.accountId, proposedAt: new Date(),
    };
    issue.adjustmentMinor = proposedTotal - originalTotal;
    issue.adjustmentStatus = issue.adjustmentMinor === 0 ? 'NOT_REQUIRED' : 'PENDING';
    issue.status = 'CUSTOMER_APPROVAL_PENDING';
    issue.version += 1;
    issue.history.push({ action: 'PROPOSED', actorId: actor.accountId, at: new Date(), adjustmentMinor: issue.adjustmentMinor });
    await issue.save();
    if (issue.customerId) await createCommerceNotification({
      eventKey: `item-resolution:${issue.publicId}:proposal:${issue.version}`,
      userId: issue.customerId,
      title: 'Approve a replacement item',
      body: `${String((issue.proposal as any).productTitle)} is available as a replacement. Review the size, colour and price difference.`,
      type: 'order_updated',
      data: { orderId: issue.orderId, itemResolutionId: issue.publicId },
    });
    await audit('fulfilment.item.substitution_proposed', 'item_resolution', issue.id, actor.accountId, { adjustmentMinor: issue.adjustmentMinor }, String(body.reason || ''), task.sourceStateId, task.hubId);
    await this.publishOrderUpdate(task.orderId, task.sourceStateId, task.hubId);
    return issue.toObject();
  }

  async customerItemResolution(customerId: string, orderIdentifier: string, issueIdentifier: string, body: Record<string, any>) {
    const order = await Order.findOne({ ...identifier(orderIdentifier), userId: customerId }).lean() as any;
    if (!order) throw new HttpError(404, 'Order not found', undefined, 'NOT_FOUND');
    const issue = await ItemResolution.findOne({ ...identifier(issueIdentifier), orderId: String(order._id), customerId });
    if (!issue) throw new HttpError(404, 'Replacement request not found', undefined, 'NOT_FOUND');
    if (issue.status !== 'CUSTOMER_APPROVAL_PENDING') {
      if (issue.customerDecision === (body.decision === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED')) {
        if (issue.status === 'PAYMENT_PENDING') {
          // Idempotent either way: an already-active link is reused as-is (see createForSubstitution),
          // and a payment that already confirmed via webhook has moved this issue past PAYMENT_PENDING already.
          await this.initializeSubstitutionTopUp(issue, order, customerId);
          const refreshed = await ItemResolution.findById(issue._id);
          return refreshed?.toObject() || issue.toObject();
        }
        if (issue.status === 'REFUND_PENDING') {
          await this.processSubstitutionRefund(issue, order, customerId);
          const refreshed = await ItemResolution.findById(issue._id);
          return refreshed?.toObject() || issue.toObject();
        }
        return issue.toObject();
      }
      throw new HttpError(409, 'This replacement request has already been decided', undefined, 'INVALID_STATE_TRANSITION');
    }
    if (Number(body.version) !== issue.version) throw new HttpError(409, 'This replacement request changed. Refresh and try again.', undefined, 'STALE_VERSION');
    if (body.decision === 'DECLINE') {
      issue.status = 'DECLINED'; issue.customerDecision = 'DECLINED'; issue.customerDecidedAt = new Date(); issue.version += 1;
      issue.history.push({ action: 'CUSTOMER_DECLINED', actorId: customerId, at: new Date() });
      await issue.save();
      const task = await taskByIdentifier(issue.taskId).catch(() => undefined);
      const productTitle = String((issue.originalSnapshot as any)?.title || 'The item');
      await notifyStaffByPermission({
        permission: 'fulfilment.manage', stateId: task?.sourceStateId, hubId: task?.hubId,
        eventKeyPrefix: `item-resolution:${issue.publicId}:declined`,
        title: 'Replacement declined by customer', body: `${productTitle} needs a new resolution — the customer declined the proposed replacement.`,
        type: 'item_resolution_declined', data: { taskId: task?.publicId, itemResolutionId: issue.publicId, href: task?.publicId ? `/dashboard/fulfilment/tasks/${task.publicId}` : undefined },
      });
      if (issue.reportedBy) void createCommerceNotification({
        eventKey: `item-resolution:${issue.publicId}:declined:${issue.reportedBy}`,
        userId: String(issue.reportedBy),
        title: 'Replacement declined by customer',
        body: `${productTitle} needs a new resolution — the customer declined the proposed replacement.`,
        type: 'item_resolution_declined',
        data: { taskId: task?.publicId, itemResolutionId: issue.publicId },
      });
      await this.publishOrderUpdate(issue.orderId, task?.sourceStateId, task?.hubId);
      return issue.toObject();
    }
    issue.customerDecision = 'ACCEPTED'; issue.customerDecidedAt = new Date(); issue.version += 1;
    issue.history.push({ action: 'CUSTOMER_ACCEPTED', actorId: customerId, at: new Date() });
    if (issue.adjustmentMinor > 0) {
      issue.status = 'PAYMENT_PENDING';
      await issue.save();
      await this.initializeSubstitutionTopUp(issue, order, customerId);
    } else if (issue.adjustmentMinor < 0) {
      issue.status = 'REFUND_PENDING';
      await issue.save();
      await this.processSubstitutionRefund(issue, order, customerId);
    } else await this.applyResolvedSubstitution(issue, customerId);
    await this.publishOrderUpdate(issue.orderId);
    return (await ItemResolution.findById(issue._id).lean({ virtuals: true })) || issue.toObject();
  }

  /**
   * A replacement top-up is "just another payment" now: it opens the exact
   * same hosted /payment/{token} page a normal order or delivery payment
   * does (provider choice, share/revoke, the lot) instead of a bespoke
   * substitution-only checkout — see PaymentLinkService.createForSubstitution.
   */
  private async initializeSubstitutionTopUp(issue: any, order: any, customerId: string) {
    const link = await new PaymentLinkService().createForSubstitution(
      customerId,
      { publicId: issue.publicId, adjustmentMinor: Number(issue.adjustmentMinor) },
      order,
    );
    const updated = await ItemResolution.findOneAndUpdate(
      { _id: issue._id, status: 'PAYMENT_PENDING' },
      { $set: { adjustmentAuthorizationUrl: link.url } },
      { returnDocument: 'after' },
    );
    if (!updated) throw new HttpError(409, 'A top-up payment is already active', undefined, 'INVALID_STATE_TRANSITION');
    Object.assign(issue, updated.toObject());
    return issue;
  }

  private async processSubstitutionRefund(issue: any, order: any, customerId: string) {
    const amountMinor = Math.abs(Number(issue.adjustmentMinor));
    const unknownEntry = [...issue.history].reverse().find((entry: any) => entry.action === 'REFUND_OUTCOME_UNKNOWN');
    const payment = unknownEntry?.paymentId ? await Payment.findById(String(unknownEntry.paymentId)) : await Payment.findOne({
      orderId: String(order._id),
      // Never fund one item's refund out of a different item's top-up payment.
      itemResolutionId: { $exists: false },
      gateway: { $in: ['paystack', 'monnify'] },
      status: { $in: [PaymentStatus.SUCCESSFUL, PaymentStatus.PARTIALLY_REFUNDED] },
      $expr: { $gte: [{ $subtract: [{ $ifNull: ['$amountMinor', 0] }, { $ifNull: ['$refundedAmount', 0] }] }, amountMinor] },
    }).sort({ paidAt: 1 });
    if (!payment) throw new HttpError(409, 'No captured payment can fund this refund', undefined, 'PAYMENT_RECORD_MISSING');
    const idempotencyKey = `substitution-refund:${issue.publicId}`;
    let result: { providerReference?: string } | undefined;
    const outcomeUnknown = Boolean(unknownEntry);
    if (outcomeUnknown) {
      result = await new PaymentService().reconcileRefund(String(payment.id), amountMinor, idempotencyKey);
      if (!result) throw new HttpError(503, 'The refund is still being verified with Paystack. No duplicate refund will be sent.', { unknown: true }, 'PROVIDER_OUTCOME_UNKNOWN');
    }
    try {
      if (!result) result = await new PaymentService().refund(String(payment.id), amountMinor, idempotencyKey);
    } catch (error: any) {
      if (error?.code === 'PROVIDER_OUTCOME_UNKNOWN') {
        result = await new PaymentService().reconcileRefund(String(payment.id), amountMinor, idempotencyKey);
        if (!result) {
          issue.history.push({ action: 'REFUND_OUTCOME_UNKNOWN', actorId: customerId, paymentId: String(payment.id), at: new Date() });
          await issue.save();
        }
      }
      if (!result) throw error;
    }
    issue.adjustmentStatus = 'CONFIRMED';
    issue.adjustmentProviderReference = result.providerReference;
    issue.adjustmentProcessedAt = new Date();
    issue.history.push({ action: 'REFUND_CONFIRMED', actorId: customerId, providerReference: result.providerReference, at: new Date() });
    await this.applyResolvedSubstitution(issue, customerId);
  }

  /**
   * Called by PaymentService.confirmPayment once a top-up Payment (scoped by
   * itemResolutionId) is verified and marked CONFIRMED — the evidence check
   * already happened there, via the same path every order/delivery payment
   * goes through, so this only applies the resulting side effect.
   */
  async confirmSubstitutionAdjustment(itemResolutionId: string, providerReference?: string, paidAt?: Date) {
    const issue = await ItemResolution.findOne({ publicId: itemResolutionId });
    if (!issue) return { matched: false };
    if (issue.status === 'RESOLVED' && issue.adjustmentStatus === 'CONFIRMED') return { matched: true, duplicate: true };
    if (issue.status !== 'PAYMENT_PENDING') throw new HttpError(409, 'This top-up is no longer payable', undefined, 'INVALID_STATE_TRANSITION');
    issue.adjustmentStatus = 'CONFIRMED';
    issue.adjustmentProviderReference = providerReference;
    issue.adjustmentProcessedAt = paidAt || new Date();
    issue.history.push({ action: 'TOP_UP_CONFIRMED', actorId: 'PAYMENT_WEBHOOK', providerReference, at: new Date() });
    await this.applyResolvedSubstitution(issue, 'PAYMENT_WEBHOOK');
    await this.publishOrderUpdate(issue.orderId);
    return { matched: true, processed: true };
  }

  private async applyResolvedSubstitution(issue: any, actorId: string) {
    const proposal = issue.proposal as any;
    await this.atomically(async (session) => {
      const item = await OrderItem.findOneAndUpdate(
        { _id: issue.orderItemId, resolutionState: 'REPLACEMENT_PENDING' },
        // variantSnapshot is what QC and item-verification compare "Found" against as
        // "Ordered" — leaving it pointing at the pre-replacement spec would flag every
        // correctly-sourced replacement as a colour/size mismatch, so it moves with
        // selectedVariants here rather than staying frozen at the original order.
        { $set: { productId: proposal.productId, productTitle: proposal.productTitle, productImage: proposal.productImage, selectedVariants: proposal.selectedVariants, variantSnapshot: proposal.selectedVariants, quantity: proposal.quantity, unitPriceMinor: proposal.unitPriceMinor, totalPriceMinor: proposal.totalPriceMinor, unitPrice: proposal.unitPriceMinor / 100, totalPrice: proposal.totalPriceMinor / 100, replacementSnapshot: { ...proposal, original: issue.originalSnapshot, approvedByCustomerAt: issue.customerDecidedAt }, resolutionState: 'RESOLVED', fulfilmentStatus: 'SOURCING' } },
        { returnDocument: 'after', session },
      ).lean() as any;
      if (!item) {
        const latest = await ItemResolution.findById(issue._id).session(session).lean() as any;
        if (latest?.status === 'RESOLVED' && latest?.adjustmentStatus === 'CONFIRMED') return;
        throw new HttpError(409, 'Order item is no longer awaiting replacement', undefined, 'INVALID_STATE_TRANSITION');
      }
      const order = await Order.findById(issue.orderId).session(session).lean() as any;
      if (!order) throw new HttpError(404, 'Order not found', undefined, 'NOT_FOUND');
      const subtotalMinor = Math.max(0, Number(order.subtotalMinor || 0) + Number(issue.adjustmentMinor || 0));
      const vatMinor = Math.round(subtotalMinor * Number(order.vatRate || 0));
      const totalMinor = Math.max(0, subtotalMinor + vatMinor + Number(order.deliveryFeeMinor || 0) - Number(order.couponDiscountMinor || 0) - Number(order.creditsAppliedMinor || 0));
      await Order.updateOne({ _id: issue.orderId }, { $set: { subtotalMinor, vatMinor, totalMinor, subtotal: subtotalMinor / 100, total: totalMinor / 100 }, $inc: { version: 1 } }, { session });
      await FulfilmentTask.updateOne({ _id: issue.taskId }, { $inc: { version: 1 } }, { session });
      issue.status = 'RESOLVED'; issue.adjustmentStatus = issue.adjustmentStatus || 'NOT_REQUIRED'; issue.version += 1;
      issue.history.push({ action: 'SUBSTITUTION_APPLIED', actorId, at: new Date() });
      await issue.save({ session });
    });
    // The reporting Market Associate is the one who now needs to go source this
    // replacement — every accept path (immediate, after top-up, after refund)
    // converges here, so notifying from this one spot covers all three.
    if (issue.reportedBy) void createCommerceNotification({
      eventKey: `item-resolution:${issue.publicId}:approved:${issue.reportedBy}`,
      userId: String(issue.reportedBy),
      title: 'Replacement approved by customer',
      body: `${String(proposal?.productTitle || 'The replacement item')} was approved — go ahead and source it.`,
      type: 'item_resolution_approved',
      data: { taskId: issue.taskId, itemResolutionId: issue.publicId },
    });
  }

  async assignmentMarketAssociates(actor: Actor, query: Record<string, unknown>) {
    await assertStaffScope(actor, query.stateId as string | undefined);
    const stateId = query.stateId ? String(query.stateId) : undefined;
    const filter: Record<string, unknown> = { status: 'active' };
    if (stateId) filter.stateIds = stateId;
    else if (actor.stateIds?.length) filter.stateIds = { $in: actor.stateIds };
    const profiles = await MarketAssociateProfile.find(filter)
      .select('publicId accountId stateIds hubIds availability status')
      .sort({ createdAt: 1 })
      .limit(200)
      .lean({ virtuals: true }) as any[];
    const accounts = await User.find({ _id: { $in: profiles.map((profile) => profile.accountId) } })
      .select('firstName lastName email phone')
      .lean() as any[];
    const accountById = new Map(accounts.map((account) => [String(account._id), account]));
    return { data: profiles.map((profile) => ({
      publicId: profile.publicId,
      id: profile.publicId,
      availability: profile.availability,
      stateIds: profile.stateIds,
      hubIds: profile.hubIds,
      ...(accountById.get(String(profile.accountId)) || {}),
    })) };
  }

  async assignmentHubs(actor: Actor, query: Record<string, unknown>) {
    await assertStaffScope(actor, query.stateId as string | undefined);
    const filter: Record<string, unknown> = { status: 'active' };
    if (query.stateId) filter.stateId = String(query.stateId);
    else if (actor.stateIds?.length) filter.stateId = { $in: actor.stateIds };
    if (actor.hubIds?.length) filter.publicId = { $in: actor.hubIds };
    const data = await DispatchHub.find(filter)
      .select('publicId name stateId cityId status')
      .sort({ name: 1 })
      .limit(200)
      .lean({ virtuals: true });
    return { data };
  }

  async reassignTask(actor: Actor, taskIdentifier: string, body: Record<string, any>) {
    const task = await taskByIdentifier(taskIdentifier);
    await assertStaffScope(actor, task.sourceStateId, task.hubId);
    if (!body.reason || String(body.reason).trim().length < 3) {
      throw new HttpError(400, 'A reassignment reason is required', undefined, 'VALIDATION_ERROR');
    }
    if ([FulfilmentTaskStatus.COMPLETED, FulfilmentTaskStatus.CANCELLED, FulfilmentTaskStatus.HUB_RECEIVED, FulfilmentTaskStatus.QC_PASSED].includes(task.status)) {
      throw new HttpError(409, 'This fulfilment task can no longer be reassigned', undefined, 'INVALID_STATE_TRANSITION');
    }

    const marketAssociateQuery = /^[a-f\d]{24}$/i.test(String(body.marketAssociateId))
      ? { $or: [{ _id: body.marketAssociateId }, { publicId: body.marketAssociateId }] }
      : { publicId: String(body.marketAssociateId) };
    const marketAssociate = await MarketAssociateProfile.findOne({ ...marketAssociateQuery, status: 'active', stateIds: task.sourceStateId }).lean({ virtuals: true }) as any;
    if (!marketAssociate) throw new HttpError(409, 'The selected Market Associate is not active in this State', undefined, 'SCOPE_DENIED');

    const assignment = await MarketAssociateMarketAssignment.findOne({
      marketAssociateId: marketAssociate._id.toString(),
      marketId: task.marketId,
      stateId: task.sourceStateId,
      status: 'active',
      isPrimary: true,
      activeFrom: { $lte: new Date() },
      $or: [{ activeTo: { $exists: false } }, { activeTo: null }, { activeTo: { $gt: new Date() } }],
    }).lean({ virtuals: true });
    if (!assignment) throw new HttpError(409, 'The selected Market Associate is not assigned to this Market', undefined, 'RUNNER_MARKET_ASSIGNMENT_REQUIRED');

    const hubQuery = /^[a-f\d]{24}$/i.test(String(body.hubId))
      ? { $or: [{ _id: body.hubId }, { publicId: body.hubId }] }
      : { publicId: String(body.hubId) };
    const hub = await DispatchHub.findOne({ ...hubQuery, stateId: task.sourceStateId, status: 'active' }).lean({ virtuals: true }) as any;
    if (!hub) throw new HttpError(409, 'The selected Hub is not active in this State', undefined, 'SCOPE_DENIED');
    await assertStaffScope(actor, task.sourceStateId, hub.publicId || hub._id.toString());

    const now = new Date();
    const updated = await FulfilmentTask.findOneAndUpdate(
      { _id: task._id, version: body.version ?? task.version },
      {
        $set: {
          marketAssociateId: marketAssociate._id.toString(),
          hubId: hub.publicId || hub._id.toString(),
          status: FulfilmentTaskStatus.ALERTED,
          alertedAt: now,
          version: task.version + 1,
        },
        $push: {
          assignmentHistory: {
            action: 'REASSIGNED',
            fromMarketAssociateId: task.marketAssociateId,
            toMarketAssociateId: marketAssociate.publicId || marketAssociate._id.toString(),
            fromHubId: task.hubId,
            toHubId: hub.publicId || hub._id.toString(),
            reason: String(body.reason).trim(),
            actorId: actor.accountId,
            at: now,
          },
        },
      },
      { returnDocument: 'after' },
    ).lean({ virtuals: true });
    if (!updated) throw new HttpError(409, 'This task changed. Refresh and try again.', undefined, 'STALE_VERSION');
    await audit('fulfilment.task.reassigned', 'fulfilment_task', task.publicId || task._id.toString(), actor.accountId, { marketAssociateId: marketAssociate.publicId || marketAssociate._id.toString(), hubId: hub.publicId || hub._id.toString() }, String(body.reason).trim(), task.sourceStateId, hub._id.toString());
    await this.publishOrderUpdate(task.orderId, task.sourceStateId, hub.publicId || hub._id.toString());
    if (task.marketAssociateId && task.marketAssociateId !== marketAssociate._id.toString()) {
      const outgoing = await MarketAssociateProfile.findById(task.marketAssociateId).select('accountId').lean();
      if (outgoing?.accountId) void createCommerceNotification({
        eventKey: `fulfilment:${task.publicId}:reassigned-from:${updated.version}`,
        userId: outgoing.accountId,
        title: 'Task reassigned',
        body: `${task.publicId} was moved to another Market Associate: ${String(body.reason).trim()}`,
        type: 'order_updated',
        data: { taskId: task.publicId },
      });
    }
    if (marketAssociate.accountId) void createCommerceNotification({
      eventKey: `fulfilment:${task.publicId}:reassigned-to:${updated.version}`,
      userId: marketAssociate.accountId,
      title: 'New order to fulfil',
      body: `${task.publicId} was reassigned to you. Accept it to begin.`,
      type: 'order_assigned',
      data: { taskId: task.publicId, orderId: task.orderId },
    });
    return updated;
  }


  /**
   * Flags Partner custody that has sat past its expiry.
   *
   * This used to also run an SLA breach loop over fulfilment tasks. That loop
   * only ever inserted a FulfilmentException row — no notification, no
   * reassignment, no escalation, and resolving the exception did nothing to the
   * task — while the deadlines it measured were hardcoded at creation
   * (15min/4h/6h/24h) and never recomputed, so a reassigned task was born
   * already breaching. It was removed rather than rebuilt; task urgency is now
   * shown as plain age in the UI.
   */
  async processOperationalDeadlines() {
    const now = new Date();

    const overdueCustody = await PartnerCustody.find({ status: { $in: ['AWAITING_RECEIPT', 'IN_CUSTODY'] }, expiresAt: { $lte: now } }).limit(100).lean({ virtuals: true }) as any[];
    let custodyOverdue = 0;
    for (const custody of overdueCustody) {
      const updated = await PartnerCustody.findOneAndUpdate(
        { _id: custody._id, status: { $in: ['AWAITING_RECEIPT', 'IN_CUSTODY'] } },
        { $set: { status: 'OVERDUE' }, $push: { history: { action: 'CUSTODY_OVERDUE', actorId: 'SYSTEM', at: now } } },
        { returnDocument: 'after' },
      ).lean({ virtuals: true });
      if (!updated) continue;
      // The OVERDUE status flip above is the real state change; it used to be
      // paired with an exception row that nothing acted on.
      custodyOverdue += 1;
      const [order, partner] = await Promise.all([
        Order.findById(custody.orderId).select('publicId sourceStateId').lean() as Promise<any>,
        HookPartner.findOne(partnerIdentity(String(custody.partnerId))).select('accountId stateId').lean() as Promise<any>,
      ]);
      await notifyStaffByPermission({
        permission: 'fulfilment.manage', stateId: order?.sourceStateId || partner?.stateId,
        eventKeyPrefix: `partner-custody:${custody.publicId}:overdue`,
        title: 'Partner custody overdue', body: `${order?.publicId || custody.publicId} has sat with the Partner past its handover window.`,
        type: 'order_updated', data: { orderId: order?.publicId, custodyId: custody.publicId, href: order?.publicId ? `/dashboard/orders/${order.publicId}` : undefined },
      });
      if (partner?.accountId) void createCommerceNotification({
        eventKey: `partner-custody:${custody.publicId}:overdue:partner`,
        userId: partner.accountId,
        title: 'A parcel with you is overdue',
        body: `${order?.publicId || custody.publicId} needs to be handed to the customer or returned to Hook — its handover window has passed.`,
        type: 'order_updated',
        data: { orderId: order?.publicId },
      });
    }
    return { custodyOverdue };
  }

  async marketAssociateTask(accountId: string, taskIdentifier: string) {
    const marketAssociate = await marketAssociateContext(accountId);
    const task = await taskByIdentifier(taskIdentifier);
    if (task.marketAssociateId !== (marketAssociate as any)._id.toString()) throw new HttpError(404, 'Fulfilment task not found', undefined, 'NOT_FOUND');
    const [items, market, hub, pack, orderDoc] = await Promise.all([
      OrderItem.find({ _id: { $in: task.orderItemIds } }).lean({ virtuals: true }),
      Market.findOne(identifier(task.marketId)).lean({ virtuals: true }),
      task.hubId ? DispatchHub.findOne(identifier(task.hubId)).lean({ virtuals: true }) : null,
      RunnerPackage.findOne({ taskId: task._id }).select('+scanCredentialCiphertext -scanCredentialHash').lean({ virtuals: true }),
      Order.findById(task.orderId).select('publicId').lean() as Promise<any>,
    ]);
    const itemIds = items.map((item: any) => String(item._id));
    const issues = itemIds.length ? await ItemResolution.find({ taskId: String(task._id), orderItemId: { $in: itemIds }, status: { $nin: ['RESOLVED', 'CANCELLED'] } }).lean({ virtuals: true }) : [];
    // The code is shown to the associate for as long as the package waits for
    // the Hub. If it cannot be decrypted (old package without one, or a changed
    // key) the task still loads; the app offers a fresh code via
    // regenerateHandoverCode instead of the whole page failing.
    let visibleCredential: string | undefined;
    let credentialUnavailable = false;
    if (pack?.status === RunnerPackageStatus.READY_FOR_HUB) {
      visibleCredential = tryDecryptPackageCredential((pack as any).scanCredentialCiphertext);
      credentialUnavailable = !visibleCredential;
      if (credentialUnavailable) console.warn(`[handover] code for package ${(pack as any).publicId} is unreadable`);
    }
    // Older Hub receipts could complete the package while leaving the task at
    // READY_FOR_HUB. Heal that mismatch on read so the associate never sees a
    // misleading "waiting" state or expects a credential that was correctly
    // destroyed when custody changed.
    if (pack?.status === RunnerPackageStatus.HUB_RECEIVED && task.status === FulfilmentTaskStatus.READY_FOR_HUB) {
      await FulfilmentTask.updateOne(
        { _id: task._id, status: FulfilmentTaskStatus.READY_FOR_HUB },
        { $set: { status: FulfilmentTaskStatus.HUB_RECEIVED, hubReceivedAt: (pack as any).credentialVerifiedAt || (pack as any).handedOverAt || new Date() }, $inc: { version: 1 } },
      );
      task.status = FulfilmentTaskStatus.HUB_RECEIVED;
      task.version = Number(task.version || 0) + 1;
      task.hubReceivedAt = (pack as any).credentialVerifiedAt || (pack as any).handedOverAt;
    }
    if (pack) delete (pack as any).scanCredentialCiphertext;
    return { ...task, orderPublicId: orderDoc?.publicId, items, market, hub, issues, package: pack ? { ...pack, ...(visibleCredential ? { scanCredential: visibleCredential } : {}), ...(credentialUnavailable ? { credentialUnavailable: true } : {}) } : null };
  }

  async verifyItem(accountId: string, taskIdentifier: string, orderItemId: string, body: Record<string, any>) {
    const marketAssociate = await marketAssociateContext(accountId);
    const task = await taskByIdentifier(taskIdentifier);
    if (task.marketAssociateId !== (marketAssociate as any)._id.toString()) throw new HttpError(404, 'Fulfilment task not found', undefined, 'NOT_FOUND');
    if (!task.orderItemIds.map(String).includes(String(orderItemId))) throw new HttpError(404, 'Order item not found on this task', undefined, 'NOT_FOUND');
    if (![FulfilmentTaskStatus.ACCEPTED, FulfilmentTaskStatus.SOURCING, FulfilmentTaskStatus.PRODUCT_SECURED, FulfilmentTaskStatus.PACKING].includes(task.status)) {
      throw new HttpError(409, 'Accept this task before completing its products', { current: task.status }, 'INVALID_STATE_TRANSITION');
    }
    const photos = Array.isArray(body.photos) ? body.photos : [];
    const photoViews = new Set(photos.map((photo: any) => photo.view));
    if (photos.length < 3 || photos.length > 7 || photoViews.size !== photos.length || !['front', 'side', 'back'].every((view) => photoViews.has(view))) throw new HttpError(400, 'Front, side and back photos are required (up to 7 photos in total)', undefined, 'VALIDATION_ERROR');
    // What this item was ordered with decides what must be verified: a phone case has no size or colour to check.
    const ordered = ((await OrderItem.findById(orderItemId).select('variantSnapshot').lean()) as { variantSnapshot?: Record<string, string> } | null)?.variantSnapshot || {};
    const orderedOther = Object.keys(ordered).filter((key) => key !== 'color' && key !== 'size' && ordered[key]);
    const needsColor = Boolean(ordered.color);
    const needsSize = Boolean(ordered.size);
    if (needsColor && !String(body.actualColor || '').trim()) throw new HttpError(400, 'Enter the colour you found', undefined, 'VALIDATION_ERROR');
    if (needsSize && !String(body.actualSize || '').trim()) throw new HttpError(400, 'Enter the size you found', undefined, 'VALIDATION_ERROR');
    const actualAttributes: Record<string, string> = {};
    for (const key of orderedOther) {
      const found = String(body.actualAttributes?.[key] ?? '').trim();
      if (!found) throw new HttpError(400, `Enter the ${key.replace(/([A-Z])/g, ' $1').toLowerCase()} you found`, undefined, 'VALIDATION_ERROR');
      actualAttributes[key] = found;
    }
    const checks = {
      productMatches: Boolean(body.checks?.productMatches),
      sizeMatches: needsSize ? Boolean(body.checks?.sizeMatches) : true,
      colorMatches: needsColor ? Boolean(body.checks?.colorMatches) : true,
      attributesMatch: orderedOther.length ? Boolean(body.checks?.attributesMatch) : true,
      quantityMatches: Boolean(body.checks?.quantityMatches),
    };
    const matched = Object.values(checks).every(Boolean);
    const entry = {
      orderItemId: String(orderItemId),
      photoUrl: String(photos.find((photo: any) => photo.view === 'front')?.url || ''),
      photos,
      actualColor: needsColor ? String(body.actualColor) : undefined,
      actualSize: needsSize ? String(body.actualSize) : undefined,
      ...(orderedOther.length ? { actualAttributes } : {}),
      actualQuantity: Number(body.actualQuantity),
      unitCostMinor: Number(body.unitCostMinor),
      supplierReference: body.supplierReference ? String(body.supplierReference) : undefined,
      conditionNote: String(body.conditionNote),
      checks,
      matched,
      verifiedAt: new Date(),
      verifiedBy: accountId,
    };
    let updated = await FulfilmentTask.findOneAndUpdate(
      { _id: task._id, 'itemVerifications.orderItemId': { $ne: String(orderItemId) } },
      { $push: { itemVerifications: entry } },
      { returnDocument: 'after' },
    ).lean({ virtuals: true });
    if (!updated) {
      const previous = (task.itemVerifications || []).find((item: any) => String(item.orderItemId) === String(orderItemId));
      updated = await FulfilmentTask.findOneAndUpdate(
        { _id: task._id, 'itemVerifications.orderItemId': String(orderItemId) },
        { $set: { 'itemVerifications.$': { ...entry, revisions: [...((previous as any)?.revisions || []), ...(previous ? [{ ...previous, revisedAt: new Date() }] : [])] } } },
        { returnDocument: 'after' },
      ).lean({ virtuals: true });
    }
    if (!updated) throw new HttpError(404, 'Fulfilment task not found', undefined, 'NOT_FOUND');
    await OrderItem.updateOne({ _id: orderItemId }, { $set: { fulfilmentStatus: matched ? 'SECURED' : 'EXCEPTION' } });
    await audit('fulfilment.marketassociate.item_verified', 'fulfilment_task', task._id.toString(), accountId, { orderItemId, matched }, undefined, task.sourceStateId, task.hubId);
    await this.publishOrderUpdate(task.orderId, task.sourceStateId, task.hubId);
    const verifications = (updated as any).itemVerifications || [];
    const verifiedCount = task.orderItemIds.filter((id: string) => verifications.some((v: any) => String(v.orderItemId) === String(id) && v.matched)).length;
    return { taskId: (updated as any).publicId || (updated as any)._id.toString(), orderItemId, matched, verifiedCount, totalCount: task.orderItemIds.length };
  }

  async marketAssociateTransition(accountId: string, taskIdentifier: string, action: string, version: number, body: Record<string, any> = {}) {
    const marketAssociate = await marketAssociateContext(accountId);
    const task = await taskByIdentifier(taskIdentifier);
    if (task.marketAssociateId !== (marketAssociate as any)._id.toString()) throw new HttpError(404, 'Fulfilment task not found', undefined, 'NOT_FOUND');
    if ((action === 'pack' || action === 'submit') && task.status === FulfilmentTaskStatus.READY_FOR_HUB) {
      const existingPackage = await RunnerPackage.findOne({ taskId: task._id }).select('+scanCredentialCiphertext -scanCredentialHash').lean({ virtuals: true });
      if (existingPackage) {
        const scanCredential = tryDecryptPackageCredential((existingPackage as any).scanCredentialCiphertext);
        delete (existingPackage as any).scanCredentialCiphertext;
        return { ...task, package: { ...existingPackage, ...(scanCredential ? { scanCredential } : {}) } };
      }
    }
    const allowed = TASK_TRANSITIONS[action] || [];
    if (!allowed.includes(task.status)) throw new HttpError(409, `Cannot ${action.replaceAll('_', ' ')} from the current task state`, { current: task.status }, 'INVALID_STATE_TRANSITION');
    const now = new Date();
    const set: Record<string, unknown> = { version: task.version + 1 };
    if (action === 'accept') {
      // Acceptance opens the item workspace immediately. ACCEPTED remains
      // readable for legacy tasks, but new tasks no longer require a second
      // "start sourcing" click.
      set.status = FulfilmentTaskStatus.SOURCING;
      set.acceptedAt = now;
      set.sourcingStartedAt = now;
    }
    if (action === 'start_sourcing') { set.status = FulfilmentTaskStatus.SOURCING; set.sourcingStartedAt = now; }
    if (action === 'secure') {
      const matched = (task.itemVerifications || []).filter((entry: any) => entry.matched);
      const matchedIds = new Set(matched.map((entry: any) => String(entry.orderItemId)));
      if (task.orderItemIds.some((id: string) => !matchedIds.has(String(id)))) throw new HttpError(409, 'Verify every item before marking the task secured', undefined, 'INVALID_STATE_TRANSITION');
      const unresolvedIssues = await ItemResolution.countDocuments({ taskId: String(task._id), status: { $nin: ['RESOLVED', 'CANCELLED'] } });
      if (unresolvedIssues) throw new HttpError(409, 'Resolve every item issue before marking the task secured', undefined, 'INVALID_STATE_TRANSITION');
      set.status = FulfilmentTaskStatus.PRODUCT_SECURED; set.productSecuredAt = now;
      set.actualCostMinor = matched.reduce((sum: number, entry: any) => sum + Number(entry.unitCostMinor || 0) * Number(entry.actualQuantity || 1), 0);
      set.evidence = evidence(body.evidence);
    }
    if (action === 'begin_packing') { set.status = FulfilmentTaskStatus.PACKING; set.packingStartedAt = now; }
    if (action === 'pack' || action === 'submit') {
      const unresolvedIssues = await ItemResolution.countDocuments({ taskId: String(task._id), status: { $nin: ['RESOLVED', 'CANCELLED'] } });
      if (unresolvedIssues) throw new HttpError(409, `${unresolvedIssues} product issue(s) must be resolved before this fulfilment can be submitted`, { unresolvedIssues }, 'INVALID_STATE_TRANSITION');
      const verifiedIds = new Set((task.itemVerifications || []).filter((v: any) => v.matched).map((v: any) => String(v.orderItemId)));
      const missingItemIds = task.orderItemIds.filter((id: string) => !verifiedIds.has(String(id)));
      if (missingItemIds.length) throw new HttpError(409, `${missingItemIds.length} product(s) still need a completed sourcing form`, { missingItemIds }, 'ITEMS_NOT_VERIFIED');
      set.status = FulfilmentTaskStatus.READY_FOR_HUB; set.packedAt = now; set.hubArrivedAt = body.arrivedAt ? new Date(body.arrivedAt) : undefined;
      // A package can already exist if an earlier submit created it and then failed
      // before the task moved on. Reuse it, and hand back its code so the
      // associate still sees it (only the hash was kept for this before).
      const existingPackage = await RunnerPackage.findOne({ taskId: task._id }).select('+scanCredentialCiphertext -scanCredentialHash').lean({ virtuals: true }) as any;
      const existingCredential = existingPackage ? tryDecryptPackageCredential(existingPackage.scanCredentialCiphertext) : undefined;
      if (existingPackage) delete existingPackage.scanCredentialCiphertext;
      const packageResult = existingPackage ? { package: existingPackage, credential: existingCredential } : await this.createRunnerPackage(task, now, body.evidence);
      const created = packageResult.package;
      const rawCredential = packageResult.credential;
      const packSet = { ...set };
      delete packSet.version;
      const updatedTask = await FulfilmentTask.findOneAndUpdate({ _id: task._id, version }, { $set: { ...packSet, status: FulfilmentTaskStatus.READY_FOR_HUB, packedAt: now }, $inc: { version: 1 } }, { returnDocument: 'after' }).lean({ virtuals: true });
      if (!updatedTask) throw new HttpError(409, 'This task changed. Refresh and try again.', undefined, 'STALE_VERSION');
      await OrderItem.updateMany({ _id: { $in: task.orderItemIds } }, { $set: { fulfilmentStatus: 'PACKED', runnerPackageId: (created as any)._id.toString() } });
      await audit('fulfilment.marketassociate.package_created', 'runner_package', (created as any).id, accountId, { publicId: (created as any).publicId }, undefined, task.sourceStateId, task.hubId);
      await this.publishOrderUpdate(task.orderId, task.sourceStateId, task.hubId);
      return { ...(updatedTask as any), package: { ...(created as any), ...(rawCredential ? { scanCredential: rawCredential } : {}) } };
    }
    const updated = await FulfilmentTask.findOneAndUpdate({ _id: task._id, version }, { $set: set }, { returnDocument: 'after' }).lean({ virtuals: true });
    if (!updated) throw new HttpError(409, 'This task changed. Refresh and try again.', undefined, 'STALE_VERSION');
    await audit(`fulfilment.marketassociate.${action}`, 'fulfilment_task', task._id.toString(), accountId, { status: (updated as any).status }, undefined, task.sourceStateId, task.hubId);
    await this.publishOrderUpdate(task.orderId, task.sourceStateId, task.hubId);
    return updated;
  }

  /**
   * Issues a new handover code for a package whose code can no longer be shown
   * (an older package created before codes were stored, or an encryption key
   * that changed). It never rotates a code that is still readable, and it
   * refuses a package the Hub locked after too many wrong attempts: that needs
   * an administrator. The conditional update means two taps produce one code.
   */
  async regenerateHandoverCode(accountId: string, taskIdentifier: string) {
    const marketAssociate = await marketAssociateContext(accountId);
    const task = await taskByIdentifier(taskIdentifier);
    if (task.marketAssociateId !== (marketAssociate as any)._id.toString()) throw new HttpError(404, 'Fulfilment task not found', undefined, 'NOT_FOUND');
    if (task.status !== FulfilmentTaskStatus.READY_FOR_HUB) throw new HttpError(409, 'A handover code is only needed while the package is waiting for the Hub', { current: task.status }, 'INVALID_STATE_TRANSITION');
    const pack = await RunnerPackage.findOne({ taskId: task._id, status: RunnerPackageStatus.READY_FOR_HUB }).select('+scanCredentialCiphertext -scanCredentialHash').lean({ virtuals: true }) as any;
    if (!pack) throw new HttpError(409, 'This package is no longer waiting for the Hub', undefined, 'INVALID_STATE_TRANSITION');
    if (pack.credentialLockedAt) throw new HttpError(423, 'Verification of this package is locked. Ask an administrator to review it.', undefined, 'ACCESS_DENIED');
    const readable = tryDecryptPackageCredential(pack.scanCredentialCiphertext);
    const respond = (code: string, source: any) => {
      const safe = { ...source }; delete safe.scanCredentialCiphertext;
      return { ...task, package: { ...safe, scanCredential: code } };
    };
    if (readable) return respond(readable, pack);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const replacement = String(randomInt(1000, 10000));
      try {
        const updated = await RunnerPackage.findOneAndUpdate(
          {
            _id: pack._id,
            status: RunnerPackageStatus.READY_FOR_HUB,
            credentialLockedAt: { $exists: false },
            // Only replace the exact unreadable value we saw.
            scanCredentialCiphertext: pack.scanCredentialCiphertext ?? { $exists: false },
          } as any,
          { $set: { scanCredentialHash: digest(replacement), scanCredentialHint: hint(replacement), scanCredentialCiphertext: encryptPackageCredential(replacement), credentialGeneratedAt: new Date(), credentialFailedAttempts: 0 } },
          { returnDocument: 'after' },
        ).select('+scanCredentialCiphertext -scanCredentialHash').lean({ virtuals: true }) as any;
        if (updated) {
          await audit('fulfilment.package.handover_code_regenerated', 'runner_package', String(pack.publicId || pack._id), accountId, { taskId: String(task.publicId || task._id) }, undefined, task.sourceStateId, task.hubId);
          return respond(replacement, updated);
        }
        // Someone else replaced it first: return theirs.
        const current = await RunnerPackage.findById(pack._id).select('+scanCredentialCiphertext -scanCredentialHash').lean({ virtuals: true }) as any;
        const theirs = tryDecryptPackageCredential(current?.scanCredentialCiphertext);
        if (current && theirs) return respond(theirs, current);
        throw new HttpError(409, 'The package changed while a new code was being issued. Refresh and try again.', undefined, 'STALE_VERSION');
      } catch (error) {
        // Another package at this Hub already holds that code: draw again.
        if (!isDuplicateKey(error) || attempt === 11) throw error;
      }
    }
    throw new HttpError(503, 'Unable to reserve a Hub handover code. Please try again.', undefined, 'PROVIDER_NOT_READY');
  }

  private async createRunnerPackage(task: any, now: Date, evidenceInput?: EvidenceInput) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const credential = String(randomInt(1000, 10000));
      try {
        const created = await RunnerPackage.create({
          publicId: await nextPublicId('runnerPackage'), orderId: task.orderId, taskId: task._id.toString(), marketAssociateId: task.marketAssociateId, hubId: task.hubId,
          status: RunnerPackageStatus.READY_FOR_HUB, scanCredentialHash: digest(credential), scanCredentialHint: hint(credential), scanCredentialCiphertext: encryptPackageCredential(credential),
          credentialGeneratedAt: now, credentialFailedAttempts: 0, itemIds: task.resourceItemIds?.length ? task.resourceItemIds : task.orderItemIds,
          labelReference: `${String(task.orderId).slice(-10).toUpperCase()}-${String(task.publicId).slice(-6).toUpperCase()}`, packedAt: now, evidence: evidence(evidenceInput), version: 1,
        });
        // toObject() drops _id in favour of id (see the schema transform), but the
        // caller needs _id to link the order items. It used to read it as undefined and
        // throw AFTER the package was saved, so the associate's submit failed and the
        // retry created no new code to show.
        const safe = { ...(created.toObject() as any), _id: created._id }; delete safe.scanCredentialHash; delete safe.scanCredentialCiphertext;
        return { package: safe, credential };
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        const existing = await RunnerPackage.findOne({ taskId: task._id }).select('-scanCredentialHash -scanCredentialCiphertext').lean({ virtuals: true });
        if (existing) return { package: existing, credential: undefined };
      }
    }
    throw new HttpError(503, 'Unable to reserve a Hub handover code. Please try again.', undefined, 'PROVIDER_NOT_READY');
  }

  async marketAssociateIssue(accountId: string, taskIdentifier: string, body: Record<string, any>) {
    const marketAssociate = await marketAssociateContext(accountId); const task = await taskByIdentifier(taskIdentifier);
    if (task.marketAssociateId !== (marketAssociate as any)._id.toString()) throw new HttpError(404, 'Fulfilment task not found', undefined, 'NOT_FOUND');
    // The reason lives on the task itself. It used to be written to a separate
    // FulfilmentException row whose id was stored here — but resolving that row
    // never unblocked anything, so the exception was a dead end that made a
    // blocked task look actionable when it was not. Admin now unblocks the task
    // directly (see unblockTask), and escalation goes to the support email.
    const idempotencyKey = String(body.idempotencyKey || `marketassociate-issue:${task._id}:${task.version}:${body.type || 'ITEM_UNAVAILABLE'}`);
    const issue = {
      type: String(body.type || 'ITEM_UNAVAILABLE'),
      summary: String(body.summary || 'Market Associate reported a fulfilment issue'),
      severity: String(body.severity || 'HIGH'),
      reportedBy: accountId,
      reportedAt: new Date(),
      evidence: body.evidence || [],
      idempotencyKey,
      ...(body.orderItemId ? { orderItemId: String(body.orderItemId) } : {}),
    };
    // The task carries its own dedupe key now that the exception collection is
    // gone, so a replayed report is a no-op rather than a second version bump.
    if ((task.issue as any)?.idempotencyKey === idempotencyKey) {
      return (await FulfilmentTask.findById(task._id).lean({ virtuals: true })) as any;
    }
    const taskUpdate = await FulfilmentTask.updateOne({ _id: task._id, version: task.version }, { $set: { status: FulfilmentTaskStatus.BLOCKED, issue }, $inc: { version: 1 } });
    if (!taskUpdate.modifiedCount) throw new HttpError(409, 'This fulfilment task changed. Refresh and try again.', undefined, 'STALE_VERSION');
    await audit('fulfilment.task.blocked', 'fulfilment_task', task._id.toString(), accountId, { issue }, undefined, task.sourceStateId, task.hubId);
    await this.publishOrderUpdate(task.orderId, task.sourceStateId, task.hubId);
    await notifyStaffByPermission({
      permission: 'fulfilment.manage', stateId: task.sourceStateId, hubId: task.hubId,
      eventKeyPrefix: `fulfilment-task:${task.publicId}:blocked:${idempotencyKey}`,
      title: 'Fulfilment task blocked', body: issue.summary,
      type: 'order_updated', data: { taskId: task.publicId, href: `/dashboard/fulfilment/tasks/${task.publicId}` },
    });
    return (await FulfilmentTask.findById(task._id).lean({ virtuals: true })) as any;
  }

  async marketAssociateItemIssue(accountId: string, taskIdentifier: string, orderItemId: string, body: Record<string, any>) {
    const marketAssociate = await marketAssociateContext(accountId);
    const task = await taskByIdentifier(taskIdentifier);
    if (task.marketAssociateId !== (marketAssociate as any)._id.toString()) throw new HttpError(404, 'Fulfilment task not found', undefined, 'NOT_FOUND');
    if (!task.orderItemIds.map(String).includes(String(orderItemId))) throw new HttpError(404, 'Order item not found on this task', undefined, 'NOT_FOUND');
    const item = await OrderItem.findById(orderItemId).lean({ virtuals: true }) as any;
    if (!item) throw new HttpError(404, 'Order item not found', undefined, 'NOT_FOUND');
    const order = await Order.findById(task.orderId).select('userId publicId').lean() as any;
    const key = String(body.idempotencyKey);
    const existing = await ItemResolution.findOne({ idempotencyKey: key }).lean({ virtuals: true });
    if (existing) return existing;
    const resolution = await ItemResolution.create({
      publicId: await nextPublicId('itemResolution'), orderId: task.orderId, taskId: String(task._id), orderItemId: String(orderItemId), marketId: task.marketId,
      type: body.type, summary: body.summary, evidence: evidence(body.evidence), originalSnapshot: { productId: item.productId, title: item.productTitle, image: item.productImage, quantity: item.quantity, selectedVariants: item.selectedVariants, unitPriceMinor: item.unitPriceMinor },
      status: 'OPEN', reportedBy: accountId, customerId: order?.userId, adjustmentMinor: 0, idempotencyKey: key, version: 1,
      history: [{ action: 'REPORTED', actorId: accountId, at: new Date() }],
    });
    await OrderItem.updateOne({ _id: orderItemId }, { $set: { fulfilmentStatus: 'EXCEPTION', resolutionState: 'REPLACEMENT_PENDING' } });
    await audit('fulfilment.item.issue_created', 'item_resolution', resolution.id, accountId, { taskId: task.publicId, orderItemId, type: body.type }, undefined, task.sourceStateId, task.hubId);
    await this.publishOrderUpdate(task.orderId, task.sourceStateId, task.hubId);
    await notifyStaffByPermission({
      permission: 'fulfilment.manage', stateId: task.sourceStateId, hubId: task.hubId,
      eventKeyPrefix: `item-resolution:${resolution.id}:reported`,
      title: 'Item exception reported', body: `${item.productTitle || 'A product'} needs review: ${body.type ? String(body.type).replaceAll('_', ' ').toLowerCase() : body.summary}`,
      type: 'item_resolution_reported', data: { taskId: task.publicId, itemResolutionId: resolution.publicId, href: `/dashboard/fulfilment/tasks/${task.publicId}` },
    });
    return resolution.toObject();
  }

  /**
   * Returns a blocked task to the queue.
   *
   * This path never existed: a task blocked by a Market Associate stayed
   * blocked forever, because "resolving" its exception only marked a row and
   * left the task untouched. Clearing the issue and returning the task to
   * ALERTED is what actually releases the work.
   */
  async unblockTask(actor: Actor, taskIdentifier: string, body: Record<string, any>) {
    const task = await taskByIdentifier(taskIdentifier);
    await assertStaffScope(actor, task.sourceStateId, task.hubId);
    const reason = String(body.reason || '').trim();
    if (reason.length < 3) throw new HttpError(400, 'A reason is required to unblock this task', undefined, 'VALIDATION_ERROR');
    if (task.status !== FulfilmentTaskStatus.BLOCKED) {
      throw new HttpError(409, 'Only a blocked task can be unblocked', undefined, 'INVALID_STATE_TRANSITION');
    }
    const updated = await FulfilmentTask.findOneAndUpdate(
      { _id: task._id, version: task.version },
      { $set: { status: FulfilmentTaskStatus.ALERTED, alertedAt: new Date() }, $unset: { issue: 1 }, $inc: { version: 1 } },
      { returnDocument: 'after' },
    ).lean({ virtuals: true });
    if (!updated) throw new HttpError(409, 'This fulfilment task changed. Refresh and try again.', undefined, 'STALE_VERSION');
    await audit('fulfilment.task.unblocked', 'fulfilment_task', task._id.toString(), actor.accountId, { reason }, undefined, task.sourceStateId, task.hubId);
    await this.publishOrderUpdate(task.orderId, task.sourceStateId, task.hubId);
    if (task.marketAssociateId) {
      const marketAssociateProfile = await MarketAssociateProfile.findById(task.marketAssociateId).select('accountId').lean();
      if (marketAssociateProfile?.accountId) void createCommerceNotification({
        eventKey: `fulfilment:${task.publicId}:unblocked:${updated.version}`,
        userId: marketAssociateProfile.accountId,
        title: 'Task unblocked',
        body: `${task.publicId} is releasable again. ${reason}`,
        type: 'order_updated',
        data: { taskId: task.publicId },
      });
    }
    return updated;
  }

  async hubDashboard(actor: Actor, query: Record<string, unknown>) {
    await assertStaffScope(actor, query.stateId as string | undefined, query.hubId as string | undefined);
    const filter: Record<string, unknown> = { status: { $in: [HubPackageStatus.RECEIVED, HubPackageStatus.QC_PENDING, HubPackageStatus.QC_PASSED, HubPackageStatus.QC_FAILED] } };
    // Intersect rather than overwrite: an explicit hubId from a multi-hub user
    // must narrow the view, not be silently ignored. Scope is still enforced by
    // assertStaffScope above, which rejects a hub the actor cannot see.
    if (actor.hubIds?.length) filter.hubId = query.hubId ? query.hubId : { $in: actor.hubIds };
    else if (query.hubId) filter.hubId = query.hubId;
    const stateIds = query.stateId ? [String(query.stateId)] : (actor.stateIds || []).map(String);
    const inboundFilter: Record<string, unknown> = { status: RunnerPackageStatus.READY_FOR_HUB };
    if (actor.hubIds?.length) inboundFilter.hubId = query.hubId ? query.hubId : { $in: actor.hubIds };
    else if (query.hubId) inboundFilter.hubId = query.hubId;
    if (stateIds.length) {
      const tasks = await FulfilmentTask.find({ sourceStateId: { $in: stateIds } }).select('_id').lean();
      filter.taskId = { $in: tasks.map((task) => task._id.toString()) };
      inboundFilter.taskId = { $in: tasks.map((task) => task._id.toString()) };
    }
    const consolidationFilter: Record<string, unknown> = { status: { $in: ['DRAFT', 'SEALED'] } };
    if (query.hubId) consolidationFilter.hubId = query.hubId;
    if (actor.hubIds?.length) consolidationFilter.hubId = { $in: actor.hubIds };
    if (query.stateId) consolidationFilter.sourceStateId = query.stateId;
    if (actor.stateIds?.length) consolidationFilter.sourceStateId = { $in: actor.stateIds };
    const [inbound, packages, consolidations] = await Promise.all([
      RunnerPackage.find(inboundFilter).sort({ createdAt: 1 }).limit(100).lean({ virtuals: true }),
      HubPackage.find(filter).sort({ createdAt: 1 }).limit(100).lean({ virtuals: true }),
      Consolidation.find(consolidationFilter).sort({ createdAt: -1 }).limit(100).lean({ virtuals: true }),
    ]);
    const taskIds = [...new Set(packages.map((pack: any) => String(pack.taskId)))];
    const tasksWithVerifications = taskIds.length
      ? await FulfilmentTask.find({ _id: { $in: taskIds } }).select('itemVerifications').lean()
      : [];
    const verificationsByTask = new Map(tasksWithVerifications.map((t: any) => [String(t._id), t.itemVerifications || []]));
    const allItemIds = [...new Set(packages.flatMap((pack: any) => pack.itemIds.map(String)))];
    const items = allItemIds.length
      ? await OrderItem.find({ _id: { $in: allItemIds } }).select('publicId productTitle productImage productSnapshot variantSnapshot quantity').lean()
      : [];
    const itemById = new Map(items.map((item: any) => [String(item._id), item]));
    const packagesWithItems = packages.map((pack: any) => ({
      ...pack,
      items: pack.itemIds.map((id: string) => {
        const verification = (verificationsByTask.get(String(pack.taskId)) || []).find((v: any) => String(v.orderItemId) === String(id));
        const item = itemById.get(String(id));
        return {
          orderItemId: id,
          productTitle: item?.productTitle,
          orderedPhotoUrl: item?.productImage || (item?.productSnapshot as any)?.image,
          pickedUpPhotoUrl: verification?.photoUrl,
          checks: verification?.checks,
          matched: verification?.matched ?? false,
          itemReference: item?.publicId,
          orderedColor: (item?.variantSnapshot as any)?.color,
          orderedSize: (item?.variantSnapshot as any)?.size,
          // Every other ordered detail (capacity, length, phone model...), in order.
          orderedAttributes: Object.entries((item?.variantSnapshot as Record<string, string>) || {}).filter(([key, value]) => key !== 'color' && key !== 'size' && value).map(([key, value]) => ({ key, value })),
          actualAttributes: verification?.actualAttributes,
          orderedQuantity: item?.quantity,
          photos: verification?.photos,
          actualColor: verification?.actualColor,
          actualSize: verification?.actualSize,
          actualQuantity: verification?.actualQuantity,
          unitCostMinor: verification?.unitCostMinor,
          supplierReference: verification?.supplierReference,
          conditionNote: verification?.conditionNote,
          verifiedAt: verification?.verifiedAt,
        };
      }),
    }));
    const names = await resolveFulfilmentNames([...inbound, ...packagesWithItems, ...consolidations] as any[]);
    const withNames = (record: any) => ({ ...record, hub: names.hub(record.hubId), order: names.order(record.orderId), marketAssociate: record.marketAssociateId ? names.marketAssociate(record.marketAssociateId) : undefined });
    return {
      inbound: inbound.map(withNames),
      packages: packagesWithItems.map(withNames),
      consolidations: consolidations.map(withNames),
    };
  }

  async consolidations(actor: Actor, query: Record<string, unknown>) {
    await assertStaffScope(actor, query.stateId as string | undefined, query.hubId as string | undefined);
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.stateId) filter.sourceStateId = query.stateId;
    if (query.hubId) filter.hubId = query.hubId;
    if (actor.stateIds?.length) filter.sourceStateId = { $in: actor.stateIds };
    if (actor.hubIds?.length) filter.hubId = { $in: actor.hubIds };
    const records = await Consolidation.find(filter).sort({ createdAt: -1 }).limit(Math.min(Number(query.limit || 100), 200)).lean({ virtuals: true });
    const names = await resolveFulfilmentNames(records as any[]);
    // Attach the courier the customer chose and paid for, so the booking screen
    // can lead with it instead of a dropdown defaulting to "manual".
    const orderIds = [...new Set(records.map((record: any) => String(record.orderId)).filter(Boolean))];
    const orders = orderIds.length
      ? await Order.find({ _id: { $in: orderIds } }).select('logisticsProviderSnapshot').lean() as any[]
      : [];
    const courierByOrder = new Map(orders.map((order) => [String(order._id), order.logisticsProviderSnapshot]));
    const availability = await this.courierAvailability();
    return records.map((record: any) => {
      const chosen = courierByOrder.get(String(record.orderId)) as any;
      return {
        ...record,
        hub: names.hub(record.hubId),
        order: names.order(record.orderId),
        chosenCourier: chosen ? { ...chosen, ...availability.describe(chosen.code) } : undefined,
        alternatives: availability.alternatives,
        printCount: (record.receiptPrints || []).length,
      };
    });
  }

  async receivePackage(actor: Actor, packageIdentifier: string, body: Record<string, any>) {
    await assertStaffScope(actor, body.stateId, body.hubId);
    const runnerPackage = await RunnerPackage.findOne(identifier(packageIdentifier)).select('+scanCredentialHash').lean({ virtuals: true }) as any;
    if (!runnerPackage) throw new HttpError(404, 'Market Associate package not found', undefined, 'NOT_FOUND');
    const task = await FulfilmentTask.findById(runnerPackage.taskId).select('sourceStateId hubId').lean() as any;
    if (!task) throw new HttpError(404, 'Market Associate package not found', undefined, 'NOT_FOUND');
    await assertStaffScope(actor, task.sourceStateId, runnerPackage.hubId);
    if (body.stateId && String(body.stateId) !== String(task.sourceStateId)) throw new HttpError(403, 'Package is outside the requested State', undefined, 'SCOPE_DENIED');
    const existing = body.idempotencyKey ? await HubPackage.findOne({ receiveIdempotencyKey: body.idempotencyKey }).lean({ virtuals: true }) : null;
    if (existing) {
      if (String((existing as any).runnerPackageId) !== runnerPackage._id.toString()) throw new HttpError(409, 'This receive idempotency key belongs to another package', undefined, 'IDEMPOTENCY_CONFLICT');
      return existing;
    }
    if (runnerPackage.status !== RunnerPackageStatus.READY_FOR_HUB) throw new HttpError(409, 'Package is not ready for Hub receiving', undefined, 'INVALID_STATE_TRANSITION');
    if (body.hubId && body.hubId !== runnerPackage.hubId) throw new HttpError(403, 'Package is assigned to another Hub', undefined, 'SCOPE_DENIED');
    if (runnerPackage.credentialLockedAt) throw new HttpError(423, 'Package verification is locked. Ask an administrator to review it.', undefined, 'ACCESS_DENIED');
    if (!body.scanCredential || digest(String(body.scanCredential)) !== runnerPackage.scanCredentialHash) {
      const failedAttempts = Number(runnerPackage.credentialFailedAttempts || 0) + 1;
      await RunnerPackage.updateOne(
        { _id: runnerPackage._id, status: RunnerPackageStatus.READY_FOR_HUB },
        { $set: { credentialFailedAttempts: failedAttempts, ...(failedAttempts >= 5 ? { credentialLockedAt: new Date() } : {}) } },
      );
      throw new HttpError(403, failedAttempts >= 5 ? 'Package verification is locked after too many attempts' : 'Invalid package handover code', { attemptsRemaining: Math.max(0, 5 - failedAttempts) }, 'ACCESS_DENIED');
    }
    const hubPackageId = await nextPublicId('hubPackage');
    let received: any;
    try {
      received = await this.atomically(async (session) => {
        // The claim is the guard: only one receive can flip READY_FOR_HUB, so
        // a double scan cannot create two hub packages for one runner package.
        const claimed = await RunnerPackage.updateOne({ _id: runnerPackage._id, status: RunnerPackageStatus.READY_FOR_HUB }, { $set: { status: RunnerPackageStatus.HUB_RECEIVED, handedOverAt: new Date(), credentialVerifiedAt: new Date() }, $unset: { scanCredentialCiphertext: 1 } }, { session });
        if (!claimed.modifiedCount) return null;
        const [created] = await HubPackage.create([{ publicId: hubPackageId, orderId: runnerPackage.orderId, taskId: runnerPackage.taskId, runnerPackageId: runnerPackage._id.toString(), hubId: runnerPackage.hubId, marketAssociateId: runnerPackage.marketAssociateId, status: HubPackageStatus.QC_PENDING, itemIds: runnerPackage.itemIds, receivedAt: new Date(), receivedBy: actor.accountId, qualityChecks: [], custodyHistory: [{ action: 'RECEIVED', actorId: actor.accountId, at: new Date() }], evidence: evidence(body.evidence), version: 1, receiveIdempotencyKey: body.idempotencyKey }], { session });
        await FulfilmentTask.updateOne({ _id: runnerPackage.taskId }, { $set: { status: FulfilmentTaskStatus.HUB_RECEIVED, hubReceivedAt: new Date() }, $inc: { version: 1 } }, { session });
        await OrderItem.updateMany({ _id: { $in: runnerPackage.itemIds } }, { $set: { fulfilmentStatus: 'RECEIVED', hubPackageId: created.id } }, { session });
        return created;
      });
    } catch (error) {
      if (!isDuplicateKey(error) || !body.idempotencyKey) throw error;
      received = null;
    }
    if (!received) {
      // Lost a race with another receive of the same package: return its result.
      const winner = await HubPackage.findOne({ runnerPackageId: runnerPackage._id.toString() }).lean({ virtuals: true });
      if (winner) return winner;
      throw new HttpError(409, 'Package is not ready for Hub receiving', undefined, 'INVALID_STATE_TRANSITION');
    }
    await audit('fulfilment.hub.package_received', 'hub_package', received.id, actor.accountId, { publicId: received.publicId }, undefined, body.stateId, runnerPackage.hubId);
    await this.publishOrderUpdate(runnerPackage.orderId, task.sourceStateId, runnerPackage.hubId);
    return received.toJSON();
  }

  async qualityCheck(actor: Actor, packageIdentifier: string, body: Record<string, any>) {
    const pack = await HubPackage.findOne(identifier(packageIdentifier)).lean({ virtuals: true }) as any;
    if (!pack) throw new HttpError(404, 'Hub package not found', undefined, 'NOT_FOUND');
    const task = await FulfilmentTask.findById(pack.taskId).select('sourceStateId').lean() as any;
    if (!task) throw new HttpError(404, 'Hub package not found', undefined, 'NOT_FOUND');
    await assertStaffScope(actor, task.sourceStateId, pack.hubId);
    if (![HubPackageStatus.QC_PENDING, HubPackageStatus.RECEIVED].includes(pack.status)) throw new HttpError(409, 'This package is no longer awaiting quality check', undefined, 'INVALID_STATE_TRANSITION');
    const passed = body.passed === true;
    let checks: Array<Record<string, unknown>> = body.checks || [];
    if (passed) {
      const confirmedIds = new Set(checks.filter((c: any) => c.confirmed === true).map((c: any) => String(c.orderItemId)));
      const missingItemIds = pack.itemIds.filter((id: string) => !confirmedIds.has(String(id)));
      if (missingItemIds.length) throw new HttpError(409, `${missingItemIds.length} item(s) still need Hub confirmation before QC can pass`, { missingItemIds }, 'ITEMS_NOT_CONFIRMED');
    }
    // A failed check must say which item failed and why. Each failure opens an
    // item issue for the admin, so the order cannot be sealed around it.
    const failures: Array<{ orderItemId: string; reason: string; note: string }> = (body.failures || []).map((f: any) => ({ orderItemId: String(f.orderItemId), reason: String(f.reason), note: String(f.note || '').trim() }));
    const resolutionIds = new Map<string, string>();
    let verifications: any[] = [];
    if (!passed) {
      if (!failures.length) throw new HttpError(400, 'Choose the item that failed and give a reason', undefined, 'VALIDATION_ERROR');
      const packageItemIds = new Set(pack.itemIds.map(String));
      if (failures.some((f) => !packageItemIds.has(f.orderItemId))) throw new HttpError(400, 'A failed item does not belong to this package', undefined, 'VALIDATION_ERROR');
      const parent = await FulfilmentTask.findById(pack.taskId).select('itemVerifications').lean() as any;
      verifications = parent?.itemVerifications || [];
      for (const failure of failures) {
        const active = await ItemResolution.findOne({ taskId: String(pack.taskId), orderItemId: failure.orderItemId, status: { $in: ['OPEN', 'ADMIN_REVIEW', 'CUSTOMER_APPROVAL_PENDING', 'PAYMENT_PENDING', 'REFUND_PENDING', 'APPROVED'] } }).select('publicId').lean() as any;
        resolutionIds.set(failure.orderItemId, active?.publicId || await nextPublicId('itemResolution'));
      }
      checks = failures.map((failure) => ({ orderItemId: failure.orderItemId, result: 'failed', reason: failure.reason, note: failure.note, resolutionId: resolutionIds.get(failure.orderItemId), at: new Date().toISOString(), by: actor.accountId }));
    }
    const updated = await this.atomically(async (session) => {
      const changed = await HubPackage.findOneAndUpdate({ _id: pack._id, version: body.version ?? pack.version, status: { $in: [HubPackageStatus.QC_PENDING, HubPackageStatus.RECEIVED] } }, { $set: { status: passed ? HubPackageStatus.QC_PASSED : HubPackageStatus.QC_FAILED, qualityChecks: checks, qcPassedAt: passed ? new Date() : undefined, qcPassedBy: passed ? actor.accountId : undefined }, $push: { custodyHistory: { action: passed ? 'QC_PASSED' : 'QC_FAILED', actorId: actor.accountId, at: new Date(), checks } }, $inc: { version: 1 } }, { returnDocument: 'after', session }).lean({ virtuals: true });
      if (!changed) return null;
      if (passed) {
        await OrderItem.updateMany({ _id: { $in: pack.itemIds } }, { $set: { fulfilmentStatus: 'QC_PASSED' } }, { session });
        await FulfilmentTask.updateOne({ _id: pack.taskId }, { $set: { status: FulfilmentTaskStatus.QC_PASSED }, $inc: { version: 1 } }, { session });
        return changed;
      }
      const order = await Order.findById(pack.orderId).select('userId').session(session).lean() as any;
      const marketId = (await FulfilmentTask.findById(pack.taskId).select('marketId').session(session).lean() as any)?.marketId;
      for (const failure of failures) {
        const publicId = resolutionIds.get(failure.orderItemId)!;
        const exists = await ItemResolution.exists({ publicId }).session(session);
        if (!exists) {
          const item = await OrderItem.findById(failure.orderItemId).session(session).lean() as any;
          const verification = verifications.find((v: any) => String(v.orderItemId) === failure.orderItemId);
          await ItemResolution.create([{
            publicId, orderId: pack.orderId, taskId: String(pack.taskId), orderItemId: failure.orderItemId, marketId,
            type: 'QC_FAILED', summary: `${QC_FAILURE_LABELS[failure.reason] || failure.reason}: ${failure.note}`,
            evidence: (verification?.photos || []).map((photo: any) => ({ type: `photo_${photo.view}`, url: photo.url })),
            originalSnapshot: { productId: item?.productId, title: item?.productTitle, image: item?.productImage, quantity: item?.quantity, selectedVariants: item?.selectedVariants, unitPriceMinor: item?.unitPriceMinor },
            status: 'ADMIN_REVIEW', reportedBy: actor.accountId, customerId: order?.userId, adjustmentMinor: 0, idempotencyKey: `qc-fail:${pack.publicId}:${failure.orderItemId}`, version: 1,
            history: [{ action: 'QC_FAILED', actorId: actor.accountId, at: new Date(), reason: failure.reason, note: failure.note, hubPackageId: pack.publicId }],
          }], { session });
        }
        await OrderItem.updateOne({ _id: failure.orderItemId }, { $set: { fulfilmentStatus: 'EXCEPTION', resolutionState: 'REPLACEMENT_PENDING' } }, { session });
      }
      await Order.updateOne({ _id: pack.orderId }, { $push: { timeline: timelineEntry('QC_FAILED', actor.accountId) } }, { session });
      return changed;
    });
    if (!updated) throw new HttpError(409, 'This package changed. Refresh and try again.', undefined, 'STALE_VERSION');
    await this.publishOrderUpdate(pack.orderId, task.sourceStateId, pack.hubId);
    if (passed) await this.notifyHubQcPassed(pack);
    else await this.notifyHubQcFailed(pack, failures);
    return updated;
  }

  private async notifyHubQcFailed(pack: any, failures: Array<{ orderItemId: string; reason: string }>) {
    const order = await Order.findById(pack.orderId).select('publicId userId').lean() as any;
    if (!order) return;
    if (order.userId) {
      await createCommerceNotification({
        eventKey: `order:${order.publicId}:qc-failed:${pack.publicId}`,
        userId: order.userId,
        title: 'One item needs attention',
        body: "An item didn't pass our quality check. We're sorting it out and will update you shortly.",
        type: 'hub_qc_failed',
        data: { orderId: order.publicId, hubPackageId: pack.publicId },
      }).catch(() => undefined);
    }
    if (pack.marketAssociateId) {
      const profile = await MarketAssociateProfile.findById(pack.marketAssociateId).select('accountId').lean() as any;
      if (profile?.accountId) {
        const reasons = [...new Set(failures.map((f) => QC_FAILURE_LABELS[f.reason] || f.reason))].join(', ');
        await createCommerceNotification({
          eventKey: `runner-package:${pack.publicId}:qc-failed`,
          userId: profile.accountId,
          title: 'Package failed Hub QC',
          body: `${failures.length} item${failures.length === 1 ? '' : 's'} did not pass: ${reasons}. Hook will contact you about next steps.`,
          type: 'hub_qc_failed',
          data: { orderId: order.publicId, hubPackageId: pack.publicId },
        }).catch(() => undefined);
      }
    }
  }

  /**
   * Send the failed items back to the Market Associate to source again.
   * The old package stays on record as history; the task is reopened for just
   * those items and a fresh package (and handover code) is created on submit.
   */
  async resourceFailedPackage(actor: Actor, packageIdentifier: string, body: Record<string, any>) {
    const pack = await HubPackage.findOne(identifier(packageIdentifier)).lean({ virtuals: true }) as any;
    if (!pack) throw new HttpError(404, 'Hub package not found', undefined, 'NOT_FOUND');
    const task = await FulfilmentTask.findById(pack.taskId).lean() as any;
    if (!task) throw new HttpError(404, 'Hub package not found', undefined, 'NOT_FOUND');
    await assertStaffScope(actor, task.sourceStateId, pack.hubId);
    if (pack.status !== HubPackageStatus.QC_FAILED) throw new HttpError(409, 'Only a failed package can be sent back', undefined, 'INVALID_STATE_TRANSITION');
    const checks: any[] = pack.qualityChecks || [];
    if (checks.length && checks.every((c) => c.resourced)) throw new HttpError(409, 'This package was already sent back', undefined, 'INVALID_STATE_TRANSITION');
    const recorded = checks.filter((c) => c.result === 'failed' && c.orderItemId && !c.resourced).map((c) => String(c.orderItemId));
    const failedIds: string[] = recorded.length ? recorded : pack.itemIds.map(String);
    const reason = String(body.note || '').trim();
    const updated = await this.atomically(async (session) => {
      const closed = await HubPackage.findOneAndUpdate(
        { _id: pack._id, version: body.version ?? pack.version, status: HubPackageStatus.QC_FAILED },
        { $set: { qualityChecks: checks.map((c) => (c.result === 'failed' ? { ...c, resourced: true } : c)) }, $push: { custodyHistory: { action: 'RESOURCED', actorId: actor.accountId, at: new Date(), itemIds: failedIds, note: reason || undefined } }, $inc: { version: 1 } },
        { returnDocument: 'after', session },
      ).lean({ virtuals: true });
      if (!closed) return null;
      await ItemResolution.updateMany(
        { taskId: String(task._id), orderItemId: { $in: failedIds }, status: { $in: ['OPEN', 'ADMIN_REVIEW', 'CUSTOMER_APPROVAL_PENDING', 'PAYMENT_PENDING', 'REFUND_PENDING', 'APPROVED'] } },
        { $set: { status: 'RESOLVED' }, $push: { history: { action: 'RESOURCED', actorId: actor.accountId, at: new Date() } }, $inc: { version: 1 } },
        { session },
      );
      // Free the task's one-package slot so a fresh package can be created.
      await RunnerPackage.updateOne({ _id: pack.runnerPackageId }, { $set: { taskId: `${task._id}:superseded:${pack.publicId}` } }, { session });
      await FulfilmentTask.updateOne(
        { _id: task._id },
        { $set: { status: FulfilmentTaskStatus.SOURCING, resourceItemIds: failedIds }, $unset: { hubReceivedAt: 1 }, $pull: { itemVerifications: { orderItemId: { $in: failedIds } } }, $inc: { version: 1 } },
        { session },
      );
      await OrderItem.updateMany({ _id: { $in: failedIds } }, { $set: { fulfilmentStatus: 'SOURCING', resolutionState: 'OPEN' } }, { session });
      await Order.updateOne({ _id: pack.orderId }, { $push: { timeline: timelineEntry('ITEM_RESOURCED', actor.accountId) } }, { session });
      return closed;
    });
    if (!updated) throw new HttpError(409, 'This package changed. Refresh and try again.', undefined, 'STALE_VERSION');
    if (pack.marketAssociateId) {
      const profile = await MarketAssociateProfile.findById(pack.marketAssociateId).select('accountId').lean() as any;
      if (profile?.accountId) {
        await createCommerceNotification({
          eventKey: `runner-package:${pack.publicId}:resourced`,
          userId: profile.accountId,
          title: 'Please source an item again',
          body: `${failedIds.length} item${failedIds.length === 1 ? '' : 's'} did not pass the Hub check. Open the task to source ${failedIds.length === 1 ? 'it' : 'them'} again.${reason ? ` Note: ${reason}` : ''}`,
          type: 'task_resourced',
          data: { hubPackageId: pack.publicId },
        }).catch(() => undefined);
      }
    }
    await audit('fulfilment.hub.package_resourced', 'hub_package', String(pack._id), actor.accountId, { publicId: pack.publicId, itemIds: failedIds }, undefined, task.sourceStateId, pack.hubId);
    await this.publishOrderUpdate(pack.orderId, task.sourceStateId, pack.hubId);
    return updated;
  }

  /** Signed so a parcel's public tracking link cannot be guessed from its number. */
  trackingSignature(receiptNumber: string) {
    return createHmac('sha256', process.env.JWT_SECRET || '').update(`parcel-tracking:${receiptNumber}`).digest('hex').slice(0, 24);
  }

  async publicParcelTracking(receiptNumber: string, signature: string) {
    const expected = Buffer.from(this.trackingSignature(receiptNumber));
    const given = Buffer.from(String(signature || ''));
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new HttpError(404, 'Parcel not found', undefined, 'NOT_FOUND');
    const order = await Order.findOne({ publicId: `ORD-${receiptNumber.replace(/^RCT-/, '')}` }).select('publicId addressSnapshot logisticsProviderSnapshot').lean() as any;
    if (!order) throw new HttpError(404, 'Parcel not found', undefined, 'NOT_FOUND');
    const shipment = await Shipment.findOne({ orderId: String(order._id) }).select('status courierName trackingNumber trackingEvents').lean() as any;
    const parcel = await Consolidation.findOne({ orderId: String(order._id), status: { $in: ['SEALED', 'HANDED_OVER'] } }).select('sealedAt').lean() as any;
    return {
      receiptNumber,
      orderReference: order.publicId,
      status: shipment?.status || (parcel ? 'PACKED' : 'PREPARING'),
      packedAt: parcel?.sealedAt,
      courier: shipment?.courierName || order.logisticsProviderSnapshot?.name,
      trackingNumber: shipment?.trackingNumber,
      destination: [order.addressSnapshot?.cityName, order.addressSnapshot?.stateName].filter(Boolean).join(', '),
      events: (shipment?.trackingEvents || []).map((event: any) => ({ status: event.status, at: event.at })),
    };
  }

  /** Put a failed package back into the check once its item issues are closed. */
  async reopenQualityCheck(actor: Actor, packageIdentifier: string, body: Record<string, any>) {
    const pack = await HubPackage.findOne(identifier(packageIdentifier)).lean({ virtuals: true }) as any;
    if (!pack) throw new HttpError(404, 'Hub package not found', undefined, 'NOT_FOUND');
    const task = await FulfilmentTask.findById(pack.taskId).select('sourceStateId').lean() as any;
    if (!task) throw new HttpError(404, 'Hub package not found', undefined, 'NOT_FOUND');
    await assertStaffScope(actor, task.sourceStateId, pack.hubId);
    if (pack.status !== HubPackageStatus.QC_FAILED) throw new HttpError(409, 'Only a failed package can be re-checked', undefined, 'INVALID_STATE_TRANSITION');
    const open = await ItemResolution.countDocuments({ taskId: String(pack.taskId), orderItemId: { $in: pack.itemIds }, status: { $in: ['OPEN', 'ADMIN_REVIEW', 'CUSTOMER_APPROVAL_PENDING', 'PAYMENT_PENDING', 'REFUND_PENDING', 'APPROVED'] } });
    if (open) throw new HttpError(409, `${open} item issue${open === 1 ? ' is' : 's are'} still open. Resolve them before re-checking.`, { open }, 'INVALID_STATE_TRANSITION');
    // Packages failed before reasons were recorded carry no per-item entries,
    // so fall back to every item on the package.
    const recorded = (pack.qualityChecks || []).filter((c: any) => c.result === 'failed' && c.orderItemId).map((c: any) => String(c.orderItemId));
    const failedIds: string[] = recorded.length ? recorded : pack.itemIds.map(String);
    const updated = await this.atomically(async (session) => {
      const moved = await HubPackage.findOneAndUpdate({ _id: pack._id, version: body.version ?? pack.version, status: HubPackageStatus.QC_FAILED }, { $set: { status: HubPackageStatus.QC_PENDING }, $push: { custodyHistory: { action: 'QC_REOPENED', actorId: actor.accountId, at: new Date() } }, $inc: { version: 1 } }, { returnDocument: 'after', session }).lean({ virtuals: true });
      if (moved && failedIds.length) await OrderItem.updateMany({ _id: { $in: failedIds } }, { $set: { fulfilmentStatus: 'PACKED' } }, { session });
      return moved;
    });
    if (!updated) throw new HttpError(409, 'This package changed. Refresh and try again.', undefined, 'STALE_VERSION');
    await this.publishOrderUpdate(pack.orderId, task.sourceStateId, pack.hubId);
    return updated;
  }

  private async notifyHubQcPassed(pack: any) {
    const order = await Order.findById(pack.orderId).select('publicId userId initiatingPartnerId channel totalMinor').lean() as any;
    if (!order) return;
    if (order.userId) {
      await createCommerceNotification({
        eventKey: `order:${order.publicId}:item-verified:${pack.publicId}`,
        userId: order.userId,
        title: 'Your items passed quality check',
        body: 'Hook Hub staff confirmed your items match your order and are ready for the next step.',
        type: 'hub_qc_passed',
        data: { orderId: order.publicId, hubPackageId: pack.publicId },
      }).catch(() => undefined);
      const customer = await User.findById(order.userId).select('email firstName').lean() as any;
      if (customer?.email) {
        await this.email.sendOrderStatusUpdate({
          to: customer.email,
          name: customer.firstName,
          orderCode: order.publicId,
          status: 'Items verified at Hub',
          amount: Number(order.totalMinor || 0) / 100,
        }).catch(() => undefined);
      }
    }
    if (pack.marketAssociateId) {
      const marketAssociateProfile = await MarketAssociateProfile.findById(pack.marketAssociateId).select('accountId').lean() as any;
      if (marketAssociateProfile?.accountId) {
        await createCommerceNotification({
          eventKey: `runner-package:${pack.publicId}:qc-passed`,
          userId: marketAssociateProfile.accountId,
          title: 'Package passed Hub QC',
          body: 'The items you sourced passed quality check at the Hub.',
          type: 'hub_qc_passed',
          data: { orderId: order.publicId, hubPackageId: pack.publicId },
        }).catch(() => undefined);
      }
    }
    if (order.channel === CommerceChannel.PARTNER_ASSISTED && order.initiatingPartnerId) {
      // Orders store the partner's internal id; older ones stored the public id. Accept both.
      const partner = await HookPartner.findOne(partnerIdentity(String(order.initiatingPartnerId))).select('accountId').lean() as any;
      if (partner?.accountId) {
        await createCommerceNotification({
          eventKey: `order:${order.publicId}:partner:item-verified:${pack.publicId}`,
          userId: partner.accountId,
          title: "Your customer's order passed Hub QC",
          body: 'The items for your customer\'s order were confirmed at the Hub and are progressing.',
          type: 'hub_qc_passed',
          data: { orderId: order.publicId, hubPackageId: pack.publicId },
        }).catch(() => undefined);
      }
    }
  }

  async consolidate(actor: Actor, orderIdentifier: string, body: Record<string, any>) {
    const order = await orderByIdentifier(orderIdentifier);
    const packages = await HubPackage.find({ orderId: order._id.toString(), hubId: body.hubId, status: HubPackageStatus.QC_PASSED }).lean({ virtuals: true });
    const tasks = await FulfilmentTask.find({ _id: { $in: packages.map((item: any) => item.taskId) } }).select('sourceStateId').lean();
    const sourceStates = [...new Set(tasks.map((task: any) => String(task.sourceStateId)))];
    if (sourceStates.length !== 1) throw new HttpError(409, 'Packages must belong to one source State', undefined, 'STATE_SCOPE_DENIED');
    const sourceStateId = sourceStates[0];
    await assertStaffScope(actor, sourceStateId, body.hubId);
    // Key the consolidation on the fulfilment GROUP, not the State. An order
    // split into several deliveries has more than one group per State, so a
    // state-keyed lookup would silently consolidate against the wrong one.
    // The packaged items are the source of truth for which group this is.
    const packageItems = new Set(packages.flatMap((item: any) => item.itemIds.map(String)));
    const packagedItems = await OrderItem.find({ _id: { $in: [...packageItems] } }).select('fulfilmentGroupId').lean() as any[];
    const groupIds = [...new Set(packagedItems.map((item) => item.fulfilmentGroupId).filter(Boolean).map(String))];
    if (groupIds.length > 1) throw new HttpError(409, 'Packages must belong to one delivery group', undefined, 'SCOPE_DENIED');
    const group = groupIds.length
      ? await OrderFulfilmentGroup.findOne({ orderId: order._id.toString(), publicId: groupIds[0] }).lean()
      : await OrderFulfilmentGroup.findOne({ orderId: order._id.toString(), sourceStateId }).lean();
    // A RESOLVED item (a replacement the customer approved) still ships as its new product and still
    // needs its own Hub QC pass — applyResolvedSubstitution sets it back to fulfilmentStatus SOURCING
    // for exactly that reason, so excluding it here would let consolidation skip its QC entirely.
    const items = await OrderItem.find({ orderId: order._id.toString(), ...(group ? { fulfilmentGroupId: group.publicId } : { stateId: sourceStateId }) }).lean({ virtuals: true }) as any[];
    if (!items.length || items.some((item) => !packageItems.has(item._id.toString()))) throw new HttpError(409, 'Every active order item must pass Hub quality check before consolidation', undefined, 'ORDER_NOT_COMPLETE');
    const packageHubIds = [...new Set(packages.map((item: any) => String(item.hubId)))];
    if (packageHubIds.length !== 1 || (body.hubId && String(body.hubId) !== packageHubIds[0])) throw new HttpError(409, 'All packages must be at the same Dispatch Hub before consolidation', undefined, 'HUB_MISMATCH');
    await assertStaffScope(actor, sourceStateId, packageHubIds[0]);
    const existing = await Consolidation.findOne({ orderId: order._id.toString(), ...(group ? { fulfilmentGroupId: group.publicId } : { sourceStateId }) }).lean({ virtuals: true });
    if (existing) return existing;
    const consolidationId = await nextPublicId('consolidation');
    let consolidation: any;
    try {
      consolidation = await this.atomically(async (session) => {
        const [created] = await Consolidation.create([{ publicId: consolidationId, orderId: order._id.toString(), fulfilmentGroupId: group?.publicId, sourceStateId, hubId: packageHubIds[0], hubPackageIds: packages.map((item: any) => item._id.toString()), status: 'DRAFT', evidence: [], version: 1 }], { session });
        await HubPackage.updateMany({ _id: { $in: packages.map((item: any) => item._id) } }, { $set: { status: HubPackageStatus.CONSOLIDATED }, $push: { custodyHistory: { action: 'CONSOLIDATION_STARTED', actorId: actor.accountId, at: new Date() } } }, { session });
        await Order.updateOne({ _id: order._id }, { $set: { commerceStatus: CommerceOrderStatus.READY_FOR_CONSOLIDATION, customerProgress: [{ key: 'hub', label: 'Order received and checked', at: new Date() }] }, $push: { timeline: timelineEntry('READY_FOR_CONSOLIDATION', actor.accountId) } }, { session });
        return created;
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const concurrent = await Consolidation.findOne({ orderId: order._id.toString(), ...(group ? { fulfilmentGroupId: group.publicId } : { sourceStateId }) }).lean({ virtuals: true });
      if (concurrent) return concurrent;
      throw error;
    }
    await notifyStatus(order._id, 'READY_FOR_CONSOLIDATION');
    await this.publishOrderUpdate(order._id.toString(), sourceStateId, packageHubIds[0]);
    return consolidation.toJSON();
  }

  /**
   * The Hook receipt / parcel slip for an order. Built on demand from the
   * order and its sealed consolidation, so it never drifts from the data and
   * every order can produce one. Carries no prices except the amount to collect
   * on delivery, and the QR code holds references only, no personal data.
   */
  async orderReceipt(actor: Actor, orderIdentifier: string, query: Record<string, unknown>) {
    const order = await orderByIdentifier(orderIdentifier);
    await assertStaffScope(actor, order.sourceStateId);
    const consolidations = await Consolidation.find({ orderId: order._id.toString(), status: { $in: ['SEALED', 'HANDED_OVER'] } }).sort({ sealedAt: -1 }).lean({ virtuals: true }) as any[];
    const parcel = (query.consolidationId ? consolidations.find((c) => c.publicId === String(query.consolidationId)) : undefined) || consolidations[0];
    if (parcel) await assertStaffScope(actor, order.sourceStateId, parcel.hubId);
    const [items, hub, shipment] = await Promise.all([
      OrderItem.find({ orderId: order._id.toString(), ...(parcel?.fulfilmentGroupId ? { fulfilmentGroupId: parcel.fulfilmentGroupId } : {}) }).select('publicId productTitle quantity selectedVariants variantSnapshot').lean({ virtuals: true }),
      parcel?.hubId ? DispatchHub.findOne(identifier(parcel.hubId)).select('publicId name address').lean() : null,
      Shipment.findOne({ orderId: order._id.toString() }).select('publicId status version courierCode courierName trackingNumber trackingEvents').lean(),
    ]) as any[];
    const address = (order.addressSnapshot || {}) as Record<string, any>;
    const legacy = (order.deliveryAddress || {}) as Record<string, any>;
    const chosen = (order.logisticsProviderSnapshot || {}) as { code?: string; name?: string };
    const receiptNumber = `RCT-${String(order.publicId).replace(/^ORD-/, '')}`;
    const collectMinor = order.commercePaymentMethod === 'PAY_AT_HANDOVER' ? Number(order.totalMinor || 0) : 0;
    return {
      receiptNumber,
      generatedAt: new Date().toISOString(),
      status: parcel ? 'SEALED' : 'PENDING_SEAL',
      order: { publicId: order.publicId, placedAt: order.createdAt },
      recipient: {
        name: address.recipientName || legacy.name,
        phone: address.phone || legacy.phone,
        line1: address.line1 || legacy.street,
        line2: address.line2,
        landmark: address.landmark || legacy.landmark,
        city: address.cityName || legacy.city,
        state: address.stateName || legacy.state,
        postalCode: address.postalCode,
      },
      hub: hub ? { name: hub.name, address: hub.address } : undefined,
      parcel: parcel ? {
        reference: parcel.publicId,
        sealReference: parcel.sealReference,
        weightGrams: parcel.weightGrams,
        dimensions: parcel.dimensions,
        sealedAt: parcel.sealedAt,
        parcels: consolidations.length,
      } : undefined,
      items: (items || []).map((item: any) => ({
        reference: item.publicId,
        title: item.productTitle,
        quantity: item.quantity,
        color: item.selectedVariants?.color || item.variantSnapshot?.color,
        size: item.selectedVariants?.size || item.variantSnapshot?.size,
        details: otherDetails(item),
      })),
      courier: { code: shipment?.courierCode || chosen.code, name: shipment?.courierName || chosen.name, trackingNumber: shipment?.trackingNumber },
      payment: { method: order.commercePaymentMethod, collectMinor },
      shipment: shipment ? { publicId: shipment.publicId, status: shipment.status, version: shipment.version, events: (shipment.trackingEvents || []).map((event: any) => ({ status: event.status, at: event.at, note: event.note })) } : undefined,
      trackingSig: this.trackingSignature(receiptNumber),
      parcelOptions: consolidations.map((c) => ({ reference: c.publicId, sealedAt: c.sealedAt })),
      printCount: (parcel?.receiptPrints || []).length,
      lastPrintedAt: (parcel?.receiptPrints || []).slice(-1)[0]?.at,
      qr: ['HOOK', receiptNumber, order.publicId, parcel?.publicId].filter(Boolean).join('|'),
    };
  }

  /** Log a print of the parcel label. Only a sealed parcel can be labelled. */
  async recordReceiptPrint(actor: Actor, orderIdentifier: string, body: Record<string, any>) {
    const order = await orderByIdentifier(orderIdentifier);
    await assertStaffScope(actor, order.sourceStateId);
    const parcel = await Consolidation.findOne({ orderId: order._id.toString(), status: { $in: ['SEALED', 'HANDED_OVER'] }, ...(body.consolidationId ? { publicId: String(body.consolidationId) } : {}) }).sort({ sealedAt: -1 }).lean() as any;
    if (!parcel) throw new HttpError(409, 'Seal the parcel before printing its receipt', undefined, 'INVALID_STATE_TRANSITION');
    await assertStaffScope(actor, order.sourceStateId, parcel.hubId);
    const updated = await Consolidation.findOneAndUpdate({ _id: parcel._id }, { $push: { receiptPrints: { by: actor.accountId, at: new Date(), size: body.size } } }, { returnDocument: 'after' }).lean() as any;
    const printCount = (updated?.receiptPrints || []).length;
    await audit('fulfilment.receipt.printed', 'consolidation', String(parcel._id), actor.accountId, { orderId: order.publicId, printCount, size: body.size }, undefined, order.sourceStateId, parcel.hubId);
    return { printCount, isReprint: printCount > 1 };
  }

  /** The customer's own copy: sealed orders only, no hub or internal references. */
  async customerReceipt(userId: string, orderIdentifier: string) {
    const order = await Order.findOne({ ...identifier(orderIdentifier), userId }).lean({ virtuals: true }) as any;
    if (!order) throw new HttpError(404, 'Order not found', undefined, 'NOT_FOUND');
    const parcel = await Consolidation.findOne({ orderId: order._id.toString(), status: { $in: ['SEALED', 'HANDED_OVER'] } }).sort({ sealedAt: -1 }).lean({ virtuals: true }) as any;
    if (!parcel) throw new HttpError(409, 'Your receipt is available once your order is packed', undefined, 'INVALID_STATE_TRANSITION');
    const [items, shipment] = await Promise.all([
      OrderItem.find({ orderId: order._id.toString() }).select('productTitle quantity selectedVariants variantSnapshot').lean(),
      Shipment.findOne({ orderId: order._id.toString() }).select('courierName trackingNumber').lean(),
    ]) as any[];
    const address = (order.addressSnapshot || {}) as Record<string, any>;
    return {
      receiptNumber: `RCT-${String(order.publicId).replace(/^ORD-/, '')}`,
      order: { publicId: order.publicId, placedAt: order.createdAt },
      packedAt: parcel.sealedAt,
      recipient: { name: address.recipientName, city: address.cityName, state: address.stateName },
      items: items.map((item: any) => ({ title: item.productTitle, quantity: item.quantity, color: item.selectedVariants?.color || item.variantSnapshot?.color, size: item.selectedVariants?.size || item.variantSnapshot?.size, details: otherDetails(item) })),
      courier: { name: shipment?.courierName || order.logisticsProviderSnapshot?.name, trackingNumber: shipment?.trackingNumber },
      payment: { method: order.commercePaymentMethod, collectMinor: order.commercePaymentMethod === 'PAY_AT_HANDOVER' ? Number(order.totalMinor || 0) : 0 },
    };
  }

  async sealConsolidation(actor: Actor, identifierValue: string, body: Record<string, any>) {
    const consolidation = await Consolidation.findOne(identifier(identifierValue)).lean({ virtuals: true }) as any;
    if (!consolidation) throw new HttpError(404, 'Consolidation not found', undefined, 'NOT_FOUND');
    await assertStaffScope(actor, consolidation.sourceStateId, consolidation.hubId);
    if (consolidation.status !== 'DRAFT') throw new HttpError(409, 'Consolidation is not open for sealing', undefined, 'INVALID_STATE_TRANSITION');
    const updated = await this.atomically(async (session) => {
      const sealed = await Consolidation.findOneAndUpdate({ _id: consolidation._id, status: 'DRAFT', version: body.version ?? consolidation.version }, { $set: { status: 'SEALED', weightGrams: body.weightGrams, dimensions: body.dimensions, sealReference: String(body.sealReference || `HK-${randomInt(100000, 999999)}`), sealedAt: new Date(), sealedBy: actor.accountId }, $inc: { version: 1 } }, { returnDocument: 'after', session }).lean({ virtuals: true });
      if (!sealed) return null;
      await Order.updateOne({ _id: consolidation.orderId }, { $set: { commerceStatus: CommerceOrderStatus.READY_FOR_DISPATCH, customerProgress: [{ key: 'consolidated', label: 'Order packed for dispatch', at: new Date() }] }, $push: { timeline: timelineEntry('READY_FOR_DISPATCH', actor.accountId) } }, { session });
      return sealed;
    });
    if (!updated) throw new HttpError(409, 'Consolidation changed. Refresh and try again.', undefined, 'STALE_VERSION');
    await notifyStatus(consolidation.orderId, 'READY_FOR_DISPATCH');
    await this.publishOrderUpdate(consolidation.orderId, consolidation.sourceStateId, consolidation.hubId);
    return updated;
  }

  async createManualShipment(actor: Actor, orderIdentifier: string, body: Record<string, any>) {
    const order = await orderByIdentifier(orderIdentifier); await assertStaffScope(actor, order.sourceStateId, body.hubId);
    const provider = String(body.provider || 'manual') as LogisticsProviderKey;
    if (provider === 'simulated' && !isLogisticsSimulationEnabled()) throw new HttpError(503, 'Logistics simulation is available only in a non-production environment when explicitly enabled', undefined, 'PROVIDER_NOT_READY');
    if (provider === 'fez' && !isFezLogisticsEnabled()) throw new HttpError(409, 'Fez is disabled until provider credentials are verified', undefined, 'PROVIDER_NOT_READY');
    if (!['manual', 'other', 'simulated', 'fez'].includes(provider)) throw new HttpError(409, 'GIG is disabled until provider credentials and contracts are verified', undefined, 'PROVIDER_NOT_READY');

    // The courier the customer chose and paid for at checkout. Booking used to
    // ignore this entirely — staff picked from a dropdown defaulting to
    // "manual" — so a customer who paid GIG's fee could silently be shipped by
    // someone else, and was never told.
    const chosen = (order.logisticsProviderSnapshot || {}) as { code?: string; name?: string };
    const requestedCode = body.courierCode ? String(body.courierCode).toUpperCase() : undefined;
    const substituting = Boolean(requestedCode && chosen.code && requestedCode !== String(chosen.code).toUpperCase());
    if (substituting && !String(body.substitutionReason || '').trim()) {
      throw new HttpError(400, 'A reason is required when booking a different courier to the one the customer chose', undefined, 'VALIDATION_ERROR');
    }
    // Resolve through the provider service. An unavailable courier is never
    // silently accepted: staff must pick an active substitute and say why.
    const wantedCode = requestedCode || (chosen.code ? String(chosen.code).toUpperCase() : undefined);
    let courier: any;
    if (wantedCode) {
      courier = await this.logisticsProviders.getSelectable(wantedCode).catch(() => undefined);
      if (!courier) {
        const alternatives = await this.logisticsProviders.listActive();
        throw new HttpError(409, `${chosen.name || wantedCode} is unavailable. Choose another courier and give the customer a reason.`, { alternatives: alternatives.map((item: any) => ({ code: item.code, name: item.name, feeMinor: item.feeMinor })) }, 'LOGISTICS_PROVIDER_UNAVAILABLE');
      }
    }
    const courierCode = courier?.code || wantedCode;
    const courierName = courier?.name || chosen.name;

    const consolidation = await Consolidation.findOne({ orderId: order._id.toString(), hubId: body.hubId, status: 'SEALED' }).lean({ virtuals: true }) as any;
    if (!consolidation) throw new HttpError(409, 'Seal the complete consolidation before booking shipment', undefined, 'ORDER_NOT_COMPLETE');
    await assertStaffScope(actor, order.sourceStateId, consolidation.hubId);
    if (body.hubId && String(body.hubId) !== String(consolidation.hubId)) throw new HttpError(409, 'Shipment Hub must match the sealed consolidation', undefined, 'HUB_MISMATCH');
    const existing = await Shipment.findOne({ orderId: order._id.toString(), sourceStateId: consolidation.sourceStateId }).lean({ virtuals: true });
    if (existing) {
      if (body.idempotencyKey && existing.bookingIdempotencyKey && body.idempotencyKey !== existing.bookingIdempotencyKey) throw new HttpError(409, 'This Order already has a shipment booking', undefined, 'IDEMPOTENCY_CONFLICT');
      return existing;
    }
    const simulationBooking = provider === 'simulated'
      ? await logisticsProvider('simulated').book({ orderId: order.publicId, providerCostMinor: body.providerCostMinor, providerQuoteMinor: body.providerQuoteMinor })
      : undefined;
    const deliveryAddressSnapshot = order.addressSnapshot || order.deliveryAddress;
    let fezBooking: Record<string, unknown> | undefined;
    let fezQuoteMinor: number | undefined;
    if (provider === 'fez') {
      const hubDoc = await DispatchHub.findOne(identifier(consolidation.hubId)).select('name address contact stateId').lean() as any;
      const hubState = hubDoc?.stateId ? await OperationState.findOne(identifier(hubDoc.stateId)).select('name').lean() as any : null;
      const hub = hubDoc ? { name: hubDoc.name, address: hubDoc.address, phone: hubDoc.contact?.phone, stateName: hubState?.name } : undefined;
      // Fez requires a sender phone for a third-party pickup — surface a clear, actionable
      // error here rather than letting Fez's raw "Senders phone is required" reach staff with
      // no indication of which Hub or where to fix it.
      if (hub?.address && !hub.phone) {
        throw new HttpError(409, `${hub.name || 'This Hub'} has no contact phone number set. Add one under Hubs before booking with Fez.`, undefined, 'VALIDATION_ERROR');
      }
      const bookingInput = { orderId: order.publicId, bookingIdempotencyKey: body.idempotencyKey, deliveryAddressSnapshot, totalMinor: order.totalMinor, weightGrams: consolidation.weightGrams, hub };
      const fez = logisticsProvider('fez');
      fezQuoteMinor = await fez.quote(bookingInput).then((quote) => Number(quote.quoteMinor)).catch(() => undefined);
      fezBooking = await fez.book(bookingInput);
    }
    const shipmentId = await nextPublicId('shipment');
    let shipment: any;
    try {
      shipment = await this.atomically(async (session) => {
        const [created] = await Shipment.create([{ publicId: shipmentId, orderId: order._id.toString(), fulfilmentGroupId: consolidation.fulfilmentGroupId, sourceStateId: consolidation.sourceStateId, hubId: consolidation.hubId, consolidationId: consolidation._id.toString(), provider, courierCode, courierName, substitutedFrom: substituting ? String(chosen.code) : undefined, substitutionReason: substituting ? String(body.substitutionReason).trim() : undefined, serviceName: body.serviceName || (provider === 'simulated' ? 'Hook Logistics Simulator' : provider === 'fez' ? 'Fez Delivery' : undefined), externalReference: body.externalReference || simulationBooking?.externalReference || fezBooking?.externalReference, status: ShipmentStatus.BOOKED_WITH_PROVIDER, deliveryAddressSnapshot, estimatedDeliveryAt: body.estimatedDeliveryAt ? new Date(body.estimatedDeliveryAt) : simulationBooking?.estimatedDeliveryAt ? new Date(String(simulationBooking.estimatedDeliveryAt)) : undefined, bookedAt: new Date(), providerCostMinor: body.providerCostMinor ?? fezQuoteMinor, providerQuoteMinor: body.providerQuoteMinor ?? fezQuoteMinor, trackingNumber: body.trackingNumber || simulationBooking?.trackingNumber || (fezBooking?.trackingNumber as string | undefined), trackingEvents: [{ status: 'BOOKED_WITH_PROVIDER', at: new Date(), actorId: actor.accountId, mode: provider === 'simulated' ? 'simulation' : undefined }], evidence: evidence(body.evidence), releaseStatus: order.commercePaymentMethod === 'PAY_AT_HANDOVER' ? 'AWAITING_HANDOVER_PAYMENT' : 'NOT_REQUIRED', bookingIdempotencyKey: body.idempotencyKey, version: 1 }], { session });
        await Order.updateOne({ _id: order._id }, { $set: { commerceStatus: CommerceOrderStatus.READY_FOR_DISPATCH, customerProgress: [{ key: 'shipment', label: 'Shipment booked and awaiting pickup', at: new Date() }] }, $push: { timeline: timelineEntry('BOOKED_WITH_PROVIDER', actor.accountId) } }, { session });
        return created;
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const concurrent = await Shipment.findOne({ orderId: order._id.toString(), sourceStateId: consolidation.sourceStateId }).lean({ virtuals: true });
      if (concurrent) return concurrent;
      throw error;
    }
    await notifyStatus(order._id, 'BOOKED_WITH_PROVIDER');
    await this.publishOrderUpdate(order._id.toString(), order.sourceStateId, consolidation.hubId);
    return shipment.toJSON();
  }

  async updateShipment(actor: Actor, identifierValue: string, body: Record<string, any>) {
    const shipment = await Shipment.findOne(identifier(identifierValue)).lean({ virtuals: true }) as any;
    if (!shipment) throw new HttpError(404, 'Shipment not found', undefined, 'NOT_FOUND'); await assertStaffScope(actor, shipment.sourceStateId, shipment.hubId);
    const order = await Order.findById(shipment.orderId).select('commercePaymentMethod publicId version userId sourceStateId totalMinor').lean() as any;
    const next = String(body.status) as ShipmentStatus;
    if (!Object.values(ShipmentStatus).includes(next)) throw new HttpError(400, 'Invalid shipment status', undefined, 'VALIDATION_ERROR');
    const allowed: Record<string, string[]> = { BOOKED_WITH_PROVIDER: ['AWAITING_PICKUP', 'CANCELLED'], AWAITING_PICKUP: ['PICKED_UP', 'CANCELLED'], PICKED_UP: ['IN_TRANSIT', 'DELIVERY_FAILED'], IN_TRANSIT: ['OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'RETURN_IN_TRANSIT'], OUT_FOR_DELIVERY: ['DELIVERED', 'DELIVERY_FAILED', 'AWAITING_HANDOVER_PAYMENT'], AWAITING_HANDOVER_PAYMENT: ['RELEASE_APPROVED'], RELEASE_APPROVED: ['DELIVERED'], DELIVERY_FAILED: ['RETURN_IN_TRANSIT'], RETURN_IN_TRANSIT: ['RETURNED_TO_HOOK'] };
    if (shipment.status !== next && !allowed[shipment.status]?.includes(next)) throw new HttpError(409, 'Invalid shipment status transition', { current: shipment.status, next }, 'INVALID_STATE_TRANSITION');
    if (next === ShipmentStatus.AWAITING_HANDOVER_PAYMENT && order?.commercePaymentMethod !== 'PAY_AT_HANDOVER') throw new HttpError(409, 'Only Pay-at-Handover shipments can require handover payment', undefined, 'PAYMENT_METHOD_NOT_ALLOWED');
    if (next === ShipmentStatus.RELEASE_APPROVED && order?.commercePaymentMethod !== 'PAY_AT_HANDOVER') throw new HttpError(409, 'Only Pay-at-Handover shipments can be released through handover payment', undefined, 'PAYMENT_METHOD_NOT_ALLOWED');
    if (next === ShipmentStatus.DELIVERED && shipment.releaseStatus === 'AWAITING_HANDOVER_PAYMENT') throw new HttpError(409, 'Verified Pay-at-Handover payment is required before release', undefined, 'PAYMENT_REQUIRED');
    let orderStatus: CommerceOrderStatus | undefined;
    const updated = await this.atomically(async (session) => {
      const moved = await Shipment.findOneAndUpdate({ _id: shipment._id, version: body.version ?? shipment.version }, { $set: { status: next, releaseStatus: next === ShipmentStatus.RELEASE_APPROVED ? 'RELEASE_APPROVED' : shipment.releaseStatus, pickedUpAt: next === ShipmentStatus.PICKED_UP ? new Date() : shipment.pickedUpAt, deliveredAt: next === ShipmentStatus.DELIVERED ? new Date() : shipment.deliveredAt, failedAt: next === ShipmentStatus.DELIVERY_FAILED ? new Date() : shipment.failedAt }, $push: { trackingEvents: { status: next, at: new Date(), actorId: actor.accountId, note: body.note } }, $inc: { version: 1 } }, { returnDocument: 'after', session }).lean({ virtuals: true });
      if (!moved) return null;
      if (next === ShipmentStatus.DELIVERY_FAILED) await recordPodRefusal(String(shipment.orderId), session);
      if (shipment.fulfilmentGroupId) {
        const groupStatus = next === ShipmentStatus.DELIVERED ? 'DELIVERED'
          : [ShipmentStatus.PICKED_UP, ShipmentStatus.IN_TRANSIT, ShipmentStatus.OUT_FOR_DELIVERY].includes(next) ? 'IN_TRANSIT'
            : next === ShipmentStatus.RETURN_IN_TRANSIT ? 'ON_HOLD' : undefined;
        if (groupStatus) await OrderFulfilmentGroup.updateOne({ publicId: shipment.fulfilmentGroupId }, { $set: { status: groupStatus, shipmentId: shipment.publicId } }, { session });
      }
      // Read inside the transaction so concurrent deliveries of two shipments
      // of one order each see the other's committed state, not a stale count.
      const allShipments = await Shipment.find({ orderId: shipment.orderId }).select('status').session(session).lean();
      const deliveredCount = allShipments.filter((entry) => entry.status === ShipmentStatus.DELIVERED).length;
      const movingCount = allShipments.filter((entry) => [ShipmentStatus.PICKED_UP, ShipmentStatus.IN_TRANSIT, ShipmentStatus.OUT_FOR_DELIVERY].includes(entry.status)).length;
      orderStatus = next === ShipmentStatus.RETURN_IN_TRANSIT ? CommerceOrderStatus.RETURN_IN_PROGRESS
        : deliveredCount === allShipments.length ? CommerceOrderStatus.DELIVERED
          : deliveredCount > 0 ? CommerceOrderStatus.PARTIALLY_DELIVERED
            : movingCount > 0 && allShipments.length > 1 ? CommerceOrderStatus.PARTIALLY_IN_TRANSIT
              : movingCount > 0 ? CommerceOrderStatus.IN_TRANSIT : undefined;
      if (orderStatus) await Order.updateOne({ _id: shipment.orderId }, { $set: { commerceStatus: orderStatus, ...(orderStatus === CommerceOrderStatus.DELIVERED ? { deliveredAt: new Date() } : {}) }, $push: { timeline: timelineEntry(next, actor.accountId) } }, { session });
      return moved;
    });
    if (!updated) throw new HttpError(409, 'Shipment changed. Refresh and try again.', undefined, 'STALE_VERSION');
    // DELIVERY_FAILED has no CommerceOrderStatus of its own, so orderStatus stays
    // undefined for it — notify anyway, this is the gap where nobody heard about a failed attempt.
    if (orderStatus || next === ShipmentStatus.DELIVERY_FAILED) await notifyStatus(shipment.orderId, next);
    if (next === ShipmentStatus.DELIVERY_FAILED) {
      await notifyStaffByPermission({
        permission: 'fulfilment.manage', stateId: shipment.sourceStateId, hubId: shipment.hubId,
        eventKeyPrefix: `shipment:${shipment.publicId}:delivery-failed:${updated.version}`,
        title: 'Delivery attempt failed', body: `${order?.publicId || shipment.publicId} needs a redelivery or return decision.`,
        type: 'order_delayed', data: { orderId: order?.publicId, shipmentId: shipment.publicId, href: order?.publicId ? `/dashboard/orders/${order.publicId}` : undefined },
      });
    }
    await this.publishOrderUpdate(shipment.orderId, shipment.sourceStateId, shipment.hubId);
    if (orderStatus === CommerceOrderStatus.DELIVERED && order?.userId) {
      await createCommerceNotification({
        eventKey: `order:${order.publicId}:delivered`,
        userId: order.userId,
        title: "Order delivered",
        body: "Your Hook Order has been delivered. Thanks for shopping with Hook.",
        type: "order_delivered",
        data: { orderId: order.publicId },
      }).catch(() => undefined);
      const customer = await User.findById(order.userId).select('email firstName').lean() as any;
      if (customer?.email) {
        await this.email.sendOrderStatusUpdate({
          to: customer.email,
          name: customer.firstName,
          orderCode: order.publicId,
          status: 'Delivered',
          amount: Number(order.totalMinor || 0) / 100,
        }).catch(() => undefined);
      }
    }
    return updated;
  }

  async partnerCustody(actor: Actor, orderIdentifier: string) {
    const partner = await HookPartner.findOne({ accountId: actor.accountId, status: 'active' }).lean({ virtuals: true }) as any; if (!partner) throw new HttpError(403, 'Active Hook Partner required', undefined, 'ACCESS_DENIED');
    const order = await Order.findOne({ ...identifier(orderIdentifier), initiatingPartnerId: { $in: partnerIds(partner) } }).lean({ virtuals: true }) as any; if (!order) throw new HttpError(404, 'Order not found', undefined, 'NOT_FOUND');
    if (order.deliveryMethod !== 'PARTNER_PICKUP') throw new HttpError(409, 'Partner custody is only available for Partner pickup Orders', undefined, 'DELIVERY_METHOD_NOT_ALLOWED');
    const shipment = await Shipment.findOne({ orderId: order._id.toString() }).lean({ virtuals: true }) as any; if (!shipment) throw new HttpError(409, 'Shipment is not ready for Partner custody', undefined, 'INVALID_STATE_TRANSITION');
    const existing = await PartnerCustody.findOne({ orderId: order._id.toString() }).lean({ virtuals: true }) as any; if (existing) return safeCustody(existing);
    const created = await this.createCustody(order, shipment, partner, actor.accountId);
    // The collection code goes to the customer, never back to the partner: the partner has to be given it at the counter.
    return created;
  }

  /**
   * Opens the custody record for a Partner pickup parcel and sends the 6-digit collection code to the CUSTOMER.
   * Runs when a Partner pickup order is dispatched (see syncPartnerCustody), so the Partner sees the incoming parcel
   * without having to ask for it.
   */
  private async createCustody(order: any, shipment: any, partner: any, actorAccountId: string) {
    const code = String(randomInt(100000, 999999));
    const custody = await PartnerCustody.create({ publicId: await nextPublicId('partnerCustody'), orderId: order._id.toString(), shipmentId: shipment._id.toString(), partnerId: partner.publicId, status: 'AWAITING_RECEIPT', collectionCodeHash: digest(code), collectionCodeHint: hint(code), codeAttempts: 0, codeSentAt: new Date(), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), customerEmailSnapshot: String((order.customerSnapshot as any)?.email || order.guestEmail || ''), idempotencyKey: `custody:${order._id}`, history: [{ action: 'CODE_CREATED', actorId: actorAccountId, at: new Date() }] });
    if (order.userId) {
      await createCommerceNotification({
        eventKey: `order:${order.publicId}:collection-code`,
        userId: String(order.userId),
        title: 'Your collection code',
        body: `Show code ${code} to ${partner.businessName || 'the partner'} when you collect your order. Do not share it with anyone else.`,
        type: 'order_updated',
        data: { orderId: order.publicId },
      }).catch(() => undefined);
    }
    return safeCustody(custody.toJSON()) as any;
  }

  /** Creates custody records for Partner pickup parcels that are on their way, so the Partner's list is never empty by accident. */
  async syncPartnerCustody() {
    const orders = await Order.find({ deliveryMethod: 'PARTNER_PICKUP', initiatingPartnerId: { $exists: true, $ne: null }, commerceStatus: { $in: ['READY_FOR_DISPATCH', 'IN_TRANSIT', 'PARTIALLY_IN_TRANSIT'] } }).select('_id publicId userId initiatingPartnerId customerSnapshot guestEmail').limit(100).lean() as any[];
    let created = 0;
    for (const order of orders) {
      if (await PartnerCustody.exists({ orderId: order._id.toString() })) continue;
      const [partner, shipment] = await Promise.all([
        HookPartner.findOne({ ...partnerIdentity(String(order.initiatingPartnerId)), status: 'active' }).lean({ virtuals: true }) as Promise<any>,
        Shipment.findOne({ orderId: order._id.toString() }).lean({ virtuals: true }) as Promise<any>,
      ]);
      if (!partner || !shipment) continue;
      await this.createCustody(order, shipment, partner, 'SYSTEM').catch(() => undefined);
      created += 1;
    }
    return { created };
  }

  async partnerCustodyList(actor: Actor, query: Record<string, unknown>) {
    const partner = await HookPartner.findOne({ accountId: actor.accountId, status: 'active' }).lean({ virtuals: true }) as any;
    if (!partner) throw new HttpError(403, 'Active Hook Partner required', undefined, 'ACCESS_DENIED');
    const filter: Record<string, unknown> = { partnerId: partner.publicId };
    if (typeof query.status === 'string' && query.status) filter.status = query.status;
    return PartnerCustody.find(filter)
      .select('-collectionCodeHash -history')
      .sort({ expiresAt: 1, createdAt: -1 })
      .limit(Math.min(Number(query.limit || 100), 200))
      .lean({ virtuals: true });
  }

  async receiveCustody(actor: Actor, identifierValue: string, idempotencyKey?: string) { return this.mutateCustody(actor, identifierValue, 'receive', undefined, idempotencyKey); }
  async releaseCustody(actor: Actor, identifierValue: string, code: string, idempotencyKey?: string) { return this.mutateCustody(actor, identifierValue, 'release', code, idempotencyKey); }

  private async mutateCustody(actor: Actor, identifierValue: string, action: 'receive' | 'release', code?: string, idempotencyKey?: string) {
    const partner = await HookPartner.findOne({ accountId: actor.accountId, status: 'active' }).lean({ virtuals: true }) as any; if (!partner) throw new HttpError(403, 'Active Hook Partner required', undefined, 'ACCESS_DENIED');
    const custody = await PartnerCustody.findOne({ ...identifier(identifierValue), partnerId: partner.publicId }).select('+collectionCodeHash').lean({ virtuals: true }) as any; if (!custody) throw new HttpError(404, 'Partner custody record not found', undefined, 'NOT_FOUND');
    if (idempotencyKey) {
      const replay = custody.history?.find((item: any) => item.idempotencyKey === idempotencyKey && item.action === (action === 'receive' ? 'RECEIVED' : 'RELEASED'));
      if (replay) return safeCustody(custody);
    }
    if (new Date(custody.expiresAt) < new Date() && custody.status !== 'RELEASED') { await PartnerCustody.updateOne({ _id: custody._id }, { $set: { status: 'OVERDUE' } }); throw new HttpError(409, 'Partner custody window has expired', undefined, 'CUSTODY_EXPIRED'); }
    if (action === 'receive') {
      if (custody.status !== 'AWAITING_RECEIPT') throw new HttpError(409, 'Package is not awaiting receipt', undefined, 'INVALID_STATE_TRANSITION');
      const received = await PartnerCustody.findOneAndUpdate({ _id: custody._id, status: 'AWAITING_RECEIPT' }, { $set: { status: 'IN_CUSTODY', receivedAt: new Date() }, $push: { history: { action: 'RECEIVED', actorId: actor.accountId, at: new Date(), ...(idempotencyKey ? { idempotencyKey } : {}) } } }, { returnDocument: 'after' }).lean({ virtuals: true });
      if (!received) throw new HttpError(409, 'Custody state changed. Refresh and try again.', undefined, 'STALE_VERSION');
      await this.publishOrderUpdate(custody.orderId);
      return safeCustody(received as any);
    }
    if (custody.status !== 'IN_CUSTODY') throw new HttpError(409, 'Package is not available for collection', undefined, 'INVALID_STATE_TRANSITION');
    // A cancelled or failed order must never hand over a parcel.
    const custodyOrder = await Order.findById(custody.orderId).select('commerceStatus').lean() as any;
    if (custodyOrder && ['CANCELLED', 'DELIVERY_FAILED', 'RETURNED', 'REFUNDED'].includes(String(custodyOrder.commerceStatus))) throw new HttpError(409, 'This order is no longer active, so it cannot be collected', undefined, 'INVALID_STATE_TRANSITION');
    // Wrong guesses lock collection for 15 minutes, then the counter starts over.
    const LOCK_MS = 15 * 60_000;
    const lastAttemptAt = custody.lastCodeAttemptAt ? new Date(custody.lastCodeAttemptAt).getTime() : 0;
    let attempts = Number(custody.codeAttempts || 0);
    if (attempts >= 5 && Date.now() - lastAttemptAt > LOCK_MS) { attempts = 0; await PartnerCustody.updateOne({ _id: custody._id }, { $set: { codeAttempts: 0 } }); }
    if (attempts >= 5) throw new HttpError(429, 'Too many wrong codes. Try again in about 15 minutes, or ask the customer to check their code.', undefined, 'RATE_LIMITED');
    const entered = String(code ?? '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(entered) || digest(entered) !== custody.collectionCodeHash) {
      await PartnerCustody.updateOne({ _id: custody._id }, { $inc: { codeAttempts: 1 }, $set: { lastCodeAttemptAt: new Date() } });
      throw new HttpError(400, attempts >= 4 ? 'Invalid collection code. Collection is now locked for 15 minutes.' : `Invalid collection code. ${4 - attempts} attempt${4 - attempts === 1 ? '' : 's'} left.`, undefined, 'VALIDATION_ERROR');
    }
    // Every live payment on the order must be confirmed, not just the first one found.
    // A replacement-item top-up is excluded: that gates the item's own resolution, not custody release for the rest of the order.
    const payments = await Payment.find({ orderId: custody.orderId, itemResolutionId: { $exists: false } }).select('commerceStatus').lean() as any[];
    const live = payments.filter((item) => !['CANCELLED', 'EXPIRED', 'FAILED'].includes(String(item.commerceStatus)));
    if (!live.length || live.some((item) => item.commerceStatus !== CommercePaymentStatus.CONFIRMED)) throw new HttpError(409, 'Confirmed payment is required before collection', undefined, 'PAYMENT_REQUIRED');
    const result = await PartnerCustody.findOneAndUpdate({ _id: custody._id, status: 'IN_CUSTODY' }, { $set: { status: 'RELEASED', releasedAt: new Date() }, $push: { history: { action: 'RELEASED', actorId: actor.accountId, at: new Date(), ...(idempotencyKey ? { idempotencyKey } : {}) } } }, { returnDocument: 'after' }).lean({ virtuals: true });
    if (!result) throw new HttpError(409, 'Custody state changed. Refresh and try again.', undefined, 'STALE_VERSION');
    await Order.updateOne({ _id: custody.orderId }, { $set: { commerceStatus: CommerceOrderStatus.COLLECTED, fulfilmentCompletedAt: new Date() }, $push: { timeline: timelineEntry('COLLECTED', actor.accountId) } });
    await notifyStatus(custody.orderId, 'COLLECTED');
    await this.publishOrderUpdate(custody.orderId);
    return safeCustody(result as any);
  }

  async createReturn(actor: Actor, orderIdentifier: string, body: Record<string, any>) {
    const order = await orderByIdentifier(orderIdentifier); if (order.userId !== actor.accountId) throw new HttpError(404, 'Order not found', undefined, 'NOT_FOUND');
    const completedStatuses = [CommerceOrderStatus.DELIVERED, CommerceOrderStatus.COLLECTED, CommerceOrderStatus.COMPLETED];
    const completedAt = order.deliveredAt || order.fulfilmentCompletedAt;
    if (!completedStatuses.includes(order.commerceStatus) || !completedAt || Date.now() - new Date(completedAt).getTime() > 24 * 60 * 60 * 1000) throw new HttpError(409, 'Return requests must be reported within 24 hours of delivery or collection', undefined, 'RETURN_WINDOW_CLOSED');
    const itemIds = Array.isArray(body.orderItemIds) ? body.orderItemIds : [];
    const items = await OrderItem.find({ orderId: order._id.toString(), _id: { $in: itemIds } }).lean() as any[];
    if (!items.length || items.some((item) => ['REFUNDED', 'CANCELLED'].includes(String(item.fulfilmentStatus || '').toUpperCase()))) throw new HttpError(400, 'Select at least one eligible delivered item', undefined, 'VALIDATION_ERROR');
    const record = await ReturnRequest.create({ publicId: await nextPublicId('returnRequest'), orderId: order._id.toString(), orderItemIds: items.map((item: any) => item._id.toString()), requestedBy: actor.accountId, reasonType: body.reasonType, reason: body.reason, evidenceAssetIds: body.evidenceAssetIds || [], status: 'REQUESTED', reportedAt: new Date() });
    await Order.updateOne({ _id: order._id }, { $set: { commerceStatus: CommerceOrderStatus.RETURN_IN_PROGRESS }, $push: { timeline: timelineEntry('RETURN_REQUESTED', actor.accountId) } });
    await notifyStatus(order._id, 'RETURN_IN_PROGRESS');
    await this.publishOrderUpdate(order._id.toString(), order.sourceStateId);
    await notifyStaffByPermission({
      permission: 'fulfilment.manage', stateId: order.sourceStateId,
      eventKeyPrefix: `return:${record.publicId}:requested`,
      title: 'New return request', body: `${order.publicId} — ${items.length} item${items.length === 1 ? '' : 's'} returned: ${String(body.reason || body.reasonType || '')}`.trim(),
      type: 'return_update', data: { orderId: order.publicId, returnRequestId: record.publicId, href: `/dashboard/orders/${order.publicId}` },
    });
    return record.toJSON();
  }

  async reviewReturn(actor: Actor, identifierValue: string, body: Record<string, any>) {
    const request = await ReturnRequest.findOne(identifier(identifierValue)).lean({ virtuals: true }) as any;
    if (!request) throw new HttpError(404, 'Return request not found', undefined, 'NOT_FOUND');
    const order = await Order.findById(request.orderId).select('sourceStateId userId publicId').lean() as any;
    if (!order) throw new HttpError(404, 'Return request not found', undefined, 'NOT_FOUND');
    await assertStaffScope(actor, order.sourceStateId);
    if (!['APPROVED', 'REJECTED'].includes(body.decision)) throw new HttpError(400, 'Return decision is required', undefined, 'VALIDATION_ERROR');
    const updated = await ReturnRequest.findOneAndUpdate({ _id: request._id, status: { $in: ['REQUESTED', 'UNDER_REVIEW'] } }, { $set: { status: body.decision, reviewedBy: actor.accountId, decisionNote: body.reason, handoverDueAt: body.decision === 'APPROVED' ? new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) : undefined } }, { returnDocument: 'after' }).lean({ virtuals: true }); if (!updated) throw new HttpError(409, 'Return request has already been decided', undefined, 'INVALID_STATE_TRANSITION');
    await this.publishOrderUpdate(request.orderId, order.sourceStateId);
    if (order.userId) void createCommerceNotification({
      eventKey: `return:${request.publicId}:${body.decision.toLowerCase()}`,
      userId: order.userId,
      title: body.decision === 'APPROVED' ? 'Your return was approved' : 'Your return was declined',
      body: body.decision === 'APPROVED' ? 'Hand your item to the courier or drop-off point named in your order.' : String(body.reason || 'Contact support if you have questions about this decision.'),
      type: 'return_update',
      data: { orderId: order.publicId },
    });
    return updated;
  }

  async createRefund(actor: Actor, body: Record<string, any>) {
    await assertStaffScope(actor); if (!body.orderId || !Number.isSafeInteger(body.amountMinor) || body.amountMinor < 1 || !body.idempotencyKey) throw new HttpError(400, 'Refund order, amount and idempotency key are required', undefined, 'VALIDATION_ERROR');
    const order = await orderByIdentifier(body.orderId);
    await assertStaffScope(actor, order.sourceStateId);
    const existing = await FulfilmentRefund.findOne({ idempotencyKey: body.idempotencyKey }).lean({ virtuals: true });
    if (existing) {
      if (String((existing as any).orderId) !== String(order._id)) throw new HttpError(409, 'This refund idempotency key belongs to another order', undefined, 'IDEMPOTENCY_CONFLICT');
      return existing;
    }
    if (body.returnRequestId) {
      const returnRequest = await ReturnRequest.findOne(identifier(String(body.returnRequestId))).select('orderId').lean() as any;
      if (!returnRequest || String(returnRequest.orderId) !== String(order._id)) throw new HttpError(400, 'Return request does not belong to this order', undefined, 'VALIDATION_ERROR');
    }
    const payment = await Payment.findOne({ orderId: order._id.toString(), itemResolutionId: { $exists: false } }).lean({ virtuals: true }) as any;
    if (!payment || payment.commerceStatus !== CommercePaymentStatus.CONFIRMED) {
      throw new HttpError(409, 'Only captured payments can be refunded', undefined, 'PAYMENT_NOT_CAPTURED');
    }
    const captured = Number(payment.amountMinor || 0);
    const refunded = Number(payment.refundedAmount || 0);
    if (body.amountMinor > captured - refunded) throw new HttpError(409, 'Refund exceeds the captured balance', undefined, 'REFUND_LIMIT_EXCEEDED');
    const result = await FulfilmentRefund.create({ publicId: await nextPublicId('refund'), orderId: order._id.toString(), paymentId: payment._id?.toString(), returnRequestId: body.returnRequestId, amountMinor: body.amountMinor, currency: order.currency || 'NGN', reason: body.reason, status: 'REQUESTED', idempotencyKey: body.idempotencyKey });
    await this.publishOrderUpdate(order._id.toString(), order.sourceStateId);
    return result.toJSON();
  }

  async processRefund(actor: Actor, identifierValue: string, body: Record<string, any>) {
    await assertStaffScope(actor);
    const refund = await FulfilmentRefund.findOne(identifier(identifierValue)).lean({ virtuals: true }) as any;
    if (!refund) throw new HttpError(404, 'Refund record not found', undefined, 'NOT_FOUND');
    const order = await Order.findById(refund.orderId).select('sourceStateId userId publicId').lean() as any;
    if (!order) throw new HttpError(404, 'Refund record not found', undefined, 'NOT_FOUND');
    await assertStaffScope(actor, order.sourceStateId);
    if (refund.status === 'REFUNDED') return refund;
    if (!['REQUESTED', 'APPROVED', 'FAILED', 'PROVIDER_UNKNOWN'].includes(refund.status)) {
      throw new HttpError(409, 'Refund is already being processed', undefined, 'INVALID_STATE_TRANSITION');
    }
    if (body.idempotencyKey && body.idempotencyKey !== refund.idempotencyKey) {
      throw new HttpError(409, 'Refund idempotency key does not match the request', undefined, 'IDEMPOTENCY_CONFLICT');
    }
    if (!refund.paymentId) throw new HttpError(409, 'Refund payment record is missing', undefined, 'PAYMENT_RECORD_MISSING');

    // An earlier attempt whose provider outcome was never confirmed. Never
    // call the provider again until we know whether it already refunded.
    if (refund.status === 'PROVIDER_UNKNOWN') {
      const found = await this.payments.reconcileRefund(refund.paymentId, refund.amountMinor, refund.idempotencyKey);
      if (found) return this.finalizeRefund(actor, refund, order, found.providerReference, body.reason);
      const quietForMs = Date.now() - new Date(refund.updatedAt || 0).getTime();
      if (quietForMs < 15 * 60_000) {
        throw new HttpError(409, 'The previous refund attempt is still being verified with the payment provider', undefined, 'PROVIDER_OUTCOME_UNKNOWN');
      }
      // Provider shows nothing after a quiet period: free the reserved amount
      // so the refund can be retried safely.
      await this.payments.releaseRefundReservation(refund.paymentId, refund.amountMinor);
      await FulfilmentRefund.updateOne({ _id: refund._id, status: 'PROVIDER_UNKNOWN' }, { $set: { status: 'FAILED', failureReason: 'Provider reported no refund after verification' } });
      throw new HttpError(409, 'No refund was found at the provider. You can retry the refund.', undefined, 'INVALID_STATE_TRANSITION');
    }

    // Claim atomically: two concurrent process calls cannot both reach the provider.
    const claimed = await FulfilmentRefund.findOneAndUpdate(
      { _id: refund._id, status: { $in: ['REQUESTED', 'APPROVED', 'FAILED'] } },
      { $set: { status: 'PROVIDER_PENDING', approvedBy: actor.accountId }, $unset: { failureReason: 1 } },
      { returnDocument: 'after' },
    ).lean();
    if (!claimed) throw new HttpError(409, 'Refund is already being processed', undefined, 'INVALID_STATE_TRANSITION');
    let providerResult: { providerReference?: string };
    try {
      providerResult = await this.payments.refund(refund.paymentId, refund.amountMinor, refund.idempotencyKey);
    } catch (error) {
      if ((error as { code?: string })?.code === 'PROVIDER_OUTCOME_UNKNOWN') {
        // The provider may have refunded. Park it for reconciliation; do not mark FAILED.
        await FulfilmentRefund.updateOne({ _id: refund._id, status: 'PROVIDER_PENDING' }, { $set: { status: 'PROVIDER_UNKNOWN', failureReason: 'Provider outcome unknown' } });
      } else {
        await FulfilmentRefund.updateOne({ _id: refund._id, status: 'PROVIDER_PENDING' }, { $set: { status: 'FAILED', failureReason: error instanceof Error ? error.message.slice(0, 500) : 'Provider refund failed' } });
      }
      throw error;
    }
    try {
      return await this.finalizeRefund(actor, refund, order, providerResult.providerReference, body.reason);
    } catch (error) {
      // The provider DID refund. Never mark FAILED (that would allow a second
      // refund); park it so reconciliation completes the bookkeeping.
      await FulfilmentRefund.updateOne({ _id: refund._id, status: 'PROVIDER_PENDING' }, { $set: { status: 'PROVIDER_UNKNOWN', failureReason: 'Refund sent; bookkeeping pending' } });
      throw error;
    }
  }

  /**
   * Resolves refunds parked as PROVIDER_UNKNOWN: if the provider shows the
   * refund, the bookkeeping is completed; otherwise it stays parked (a person
   * can retry it from Admin after the quiet period, see processRefund).
   */
  async reconcileUnknownRefunds(limit = 10) {
    const parked = await FulfilmentRefund.find({ status: 'PROVIDER_UNKNOWN' }).sort({ updatedAt: 1 }).limit(limit).lean({ virtuals: true }) as any[];
    let resolved = 0;
    for (const refund of parked) {
      try {
        if (!refund.paymentId) continue;
        const found = await this.payments.reconcileRefund(refund.paymentId, refund.amountMinor, refund.idempotencyKey);
        if (!found) {
          // Still unresolved after an hour parked: alert finance once (the eventKey is per
          // refund with no time component, so this can only ever fire a single time for it).
          if (Date.now() - new Date(refund.updatedAt || 0).getTime() > 60 * 60_000) {
            const order = await Order.findById(refund.orderId).select('sourceStateId publicId').lean() as any;
            await notifyStaffByPermission({
              permission: 'finance.refunds.view', stateId: order?.sourceStateId,
              eventKeyPrefix: `refund:${refund.publicId}:stuck-unknown`,
              title: 'Refund outcome still unknown', body: `${order?.publicId || refund.publicId}'s refund could not be confirmed with the provider — it may need a manual check.`,
              type: 'order_updated', data: { orderId: order?.publicId, refundId: refund.publicId, href: order?.publicId ? `/dashboard/orders/${order.publicId}` : undefined },
            });
          }
          continue;
        }
        const order = await Order.findById(refund.orderId).select('sourceStateId userId publicId').lean() as any;
        if (!order) continue;
        await this.finalizeRefund({ accountId: 'SYSTEM' } as Actor, refund, order, found.providerReference, 'Reconciled with provider');
        resolved += 1;
      } catch (error) {
        console.error('[refund-reconcile] failed for', refund.publicId, error instanceof Error ? error.message : error);
      }
    }
    return { checked: parked.length, resolved };
  }

  /**
   * Records a successful provider refund. The refund status, the order
   * timeline and the outbox event commit together; notification and email
   * are delivered from the outbox so a mail outage cannot undo or hide it.
   */
  private async finalizeRefund(actor: Actor, refund: any, order: any, providerReference: string | undefined, reason?: string) {
    const session = await mongoose.startSession();
    let updated: any;
    let fullyRefunded = false;
    try {
      await session.withTransaction(async () => {
        updated = await FulfilmentRefund.findOneAndUpdate(
          { _id: refund._id, status: { $in: ['PROVIDER_PENDING', 'PROVIDER_UNKNOWN'] } },
          { $set: { status: 'REFUNDED', providerReference, processedAt: new Date() }, $unset: { failureReason: 1 } },
          { returnDocument: 'after', session },
        ).lean({ virtuals: true });
        if (!updated) return;
        const paymentAfter = await Payment.findById(refund.paymentId).select('commerceStatus').session(session).lean() as any;
        fullyRefunded = paymentAfter?.commerceStatus === CommercePaymentStatus.REFUNDED;
        await Order.updateOne(
          { _id: refund.orderId },
          {
            ...(fullyRefunded ? { $set: { commerceStatus: CommerceOrderStatus.REFUNDED } } : {}),
            $push: { timeline: timelineEntry(fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED', actor.accountId) },
          },
          { session },
        );
        await emitOutbox([{
          aggregateType: 'refund',
          aggregateId: String(refund._id),
          eventType: 'REFUND_PROCESSED_EFFECTS',
          payload: { refundId: refund.publicId, orderId: String(refund.orderId), fullyRefunded },
        }], session);
      });
    } finally {
      await session.endSession();
    }
    // Lost the claim: another caller already finalized this refund.
    if (!updated) return FulfilmentRefund.findById(refund._id).lean({ virtuals: true });
    wakeOutbox();
    await this.publishOrderUpdate(refund.orderId, order.sourceStateId);
    await audit('fulfilment.refund.processed', 'refund', refund.publicId, actor.accountId, { providerReference, amountMinor: refund.amountMinor }, reason).catch(() => undefined);
    return updated;
  }

  /** Outbox consumer for REFUND_PROCESSED_EFFECTS. Keyed, so replays are harmless. */
  async deliverRefundEffects(event: { payload: Record<string, any> }) {
    const { refundId, orderId, fullyRefunded } = event.payload;
    const refund = await FulfilmentRefund.findOne({ publicId: refundId }).lean({ virtuals: true }) as any;
    const order = await Order.findById(orderId).select('userId publicId').lean() as any;
    if (!refund || !order) return;
    if (fullyRefunded) await notifyStatus(orderId, 'REFUNDED');
    if (!order.userId) return;
    await createCommerceNotification({
      eventKey: `order:${order.publicId}:refund:${refund.publicId}`,
      userId: order.userId,
      title: fullyRefunded ? "Refund processed" : "Partial refund processed",
      body: `A refund of ${(refund.amountMinor / 100).toLocaleString("en-NG", { style: "currency", currency: refund.currency || "NGN" })} has been processed to your original payment method.`,
      type: "refund_processed",
      data: { orderId: order.publicId, refundId: refund.publicId },
    });
    const customer = await User.findById(order.userId).select('email firstName').lean() as any;
    if (customer?.email) {
      await this.email.sendRefundIssued({
        to: customer.email,
        name: customer.firstName,
        orderCode: order.publicId,
        amountMinor: refund.amountMinor,
        currency: refund.currency || 'NGN',
        fullyRefunded,
      });
    }
  }

  async customerOrderProgress(customerId: string, orderIdentifier: string) {
    const order = await Order.findOne({ ...identifier(orderIdentifier), userId: customerId }).lean({ virtuals: true }) as any;
    if (!order) throw new HttpError(404, 'Order not found', undefined, 'NOT_FOUND');
    const [tasks, packages, shipments, custody, returns, refunds] = await Promise.all([
      FulfilmentTask.find({ orderId: order._id.toString() }).select('publicId status acceptedAt sourcingStartedAt productSecuredAt packedAt hubReceivedAt completedAt').lean({ virtuals: true }),
      HubPackage.find({ orderId: order._id.toString() }).select('publicId status receivedAt qcPassedAt').lean({ virtuals: true }),
      Shipment.find({ orderId: order._id.toString() }).select('publicId fulfilmentGroupId status provider trackingNumber estimatedDeliveryAt pickedUpAt deliveredAt trackingEvents').lean({ virtuals: true }),
      PartnerCustody.findOne({ orderId: order._id.toString() }).select('-collectionCodeHash -history').lean({ virtuals: true }),
      ReturnRequest.find({ orderId: order._id.toString() }).select('-reviewedBy -decisionNote').lean({ virtuals: true }),
      FulfilmentRefund.find({ orderId: order._id.toString() }).select('-idempotencyKey').lean({ virtuals: true }),
    ]);
    return {
      order: { id: order.publicId, status: order.commerceStatus || order.status },
      tasks: tasks.map((task: any) => ({ id: task.publicId, status: task.status, acceptedAt: task.acceptedAt, sourcingStartedAt: task.sourcingStartedAt, productSecuredAt: task.productSecuredAt, packedAt: task.packedAt, hubReceivedAt: task.hubReceivedAt, completedAt: task.completedAt })),
      packages: packages.map((pack: any) => ({ id: pack.publicId, status: pack.status, receivedAt: pack.receivedAt, qcPassedAt: pack.qcPassedAt })),
      shipments: shipments.map((shipment: any) => {
        const dispatched = ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(String(shipment.status));
        return { id: shipment.publicId, fulfilmentGroupId: shipment.fulfilmentGroupId, status: shipment.status, estimatedDeliveryAt: shipment.estimatedDeliveryAt, provider: dispatched ? shipment.provider : undefined, trackingNumber: dispatched ? shipment.trackingNumber : undefined, pickedUpAt: dispatched ? shipment.pickedUpAt : undefined, deliveredAt: shipment.deliveredAt, trackingEvents: dispatched ? shipment.trackingEvents : [] };
      }),
      custody: custody ? { status: custody.status, collectionCodeHint: custody.collectionCodeHint, expiresAt: custody.expiresAt, receivedAt: custody.receivedAt, releasedAt: custody.releasedAt } : undefined,
      returns: returns.map((item: any) => ({ id: item.publicId, status: item.status, reasonType: item.reasonType, requestedAt: item.requestedAt, createdAt: item.createdAt })),
      refunds: refunds.map((item: any) => ({ id: item.publicId, status: item.status, amountMinor: item.amountMinor, currency: item.currency, processedAt: item.processedAt })),
    };
  }

  async controlTower(actor: Actor, query: Record<string, unknown>) {
    await assertStaffScope(actor, query.stateId as string | undefined, query.hubId as string | undefined);
    const filter: Record<string, any> = { status: { $nin: [FulfilmentTaskStatus.COMPLETED, FulfilmentTaskStatus.CANCELLED] } };
    const shipmentFilter: Record<string, any> = {};
    if (query.stateId) { filter.sourceStateId = query.stateId; shipmentFilter.sourceStateId = query.stateId; }
    if (query.hubId) { filter.hubId = query.hubId; shipmentFilter.hubId = query.hubId; }
    if (actor.stateIds?.length) { filter.sourceStateId = { $in: actor.stateIds }; shipmentFilter.sourceStateId = { $in: actor.stateIds }; }
    if (actor.hubIds?.length) { filter.hubId = { $in: actor.hubIds }; shipmentFilter.hubId = { $in: actor.hubIds }; }
    const orderScope = actor.stateIds?.length
      ? (await Order.distinct('_id', { sourceStateId: { $in: actor.stateIds } })).map(String)
      : null;
    const returnFilter: Record<string, any> = { status: { $in: ['REQUESTED', 'UNDER_REVIEW', 'APPROVED'] } };
    if (orderScope) returnFilter.orderId = { $in: orderScope };
    const [tasks, shipments, returns] = await Promise.all([FulfilmentTask.find(filter).sort({ createdAt: 1 }).limit(200).lean({ virtuals: true }), Shipment.find(shipmentFilter).sort({ createdAt: -1 }).limit(100).lean({ virtuals: true }), ReturnRequest.find(returnFilter).sort({ createdAt: -1 }).limit(100).lean({ virtuals: true })]);
    const names = await resolveFulfilmentNames([...tasks, ...shipments, ...returns] as any[]);
    const withNames = (record: any) => ({
      ...record,
      market: names.market(record.marketId),
      hub: names.hub(record.hubId),
      marketAssociate: names.marketAssociate(record.marketAssociateId),
      order: names.order(record.orderId),
    });
    return {
      tasks: tasks.map(withNames),
      shipments: shipments.map(withNames),
      returns: returns.map(withNames),
      metrics: { openTasks: tasks.length, activeShipments: shipments.filter((item: any) => ![ShipmentStatus.DELIVERED, ShipmentStatus.CANCELLED, ShipmentStatus.RETURNED_TO_HOOK].includes(item.status)).length, openReturns: returns.length },
    };
  }

  async returns(actor: Actor, query: Record<string, unknown>) {
    await assertStaffScope(actor, query.stateId as string | undefined);
    const filter: Record<string, any> = query.status ? { status: query.status } : {};
    if (actor.stateIds?.length || query.stateId) {
      const states = (query.stateId ? [String(query.stateId)] : (actor.stateIds || []).map(String));
      filter.orderId = { $in: (await Order.distinct('_id', { sourceStateId: { $in: states } })).map(String) };
    }
    const records = await ReturnRequest.find(filter).sort({ createdAt: -1 }).limit(Math.min(Number(query.limit || 100), 200)).lean({ virtuals: true });
    const names = await resolveFulfilmentNames(records as any[]);
    return records.map((record: any) => ({ ...record, order: names.order(record.orderId) }));
  }

  async refunds(actor: Actor, query: Record<string, unknown>) {
    await assertStaffScope(actor, query.stateId as string | undefined);
    const filter: Record<string, any> = query.status ? { status: query.status } : {};
    if (actor.stateIds?.length || query.stateId) {
      const states = (query.stateId ? [String(query.stateId)] : (actor.stateIds || []).map(String));
      filter.orderId = { $in: (await Order.distinct('_id', { sourceStateId: { $in: states } })).map(String) };
    }
    const records = await FulfilmentRefund.find(filter).sort({ createdAt: -1 }).limit(Math.min(Number(query.limit || 100), 200)).lean({ virtuals: true });
    const names = await resolveFulfilmentNames(records as any[]);
    return records.map((record: any) => ({ ...record, order: names.order(record.orderId) }));
  }

  async shipments(actor: Actor, query: Record<string, unknown>) {
    await assertStaffScope(actor, query.stateId as string | undefined, query.hubId as string | undefined);
    const filter: Record<string, any> = query.status ? { status: query.status } : {};
    if (query.stateId) filter.sourceStateId = query.stateId;
    if (query.hubId) filter.hubId = query.hubId;
    if (actor.stateIds?.length) filter.sourceStateId = { $in: actor.stateIds };
    if (actor.hubIds?.length) filter.hubId = { $in: actor.hubIds };
    const records = await Shipment.find(filter).sort({ createdAt: -1 }).limit(Math.min(Number(query.limit || 100), 200)).lean({ virtuals: true });
    const names = await resolveFulfilmentNames(records as any[]);
    const availability = await this.courierAvailability();
    return records.map((record: any) => ({ ...record, hub: names.hub(record.hubId), order: names.order(record.orderId), courier: record.courierCode ? availability.describe(record.courierCode) : undefined, alternatives: availability.alternatives }));
  }

  /** Active couriers plus a per-code availability lookup for list payloads. */
  private async courierAvailability() {
    const all: any = await this.logisticsProviders.list().catch(() => []);
    const rows: any[] = Array.isArray(all) ? all : all?.items || [];
    const byCode = new Map(rows.map((row) => [String(row.code).toUpperCase(), row]));
    const alternatives = rows.filter((row) => row.status === 'active').map((row) => ({ code: row.code, name: row.name, feeMinor: row.feeMinor }));
    return {
      alternatives,
      describe: (code?: string) => {
        const row = code ? byCode.get(String(code).toUpperCase()) : undefined;
        const available = row?.status === 'active';
        return { available, unavailableReason: available ? undefined : row ? 'Courier is currently inactive' : 'Courier no longer exists', currentFeeMinor: row?.feeMinor };
      },
    };
  }

  /** Switch the courier on a booked shipment until it has been picked up. */
  async reassignShipmentCourier(actor: Actor, identifierValue: string, body: Record<string, any>) {
    const shipment = await Shipment.findOne(identifier(identifierValue)).lean({ virtuals: true }) as any;
    if (!shipment) throw new HttpError(404, 'Shipment not found', undefined, 'NOT_FOUND');
    await assertStaffScope(actor, shipment.sourceStateId, shipment.hubId);
    const editable = [ShipmentStatus.BOOKED_WITH_PROVIDER, ShipmentStatus.AWAITING_PICKUP];
    if (!editable.includes(shipment.status)) throw new HttpError(409, 'The courier can only be changed before pickup', { current: shipment.status }, 'INVALID_STATE_TRANSITION');
    const code = String(body.courierCode || '').toUpperCase();
    if (code === String(shipment.courierCode || '').toUpperCase()) return shipment;
    const courier = await this.logisticsProviders.getSelectable(code);
    const reason = String(body.reason).trim();
    const updated = await this.atomically(async (session) => {
      const moved = await Shipment.findOneAndUpdate(
        { _id: shipment._id, version: body.version ?? shipment.version, status: { $in: editable } },
        { $set: { courierCode: courier.code, courierName: courier.name, substitutedFrom: shipment.substitutedFrom || shipment.courierCode, substitutionReason: reason }, $push: { trackingEvents: { status: shipment.status, at: new Date(), actorId: actor.accountId, note: `Courier switched from ${shipment.courierName || shipment.courierCode} to ${courier.name}: ${reason}` } }, $inc: { version: 1 } },
        { returnDocument: 'after', session },
      ).lean({ virtuals: true });
      if (moved) await Order.updateOne({ _id: shipment.orderId }, { $push: { timeline: timelineEntry('COURIER_SWITCHED', actor.accountId) } }, { session });
      return moved;
    });
    if (!updated) throw new HttpError(409, 'Shipment changed. Refresh and try again.', undefined, 'STALE_VERSION');
    await this.publishOrderUpdate(shipment.orderId, shipment.sourceStateId, shipment.hubId);
    return updated;
  }

  /** Real stage counts for the control tower cards, scoped like the lists. */
  async overview(actor: Actor, query: Record<string, unknown>) {
    await assertStaffScope(actor, query.stateId as string | undefined, query.hubId as string | undefined);
    const scope: Record<string, any> = {};
    if (query.hubId) scope.hubId = query.hubId;
    if (actor.stateIds?.length) scope.sourceStateId = { $in: actor.stateIds };
    if (actor.hubIds?.length) scope.hubId = { $in: actor.hubIds };
    const hubOnly = scope.hubId ? { hubId: scope.hubId } : {};
    const active = { $nin: [FulfilmentTaskStatus.COMPLETED, FulfilmentTaskStatus.CANCELLED] };
    const [sourcing, blocked, inbound, awaitingQc, readyToConsolidate, consolidating, sealed, booked, inTransit, exceptions, bookedOrders, failed] = await Promise.all([
      FulfilmentTask.countDocuments({ ...scope, status: active }),
      FulfilmentTask.countDocuments({ ...scope, status: FulfilmentTaskStatus.BLOCKED }),
      RunnerPackage.countDocuments({ ...hubOnly, status: RunnerPackageStatus.READY_FOR_HUB }),
      HubPackage.countDocuments({ ...hubOnly, status: { $in: [HubPackageStatus.RECEIVED, HubPackageStatus.QC_PENDING] } }),
      HubPackage.countDocuments({ ...hubOnly, status: HubPackageStatus.QC_PASSED }),
      Consolidation.countDocuments({ ...scope, status: 'DRAFT' }),
      Consolidation.countDocuments({ ...scope, status: 'SEALED' }),
      Shipment.countDocuments({ ...scope, status: { $in: [ShipmentStatus.BOOKED_WITH_PROVIDER, ShipmentStatus.AWAITING_PICKUP] } }),
      Shipment.countDocuments({ ...scope, status: { $in: [ShipmentStatus.PICKED_UP, ShipmentStatus.IN_TRANSIT, ShipmentStatus.OUT_FOR_DELIVERY] } }),
      Shipment.countDocuments({ ...scope, status: { $in: [ShipmentStatus.DELIVERY_FAILED, ShipmentStatus.RETURN_IN_TRANSIT] } }),
      Shipment.distinct('orderId', scope),
      HubPackage.countDocuments({ ...hubOnly, status: HubPackageStatus.QC_FAILED, 'qualityChecks.resourced': { $ne: true } }),
    ]);
    const readyToBook = await Consolidation.countDocuments({ ...scope, status: 'SEALED', orderId: { $nin: bookedOrders } });
    return { sourcing, blocked, inbound, awaitingQc, readyToConsolidate, consolidating, sealed, readyToBook, booked, inTransit, exceptions, failed };
  }

  async logisticsReadiness(actor: Actor) {
    await assertStaffScope(actor);
    return { providers: logisticsReadiness() };
  }

  async logisticsWebhook(provider: string, eventId: string, payload: Record<string, unknown>, signature: string, timestamp?: string) {
    if (!['gig', 'fez', 'manual', 'simulated', 'other'].includes(provider)) throw new HttpError(400, 'Unsupported logistics provider', undefined, 'VALIDATION_ERROR');
    if (!eventId) throw new HttpError(400, 'Provider event id is required', undefined, 'VALIDATION_ERROR');
    if (['gig', 'fez'].includes(provider) && process.env[`LOGISTICS_${provider.toUpperCase()}_ENABLED`] !== 'true') throw new HttpError(503, `${provider.toUpperCase()} logistics integration is not enabled`, undefined, 'PROVIDER_NOT_READY');
    if (provider === 'simulated' && !isLogisticsSimulationEnabled()) throw new HttpError(503, 'Logistics simulation is not enabled', undefined, 'PROVIDER_NOT_READY');
    if (!logisticsSignature(provider, payload, signature, timestamp)) throw new HttpError(401, 'Invalid logistics webhook signature', undefined, 'WEBHOOK_SIGNATURE_INVALID');
    const payloadHash = digest(JSON.stringify(payload));
    const normalizedProvider = provider as any;
    // Only a fully handled delivery is a duplicate. One left RECEIVED (crash,
    // stale version) must be reprocessed when the provider retries it,
    // otherwise the shipment would never advance.
    const existing = await LogisticsWebhookEvent.findOne({ provider: normalizedProvider, providerEventId: eventId }).lean({ virtuals: true }) as any;
    if (existing && ['PROCESSED', 'IGNORED'].includes(String(existing.status))) return { duplicate: true, event: existing };
    const LEASE_MS = 30_000;
    let event: any;
    if (!existing) {
      try {
        // Created already holding the lease, so this delivery owns the event.
        event = await LogisticsWebhookEvent.create({ provider: normalizedProvider, providerEventId: eventId, payloadHash, eventType: String(payload.eventType || payload.status || 'unknown'), shipmentId: payload.shipmentId ? String(payload.shipmentId) : undefined, signatureVerified: true, status: 'RECEIVED', receivedAt: new Date(), lockedUntil: new Date(Date.now() + LEASE_MS) });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        // A concurrent delivery of the same event is already being handled.
        const concurrent = await LogisticsWebhookEvent.findOne({ provider: normalizedProvider, providerEventId: eventId }).lean({ virtuals: true });
        return { duplicate: true, event: concurrent };
      }
    } else {
      // A previous attempt left it unfinished. Take it over only if nobody
      // holds a live lease, so concurrent retries cannot all reprocess it.
      event = await LogisticsWebhookEvent.findOneAndUpdate(
        { _id: existing._id, status: { $in: ['RECEIVED', 'FAILED'] }, $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: { $lt: new Date() } }] } as any,
        { $set: { lockedUntil: new Date(Date.now() + LEASE_MS) } },
        { returnDocument: 'after' },
      );
      if (!event) return { duplicate: true, event: existing };
    }
    try {
    const shipmentValue = payload.shipmentId ? String(payload.shipmentId) : undefined;
    const shipment = shipmentValue
      ? await Shipment.findOne({ $or: [identifier(shipmentValue), { externalReference: shipmentValue }, { trackingNumber: shipmentValue }] } as any).lean({ virtuals: true }) as any
      : null;
    const statusKey = String(payload.status || payload.eventType || '').toUpperCase().replace(/[ .-]+/g, '_');
    const statusMap: Record<string, ShipmentStatus> = {
      BOOKED: ShipmentStatus.BOOKED_WITH_PROVIDER,
      BOOKED_WITH_PROVIDER: ShipmentStatus.BOOKED_WITH_PROVIDER,
      AWAITING_PICKUP: ShipmentStatus.AWAITING_PICKUP,
      PICKED_UP: ShipmentStatus.PICKED_UP,
      IN_TRANSIT: ShipmentStatus.IN_TRANSIT,
      OUT_FOR_DELIVERY: ShipmentStatus.OUT_FOR_DELIVERY,
      AWAITING_HANDOVER_PAYMENT: ShipmentStatus.AWAITING_HANDOVER_PAYMENT,
      DELIVERED: ShipmentStatus.DELIVERED,
      DELIVERY_FAILED: ShipmentStatus.DELIVERY_FAILED,
      RETURN_IN_TRANSIT: ShipmentStatus.RETURN_IN_TRANSIT,
      RETURNED_TO_HOOK: ShipmentStatus.RETURNED_TO_HOOK,
      // Fez's own, coarser status vocabulary (its docs don't fully enumerate it,
      // so this list may need extending once real webhook traffic is observed).
      PENDING_PICK_UP: ShipmentStatus.AWAITING_PICKUP,
      DISPATCHED: ShipmentStatus.IN_TRANSIT,
      RETURNED: ShipmentStatus.RETURNED_TO_HOOK,
    };
    const next = statusMap[statusKey];
    if (!shipment || !next) {
      await LogisticsWebhookEvent.updateOne({ _id: event._id }, { $set: { status: 'IGNORED', processedAt: new Date() } });
      return { duplicate: false, event: { ...event.toJSON(), status: 'IGNORED' }, accepted: false };
    }
    // IN_TRANSIT allows DELIVERED and RETURNED_TO_HOOK directly (not just via
    // OUT_FOR_DELIVERY/DELIVERY_FAILED), and PICKED_UP allows RETURNED_TO_HOOK
    // directly, because Fez's coarser status vocabulary has no "out for
    // delivery" or "delivery failed" event of its own before Delivered/Returned.
    const allowed: Record<string, string[]> = { READY_FOR_BOOKING: ['BOOKED_WITH_PROVIDER'], BOOKING_PENDING: ['BOOKED_WITH_PROVIDER'], BOOKED_WITH_PROVIDER: ['AWAITING_PICKUP', 'CANCELLED'], AWAITING_PICKUP: ['PICKED_UP', 'CANCELLED'], PICKED_UP: ['IN_TRANSIT', 'DELIVERY_FAILED', 'RETURNED_TO_HOOK'], IN_TRANSIT: ['OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'RETURN_IN_TRANSIT', 'DELIVERED', 'RETURNED_TO_HOOK'], OUT_FOR_DELIVERY: ['DELIVERED', 'DELIVERY_FAILED', 'AWAITING_HANDOVER_PAYMENT'], AWAITING_HANDOVER_PAYMENT: ['RELEASE_APPROVED'], RELEASE_APPROVED: ['DELIVERED'], DELIVERY_FAILED: ['RETURN_IN_TRANSIT'], RETURN_IN_TRANSIT: ['RETURNED_TO_HOOK'] };
    if (shipment.status === next) {
      // Already in this state (e.g. the provider re-sent it under a new event id): nothing to apply.
      await LogisticsWebhookEvent.updateOne({ _id: event._id }, { $set: { status: 'PROCESSED', processedAt: new Date(), shipmentId: shipment.publicId || shipment._id.toString() } });
      return { duplicate: false, event: { ...event.toJSON(), status: 'PROCESSED' }, shipment, accepted: true };
    }
    if (shipment.status !== next && !allowed[shipment.status]?.includes(next)) {
      await LogisticsWebhookEvent.updateOne({ _id: event._id }, { $set: { status: 'IGNORED', processedAt: new Date() } });
      return { duplicate: false, event: { ...event.toJSON(), status: 'IGNORED' }, accepted: false };
    }
    const orderStatus = next === ShipmentStatus.DELIVERED ? CommerceOrderStatus.DELIVERED : next === ShipmentStatus.RETURN_IN_TRANSIT ? CommerceOrderStatus.RETURN_IN_PROGRESS : [ShipmentStatus.PICKED_UP, ShipmentStatus.IN_TRANSIT, ShipmentStatus.OUT_FOR_DELIVERY].includes(next) ? CommerceOrderStatus.IN_TRANSIT : undefined;
    // Shipment, order and the event marker commit together, so a crash cannot
    // leave a moved shipment whose event is still "received".
    const updated = await this.atomically(async (session) => {
      const moved = await Shipment.findOneAndUpdate({ _id: shipment._id, version: shipment.version }, { $set: { status: next, trackingNumber: payload.trackingNumber ? String(payload.trackingNumber) : shipment.trackingNumber, pickedUpAt: next === ShipmentStatus.PICKED_UP ? new Date() : shipment.pickedUpAt, deliveredAt: next === ShipmentStatus.DELIVERED ? new Date() : shipment.deliveredAt, failedAt: next === ShipmentStatus.DELIVERY_FAILED ? new Date() : shipment.failedAt }, $push: { trackingEvents: { status: next, at: new Date(), actorId: `WEBHOOK:${provider}`, note: typeof payload.note === 'string' ? payload.note.slice(0, 500) : undefined } }, $inc: { version: 1 } }, { returnDocument: 'after', session }).lean({ virtuals: true });
      if (!moved) return null;
      if (next === ShipmentStatus.DELIVERY_FAILED) await recordPodRefusal(String(shipment.orderId), session);
      if (orderStatus) await Order.updateOne({ _id: shipment.orderId }, { $set: { commerceStatus: orderStatus, ...(next === ShipmentStatus.DELIVERED ? { deliveredAt: new Date() } : {}) }, $push: { timeline: timelineEntry(next, `WEBHOOK:${provider}`) } }, { session });
      await LogisticsWebhookEvent.updateOne({ _id: event._id }, { $set: { status: 'PROCESSED', processedAt: new Date(), shipmentId: shipment.publicId || shipment._id.toString() } }, { session });
      return moved;
    });
    if (!updated) throw new HttpError(409, 'Shipment changed while processing provider event', undefined, 'STALE_VERSION');
    if (orderStatus || next === ShipmentStatus.DELIVERY_FAILED) await notifyStatus(shipment.orderId, next);
    if (next === ShipmentStatus.DELIVERY_FAILED) {
      const order = await Order.findById(shipment.orderId).select('publicId').lean() as any;
      await notifyStaffByPermission({
        permission: 'fulfilment.manage', stateId: shipment.sourceStateId, hubId: shipment.hubId,
        eventKeyPrefix: `shipment:${shipment.publicId}:delivery-failed:${updated.version}`,
        title: 'Delivery attempt failed', body: `${order?.publicId || shipment.publicId} needs a redelivery or return decision.`,
        type: 'order_delayed', data: { orderId: order?.publicId, shipmentId: shipment.publicId, href: order?.publicId ? `/dashboard/orders/${order.publicId}` : undefined },
      });
    }
    await this.publishOrderUpdate(shipment.orderId, shipment.sourceStateId, shipment.hubId);
    return { duplicate: false, event: { ...event.toJSON(), status: 'PROCESSED' }, shipment: updated, accepted: true };
    } catch (error) {
      // Free the event immediately so the provider's retry is not made to wait out the lease.
      await LogisticsWebhookEvent.updateOne({ _id: event._id, status: { $ne: 'PROCESSED' } }, { $unset: { lockedUntil: 1 } }).catch(() => undefined);
      throw error;
    }
  }
}

export const fulfilmentService = new FulfilmentService();
