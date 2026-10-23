import mongoose from 'mongoose';
import { CreditService } from '@services/credit.service';
import { PaymentLink } from '@models/payments/payment-link.model';
import type { MongoRepository as Repository } from '@lib/mongo-repository';
import { AppDataSource } from '@config/data-source';
import { AccountStatus, AccountType, DEFAULT_DELIVERY_FEE, DELIVERY_SLA_HOURS, OrderStatus, OrderType, PaymentMode, PaymentStatus, POD_PAUSED, ProductStatus, ScopeType } from '@lib/constants';
import { EmailService } from '@emails/email.service';
import { getEmailSettings } from '@services/email-settings.service';
import { Cart } from '@models/cart/cart.model';
import { CartItem } from '@models/cart/cart-item.model';
import { Logistics } from '@models/logistics/logistics.model';
import { OrderItem } from '@models/orders/order-item.model';
import { Order } from '@models/orders/order.model';
import { Product } from '@models/products/product.model';
import { Payment } from '@models/payments/payment.model';
import { OrderFulfilmentGroup } from '@models/orders/order-fulfilment-group.model';
import { Shipment } from '@models/fulfilment/fulfilment.model';
import { ItemResolution } from '@models/fulfilment/item-resolution.model';
import { User } from '@models/users/user.model';
import { CustomerOwner } from './cart.service';
import { HttpError } from '@utils/http';
import { Otp } from '@models/auth/otp.model';
import { randomInt } from 'crypto';
import { nextPublicId } from '@modules/platform/public-id.service';
import { publishRealtime } from '@modules/platform/realtime.service';
import { createCommerceNotification } from './commerce-notification.service';
import { customerStatusLabel } from '@lib/order-status-labels';
import { appendTimeline, timelineEntry } from '@lib/order-timeline';
import { restoreOrderIncentives } from './order-restoration.service';

type CheckoutBody = Pick<Order, 'deliveryAddress' | 'deliveryNotes' | 'scheduledDeliveryAt' | 'guestEmail' | 'guestName' | 'paymentMode' | 'orderType' | 'giftRecipient'>;

const DISPATCHED_SHIPMENT_STATUSES = new Set(['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED']);

function displayNumber(order: any) {
  const reference = String(order.publicId || order.orderCode || '');
  const sequence = reference.match(/(\d+)$/)?.[1];
  return sequence ? `Order #${sequence}` : 'Order';
}


function timelineFor(order: any, shipment?: any) {
  const events = [...(order.timeline || [])]
    .map((event: any) => ({ status: String(event.status || ''), at: event.at || event.createdAt }))
    .filter((event: any) => event.status);
  const occurred = new Map(events.map((event: any) => [event.status, event.at]));
  // A delivery's own shipment events override the order-level ones so multiple deliveries don't render identical ladders.
  for (const event of shipment?.trackingEvents || []) {
    const status = String(event.status || '').toUpperCase();
    if (status && event.at) occurred.set(status, event.at);
  }
  const status = String(order.commerceStatus || order.status || 'AWAITING_PAYMENT').toUpperCase();
  const sequence = ['AWAITING_PAYMENT', 'OPERATIONS_REVIEW', 'IN_FULFILMENT', 'READY_FOR_CONSOLIDATION', 'READY_FOR_DISPATCH', 'IN_TRANSIT', 'DELIVERED'];
  const stageByStatus: Record<string, number> = {
    AWAITING_PAYMENT: 0,
    AWAITING_DELIVERY_FEE: 0,
    VERIFICATION_PENDING: 1,
    OPERATIONS_REVIEW: 1,
    APPROVED_FOR_FULFILMENT: 2,
    IN_FULFILMENT: 2,
    PARTIALLY_RECEIVED: 3,
    READY_FOR_CONSOLIDATION: 3,
    READY_FOR_DISPATCH: 4,
    BOOKED_WITH_PROVIDER: 4,
    AWAITING_PICKUP: 4,
    PICKED_UP: 5,
    IN_TRANSIT: 5,
    OUT_FOR_DELIVERY: 5,
    PARTIALLY_IN_TRANSIT: 5,
    PARTIALLY_DELIVERED: 5,
    DELIVERED: 6,
    COLLECTED: 6,
    COMPLETED: 6,
  };
  const inferredIndex = stageByStatus[status] ?? events.reduce((last: number, event: any) => Math.max(last, stageByStatus[event.status] ?? 0), 0);
  return sequence.map((step, index) => ({
    key: step.toLowerCase(),
    label: customerStatusLabel(step),
    status: index < inferredIndex ? 'completed' : index === inferredIndex ? 'current' : 'upcoming',
    occurredAt: occurred.get(step) || (step === 'AWAITING_PAYMENT' ? order.createdAt : undefined),
  })).concat((shipment?.trackingEvents || []).map((event: any, index: number) => ({
    key: `tracking-${index}`,
    label: customerStatusLabel(event.status),
    status: 'completed',
    occurredAt: event.at,
  })));
}

function safeItem(item: any) {
  return {
    id: item.publicId,
    productId: typeof item.productId === 'string' && !/^[a-f\d]{24}$/i.test(item.productId) ? item.productId : undefined,
    title: item.productSnapshot?.title || item.productTitle,
    imageUrl: item.productSnapshot?.image || item.productImage,
    variants: item.variantSnapshot || item.selectedVariants || {},
    quantity: Number(item.quantity || 0),
    unitPriceMinor: Number(item.unitPriceMinor ?? Math.round(Number(item.unitPrice || 0) * 100)),
    lineTotalMinor: Number(item.totalPriceMinor ?? Math.round(Number(item.totalPrice || 0) * 100)),
    deliveryStatus: item.deliveryStatus,
  };
}

export class OrderService {
  private readonly email = new EmailService();

  constructor(
    private readonly carts: Repository<Cart>,
    private readonly cartItems: Repository<CartItem>,
    private readonly orders: Repository<Order>,
    private readonly orderItems: Repository<OrderItem>,
    private readonly products: Repository<Product>,
    private readonly logistics: Repository<Logistics>,
  ) {}

  async checkout(owner: CustomerOwner, body: CheckoutBody) {
    const where = this.ownerWhere(owner);
    if (!owner.userId && (!body.guestEmail || !body.guestName)) {
      throw new HttpError(400, 'Guest checkout requires a name and email address');
    }
    const cart = await this.carts.findOne({
      where: { ...where, isCheckedOut: false },
      relations: { items: { product: true } },
    });
    if (cart) cart.items = cart.items || await this.cartItems.find({ where: { cartId: cart.id }, relations: { product: true } });
    const cartItems = cart?.items || [];
    if (!cart || !cartItems.length) throw new HttpError(400, 'Cart is empty');
    if (body.paymentMode === PaymentMode.PAY_ON_DELIVERY && POD_PAUSED) {
      throw new HttpError(409, 'Pay on Delivery is not currently available');
    }
    if (body.orderType === OrderType.GIFT && (!body.giftRecipient || body.paymentMode !== PaymentMode.PAY_NOW)) {
      throw new HttpError(400, 'Gift orders require recipient delivery details and Pay Now');
    }

    const legacySourceIds = [...new Set(cartItems.map((item) => item.product.vendorId).filter(Boolean))];
    for (const item of cartItems) {
      const available = Number(item.product.quantity || 0) - Number(item.product.reservedQuantity || 0);
      if (available < item.quantity) throw new HttpError(409, `${item.product.title} no longer has enough available stock`);
    }
    const provisionalUser = !owner.userId && body.guestEmail
      ? await this.ensureGuestAccount(body.guestEmail, body.guestName || '', owner.guestId)
      : undefined;
    const order = await this.orders.save(this.orders.create({
      orderCode: `HK-${Date.now().toString().slice(-8)}`,
      ...where,
      userId: owner.userId || provisionalUser?.id,
      guestEmail: body.guestEmail,
      guestName: body.guestName,
      subtotal: cart.subtotal,
      deliveryFee: Number(process.env.DEFAULT_DELIVERY_FEE || DEFAULT_DELIVERY_FEE),
      deliverySubsidy: Number(process.env.DELIVERY_VENDOR_SUBSIDY || 0),
      discount: 0,
      total: cart.subtotal + Number(process.env.DEFAULT_DELIVERY_FEE || DEFAULT_DELIVERY_FEE),
      vendorCount: legacySourceIds.length,
      status: body.paymentMode === PaymentMode.PAY_NOW ? OrderStatus.AWAITING_PAYMENT : OrderStatus.PENDING,
      paymentStatus: PaymentStatus.UNPAID,
      paymentMode: body.paymentMode || PaymentMode.PAY_NOW,
      orderType: body.orderType || OrderType.STANDARD,
      giftRecipient: body.giftRecipient,
      deliveryAddress: body.orderType === OrderType.GIFT && body.giftRecipient ? body.giftRecipient.address : body.deliveryAddress,
      partialFulfilment: false,
      deliveryNotes: body.deliveryNotes,
      scheduledDeliveryAt: body.scheduledDeliveryAt,
    }));

    const createdItems: any[] = [];
    const reservations: Array<{ productId: string; quantity: number }> = [];
    try {
      for (const item of cartItems) {
        const product = item.product;
        const reserved = await Product.findOneAndUpdate(
          {
            _id: product.id,
            status: ProductStatus.APPROVED,
            $expr: { $gte: [{ $subtract: ['$quantity', '$reservedQuantity'] }, item.quantity] },
          },
          { $inc: { reservedQuantity: item.quantity } },
          { returnDocument: 'after' },
        );
        if (!reserved) throw new HttpError(409, `${product.title} no longer has enough available stock`);
        reservations.push({ productId: product.id, quantity: item.quantity });
        createdItems.push(await this.orderItems.save(this.orderItems.create({
          orderId: order.id,
          productId: item.productId,
          productTitle: product.title,
          productImage: product.images?.[0],
          vendorId: product.vendorId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
          selectedVariants: item.selectedVariants,
          commissionAmount: 0,
        })));
      }
    } catch (error) {
      await Promise.all(reservations.map(({ productId, quantity }) => Product.findByIdAndUpdate(productId, { $inc: { reservedQuantity: -quantity } })));
      await this.orderItems.delete({ orderId: order.id });
      await this.orders.delete(order.id);
      throw error;
    }
    await this.logistics.save(this.logistics.create({
      orderId: order.id,
      deliveryLocation: {
        address: `${order.deliveryAddress.street}, ${order.deliveryAddress.city}, ${order.deliveryAddress.state}`,
        coordinates: order.deliveryAddress.coordinates || { lat: 0, lng: 0 },
        instructions: body.deliveryNotes,
      },
      estimatedDeliveryAt: new Date(Date.now() + DELIVERY_SLA_HOURS * 60 * 60 * 1000),
    }));

    cart.isCheckedOut = true;
    await Promise.all([this.carts.save(cart), this.cartItems.delete({ cartId: cart.id })]);
    const itemCount = cartItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const customer = owner.userId ? await AppDataSource.getRepository(User).findOne({ where: { id: owner.userId } }) : undefined;
    const customerEmail = customer?.email || body.guestEmail;
    const customerName = `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim() || body.guestName || body.guestEmail;
    if (customerEmail && body.paymentMode === PaymentMode.PAY_ON_DELIVERY) {
      await this.email.sendOrderConfirmation({
        to: customerEmail,
        name: customerName,
        orderCode: order.orderCode,
        amount: order.total,
        itemCount,
        lines: cartItems.map((item) => ({
          title: item.product?.title || 'Product',
          quantity: Number(item.quantity || 0),
          amount: Number(item.unitPrice || 0) * Number(item.quantity || 0),
        })),
        subtotal: order.subtotal,
        deliveryFee: order.deliveryFee,
        deliveryAddress: order.deliveryAddress?.formattedAddress,
        expectedDeliveryDate: order.estimatedDeliveryAt
          ? new Date(order.estimatedDeliveryAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })
          : undefined,
      });
    }
    const hookOpsEmail = (await getEmailSettings()).hookOpsEmail;
    if (hookOpsEmail && body.paymentMode === PaymentMode.PAY_ON_DELIVERY) {
      await this.email.sendHookNewOrder({
        to: hookOpsEmail,
        customerName: customerName || 'Customer',
        orderCode: order.orderCode,
        amount: order.total,
        itemCount,
      });
    }

    const result = await this.orders.findOne({
      where: { id: order.id },
      relations: { items: true, logistics: true },
    });
    const response = { ...result, provisionalAccount: provisionalUser?.accountStatus === 'pending_password' ? { email: provisionalUser.email, nextStep: 'set_password' } : undefined };
    publishRealtime({ type: 'order.updated', entityId: order.publicId || order.id, version: 1 }, owner.userId ? { accountId: owner.userId, admin: true } : { admin: true });
    return response;
  }

  async listCustomerOrders(owner: CustomerOwner) {
    const orders = await Order.find(this.ownerWhere(owner))
      .select('-legacyCommerceSnapshot -timeline -customerSnapshot -addressSnapshot')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean({ virtuals: true });
    const orderIds = orders.map((order) => order.id);
    const [items, payments, groups] = await Promise.all([
      orderIds.length ? OrderItem.find({ orderId: { $in: orderIds } }).lean({ virtuals: true }) : [],
      // Excludes replacement-item top-ups: orderPayments[0] below stands in for "this order's payment status", which a top-up must not shadow.
      orderIds.length ? Payment.find({ orderId: { $in: orderIds }, itemResolutionId: { $exists: false } }).select('-gatewayResponse -authorizationUrl -accessCode').lean({ virtuals: true }) : [],
      orderIds.length ? OrderFulfilmentGroup.find({ orderId: { $in: orderIds } }).sort({ createdAt: 1 }).lean({ virtuals: true }) : [],
    ]);
    const itemMap = new Map<string, any[]>();
    (items as any[]).forEach((item) => itemMap.set(String(item.orderId), [...(itemMap.get(String(item.orderId)) || []), item]));
    const paymentMap = new Map<string, any[]>();
    (payments as any[]).forEach((payment) => paymentMap.set(String(payment.orderId), [...(paymentMap.get(String(payment.orderId)) || []), payment]));
    const groupMap = new Map<string, any[]>();
    (groups as any[]).forEach((group) => groupMap.set(String(group.orderId), [...(groupMap.get(String(group.orderId)) || []), group]));
    return orders.map((order) => {
      const orderPayments = paymentMap.get(order.id) || [];
      const orderItems = itemMap.get(order.id) || [];
      const subtotalMinor = Number(order.subtotalMinor ?? Math.round(Number(order.subtotal || 0) * 100));
      const vatMinor = Number(order.vatMinor || 0);
      const deliveryFeeMinor = Number(order.deliveryFeeMinor ?? Math.round(Number(order.deliveryFee || 0) * 100));
      return {
        id: order.publicId || order.orderCode,
        displayNumber: displayNumber(order),
        createdAt: order.createdAt,
        status: order.commerceStatus || order.status,
        statusLabel: customerStatusLabel(order.commerceStatus || order.status),
        paymentStatus: order.commercePaymentStatus || order.paymentStatus,
        paymentMethod: order.commercePaymentMethod || order.paymentMode,
        itemCount: orderItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
        items: orderItems.map(safeItem),
        subtotalMinor,
        vatRate: Number(order.vatRate || 0),
        vatMinor,
        deliveryFeeMinor,
        discountMinor: Math.round(Number(order.discount || 0) * 100),
        couponCode: order.couponCode,
        couponDiscountMinor: Number(order.couponDiscountMinor || 0),
        creditsAppliedMinor: Number(order.creditsAppliedMinor || 0),
        // The courier the customer picked and paid for at checkout, never exposed to them until now.
        logisticsProvider: order.logisticsProviderSnapshot
          ? { code: (order.logisticsProviderSnapshot as any).code, name: (order.logisticsProviderSnapshot as any).name }
          : undefined,
        totalMinor: Number(order.totalMinor ?? Math.round(Number(order.total || 0) * 100)),
        currency: order.currency || 'NGN',
        payment: orderPayments[0] ? { status: orderPayments[0].commerceStatus || orderPayments[0].status } : undefined,
        deliveryCount: (groupMap.get(order.id) || []).length || 1,
      };
    }) as any;
  }

  /**
   * A light, cross-order signal for "do I have anything to confirm right now" —
   * the home-screen prompt and Profile badge poll this instead of loading
   * every order's full detail just to check for a pending substitution.
   */
  /**
   * Cross-order signal for the mascot/banner: still needs the customer's
   * attention either way — either a decision (CUSTOMER_APPROVAL_PENDING) or,
   * once they've accepted a priced replacement, the top-up payment that
   * unblocks fulfilment (PAYMENT_PENDING). Dropping the mascot the moment
   * they accept would strand them mid-flow with an unpaid top-up and no
   * reminder to finish it.
   */
  async pendingApprovals(owner: CustomerOwner) {
    if (!owner.userId) return { count: 0, items: [] };
    const resolutions = await ItemResolution.find({ customerId: owner.userId, status: { $in: ['CUSTOMER_APPROVAL_PENDING', 'PAYMENT_PENDING'] } })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean({ virtuals: true });
    if (!resolutions.length) return { count: 0, items: [] };
    const orders = await Order.find({ _id: { $in: resolutions.map((entry: any) => entry.orderId) } })
      .select('publicId orderCode')
      .lean({ virtuals: true });
    const orderMap = new Map(orders.map((order: any) => [order.id, order]));
    return {
      count: resolutions.length,
      items: resolutions.map((entry: any) => {
        const order = orderMap.get(entry.orderId);
        return {
          itemResolutionId: entry.publicId,
          orderId: order?.publicId || order?.orderCode || entry.orderId,
          displayNumber: order ? displayNumber(order) : undefined,
          productTitle: entry.proposal?.productTitle,
          summary: entry.summary,
          adjustmentMinor: Number(entry.adjustmentMinor || 0),
          createdAt: entry.createdAt,
          status: entry.status as 'CUSTOMER_APPROVAL_PENDING' | 'PAYMENT_PENDING',
        };
      }),
    };
  }

  async getCustomerOrder(owner: CustomerOwner, id: string) {
    const identifier = id.match(/^[a-f\d]{24}$/i) ? { $or: [{ _id: id }, { publicId: id }, { orderCode: id }] } : { $or: [{ publicId: id }, { orderCode: id }] };
    const order = await Order.findOne({ ...identifier, ...this.ownerWhere(owner) }).lean({ virtuals: true });
    if (!order) throw new HttpError(404, 'Order not found');
    const [items, payments, fulfilmentGroups, shipments, substitutions] = await Promise.all([
      OrderItem.find({ orderId: order.id }).lean({ virtuals: true }),
      Payment.find({ orderId: order.id }).select('-gatewayResponse -authorizationUrl -accessCode').lean({ virtuals: true }),
      OrderFulfilmentGroup.find({ orderId: order.id }).sort({ createdAt: 1 }).lean({ virtuals: true }),
      Shipment.find({ orderId: order.id }).sort({ createdAt: 1 }).lean({ virtuals: true }),
      // OPEN/ADMIN_REVIEW included too, not just CUSTOMER_APPROVAL_PENDING onward — a
      // customer should see why an item is being worked on as soon as it's reported,
      // not only once staff have proposed a replacement.
      ItemResolution.find({ orderId: order.id, ...(order.userId ? { customerId: order.userId } : {}), status: { $in: ['OPEN', 'ADMIN_REVIEW', 'CUSTOMER_APPROVAL_PENDING', 'PAYMENT_PENDING', 'REFUND_PENDING', 'DECLINED', 'RESOLVED'] } }).sort({ createdAt: -1 }).lean({ virtuals: true }),
    ]);
    const subtotalMinor = Number(order.subtotalMinor ?? Math.round(Number(order.subtotal || 0) * 100));
    const vatMinor = Number(order.vatMinor || 0);
    const deliveryFeeMinor = Number(order.deliveryFeeMinor ?? Math.round(Number(order.deliveryFee || 0) * 100));
    const safeItems = items.map(safeItem);
    const deliveries = (fulfilmentGroups.length ? fulfilmentGroups : [{ publicId: 'legacy', sourceStateId: order.sourceStateId, status: order.commerceStatus || order.status }]).map((group: any, index: number) => {
      // Match on the group first, falling back to the State only when a single group exists there.
      const shipment = shipments.find((entry: any) => entry.fulfilmentGroupId === group.publicId)
        || (fulfilmentGroups.length <= 1
          ? shipments.find((entry: any) => String(entry.sourceStateId) === String(group.sourceStateId))
          : undefined);
      const shipmentStatus = String(shipment?.status || '').toUpperCase();
      const trackingVisible = DISPATCHED_SHIPMENT_STATUSES.has(shipmentStatus);
      // Ungrouped items are only safe to show when there is a single delivery to attribute them to.
      const groupItems = items
        .filter((item: any) => (item.fulfilmentGroupId ? item.fulfilmentGroupId === group.publicId : fulfilmentGroups.length <= 1))
        .map(safeItem);
      const payment = payments.find((entry: any) => entry.fulfilmentGroupId === group.publicId);
      return {
        id: group.publicId || `delivery-${index + 1}`,
        label: `Delivery ${index + 1}`,
        status: shipment?.status || group.status || order.commerceStatus || order.status,
        statusLabel: customerStatusLabel(shipment?.status || group.status || order.commerceStatus || order.status),
        eta: shipment?.estimatedDeliveryAt,
        items: groupItems,
        payment: payment ? { status: payment.commerceStatus || payment.status, amountMinor: Number(payment.amountMinor || 0) } : undefined,
        // Pin `status` too, not just `commerceStatus`, to avoid leaking the order-wide status into a group that hasn't reached it yet.
        timeline: timelineFor(
          { ...order, commerceStatus: shipment?.status || group.status, status: shipment?.status || group.status },
          shipment,
        ),
        shipment: shipment ? {
          provider: trackingVisible ? shipment.provider : undefined,
          // The courier the customer actually chose and paid for, not the internal booking adapter in `provider`.
          courierName: shipment.courierName,
          courierCode: shipment.courierCode,
          substitutedFrom: shipment.substitutedFrom,
          substitutionReason: shipment.substitutionReason,
          trackingReference: trackingVisible ? shipment.trackingNumber : undefined,
          status: shipment.status,
          dispatchedAt: trackingVisible ? shipment.pickedUpAt || shipment.bookedAt : undefined,
          deliveredAt: shipment.deliveredAt,
        } : undefined,
      };
    });
    const primaryShipment = shipments[0];
    return {
      id: order.publicId || order.orderCode,
      displayNumber: displayNumber(order),
      createdAt: order.createdAt,
      status: order.commerceStatus || order.status,
      statusLabel: customerStatusLabel(order.commerceStatus || order.status),
      paymentStatus: order.commercePaymentStatus || order.paymentStatus,
      paymentMethod: order.commercePaymentMethod || order.paymentMode,
      itemCount: safeItems.reduce((sum, item) => sum + item.quantity, 0),
      address: order.addressSnapshot ? {
        label: order.addressSnapshot.label,
        recipientName: order.addressSnapshot.recipientName,
        phone: order.addressSnapshot.phone,
        formattedAddress: order.addressSnapshot.formattedAddress || [order.addressSnapshot.line1, order.addressSnapshot.line2, order.addressSnapshot.localGovernmentArea, order.addressSnapshot.cityName, order.addressSnapshot.stateName].filter(Boolean).join(', '),
        stateName: order.addressSnapshot.stateName,
        cityName: order.addressSnapshot.cityName,
        localGovernmentArea: order.addressSnapshot.localGovernmentArea,
      } : {
        formattedAddress: [order.deliveryAddress?.street, order.deliveryAddress?.city, order.deliveryAddress?.state].filter(Boolean).join(', '),
        phone: order.deliveryAddress?.phone,
      },
      items: safeItems,
      subtotalMinor,
      vatRate: Number(order.vatRate || 0),
      vatMinor,
      deliveryFeeMinor,
      discountMinor: Math.round(Number(order.discount || 0) * 100),
      couponCode: order.couponCode,
      couponDiscountMinor: Number(order.couponDiscountMinor || 0),
      creditsAppliedMinor: Number(order.creditsAppliedMinor || 0),
        // The courier the customer picked and paid for at checkout, never exposed to them until now.
        logisticsProvider: order.logisticsProviderSnapshot
          ? { code: (order.logisticsProviderSnapshot as any).code, name: (order.logisticsProviderSnapshot as any).name }
          : undefined,
      totalMinor: Number(order.totalMinor ?? Math.round(Number(order.total || 0) * 100)),
      currency: order.currency || 'NGN',
      // Pay on Delivery: the online delivery fee and whether it has been paid.
      awaitingDeliveryFee: String(order.commerceStatus || '').toUpperCase() === 'AWAITING_DELIVERY_FEE',
      podFeeDueNowMinor: Number((order as any).podFeeDueNowMinor || 0),
      podFeePaid: Boolean((order as any).podFeePaid),
      timeline: timelineFor(order, primaryShipment),
      deliveries,
      substitutions: substitutions.map((entry: any) => ({ id: entry.publicId || entry.id, version: entry.version, status: entry.status, type: entry.type, summary: entry.summary, original: entry.originalSnapshot, proposal: entry.proposal, adjustmentMinor: entry.adjustmentMinor, adjustmentStatus: entry.adjustmentStatus, adjustmentAuthorizationUrl: entry.adjustmentAuthorizationUrl, customerDecision: entry.customerDecision })),
      canCancel: ['PENDING', 'AWAITING_PAYMENT', 'AWAITING_DELIVERY_FEE'].includes(String(order.commerceStatus || order.status).toUpperCase())
        && !['CONFIRMED', 'PAID'].includes(String(order.commercePaymentStatus || order.paymentStatus).toUpperCase()),
    } as any;
  }

  async cancelCustomerOrder(owner: CustomerOwner, id: string, reason?: string) {
    const order = await this.getCustomerOrder(owner, id);
    const stored = await Order.findOne({ $or: [{ publicId: order.id }, { orderCode: order.id }], userId: owner.userId });
    if (!stored || !order.canCancel) throw new HttpError(409, 'This order can no longer be cancelled', undefined, 'INVALID_STATE_TRANSITION');
    // One transaction so the status flip, released payment links, and restored credit/coupon all happen or none do.
    const session = await mongoose.startSession();
    let saved: any;
    try {
      await session.withTransaction(async () => {
        saved = await Order.findOneAndUpdate(
          {
            _id: stored._id,
            userId: owner.userId,
            commerceStatus: { $in: ['PENDING', 'AWAITING_PAYMENT', 'AWAITING_DELIVERY_FEE'] },
            commercePaymentStatus: { $nin: ['CONFIRMED', 'PAID'] },
          } as any,
          {
            $set: {
              status: OrderStatus.CANCELLED,
              commerceStatus: 'CANCELLED',
              cancelledAt: new Date(),
              cancellationReason: reason,
            },
            $push: { timeline: timelineEntry('CANCELLED', owner.userId, { actorType: 'customer' }) },
          },
          { returnDocument: 'after', session },
        ).lean({ virtuals: true });
        if (!saved) return;
        await restoreOrderIncentives(String(stored._id), session);
        await PaymentLink.updateMany(
          { orderId: stored.id, status: { $in: ['active', 'processing'] } },
          { $set: { status: 'cancelled', cancelledAt: new Date() } },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
    if (!saved) throw new HttpError(409, 'This order can no longer be cancelled', undefined, 'INVALID_STATE_TRANSITION');
    if (owner.userId && Number(saved.creditsAppliedMinor || 0) > 0) {
      await new CreditService().announceRefund(owner.userId, String(stored._id), Number(saved.creditsAppliedMinor)).catch(() => undefined);
    }
    publishRealtime({ type: 'order.updated', entityId: saved.publicId || saved.id, version: Number(saved.__v || 1) }, { accountId: owner.userId, admin: true });
    if (owner.userId) {
      await createCommerceNotification({
        eventKey: `order:${saved.publicId || saved.id}:cancelled`,
        userId: owner.userId,
        title: 'Order cancelled',
        body: `Your order ${saved.publicId || saved.orderCode} has been cancelled.`,
        type: 'order_cancelled',
        data: { orderId: saved.publicId || saved.id },
      }).catch(() => undefined);
      const customer = await AppDataSource.getRepository(User).findOne({ where: { id: owner.userId } });
      if (customer?.email) {
        await this.email.sendOrderCancelled({
          to: customer.email,
          name: customer.firstName,
          orderCode: saved.publicId || saved.orderCode || '',
          amount: Number(saved.total || 0),
          reason,
        }).catch(() => undefined);
      }
    }
    return this.getCustomerOrder(owner, saved.publicId || saved.orderCode);
  }

  private ownerWhere(owner: CustomerOwner) {
    if (owner.userId) return { userId: owner.userId };
    throw new HttpError(401, 'Customer authentication required');
  }

  private async ensureGuestAccount(email: string, name: string, guestId?: string) {
    const users = AppDataSource.getRepository(User);
    const normalized = email.toLowerCase().trim();
    const existing = await users.findOne({ where: { email: normalized } });
    if (existing) return existing;
    const [firstName, ...last] = name.trim().split(/\s+/);
    const user = await users.save(users.create({
      publicId: await nextPublicId('customer'),
      accountType: AccountType.CUSTOMER,
      scopeType: ScopeType.SELF,
      email: normalized, firstName: firstName || '', lastName: last.join(' '),
      role: 'shopper' as any, isActive: true, isEmailVerified: false, isPhoneVerified: false,
      accountStatus: AccountStatus.PENDING_PASSWORD, originatingGuestId: guestId,
    }));
    const otps = AppDataSource.getRepository(Otp);
    await Otp.updateMany({ email: normalized, type: 'password_reset', isUsed: false }, { $set: { isUsed: true } });
    const code = String(randomInt(1000, 10000));
    await otps.save(otps.create({ email: normalized, code, type: 'password_reset', isUsed: false, expiresAt: new Date(Date.now() + 10 * 60 * 1000) }));
    if (process.env.NODE_ENV !== 'production') console.log(`[otp:dev] guest_password_setup for ${normalized}: ${code} (expires in 10m)`);
    await this.email.sendOtp({ email: normalized, code, name, purpose: 'password_reset', expiresInMinutes: 10 }).catch(() => undefined);
    return user;
  }
}

/** Cancels prepaid orders nobody paid for and returns the credit/coupon they held, leaving orders still mid-payment alone. */
export async function expireUnpaidOrders(now = new Date()) {
  const hours = Math.max(1, Number(process.env.UNPAID_ORDER_EXPIRY_HOURS || 24));
  const cutoff = new Date(now.getTime() - hours * 3_600_000);
  const stale = await Order.find({
    commerceStatus: 'AWAITING_PAYMENT',
    commercePaymentMethod: 'PREPAID',
    commercePaymentStatus: { $nin: ['CONFIRMED', 'PROCESSING'] },
    createdAt: { $lt: cutoff },
  } as any).select('_id publicId userId').limit(200).lean();
  let expired = 0;
  for (const item of stale) {
    const session = await mongoose.startSession();
    try {
      let flipped = false;
      await session.withTransaction(async () => {
        const saved = await Order.findOneAndUpdate(
          { _id: item._id, commerceStatus: 'AWAITING_PAYMENT', commercePaymentStatus: { $nin: ['CONFIRMED', 'PROCESSING'] } } as any,
          { $set: { status: OrderStatus.CANCELLED, commerceStatus: 'CANCELLED', cancelledAt: new Date(), cancellationReason: 'Not paid in time' }, $push: { timeline: timelineEntry('CANCELLED', 'SYSTEM', { actorType: 'system' }) } },
          { session },
        ).lean();
        if (!saved) return;
        flipped = true;
        await restoreOrderIncentives(String(item._id), session);
        await PaymentLink.updateMany({ orderId: String(item._id), status: { $in: ['active', 'processing'] } }, { $set: { status: 'cancelled', cancelledAt: new Date() } }, { session });
      });
      if (flipped) {
        expired += 1;
        if (item.userId) {
          await createCommerceNotification({
            eventKey: `order:${item.publicId}:expired`,
            userId: String(item.userId),
            title: 'Order cancelled',
            body: `Order ${item.publicId} was cancelled because it was not paid in time. Any Hook credit and coupon you used have been returned.`,
            type: 'order_cancelled',
            data: { orderId: item.publicId },
          }).catch(() => undefined);
        }
      }
    } finally {
      await session.endSession();
    }
  }
  return { expired };
}

