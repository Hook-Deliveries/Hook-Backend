import { Router } from "express";
import { AdminCategoriesController } from "@controllers/admin/categories.controller";
import { AdminCouponsController } from "@controllers/admin/coupons.controller";
import { AdminSavedViewsController } from "@controllers/admin/saved-views.controller";
import { AdminWaitlistController } from "@controllers/admin/waitlist.controller";
import { AdminCommunicationsController } from "@controllers/admin/communications.controller";
import { AdminFaqController } from "@controllers/admin/faq.controller";
import { AdminLogisticsProvidersController } from "@controllers/admin/logistics-providers.controller";
import { AdminDashboardController } from "@controllers/admin/dashboard.controller";
import { AdminOverviewController } from "@controllers/admin/overview.controller";
import { AdminFinancialsController } from "@controllers/admin/financials.controller";
import { AdminNegotiationsController } from "@controllers/admin/negotiations.controller";
import { AdminOrdersController } from "@controllers/admin/orders.controller";
import { AdminOperationsController } from "@controllers/admin/operations.controller";
import { AdminSearchController } from "@controllers/admin/search.controller";
import { AdminProductsController } from "@controllers/admin/products.controller";
import { AdminReportsController } from "@controllers/admin/reports.controller";
import { AdminSettingsController } from "@controllers/admin/settings.controller";
import { AdminBannersController } from "@controllers/admin/banners.controller";
import { AdminLegalContentController } from "@controllers/admin/legal-content.controller";
import { AdminUsersController } from "@controllers/admin/users.controller";
import { AdminCommerceController } from "@controllers/admin/commerce.controller";
import { AdminCatalogReviewController } from "@controllers/admin/catalog-review.controller";
import { AdminCommercialCatalogController } from "@controllers/admin/commercial-catalog.controller";
import { AdminEmailSettingsController } from "@controllers/admin/email-settings.controller";
import { createAdminAuthRouter } from "@controllers/admin/admin-auth.controller";
import { createPlatformAdminRouter } from "./platform";
import { requireAuth } from "@middleware/auth";
import { platformContext } from "@middleware/platform-context";
import { requireAdmin, requireSuperAdmin } from "@middleware/roles";
import { requireAnyPermission, requirePermission } from "@middleware/permissions";
import { validateBody } from "@middleware/validate";
import { withIdempotency } from '@middleware/idempotency';
import {
  adminUserSchema,
  categoryCreateSchema,
  categoryUpdateSchema,
  adminProductCreateSchema,
  adminProductUpdateSchema,
  operationalStateAssignSchema,
  operationalStateToggleSchema,
  productReviewSchema,
  reportSchema,
  roleSchema,
  settingsSchema,
  adminRefundReviewSchema,
  deletionUpdateSchema,
  refundSchema,
  adminGiftCreditSchema,
  waitlistBroadcastSchema,
  waitlistGiftSchema,
  communicationsPreviewSchema,
  communicationsSendSchema,
  faqCreateSchema,
  faqUpdateSchema,
} from "@validations/common.schemas";
import {
  lifecycleReasonSchema,
  negotiationRulesSchema,
  reviewReasonSchema,
  reviewStartSchema,
  submissionApproveAsProductSchema,
} from "@validations/catalog.schemas";
import {
  couponCreateSchema,
  couponUpdateSchema,
  logisticsProviderCreateSchema,
  logisticsProviderUpdateSchema,
} from "@validations/promotions.schemas";
import { asyncHandler } from "@utils/http";
import {
  commerceSettingsSchema,
  emailSettingsSchema,
  inventorySettingsSchema,
  checkoutSettingsSchema,
  hookCoinSettingsSchema,
  adminOrderUpdateSchema,
  adminOrderCancelSchema,
  adminOrderSplitSchema,
  paymentProviderSettingsSchema,
  pricingConfigSchema,
} from "@validations/commerce.schemas";
import { z } from "zod";
import { FulfilmentController } from "@controllers/fulfilment.controller";
import { AdminNotificationsController } from "@controllers/admin/notifications.controller";
import { AdminDeliveryController } from "@controllers/admin/delivery.controller";
import { UploadController } from "@controllers/upload.controller";
import { upload } from "@middleware/upload";
import { AppReleasesController } from '@controllers/admin/app-releases.controller';
import { appReleaseSchema, versionAnnouncementSchema } from '@lib/app-release-policy';

export function createAdminRouter() {
  const router = Router();
  const dashboard = new AdminDashboardController();
  const overview = new AdminOverviewController();
  const users = new AdminUsersController();
  const products = new AdminProductsController();
  const orders = new AdminOrdersController();
  const financials = new AdminFinancialsController();
  const negotiations = new AdminNegotiationsController();
  const reports = new AdminReportsController();
  const settings = new AdminSettingsController();
  const legalContent = new AdminLegalContentController();
  const banners = new AdminBannersController();
  const search = new AdminSearchController();
  const categories = new AdminCategoriesController();
  const coupons = new AdminCouponsController();
  const savedViews = new AdminSavedViewsController();
  const waitlist = new AdminWaitlistController();
  const communications = new AdminCommunicationsController();
  const faqs = new AdminFaqController();
  const logisticsProviders = new AdminLogisticsProvidersController();
  const operations = new AdminOperationsController();
  const commerce = new AdminCommerceController();
  const catalogReview = new AdminCatalogReviewController();
  const commercial = new AdminCommercialCatalogController();
  const emailSettings = new AdminEmailSettingsController();
  const fulfilment = new FulfilmentController();
  const notifications = new AdminNotificationsController();
  const delivery = new AdminDeliveryController();
  const uploads = new UploadController();

  // ── Public admin auth (no token required) ──────────────────────────────
  router.use("/auth", createAdminAuthRouter());

  // ── All routes below require a valid admin token ───────────────────────
  router.use(requireAuth, requireAdmin);
  router.use(platformContext);
  const releases = new AppReleasesController();
  router.get('/app-releases', requirePermission('app_releases.view'), asyncHandler(releases.list));
  router.post('/app-releases', requirePermission('app_releases.manage'), validateBody(z.union([versionAnnouncementSchema, appReleaseSchema])), asyncHandler(releases.create));
  router.post('/app-releases/:id/publish', requirePermission('app_releases.manage'), validateBody(z.object({ storeAvailable: z.literal(true) }).strict()), asyncHandler(releases.publish));
  router.post('/app-releases/:id/withdraw', requirePermission('app_releases.manage'), validateBody(z.object({}).strict()), asyncHandler(releases.withdraw));
  router.post(
    "/uploads/images",
    // Shared utility: every area that attaches an image needs it, so it is
    // gated on holding any one of their manage permissions rather than on
    // markets.manage alone.
    requireAnyPermission(
      "markets.manage",
      "products.edit",
      "categories.manage",
      "coupons.manage",
      "logistics.manage",
      "hubs.manage",
      "partners.manage",
      "catalog.media.upload",
    ),
    upload.array("images", Number(process.env.UPLOAD_MAX_FILES || 8)),
    asyncHandler(uploads.images),
  );
  router.use("/", createPlatformAdminRouter());

  // Customer notifications stay outside the staff route group.
  // Keep staff notifications on an explicit admin path so the Admin shell
  // never presents a customer identity to the API.
  router.get("/notifications", asyncHandler(notifications.list));
  router.patch("/notifications/read-all", asyncHandler(notifications.markAllRead));
  router.patch("/notifications/:id/read", asyncHandler(notifications.markRead));
  router.post(
    "/push/subscribe",
    validateBody(z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }) })),
    asyncHandler(notifications.subscribePush),
  );
  router.post(
    "/push/unsubscribe",
    validateBody(z.object({ endpoint: z.string().url() })),
    asyncHandler(notifications.unsubscribePush),
  );

  // ── Search (permission-scoped — controller reads user from req) ────────
  router.get("/search", asyncHandler(search.global));

  // ── Dashboard & analytics (all admin roles) ────────────────────────────
  router.get("/overview", asyncHandler(overview.overview));
  router.get("/dashboard", asyncHandler(dashboard.dashboard));
  router.get("/analytics", asyncHandler(dashboard.analytics));
  router.get("/health", asyncHandler(dashboard.health));

  // ── Operations catalog (Nigeria-first operating states) ───────────────
  router.get("/operations/states", asyncHandler(operations.listStates));
  router.patch(
    "/operations/states/:code",
    requireSuperAdmin,
    validateBody(operationalStateToggleSchema),
    asyncHandler(operations.setStateStatus),
  );
  router.post(
    "/operations/states/reset",
    requireSuperAdmin,
    asyncHandler(operations.resetCatalog),
  );

  // ── Users / Customers ──────────────────────────────────────────────────
  router.get(
    "/users",
    requirePermission("customers.view"),
    asyncHandler(users.list),
  );
  router.get(
    "/customers",
    requirePermission("customers.view"),
    asyncHandler(users.customers),
  );
  router.get(
    "/users/:id",
    requirePermission("customers.view"),
    asyncHandler(users.detail),
  );
  router.post(
    "/users",
    requireSuperAdmin,
    validateBody(adminUserSchema),
    asyncHandler(users.create),
  );
  router.patch(
    "/users/:id/toggle",
    requirePermission("customers.edit"),
    asyncHandler(users.toggle),
  );
  router.patch(
    "/users/:id/role",
    requireSuperAdmin,
    validateBody(roleSchema),
    asyncHandler(users.role),
  );
  router.post(
    "/users/:id/soft-delete",
    requirePermission("customers.edit"),
    asyncHandler(users.softDelete),
  );
  router.post(
    "/users/:id/restore",
    requirePermission("customers.edit"),
    asyncHandler(users.restore),
  );
  router.post(
    "/users/:id/hard-delete",
    requireSuperAdmin,
    asyncHandler(users.hardDelete),
  );
  router.post(
    "/users/:id/gift-credit",
    requirePermission("credits.adjust"),
    validateBody(adminGiftCreditSchema),
    asyncHandler(users.giftCredit),
  );

  // ── Categories (taxonomy managed through explicit catalog permissions) ──
  router.get(
    "/categories",
    requirePermission("categories.view"),
    asyncHandler(categories.list),
  );
  router.post(
    "/categories",
    requirePermission("categories.manage"),
    validateBody(categoryCreateSchema),
    asyncHandler(categories.create),
  );
  // Registered before /categories/:id so "reorder" is never read as an id.
  router.patch(
    "/categories/reorder",
    requirePermission("categories.manage"),
    validateBody(z.object({ ids: z.array(z.string().min(3).max(80)).min(2).max(200) }).strict()),
    asyncHandler(categories.reorder),
  );
  router.get(
    "/categories/:id",
    requirePermission("categories.view"),
    asyncHandler(categories.detail),
  );
  router.patch(
    "/categories/:id",
    requirePermission("categories.manage"),
    validateBody(categoryUpdateSchema),
    asyncHandler(categories.update),
  );
  router.get(
    "/categories/:id/manager-options",
    requirePermission("categories.view"),
    asyncHandler(categories.managerOptions),
  );
  router.put(
    "/categories/:id/managers",
    requirePermission("categories.manage"),
    validateBody(z.object({ userIds: z.array(z.string().min(3).max(80)).max(50) }).strict()),
    asyncHandler(categories.setManagers),
  );
  router.patch(
    "/categories/:id/toggle",
    requirePermission("categories.manage"),
    asyncHandler(categories.toggle),
  );
  router.delete(
    "/categories/:id",
    requirePermission("categories.manage"),
    asyncHandler(categories.remove),
  );

  // ── Logistics providers (the courier list customers pick at checkout) ──
  router.get(
    "/logistics-providers",
    requirePermission("logistics.view"),
    asyncHandler(logisticsProviders.list),
  );
  router.post(
    "/logistics-providers",
    requirePermission("logistics.manage"),
    validateBody(logisticsProviderCreateSchema),
    asyncHandler(logisticsProviders.create),
  );
  router.get(
    "/logistics-providers/:id",
    requirePermission("logistics.view"),
    asyncHandler(logisticsProviders.detail),
  );
  router.patch(
    "/logistics-providers/:id",
    requirePermission("logistics.manage"),
    validateBody(logisticsProviderUpdateSchema),
    asyncHandler(logisticsProviders.update),
  );
  router.delete(
    "/logistics-providers/:id",
    requirePermission("logistics.manage"),
    asyncHandler(logisticsProviders.remove),
  );

  // ── Coupons ────────────────────────────────────────────────────────────
  router.get(
    "/coupons",
    requirePermission("coupons.view"),
    asyncHandler(coupons.list),
  );
  router.post(
    "/coupons",
    requirePermission("coupons.manage"),
    validateBody(couponCreateSchema),
    asyncHandler(coupons.create),
  );
  router.get(
    "/coupons/:id",
    requirePermission("coupons.view"),
    asyncHandler(coupons.detail),
  );
  router.get(
    "/coupons/:id/redemptions",
    requirePermission("coupons.view"),
    asyncHandler(coupons.redemptions),
  );
  router.patch(
    "/coupons/:id",
    requirePermission("coupons.manage"),
    validateBody(couponUpdateSchema),
    asyncHandler(coupons.update),
  );
  router.delete(
    "/coupons/:id",
    requirePermission("coupons.manage"),
    asyncHandler(coupons.remove),
  );

  // ── Saved views (per-admin, per-page filter presets) ─────────────────────
  router.get(
    "/saved-views",
    requirePermission("products.view"),
    asyncHandler(savedViews.list),
  );
  router.post(
    "/saved-views",
    requirePermission("products.view"),
    validateBody(z.object({
      page: z.string().trim().min(1).max(40),
      name: z.string().trim().min(1).max(80),
      params: z.record(z.string(), z.string()),
    }).strict()),
    asyncHandler(savedViews.create),
  );
  router.delete(
    "/saved-views/:id",
    requirePermission("products.view"),
    asyncHandler(savedViews.remove),
  );

  // ── Waitlist ───────────────────────────────────────────────────────────
  router.get(
    "/waitlist",
    requirePermission("waitlist.view"),
    asyncHandler(waitlist.list),
  );
  router.delete(
    "/waitlist/:id",
    requirePermission("waitlist.manage"),
    asyncHandler(waitlist.remove),
  );
  router.post(
    "/waitlist/broadcast",
    requirePermission("waitlist.manage"),
    validateBody(waitlistBroadcastSchema),
    asyncHandler(waitlist.broadcast),
  );
  router.post(
    "/waitlist/gift",
    requirePermission("waitlist.manage"),
    validateBody(waitlistGiftSchema),
    asyncHandler(waitlist.gift),
  );

  // ── Communications (targeted push/email/inbox broadcasts) ───────────────
  router.get(
    "/communications",
    requirePermission("communications.send"),
    asyncHandler(communications.list),
  );
  router.get(
    "/communications/search-users",
    requirePermission("communications.send"),
    asyncHandler(communications.searchUsers),
  );
  router.post(
    "/communications/preview",
    requirePermission("communications.send"),
    validateBody(communicationsPreviewSchema),
    asyncHandler(communications.preview),
  );
  router.post(
    "/communications/send",
    requirePermission("communications.send"),
    validateBody(communicationsSendSchema),
    asyncHandler(communications.send),
  );
  router.delete(
    "/communications/:id",
    requirePermission("communications.send"),
    asyncHandler(communications.remove),
  );

  // ── FAQs (shown on /help and in the app) ────────────────────────────────
  router.get("/faqs", requirePermission("faq.view"), asyncHandler(faqs.list));
  router.post("/faqs", requirePermission("faq.manage"), validateBody(faqCreateSchema), asyncHandler(faqs.create));
  router.patch("/faqs/:id", requirePermission("faq.manage"), validateBody(faqUpdateSchema), asyncHandler(faqs.update));
  router.delete("/faqs/:id", requirePermission("faq.manage"), asyncHandler(faqs.remove));

  // ── Products ───────────────────────────────────────────────────────────
  router.get(
    "/catalog/review/dashboard",
    requirePermission("catalog.submission.view"),
    asyncHandler(catalogReview.dashboard),
  );
  router.get(
    "/catalog/review",
    requirePermission("catalog.submission.view"),
    asyncHandler(catalogReview.list),
  );
  router.get(
    "/catalog/review/:id",
    requirePermission("catalog.submission.view"),
    asyncHandler(catalogReview.detail),
  );
  router.post(
    "/catalog/review/:id/start",
    requirePermission("catalog.submission.review"),
    validateBody(reviewStartSchema),
    asyncHandler(catalogReview.start),
  );
  router.post(
    "/catalog/review/:id/request-changes",
    requirePermission("catalog.submission.request_changes"),
    validateBody(reviewReasonSchema),
    asyncHandler(catalogReview.requestChanges),
  );
  router.post(
    "/catalog/review/:id/approve",
    requirePermission("catalog.submission.approve"),
    validateBody(submissionApproveAsProductSchema),
    asyncHandler(catalogReview.approve),
  );
  router.post(
    "/catalog/review/:id/reject",
    requirePermission("catalog.submission.reject"),
    validateBody(reviewReasonSchema),
    asyncHandler(catalogReview.reject),
  );

  router.get(
    "/products/review",
    requirePermission("products.review"),
    asyncHandler(products.reviewQueue),
  );
  router.get(
    "/products/stats",
    requirePermission("products.view"),
    asyncHandler(products.stats),
  );
  router.get(
    "/products",
    requirePermission("products.view"),
    asyncHandler(products.list),
  );
  router.post(
    "/products/recategorise",
    requirePermission("products.edit"),
    validateBody(z.object({ productIds: z.array(z.string().min(3).max(80)).min(1).max(500), categoryId: z.string().min(3).max(80) }).strict()),
    asyncHandler(products.recategorise),
  );
  router.post(
    "/products",
    requirePermission("products.create"),
    validateBody(adminProductCreateSchema),
    asyncHandler(products.create),
  );
  router.get(
    "/products/:id",
    requirePermission("products.view"),
    asyncHandler(products.detail),
  );
  router.patch(
    "/products/:id",
    requirePermission("products.edit"),
    validateBody(adminProductUpdateSchema),
    asyncHandler(products.update),
  );
  router.patch(
    "/products/:id/review",
    requirePermission("products.review"),
    validateBody(productReviewSchema),
    asyncHandler(products.review),
  );
  router.patch(
    "/products/:id/disable",
    requirePermission("products.edit"),
    asyncHandler(products.disable),
  );
  router.delete(
    "/products/:id",
    requireSuperAdmin,
    asyncHandler(products.remove),
  );
  router.patch(
    "/products/:id/negotiation-rules",
    requirePermission("catalog.negotiation_rules.edit"),
    validateBody(negotiationRulesSchema),
    asyncHandler(commercial.rules),
  );
  router.post(
    "/products/:id/publish",
    requirePermission("catalog.product.publish"),
    validateBody(lifecycleReasonSchema),
    asyncHandler(commercial.publish),
  );
  router.post(
    "/products/:id/pause",
    requirePermission("catalog.product.pause"),
    validateBody(lifecycleReasonSchema),
    asyncHandler(commercial.pause),
  );
  router.post(
    "/products/:id/unpublish",
    requirePermission("catalog.product.unpublish"),
    validateBody(lifecycleReasonSchema),
    asyncHandler(commercial.unpublish),
  );
  router.post(
    "/products/:id/availability-check",
    requirePermission("catalog.availability.manage"),
    validateBody(lifecycleReasonSchema),
    asyncHandler(commercial.availabilityUnconfirmed),
  );

  // ── Orders ─────────────────────────────────────────────────────────────
  router.get(
    "/orders/stats",
    requirePermission("orders.view"),
    asyncHandler(orders.stats),
  );
  router.get(
    "/orders",
    requirePermission("orders.view"),
    asyncHandler(orders.list),
  );
  // Phase 4 Orders are created only by the Checkout service.
  router.get(
    "/orders/:id",
    requirePermission("orders.view"),
    asyncHandler(orders.detail),
  );
  router.patch(
    "/orders/:id",
    requirePermission("orders.edit"),
    validateBody(adminOrderUpdateSchema),
    asyncHandler(orders.updateDelivery),
  );
  router.post(
    "/orders/:id/split",
    requirePermission("orders.edit"),
    validateBody(adminOrderSplitSchema),
    asyncHandler(orders.split),
  );
  router.post(
    "/orders/:id/cancel",
    requirePermission("orders.cancel"),
    validateBody(adminOrderCancelSchema),
    asyncHandler(orders.cancel),
  );
  router.get(
    "/commerce/payments",
    requirePermission("commerce.payments.view"),
    asyncHandler(commerce.payments),
  );
  router.get(
    "/commerce/payments/:id",
    requirePermission("commerce.payments.view"),
    asyncHandler(commerce.paymentDetail),
  );
  router.get(
    "/commerce/integration-exceptions",
    requirePermission("commerce.payments.reconcile"),
    asyncHandler(commerce.exceptions),
  );
  router.get(
    "/commerce/outbox",
    requirePermission("commerce.outbox.view"),
    asyncHandler(commerce.outbox),
  );
  router.get(
    "/commerce/outbox/dead-letters",
    requirePermission("commerce.outbox.view"),
    asyncHandler(commerce.deadLetters),
  );
  router.post(
    "/commerce/outbox/dead-letters/:id/replay",
    requirePermission("commerce.outbox.replay"),
    asyncHandler(commerce.replayDeadLetter),
  );
  router.get(
    "/commerce/settings",
    requireSuperAdmin,
    asyncHandler(commerce.settings),
  );
  router.patch(
    "/commerce/settings",
    requireSuperAdmin,
    validateBody(commerceSettingsSchema),
    asyncHandler(commerce.updateSettings),
  );
  router.get(
    "/commerce/payment-providers",
    requirePermission("commerce.settings.view"),
    asyncHandler(commerce.paymentProviders),
  );
  router.patch(
    "/commerce/payment-providers",
    requirePermission("commerce.settings.manage"),
    validateBody(paymentProviderSettingsSchema),
    asyncHandler(commerce.updatePaymentProviders),
  );
  router.get(
    "/commerce/pricing-config",
    requirePermission("commerce.settings.view"),
    asyncHandler(commerce.pricingConfig),
  );
  router.patch(
    "/commerce/pricing-config",
    requirePermission("commerce.settings.manage"),
    validateBody(pricingConfigSchema),
    asyncHandler(commerce.updatePricingConfig),
  );
  router.get(
    "/commerce/checkout-settings",
    requirePermission("commerce.settings.view"),
    asyncHandler(commerce.checkoutSettings),
  );
  router.patch(
    "/commerce/checkout-settings",
    requirePermission("commerce.settings.manage"),
    validateBody(checkoutSettingsSchema),
    asyncHandler(commerce.updateCheckoutSettings),
  );
  router.get(
    "/commerce/inventory-settings",
    requirePermission("commerce.settings.view"),
    asyncHandler(commerce.inventorySettings),
  );
  router.patch(
    "/commerce/inventory-settings",
    requirePermission("commerce.settings.manage"),
    validateBody(inventorySettingsSchema),
    asyncHandler(commerce.updateInventorySettings),
  );
  router.get(
    "/commerce/hook-coin-settings",
    requirePermission("commerce.settings.view"),
    asyncHandler(commerce.hookCoinSettings),
  );
  router.patch(
    "/commerce/hook-coin-settings",
    requirePermission("commerce.settings.manage"),
    validateBody(hookCoinSettingsSchema),
    asyncHandler(commerce.updateHookCoinSettings),
  );
  // Read-only support contact for any signed-in staff member. The full email
  // settings endpoint below needs commerce.settings.view, which operational
  // roles do not hold — but they still need somewhere to escalate a blocked
  // task to, so the address alone is exposed here.
  router.get(
    "/support-contact",
    asyncHandler(emailSettings.supportContact),
  );
  router.get(
    "/settings/email",
    requirePermission("commerce.settings.view"),
    asyncHandler(emailSettings.get),
  );
  router.patch(
    "/settings/email",
    requirePermission("commerce.settings.manage"),
    validateBody(emailSettingsSchema),
    asyncHandler(emailSettings.update),
  );

  // ── Phase 5 fulfilment, Hub, logistics, returns and refunds ───────────
  router.get('/fulfilment/control-tower', requirePermission('fulfilment.view'), asyncHandler(fulfilment.controlTower));
  router.get('/fulfilment/tasks/:id', requirePermission('fulfilment.view'), asyncHandler(fulfilment.adminTaskDetail));
  router.post('/fulfilment/issues/:id/proposals', requirePermission('fulfilment.assign'), validateBody(z.object({ version: z.coerce.number().int().positive(), productId: z.string().min(1).optional(), productTitle: z.string().min(1).max(200), productImage: z.string().url().optional(), color: z.string().min(1).max(80), size: z.string().min(1).max(80), quantity: z.coerce.number().int().positive(), unitPriceMinor: z.coerce.number().int().nonnegative(), reason: z.string().min(3).max(1000) }).strict()), asyncHandler(fulfilment.proposeItemResolution));
  router.get('/fulfilment/market-associates', requirePermission('fulfilment.assign'), asyncHandler(fulfilment.assignmentMarketAssociates));
  router.get('/fulfilment/hubs', requireAnyPermission('fulfilment.hub.view', 'fulfilment.assign'), asyncHandler(fulfilment.assignmentHubs));
  router.post('/fulfilment/tasks/:id/reassign', requirePermission('fulfilment.assign'), validateBody(z.object({ marketAssociateId: z.string().min(1), hubId: z.string().min(1), version: z.coerce.number().int().positive(), reason: z.string().min(3).max(1000) }).strict()), asyncHandler(fulfilment.reassignTask));
  router.post('/fulfilment/tasks/:id/unblock', requirePermission('fulfilment.assign'), validateBody(z.object({ reason: z.string().trim().min(3).max(500) }).strict()), asyncHandler(fulfilment.unblockTask));
  router.get('/fulfilment/hub', requirePermission('fulfilment.hub.view'), asyncHandler(fulfilment.hubDashboard));
  router.get('/fulfilment/consolidations', requirePermission('fulfilment.hub.view'), asyncHandler(fulfilment.adminConsolidations));
  router.post('/fulfilment/packages/:id/receive', requirePermission('fulfilment.hub.receive'), validateBody(z.object({ hubId: z.string().min(1), scanCredential: z.string().regex(/^\d{4}$/), idempotencyKey: z.string().min(8), stateId: z.string().optional(), evidence: z.array(z.object({ type: z.string().min(1), url: z.string().url().optional(), assetId: z.string().optional(), note: z.string().max(500).optional() })).optional() }).strict()), asyncHandler(fulfilment.receivePackage));
  router.post('/fulfilment/packages/:id/qc', requirePermission('fulfilment.hub.qc'), validateBody(z.object({ version: z.coerce.number().int().positive().optional(), passed: z.boolean(), checks: z.array(z.record(z.string(), z.unknown())).default([]), failures: z.array(z.object({ orderItemId: z.string().min(1), reason: z.enum(['WRONG_PRODUCT', 'WRONG_SIZE', 'WRONG_COLOR', 'DAMAGED', 'MISSING', 'OTHER']), note: z.string().trim().min(3).max(500) }).strict()).max(50).optional() }).strict()), asyncHandler(fulfilment.qualityCheck));
  router.post('/fulfilment/packages/:id/resource', requirePermission('fulfilment.hub.qc'), validateBody(z.object({ version: z.coerce.number().int().positive().optional(), note: z.string().trim().max(500).optional() }).strict()), asyncHandler(fulfilment.resourceFailedPackage));
  router.post('/fulfilment/packages/:id/qc/reopen', requirePermission('fulfilment.hub.qc'), validateBody(z.object({ version: z.coerce.number().int().positive().optional() }).strict()), asyncHandler(fulfilment.reopenQualityCheck));
  router.post('/fulfilment/orders/:id/consolidate', requirePermission('fulfilment.consolidate'), validateBody(z.object({ hubId: z.string().min(1) }).strict()), asyncHandler(fulfilment.consolidate));
  router.post('/fulfilment/consolidations/:id/seal', requirePermission('fulfilment.consolidate'), validateBody(z.object({ version: z.coerce.number().int().positive().optional(), weightGrams: z.number().positive().optional(), dimensions: z.object({ lengthCm: z.number().positive(), widthCm: z.number().positive(), heightCm: z.number().positive() }).optional(), sealReference: z.string().max(100).optional() }).strict()), asyncHandler(fulfilment.sealConsolidation));
  router.get('/fulfilment/shipments', requirePermission('logistics.view'), asyncHandler(fulfilment.adminShipments));
  router.get('/fulfilment/orders/:id/receipt', requireAnyPermission('fulfilment.hub.view', 'fulfilment.view'), asyncHandler(fulfilment.orderReceipt));
  router.post('/fulfilment/orders/:id/receipt/print', requireAnyPermission('fulfilment.hub.view', 'fulfilment.view'), validateBody(z.object({ size: z.enum(['a6', 'a4', 'thermal']).optional(), consolidationId: z.string().max(60).optional() }).strict()), asyncHandler(fulfilment.recordReceiptPrint));
  router.get('/fulfilment/overview', requirePermission('fulfilment.view'), asyncHandler(fulfilment.fulfilmentOverview));
  router.post('/fulfilment/shipments/:id/reassign-courier', requirePermission('logistics.manage'), validateBody(z.object({ courierCode: z.string().trim().min(1).max(40), reason: z.string().trim().min(3).max(500), version: z.coerce.number().int().positive().optional() }).strict()), asyncHandler(fulfilment.reassignShipmentCourier));
  router.get('/fulfilment/logistics/readiness', requirePermission('logistics.view'), asyncHandler(fulfilment.logisticsReadiness));
  router.post('/fulfilment/orders/:id/shipments', requirePermission('logistics.book'), validateBody(z.object({ provider: z.enum(['manual', 'simulated', 'gig', 'fez', 'other']), hubId: z.string().min(1), courierCode: z.string().trim().max(40).optional(), substitutionReason: z.string().trim().min(3).max(500).optional(), serviceName: z.string().max(100).optional(), externalReference: z.string().max(160).optional(), trackingNumber: z.string().max(160).optional(), estimatedDeliveryAt: z.string().datetime().optional(), providerCostMinor: z.number().int().nonnegative().optional(), providerQuoteMinor: z.number().int().nonnegative().optional(), idempotencyKey: z.string().min(8), evidence: z.array(z.object({ type: z.string().min(1), url: z.string().url().optional(), assetId: z.string().optional(), note: z.string().max(500).optional() })).optional() }).strict()), withIdempotency({ operation: 'POST /admin/fulfilment/orders/:id/shipments', tier: 'financial' }), asyncHandler(fulfilment.createShipment));
  router.patch('/fulfilment/shipments/:id', requirePermission('logistics.manage'), validateBody(z.object({ status: z.string().min(1), version: z.coerce.number().int().positive().optional(), note: z.string().max(500).optional() }).strict()), asyncHandler(fulfilment.updateShipment));
  router.get('/fulfilment/returns', requirePermission('returns.view'), asyncHandler(fulfilment.adminReturns));
  router.patch('/fulfilment/returns/:id/review', requirePermission('returns.review'), validateBody(z.object({ decision: z.enum(['APPROVED', 'REJECTED']), reason: z.string().min(3).max(1000) }).strict()), asyncHandler(fulfilment.adminReturnReview));
  router.get('/fulfilment/refunds', requirePermission('refunds.view'), asyncHandler(fulfilment.adminRefunds));
  router.post('/fulfilment/refunds', requirePermission('refunds.manage'), validateBody(z.object({ orderId: z.string().min(1), returnRequestId: z.string().optional(), amountMinor: z.number().int().positive(), reason: z.string().min(3).max(1000), idempotencyKey: z.string().min(8) }).strict()), withIdempotency({ operation: 'POST /admin/fulfilment/refunds', tier: 'financial' }), asyncHandler(fulfilment.adminRefund));
  router.post('/fulfilment/refunds/:id/process', requirePermission('finance.refunds.process'), validateBody(z.object({ idempotencyKey: z.string().min(8).optional(), reason: z.string().max(1000).optional() }).strict()), withIdempotency({ operation: 'POST /admin/fulfilment/refunds/:id/process', tier: 'financial' }), asyncHandler(fulfilment.adminRefundProcess));
  // ── Support operations ───────────────────────────────────────────────
  router.get(
    "/support/deletion-requests",
    requirePermission("deletions.view"),
    asyncHandler(commerce.deletionRequests),
  );
  router.patch(
    "/support/deletion-requests/:id",
    requirePermission("deletions.manage"),
    validateBody(deletionUpdateSchema),
    asyncHandler(commerce.updateDeletion),
  );

  // ── Financials (view gated by permission, write stays super_admin) ─────
  router.get(
    "/financials",
    requirePermission("financials.view"),
    asyncHandler(financials.dashboard),
  );
  router.get(
    "/financials/audit-logs",
    requireSuperAdmin,
    asyncHandler(financials.audit),
  );
  router.get(
    "/financials/payments",
    requirePermission("financials.view"),
    asyncHandler(financials.payments),
  );
  router.get(
    "/financials/escrow-ledger",
    requirePermission("financials.view"),
    asyncHandler(financials.escrow),
  );
  router.get(
    "/financials/reconciliation",
    requirePermission("financials.reconcile"),
    asyncHandler(financials.reconciliation),
  );
  router.get(
    "/financials/refund-requests",
    requirePermission("refunds.view"),
    asyncHandler(commerce.refundRequests),
  );
  router.patch(
    "/financials/refund-requests/:id/review",
    requirePermission("refunds.manage"),
    validateBody(adminRefundReviewSchema),
    asyncHandler(commerce.reviewRefund),
  );
  router.post(
    "/financials/refund-requests/:id/approve",
    requireSuperAdmin,
    validateBody(refundSchema.pick({ reason: true })),
    asyncHandler(commerce.approveRefund),
  );
  router.post(
    "/financials/payments/:paymentId/refund",
    requireSuperAdmin,
    validateBody(refundSchema),
    asyncHandler(financials.refund),
  );

  // ── Negotiations ──────────────────────────────────────────────────────
  router.get(
    "/negotiations",
    requirePermission("ai_negotiation.view"),
    asyncHandler(negotiations.list),
  );
  router.get(
    "/negotiations/:id",
    requirePermission("ai_negotiation.view"),
    asyncHandler(negotiations.detail),
  );
  router.get(
    "/negotiation-settings",
    requirePermission("ai_negotiation.view"),
    asyncHandler(negotiations.settings),
  );
  router.patch(
    "/negotiation-settings",
    requirePermission("ai_negotiation.manage"),
    validateBody(z.object({
      enabled: z.boolean(),
      sessionMode: z.enum(["fixed", "unlimited"]),
      sessionMinutes: z.number().int().min(1).max(1440),
      maximumOffers: z.number().int().min(1).max(10),
      quoteMinutes: z.number().int().min(1).max(1440),
      azureWordingEnabled: z.boolean(),
      cooldownMinutes: z.number().int().min(0).max(1440).optional(),
      maxSessionsPerDay: z.number().int().min(1).max(20).optional(),
      reason: z.string().trim().min(3).max(500),
    }).strict()),
    asyncHandler(negotiations.updateSettings),
  );

  // ── Reports ───────────────────────────────────────────────────────────
  router.get(
    "/reports",
    requirePermission("reports.view"),
    asyncHandler(reports.list),
  );
  router.post(
    "/reports/generate",
    requirePermission("reports.view"),
    validateBody(reportSchema),
    asyncHandler(reports.generate),
  );
  router.get(
    "/reports/:id",
    requirePermission("reports.view"),
    asyncHandler(reports.detail),
  );

  // ── Settings ──────────────────────────────────────────────────────────
  router.get(
    "/settings",
    requirePermission("settings.view"),
    asyncHandler(settings.get),
  );
  router.patch(
    "/settings",
    requireSuperAdmin,
    validateBody(settingsSchema),
    asyncHandler(settings.update),
  );
  router.get('/settings/catalog-availability', requirePermission('catalog.availability.view'), asyncHandler(settings.catalogAvailability));
  router.patch('/settings/catalog-availability', requirePermission('catalog.availability.manage'), validateBody(z.object({ catalogAvailabilityCheckDays: z.coerce.number().int().min(1).max(30), reason: z.string().trim().min(3).max(500) }).strict()), asyncHandler(settings.updateCatalogAvailability));
  const bannerBody = z.object({
    text: z.string().trim().min(3).max(140),
    imageUrl: z.string().trim().url().max(500).or(z.literal('')).optional(),
    linkType: z.enum(['category', 'product', 'market', 'none']).optional(),
    linkTarget: z.string().trim().max(120).optional(),
    placement: z.enum(['home', 'category', 'all']).optional(),
    tone: z.enum(['gold', 'dark', 'green', 'red']).optional(),
    colorBg: z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
    colorFg: z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).max(999).optional(),
    startsAt: z.coerce.date().nullable().optional(),
    endsAt: z.coerce.date().nullable().optional(),
  }).strict();
  router.get('/banners', requirePermission('settings.view'), asyncHandler(banners.list));
  router.post('/banners', requirePermission('settings.manage'), validateBody(bannerBody), asyncHandler(banners.create));
  // Registered before /banners/:id so "reorder" is never read as an id.
  router.patch('/banners/reorder', requirePermission('settings.manage'), validateBody(z.object({ ids: z.array(z.string().min(3).max(80)).min(2).max(200) }).strict()), asyncHandler(banners.reorder));
  router.patch('/banners/:id', requirePermission('settings.manage'), validateBody(bannerBody.partial()), asyncHandler(banners.update));
  router.delete('/banners/:id', requirePermission('settings.manage'), asyncHandler(banners.remove));
  router.get('/legal/:type', requirePermission('settings.view'), asyncHandler(legalContent.get));
  router.patch('/legal/:type', requirePermission('settings.manage'), validateBody(z.object({ title: z.string().trim().min(1).max(200).optional(), bodyHtml: z.string().trim().min(1), effectiveDate: z.coerce.date().optional(), reason: z.string().trim().min(3).max(500) }).strict()), asyncHandler(legalContent.update));

  // ── Delivery coverage and fee rules ────────────────────────────────────
  router.get('/delivery', requirePermission('delivery.coverage.view'), asyncHandler(delivery.settings));
  router.get('/delivery/settings', requirePermission('delivery.coverage.view'), asyncHandler(delivery.settings));
  router.patch('/delivery/settings', requirePermission('delivery.pricing.manage'), validateBody(z.object({
    defaultDeliveryFeeMinor: z.number().int().nonnegative(),
    reason: z.string().trim().min(3).max(500).optional(),
  }).strict()), asyncHandler(delivery.updateSettings));
  router.get('/delivery/rules', requirePermission('delivery.pricing.view'), asyncHandler(delivery.listRules));
  router.post('/delivery/rules', requirePermission('delivery.pricing.manage'), validateBody(z.object({
    name: z.string().trim().min(2).max(120),
    scope: z.enum(['global', 'state']),
    scopeId: z.string().min(1).optional(),
    mode: z.enum(['flat', 'per_km', 'distance_bands']),
    flatFeeMinor: z.number().int().nonnegative().optional(),
    baseFeeMinor: z.number().int().nonnegative().optional(),
    feePerKmMinor: z.number().int().nonnegative().optional(),
    fallbackFeeMinor: z.number().int().nonnegative().optional(),
    originHubId: z.string().min(1).optional(),
    bands: z.array(z.object({ upToKm: z.number().positive(), feeMinor: z.number().int().nonnegative() }).strict()).max(20).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    effectiveFrom: z.coerce.date().optional(),
    effectiveUntil: z.coerce.date().optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  }).strict()), asyncHandler(delivery.createRule));
  router.patch('/delivery/rules/:id', requirePermission('delivery.pricing.manage'), validateBody(z.object({
    name: z.string().trim().min(2).max(120).optional(),
    scope: z.enum(['global', 'state']).optional(),
    scopeId: z.string().min(1).optional(),
    mode: z.enum(['flat', 'per_km', 'distance_bands']).optional(),
    flatFeeMinor: z.number().int().nonnegative().optional(),
    baseFeeMinor: z.number().int().nonnegative().optional(),
    feePerKmMinor: z.number().int().nonnegative().optional(),
    fallbackFeeMinor: z.number().int().nonnegative().optional(),
    originHubId: z.string().min(1).optional(),
    bands: z.array(z.object({ upToKm: z.number().positive(), feeMinor: z.number().int().nonnegative() }).strict()).max(20).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    effectiveFrom: z.coerce.date().optional(),
    effectiveUntil: z.coerce.date().optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  }).strict()), asyncHandler(delivery.updateRule));
  router.patch('/delivery/states/:id', requireAnyPermission('delivery.coverage.manage', 'delivery.pricing.manage'), validateBody(z.object({
    deliveryEnabled: z.boolean().optional(),
    deliveryFeeMinor: z.number().int().nonnegative().max(100_000_000).optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  }).strict().refine((body) => body.deliveryEnabled !== undefined || body.deliveryFeeMinor !== undefined, { message: 'Nothing to update' })), asyncHandler(delivery.toggleState));
  router.post('/delivery/locations/refresh', requirePermission('delivery.coverage.manage'), validateBody(z.object({
    reason: z.string().trim().min(3).max(500).optional(),
  }).strict()), asyncHandler(delivery.refreshLocations));
  router.post('/delivery/preview', requirePermission('delivery.pricing.preview'), validateBody(z.object({
    stateId: z.string().min(1),
    coordinates: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
  }).strict()), asyncHandler(delivery.preview));

  return router;
}
