import { Request, Response } from "express";
import { getPreferences, updatePreferences } from "@modules/notifications/notification-dispatch.service";
import { AppDataSource } from "@config/data-source";
import { CartItem } from "@models/cart/cart-item.model";
import { Cart } from "@models/cart/cart.model";
import { Logistics } from "@models/logistics/logistics.model";
import { OrderItem } from "@models/orders/order-item.model";
import { Order } from "@models/orders/order.model";
import { Payment } from "@models/payments/payment.model";
import { EscrowLedger } from "@models/payments/escrow-ledger.model";
import { Product } from "@models/products/product.model";
import { User } from "@models/users/user.model";
import { DeviceToken } from "@models/notifications/device-token.model";
import { Notification } from "@models/notifications/notification.model";
import { AccountDeletionRequest } from "@models/support/account-deletion-request.model";
import { CartService } from "@modules/orders/cart.service";
import { NotificationService } from "@modules/notifications/notification.service";
import { OrderService } from "@modules/orders/order.service";
import { PaymentService } from "@modules/payments/payment.service";
import { HttpError } from "@utils/http";
import { routeParam } from "@lib/api-utils";
import { sendCreated, sendSuccess } from "@utils/http";
import { RefundRequest } from "@models/orders/refund-request.model";
import { OrderStatus, PaymentStatus } from "@lib/constants";
import { publicCart, publicOrder } from "@lib/public-resource";
import { AddressService } from "@modules/identity/address.service";
import { CheckoutService } from "@modules/orders/checkout.service";
import { CommerceSettings } from "@models/commerce/commerce.model";
import { CommerceImportService } from "@modules/catalog/commerce-import.service";
import { LogisticsProviderService } from "@modules/fulfilment/logistics-provider.service";
import { CreditService } from "@modules/orders/credit.service";
import { ReferralService } from "@modules/orders/referral.service";
import { CouponService } from "@modules/orders/coupon.service";

function owner(req: Request) {
  return { userId: req.user!.sub };
}

function ownerId(req: Request) {
  return req.user!.sub;
}

export class CustomerController {
  private readonly cart = new CartService(
    AppDataSource.getRepository(Cart),
    AppDataSource.getRepository(CartItem),
    AppDataSource.getRepository(Product),
  );

  private readonly orders = new OrderService(
    AppDataSource.getRepository(Cart),
    AppDataSource.getRepository(CartItem),
    AppDataSource.getRepository(Order),
    AppDataSource.getRepository(OrderItem),
    AppDataSource.getRepository(Product),
    AppDataSource.getRepository(Logistics),
  );

  private readonly payments = new PaymentService(
    AppDataSource.getRepository(Payment),
    AppDataSource.getRepository(Order),
    AppDataSource.getRepository(EscrowLedger),
  );

  private readonly notificationService = new NotificationService(
    AppDataSource.getRepository(DeviceToken),
    AppDataSource.getRepository(Notification),
  );
  private readonly addresses = new AddressService();
  private readonly checkoutV4 = new CheckoutService();
  private readonly commerceImport = new CommerceImportService();
  private readonly logisticsService = new LogisticsProviderService();
  private readonly creditService = new CreditService();
  private readonly referralService = new ReferralService();
  private readonly couponService = new CouponService();

  importCommerce = async (req: Request, res: Response) =>
    sendSuccess(
      res,
      await this.commerceImport.import(
        req.user!.sub,
        String(req.header("idempotency-key") || ""),
        req.body,
      ),
      "Shopping data imported successfully",
    );

  getCart = async (req: Request, res: Response) => {
    sendSuccess(
      res,
      publicCart(await this.cart.getCart(owner(req))),
      "Cart retrieved successfully",
    );
  };

  addCartItem = async (req: Request, res: Response) => {
    sendCreated(
      res,
      publicCart(
        await this.cart.addItem(
          owner(req),
          req.body.productId,
          req.body.quantity,
          req.body.selectedVariants,
          req.body.variantId,
          req.body.quoteId,
          { deferRecalculation: true },
        ),
      ),
      "Item added to cart successfully",
    );
  };

  updateCartItem = async (req: Request, res: Response) => {
    sendSuccess(
      res,
      publicCart(
        await this.cart.updateItem(
          owner(req),
          routeParam(req.params.itemId),
          req.body.quantity,
          { deferRecalculation: true },
        ),
      ),
      "Cart updated successfully",
    );
  };

  removeCartItem = async (req: Request, res: Response) => {
    sendSuccess(
      res,
      publicCart(
        await this.cart.removeItem(owner(req), routeParam(req.params.itemId), {
          deferRecalculation: true,
        }),
      ),
      "Item removed from cart successfully",
    );
  };

  clearCart = async (req: Request, res: Response) => {
    sendSuccess(
      res,
      publicCart(await this.cart.clear(owner(req), undefined, { deferRecalculation: true })),
      "Cart cleared successfully",
    );
  };

  clearCartState = async (req: Request, res: Response) => {
    sendSuccess(
      res,
      publicCart(
        await this.cart.clear(owner(req), routeParam(req.params.stateId), {
          deferRecalculation: true,
        }),
      ),
      "State basket cleared successfully",
    );
  };

  listAddresses = async (req: Request, res: Response) =>
    sendSuccess(res, await this.addresses.list(req.user!.sub));
  createAddress = async (req: Request, res: Response) =>
    sendCreated(res, await this.addresses.create(req.user!.sub, req.body));
  updateAddress = async (req: Request, res: Response) =>
    sendSuccess(
      res,
      await this.addresses.update(
        req.user!.sub,
        routeParam(req.params.id),
        req.body,
      ),
    );
  deleteAddress = async (req: Request, res: Response) =>
    sendSuccess(
      res,
      await this.addresses.archive(req.user!.sub, routeParam(req.params.id)),
    );
  defaultAddress = async (req: Request, res: Response) =>
    sendSuccess(
      res,
      await this.addresses.setDefault(req.user!.sub, routeParam(req.params.id)),
    );

  checkoutPreview = async (req: Request, res: Response) =>
    sendCreated(
      res,
      await this.checkoutV4.preview(
        { type: "customer", actorId: req.user!.sub, customerId: req.user!.sub },
        routeParam(req.params.stateId),
        req.body,
      ),
    );
  checkoutCombinedPreview = async (req: Request, res: Response) =>
    sendCreated(
      res,
      await this.checkoutV4.preview(
        { type: "customer", actorId: req.user!.sub, customerId: req.user!.sub },
        "all",
        req.body,
      ),
    );
  checkoutConfirm = async (req: Request, res: Response) =>
    sendCreated(
      res,
      await this.checkoutV4.confirm(
        { type: "customer", actorId: req.user!.sub, customerId: req.user!.sub },
        req.body.previewToken,
        String(req.header("idempotency-key") || ""),
      ),
    );
  checkoutCombinedConfirm = this.checkoutConfirm;
  commerceConfig = async (_req: Request, res: Response) => {
    const settings = await CommerceSettings.findOne({ key: "commerce" }).lean();
    sendSuccess(res, {
      currency: settings?.currency || "NGN",
      // Pay on Delivery is an admin setting now (and per state): no code-level pause.
      podEnabled: settings?.podEnabled || false,
      podPaused: false,
      podMinimumOrderMinor: settings?.podMinimumOrderMinor ?? 3000000,
      podSurchargeType: settings?.podSurchargeType || "flat",
      podSurchargeValue: settings?.podSurchargeValue ?? 0,
      vatRatePercent: settings?.vatRatePercent ?? 7.5,
      policyVersions: settings?.activePolicyVersions || {},
      orderEarnEnabled: settings?.orderEarnEnabled ?? true,
      orderEarnPercent: settings?.orderEarnPercent ?? 1,
      orderEarnMaxMinor: settings?.orderEarnMaxMinor ?? 0,
      minimumCheckoutMinor: settings?.minimumCheckoutMinor ?? 1800000,
    });
  };

  logisticsProviders = async (_req: Request, res: Response) =>
    sendSuccess(res, await this.logisticsService.listActive());

  credits = async (req: Request, res: Response) => {
    const userId = req.user!.sub;
    const [balanceMinor, history, capPercent] = await Promise.all([
      this.creditService.balance(userId),
      this.creditService.history(userId),
      this.creditService.spendCapPercent(),
    ]);
    sendSuccess(res, { balanceMinor, capPercent, currency: "NGN", history });
  };

  referrals = async (req: Request, res: Response) =>
    sendSuccess(res, await this.referralService.summary(req.user!.sub));

  /** Lets the app show a coupon's worth before the customer commits to pay. */
  validateCoupon = async (req: Request, res: Response) => {
    const result = await this.couponService.validate(String(req.body.code), {
      userId: req.user!.sub,
      subtotalMinor: Number(req.body.subtotalMinor || 0),
      deliveryFeeMinor: Number(req.body.deliveryFeeMinor || 0),
    });
    sendSuccess(res, {
      code: result.code,
      type: result.type,
      discountMinor: result.discountMinor,
      appliesToDelivery: result.appliesToDelivery,
    });
  };

  pendingApprovals = async (req: Request, res: Response) => {
    sendSuccess(res, await this.orders.pendingApprovals(owner(req)));
  };

  listOrders = async (req: Request, res: Response) => {
    sendSuccess(
      res,
      (await this.orders.listCustomerOrders(owner(req))).map((order: unknown) =>
        publicOrder(order as any),
      ),
    );
  };

  getOrder = async (req: Request, res: Response) => {
    sendSuccess(
      res,
      publicOrder(
        await this.orders.getCustomerOrder(
          owner(req),
          routeParam(req.params.id),
        ),
      ),
    );
  };

  cancelOrder = async (req: Request, res: Response) => {
    sendSuccess(
      res,
      publicOrder(
        await this.orders.cancelCustomerOrder(
          owner(req),
          routeParam(req.params.id),
          req.body.reason,
        ),
      ),
    );
  };

  initializePayment = async (req: Request, res: Response) => {
    if (!req.user?.sub)
      throw new HttpError(401, "Customer authentication required");
    sendCreated(
      res,
      await this.payments.initialize(req.user.sub, req.body.orderId, req.body.fulfilmentGroupId),
    );
  };

  paymentStatus = async (req: Request, res: Response) => {
    if (!req.user?.sub)
      throw new HttpError(401, "Customer authentication required");
    sendSuccess(
      res,
      await this.payments.status(req.user.sub, routeParam(req.params.orderId)),
    );
  };

  paymentMethodCapability = async (_req: Request, res: Response) => {
    sendSuccess(res, await this.payments.capability());
  };

  notificationPreferences = async (req: Request, res: Response) =>
    sendSuccess(res, await getPreferences(req.user!.sub));

  updateNotificationPreferences = async (req: Request, res: Response) =>
    sendSuccess(res, await updatePreferences(req.user!.sub, req.body));

  /** The customer tapped a push: record it so we know which notifications people act on. */
  notificationOpened = async (req: Request, res: Response) => {
    await Notification.updateOne(
      { _id: routeParam(req.params.id), userId: req.user!.sub, openedAt: { $exists: false } },
      { $set: { openedAt: new Date(), isRead: true, readAt: new Date() } },
    ).catch(() => undefined);
    sendSuccess(res, { opened: true });
  };

  listNotifications = async (req: Request, res: Response) => {
    sendSuccess(res, await this.notificationService.list(owner(req), {
      limit: Number(req.query.limit || 30),
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
    }));
  };

  getNotification = async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await this.notificationService.detail(
        owner(req),
        routeParam(req.params.id),
      ),
    );
  };

  markNotificationRead = async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await this.notificationService.markRead(
        owner(req),
        routeParam(req.params.id),
      ),
    );
  };

  markAllNotificationsRead = async (req: Request, res: Response) => {
    sendSuccess(res, await this.notificationService.markAllRead(owner(req)));
  };

  deleteNotification = async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await this.notificationService.delete(
        owner(req),
        routeParam(req.params.id),
      ),
    );
  };

  clearNotifications = async (req: Request, res: Response) => {
    sendSuccess(res, await this.notificationService.clearAll(owner(req)));
  };

  requestRefund = async (req: Request, res: Response) => {
    const order = await this.orders.getCustomerOrder(
      owner(req),
      routeParam(req.params.id),
    );
    if (
      ![PaymentStatus.SUCCESSFUL, PaymentStatus.PARTIALLY_REFUNDED].includes(
        order.paymentStatus,
      )
    )
      throw new HttpError(
        409,
        "Only captured payments can be considered for a refund",
      );
    const refundable =
      Number(order.total) - Number(order.payment?.refundedAmount || 0);
    const amount = Math.min(Number(req.body.amount || refundable), refundable);
    if (amount <= 0)
      throw new HttpError(409, "This order has no refundable balance");
    if (order.status === OrderStatus.DELIVERED) {
      if (!["damaged", "wrong_item"].includes(req.body.reasonType))
        throw new HttpError(
          409,
          "Delivered orders are refundable only for damaged or wrong items",
        );
      if (
        !order.deliveredAt ||
        Date.now() - new Date(order.deliveredAt).getTime() > 48 * 60 * 60 * 1000
      )
        throw new HttpError(
          409,
          "The 48-hour delivery issue window has closed",
        );
    } else if (
      req.body.reasonType !== "not_delivered" &&
      order.status === OrderStatus.SHIPPED
    ) {
      throw new HttpError(
        409,
        "Use the non-delivery reason while this order is in transit",
      );
    }
    const existing = await RefundRequest.findOne({
      idempotencyKey: req.body.idempotencyKey,
    }).lean({ virtuals: true });
    if (existing) return sendSuccess(res, existing);
    const request = await RefundRequest.create({
      orderId: order.id,
      paymentId: order.payment?.id,
      requestedBy: ownerId(req),
      reasonType: req.body.reasonType,
      reason: req.body.reason,
      evidenceUrls: req.body.evidenceUrls,
      amount,
      status: "requested",
      idempotencyKey: req.body.idempotencyKey,
      auditHistory: [
        { action: "requested", actorId: ownerId(req), at: new Date() },
      ],
    });
    sendCreated(res, request);
  };


}
