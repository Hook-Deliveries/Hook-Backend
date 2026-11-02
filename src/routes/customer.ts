import { Router } from "express";
import { z } from "zod";
import { CustomerController } from "@controllers/customer.controller";
import { NegotiationController } from "@controllers/negotiation.controller";
import { requireCustomerIdentity } from "@middleware/auth";
import { validateBody } from "@middleware/validate";
import { withIdempotency } from "@middleware/idempotency";
import {
  cartQuantitySchema,
  customerRefundRequestSchema,
} from "@validations/common.schemas";
import {
  negotiationCreateSchema,
  negotiationOfferSchema,
} from "@validations/catalog.schemas";
import {
  addressCreateSchema,
  addressUpdateSchema,
  checkoutConfirmSchema,
  checkoutPreviewSchema,
  commerceCartItemSchema,
  commerceImportSchema,
  paymentInitializeV4Schema,
  paymentLinkCreateSchema,
} from "@validations/commerce.schemas";
import { PaymentLinkController } from "@controllers/payment-link.controller";
import { requireAuth, requireAccountType } from "@middleware/auth";
import { AccountType } from "@lib/constants";
import { asyncHandler } from "@utils/http";
import { FulfilmentController } from "@controllers/fulfilment.controller";
import { ProductLikesController } from "@controllers/product-likes.controller";

export function createCustomerRouter() {
  const router = Router();
  const controller = new CustomerController();
  const paymentLinks = new PaymentLinkController();
  const negotiations = new NegotiationController();
  const fulfilment = new FulfilmentController();
  const likes = new ProductLikesController();

  router.use(requireCustomerIdentity);

  router.post(
    "/commerce/import",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    validateBody(commerceImportSchema),
    asyncHandler(controller.importCommerce),
  );

  router.get("/cart", asyncHandler(controller.getCart));
  router.post(
    "/cart/items",
    validateBody(commerceCartItemSchema),
    asyncHandler(controller.addCartItem),
  );
  router.patch(
    "/cart/items/:itemId",
    validateBody(cartQuantitySchema),
    asyncHandler(controller.updateCartItem),
  );
  router.delete("/cart/items/:itemId", asyncHandler(controller.removeCartItem));
  router.delete("/cart", asyncHandler(controller.clearCart));
  router.delete(
    "/cart/states/:stateId",
    asyncHandler(controller.clearCartState),
  );
  router.get("/commerce/config", asyncHandler(controller.commerceConfig));
  // Public: the checkout picker needs the courier list before sign-in gates.
  router.get("/logistics-providers", asyncHandler(controller.logisticsProviders));

  router.get("/credits", requireAuth, asyncHandler(controller.credits));
  router.get("/referrals", requireAuth, asyncHandler(controller.referrals));
  router.post(
    "/coupons/validate",
    requireAuth,
    validateBody(z.object({
      code: z.string().trim().min(3).max(40),
      subtotalMinor: z.coerce.number().int().nonnegative(),
      deliveryFeeMinor: z.coerce.number().int().nonnegative().default(0),
    })),
    asyncHandler(controller.validateCoupon),
  );

  router.get(
    "/likes",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    asyncHandler(likes.list),
  );
  router.put(
    "/likes/:productId",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    asyncHandler(likes.add),
  );
  router.delete(
    "/likes/:productId",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    asyncHandler(likes.remove),
  );

  router.get(
    "/addresses",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    asyncHandler(controller.listAddresses),
  );
  router.post(
    "/addresses",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    validateBody(addressCreateSchema),
    asyncHandler(controller.createAddress),
  );
  router.patch(
    "/addresses/:id",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    validateBody(addressUpdateSchema),
    asyncHandler(controller.updateAddress),
  );
  router.delete(
    "/addresses/:id",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    asyncHandler(controller.deleteAddress),
  );
  router.post(
    "/addresses/:id/default",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    asyncHandler(controller.defaultAddress),
  );
  router.post(
    "/checkout/preview",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    validateBody(checkoutPreviewSchema),
    asyncHandler(controller.checkoutCombinedPreview),
  );
  router.post(
    "/checkout/confirm",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    validateBody(checkoutConfirmSchema),
    withIdempotency({ operation: "POST /checkout/confirm", tier: "financial", fingerprint: (req) => ({ params: req.params }) }),
    asyncHandler(controller.checkoutCombinedConfirm),
  );
  router.post(
    "/checkout/states/:stateId/preview",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    validateBody(checkoutPreviewSchema),
    asyncHandler(controller.checkoutPreview),
  );
  router.post(
    "/checkout/states/:stateId/confirm",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    validateBody(checkoutConfirmSchema),
    withIdempotency({ operation: "POST /checkout/states/:stateId/confirm", tier: "financial", fingerprint: (req) => ({ params: req.params }) }),
    asyncHandler(controller.checkoutConfirm),
  );
  router.get("/orders", asyncHandler(controller.listOrders));
  // Registered ahead of /orders/:id below, since that route would otherwise
  // match "pending-approvals" as an :id.
  router.get(
    "/orders/pending-approvals",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    asyncHandler(controller.pendingApprovals),
  );
  router.get("/orders/:id", asyncHandler(controller.getOrder));
  router.get(
    "/orders/:id/receipt",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    asyncHandler(fulfilment.customerReceipt),
  );
  router.get(
    "/orders/:id/fulfilment",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    asyncHandler(fulfilment.customerFulfilment),
  );
  router.post(
    "/orders/:orderId/substitutions/:id/respond",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    validateBody(z.object({ decision: z.enum(['ACCEPT', 'DECLINE']), version: z.coerce.number().int().positive() }).strict()),
    withIdempotency({ operation: 'POST /orders/:orderId/substitutions/:id/respond', tier: 'financial', fingerprint: (req) => ({ params: req.params }) }),
    asyncHandler(fulfilment.customerItemResolution),
  );
  router.post(
    "/orders/:id/returns",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    validateBody(
      z
        .object({
          reasonType: z.enum([
            "DAMAGED",
            "WRONG_ITEM",
            "NOT_DELIVERED",
            "CUSTOMER_PREFERENCE",
            "OTHER",
          ]),
          reason: z.string().min(3).max(2000),
          orderItemIds: z.array(z.string().min(1)).min(1),
          evidenceAssetIds: z.array(z.string().min(1)).max(10).default([]),
        })
        .strict(),
    ),
    asyncHandler(fulfilment.customerReturn),
  );
  router.post(
    "/orders/:id/cancel",
    validateBody(z.object({ reason: z.string().optional() })),
    withIdempotency({ operation: "POST /orders/:id/cancel", tier: "consequential" }),
    asyncHandler(controller.cancelOrder),
  );
  router.post(
    "/orders/:id/refunds",
    validateBody(customerRefundRequestSchema),
    withIdempotency({ operation: "POST /orders/:id/refunds", tier: "financial" }),
    asyncHandler(controller.requestRefund),
  );

  router.get("/negotiations", asyncHandler(negotiations.list));
  router.get("/negotiations-active", asyncHandler(negotiations.active));
  router.post(
    "/negotiations",
    validateBody(negotiationCreateSchema),
    asyncHandler(negotiations.create),
  );
  router.get("/negotiations/:id", asyncHandler(negotiations.detail));
  router.post('/negotiations/:id/messages', validateBody(z.object({ message: z.string().trim().min(1).max(500) }).strict()), asyncHandler(negotiations.message));
  router.post('/negotiations/:id/actions/:actionId/confirm', validateBody(z.object({ quantity: z.number().int().min(1).max(20), variantId: z.string().min(1).max(100) }).strict()), asyncHandler(negotiations.confirmAction));
  router.post(
    "/negotiations/:id/offers",
    validateBody(negotiationOfferSchema),
    asyncHandler(negotiations.offer),
  );
  router.post("/negotiations/:id/accept", asyncHandler(negotiations.accept));
  router.post("/negotiations/:id/close", asyncHandler(negotiations.close));

  router.post(
    "/payments/initialize",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    validateBody(paymentInitializeV4Schema),
    withIdempotency({ operation: "POST /payments/initialize", tier: "financial" }),
    asyncHandler(controller.initializePayment),
  );
  router.post(
    "/payments/links",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    validateBody(paymentLinkCreateSchema),
    withIdempotency({ operation: "POST /payments/links", tier: "financial" }),
    asyncHandler(paymentLinks.create),
  );
  router.post(
    "/payments/links/:id/revoke",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    asyncHandler(paymentLinks.revoke),
  );
  router.get(
    "/payments/:orderId",
    requireAuth,
    requireAccountType(AccountType.CUSTOMER),
    asyncHandler(controller.paymentStatus),
  );
  router.get(
    "/payments/orders/:orderId/status",
    asyncHandler(controller.paymentStatus),
  );
  router.get("/notifications", asyncHandler(controller.listNotifications));
  router.get("/notifications/preferences", asyncHandler(controller.notificationPreferences));
  router.patch(
    "/notifications/preferences",
    validateBody(z.object({
      groups: z.object({ credit: z.boolean(), reminders: z.boolean(), discovery: z.boolean() }).partial().strict().optional(),
      quietHours: z.object({
        enabled: z.boolean(),
        start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      }).partial().strict().optional(),
    }).strict()),
    asyncHandler(controller.updateNotificationPreferences),
  );
  router.post("/notifications/:id/opened", asyncHandler(controller.notificationOpened));
  router.patch(
    "/notifications/read-all",
    asyncHandler(controller.markAllNotificationsRead),
  );
  router.delete(
    "/notifications/clear",
    asyncHandler(controller.clearNotifications),
  );
  router.get("/notifications/:id", asyncHandler(controller.getNotification));
  router.patch(
    "/notifications/:id/read",
    asyncHandler(controller.markNotificationRead),
  );
  router.delete(
    "/notifications/:id",
    asyncHandler(controller.deleteNotification),
  );

  return router;
}
