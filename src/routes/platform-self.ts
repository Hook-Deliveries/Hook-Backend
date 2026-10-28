import { rateLimit } from "@middleware/security";
import { Router } from "express";
import { z } from "zod";
import { AccountType, ProductAvailabilityStatus } from "@lib/constants";
import { routeParam } from "@lib/api-utils";
import { requireAccountType, requireAuth } from "@middleware/auth";
import { validateBody } from "@middleware/validate";
import { withIdempotency } from '@middleware/idempotency';
import {
  HookPartner,
  MarketAssociateMarketAssignment,
  MarketAssociateProfile,
} from "@models/platform/operations-accounts.model";
import { Market } from "@models/platform/network.model";
import { User } from "@models/users/user.model";
import { asyncHandler, HttpError, sendSuccess } from "@utils/http";
import { MarketAssociateCatalogController } from "@controllers/market-associate/catalog.controller";
import {
  negotiationCreateSchema,
  negotiationOfferSchema,
  marketAssociateSubmissionDraftSchema,
} from "@validations/catalog.schemas";
import { PartnerCommerceController } from "@controllers/partner-commerce.controller";
import { PartnerNegotiationController } from "@controllers/partner-negotiation.controller";
import { FulfilmentController } from "@controllers/fulfilment.controller";
import {
  checkoutConfirmSchema,
  checkoutPreviewSchema,
  commerceCartItemSchema,
} from "@validations/commerce.schemas";
import { MarketAssociateMarketVendorController } from '@controllers/market-vendor.controller';
import { availabilityConfirmSchema, availabilityReportSchema, marketVendorSchema, marketVendorUpdateSchema, vendorCollectionSchema } from '@validations/vendor.schemas';
import { itemIssueSchema, itemVerifySchema } from '@validations/fulfilment.schemas';
import { Product } from '@models/products/product.model';
import { CatalogAvailabilityService } from '@modules/catalog/catalog-availability.service';
import { AppDataSource } from '@config/data-source';
import { DeviceToken } from '@models/notifications/device-token.model';
import { Notification } from '@models/notifications/notification.model';
import { NotificationService } from '@modules/notifications/notification.service';
import { WebPushSubscription } from '@models/notifications/web-push-subscription.model';

const webPushSubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

function mountNotificationRoutes(router: Router) {
  const notifications = new NotificationService(
    AppDataSource.getRepository(DeviceToken),
    AppDataSource.getRepository(Notification),
  );
  router.post(
    '/push/subscribe',
    validateBody(webPushSubscribeSchema),
    asyncHandler(async (req, res) => {
      await WebPushSubscription.findOneAndUpdate(
        { endpoint: req.body.endpoint },
        { $set: { userId: req.user!.sub, p256dh: req.body.keys.p256dh, auth: req.body.keys.auth, isActive: true, lastSeenAt: new Date() } },
        { upsert: true },
      );
      sendSuccess(res, { subscribed: true });
    }),
  );
  router.post(
    '/push/unsubscribe',
    validateBody(z.object({ endpoint: z.string().url() })),
    asyncHandler(async (req, res) => {
      await WebPushSubscription.updateOne({ endpoint: req.body.endpoint, userId: req.user!.sub }, { $set: { isActive: false } });
      sendSuccess(res, { subscribed: false });
    }),
  );
  router.get(
    '/notifications',
    asyncHandler(async (req, res) => {
      sendSuccess(res, await notifications.list({ userId: req.user!.sub }, {
        limit: Number(req.query.limit || 30),
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      }));
    }),
  );
  router.patch(
    '/notifications/read-all',
    asyncHandler(async (req, res) => {
      sendSuccess(res, await notifications.markAllRead({ userId: req.user!.sub }));
    }),
  );
  router.patch(
    '/notifications/:id/read',
    asyncHandler(async (req, res) => {
      sendSuccess(res, await notifications.markRead({ userId: req.user!.sub }, routeParam(req.params.id)));
    }),
  );
}

export function createMarketAssociateRouter() {
  const router = Router();
  const catalog = new MarketAssociateCatalogController();
  const fulfilment = new FulfilmentController();
  const marketVendors = new MarketAssociateMarketVendorController();
  router.use(requireAuth, requireAccountType(AccountType.MARKETASSOCIATE));
  mountNotificationRoutes(router);
  router.get(
    "/profile",
    asyncHandler(async (req, res) => {
      const [account, profile] = await Promise.all([
        User.findById(req.user!.sub)
          .select("-password -refreshToken")
          .lean({ virtuals: true }),
        MarketAssociateProfile.findOne({ accountId: req.user!.sub }).lean({
          virtuals: true,
        }),
      ]);
      if (!profile)
        throw new HttpError(
          404,
          "Market Associate profile not found",
          undefined,
          "NOT_FOUND",
        );
      sendSuccess(res, { account, profile });
    }),
  );
  router.patch(
    "/profile",
    validateBody(z.object({
      phone: z.string().trim().min(7).max(24).regex(/^[+\d][\d\s()-]*$/, "Enter a valid phone number").optional(),
      avatarUrl: z.union([z.string().trim().url().max(500), z.literal("")]).optional(),
      // Merged into the saved preferences, so one key can change without wiping the rest.
      preferences: z.record(z.string().max(60), z.unknown()).optional(),
    }).strict()),
    asyncHandler(async (req, res) => {
      const { phone, avatarUrl, preferences } = req.body ?? {};
      const set: Record<string, unknown> = {};
      const unset: Record<string, unknown> = {};
      if (phone !== undefined) set.phone = phone;
      if (preferences !== undefined) for (const [key, value] of Object.entries(preferences as Record<string, unknown>)) set[`preferences.${key}`] = value;
      // An empty avatarUrl means "remove my photo"; $set with undefined is a no-op.
      if (avatarUrl !== undefined) {
        if (avatarUrl) set.avatarUrl = avatarUrl;
        else unset.avatarUrl = "";
      }
      const account = await User.findByIdAndUpdate(
        req.user!.sub,
        {
          ...(Object.keys(set).length ? { $set: set } : {}),
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
        },
        { returnDocument: "after" },
      )
        .select("-password -refreshToken")
        .lean({ virtuals: true });
      sendSuccess(res, account);
    }),
  );
  router.get(
    "/markets",
    asyncHandler(async (req, res) => {
      const profile = await MarketAssociateProfile.findOne({
        accountId: req.user!.sub,
      }).lean();
      if (!profile)
        throw new HttpError(
          404,
          "Market Associate profile not found",
          undefined,
          "NOT_FOUND",
        );
      const assignments = await MarketAssociateMarketAssignment.find({
        marketAssociateId: profile._id.toString(),
        status: "active",
      }).lean({ virtuals: true });
      const markets = await Market.find({
        _id: { $in: assignments.map((item) => item.marketId) },
        status: "active",
      }).lean({ virtuals: true });
      sendSuccess(res, { assignments, markets });
    }),
  );
  router.get('/markets/:id', asyncHandler(marketVendors.market));
  router.get('/markets/:id/vendors', asyncHandler(marketVendors.vendors));
  router.post('/markets/:id/vendors', validateBody(marketVendorSchema), asyncHandler(marketVendors.create));
  router.get('/market-vendors/:id', asyncHandler(marketVendors.detail));
  router.patch('/market-vendors/:id', validateBody(marketVendorUpdateSchema), asyncHandler(marketVendors.update));
  router.post('/market-vendors/:id/invite', asyncHandler(marketVendors.invite));
  router.get('/vendor-collections', asyncHandler(marketVendors.collections));
  router.post('/product-submissions/:id/collection', validateBody(vendorCollectionSchema), asyncHandler(marketVendors.collection));
  router.get('/availability-checks', asyncHandler(async (req, res) => {
    const profile = await MarketAssociateProfile.findOne({ accountId: req.user!.sub, status: 'active' }).lean();
    if (!profile) throw new HttpError(403, 'Active Market Associate profile required', undefined, 'ACCESS_DENIED');
    const assignments = await MarketAssociateMarketAssignment.find({ marketAssociateId: profile._id.toString(), status: 'active', activeFrom: { $lte: new Date() }, $or: [{ activeTo: { $exists: false } }, { activeTo: null }, { activeTo: { $gt: new Date() } }] }).select('marketId').lean();
    const products = await Product.find({ marketId: { $in: assignments.map((assignment) => assignment.marketId) }, availabilityStatus: ProductAvailabilityStatus.UNCONFIRMED, deletedAt: { $exists: false } })
      .select('publicId title marketId sourceMarketAssociateId status availabilityStatus availabilityCheckDueAt availabilityCheckNote catalogVersion images')
      .sort({ availabilityCheckDueAt: 1 }).limit(100).lean({ virtuals: true });
    const sourceMarketAssociateIds = [...new Set(products.map((product) => product.sourceMarketAssociateId).filter(Boolean))];
    const activeSources = await MarketAssociateProfile.find({ _id: { $in: sourceMarketAssociateIds }, status: 'active' }).select('_id').lean();
    const activeSourceIds = new Set(activeSources.map((source) => source._id.toString()));
    sendSuccess(res, products.filter((product) => product.sourceMarketAssociateId === profile._id.toString() || !product.sourceMarketAssociateId || !activeSourceIds.has(product.sourceMarketAssociateId)));
  }));
  router.post('/products/:id/availability/confirm', validateBody(availabilityConfirmSchema), asyncHandler(async (req, res) => {
    sendSuccess(res, await new CatalogAvailabilityService().confirm(req.user!.sub, routeParam(req.params.id), req.body));
  }));
  router.post('/products/:id/availability/report', validateBody(availabilityReportSchema), asyncHandler(async (req, res) => {
    sendSuccess(res, await new CatalogAvailabilityService().report(req.user!.sub, routeParam(req.params.id), req.body));
  }));
  router.get("/dashboard", asyncHandler(catalog.dashboard));
  router.get("/fulfilments/dashboard", asyncHandler(fulfilment.marketAssociateDashboard));
  router.get("/fulfilments", asyncHandler(fulfilment.marketAssociateTasks));
  router.get("/fulfilments/:id", asyncHandler(fulfilment.marketAssociateTask));
  router.post(
    "/fulfilments/:id/issues",
    validateBody(z.object({ type: z.string().optional(), severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(), summary: z.string().min(3).max(1000), evidence: z.array(z.unknown()).optional(), orderItemId: z.string().optional(), idempotencyKey: z.string().min(8).optional() }).strict()),
    asyncHandler(fulfilment.marketAssociateIssue),
  );
  router.post(
    "/fulfilments/:id/items/:orderItemId/verify",
    validateBody(itemVerifySchema),
    asyncHandler(fulfilment.verifyItem),
  );
  router.put(
    "/fulfilments/:id/items/:orderItemId",
    validateBody(itemVerifySchema),
    asyncHandler(fulfilment.verifyItem),
  );
  router.post(
    "/fulfilments/:id/items/:orderItemId/issues",
    validateBody(itemIssueSchema),
    asyncHandler(fulfilment.marketAssociateItemIssue),
  );
  // Declared before /:action, which would otherwise treat "handover-code" as an action name.
  router.post("/fulfilments/:id/handover-code", asyncHandler(fulfilment.regenerateHandoverCode));
  router.post(
    "/fulfilments/:id/:action",
    validateBody(z.object({ version: z.coerce.number().int().positive(), actualCostMinor: z.coerce.number().int().nonnegative().optional(), evidence: z.array(z.object({ type: z.string().min(1), url: z.string().url().optional(), assetId: z.string().optional(), note: z.string().max(500).optional() })).optional(), arrivedAt: z.string().datetime().optional() }).passthrough()),
    asyncHandler(fulfilment.marketAssociateAction),
  );
  router.get("/product-submissions", asyncHandler(catalog.list));
  router.post(
    "/product-submissions",
    validateBody(marketAssociateSubmissionDraftSchema),
    asyncHandler(catalog.create),
  );
  router.get("/product-submissions/:id", asyncHandler(catalog.detail));
  router.patch(
    "/product-submissions/:id",
    validateBody(marketAssociateSubmissionDraftSchema),
    asyncHandler(catalog.update),
  );
  router.post(
    "/product-submissions/:id/submit",
    validateBody(
      z.object({ version: z.coerce.number().int().positive() }).strict(),
    ),
    asyncHandler(catalog.submit),
  );
  return router;
}

export function createPartnerRouter() {
  const router = Router();
  const commerce = new PartnerCommerceController();
  const fulfilment = new FulfilmentController();
  const negotiations = new PartnerNegotiationController();
  router.use(requireAuth, requireAccountType(AccountType.PARTNER));
  mountNotificationRoutes(router);
  router.get(
    "/profile",
    asyncHandler(async (req, res) => {
      const [account, partner] = await Promise.all([
        User.findById(req.user!.sub)
          .select("-password -refreshToken")
          .lean({ virtuals: true }),
        HookPartner.findOne({ accountId: req.user!.sub }).lean({
          virtuals: true,
        }),
      ]);
      if (!partner)
        throw new HttpError(
          404,
          "Hook Partner profile not found",
          undefined,
          "NOT_FOUND",
        );
      sendSuccess(res, { account, partner });
    }),
  );
  router.patch(
    "/profile",
    asyncHandler(async (req, res) => {
      const { phone, avatarUrl, preferences } = req.body ?? {};
      const set: Record<string, unknown> = {};
      const unset: Record<string, unknown> = {};
      if (phone !== undefined) set.phone = phone;
      if (preferences !== undefined) set.preferences = preferences;
      // An empty avatarUrl means "remove my photo"; $set with undefined is a no-op.
      if (avatarUrl !== undefined) {
        if (avatarUrl) set.avatarUrl = avatarUrl;
        else unset.avatarUrl = "";
      }
      const account = await User.findByIdAndUpdate(
        req.user!.sub,
        {
          ...(Object.keys(set).length ? { $set: set } : {}),
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
        },
        { returnDocument: "after" },
      )
        .select("-password -refreshToken")
        .lean({ virtuals: true });
      sendSuccess(res, account);
    }),
  );
  router.get(
    "/location",
    asyncHandler(async (req, res) => {
      const partner = await HookPartner.findOne({
        accountId: req.user!.sub,
      }).lean({ virtuals: true });
      if (!partner)
        throw new HttpError(
          404,
          "Hook Partner location not found",
          undefined,
          "NOT_FOUND",
        );
      sendSuccess(res, partner);
    }),
  );
  // Exact-email lookups are throttled per partner so the directory cannot be probed for who has an account.
  router.get(
    "/customers/lookup",
    rateLimit("partner-customer-lookup", { windowMs: 10 * 60_000, max: 20, key: (req) => `partner:${req.user?.sub || "anon"}`, message: "Too many customer lookups. Please wait a few minutes." }),
    asyncHandler(commerce.lookupCustomer),
  );
  router.post(
    "/customers",
    validateBody(
      z
        .object({
          firstName: z.string().min(1).max(80),
          lastName: z.string().min(1).max(80),
          email: z.string().email(),
          phone: z.string().min(7).max(30),
          consent: z.literal(true),
          policyVersions: z
            .object({
              TERMS: z.string(),
              PRIVACY: z.string(),
              RETURNS: z.string(),
            })
            .strict(),
        })
        .strict(),
    ),
    asyncHandler(commerce.createCustomer),
  );
  router.get("/customers/:customerId/cart", asyncHandler(commerce.getCart));
  router.post(
    "/customers/:customerId/cart/items",
    validateBody(commerceCartItemSchema),
    asyncHandler(commerce.addCart),
  );
  router.patch(
    "/customers/:customerId/cart/items/:itemId",
    validateBody(
      z.object({ quantity: z.coerce.number().int().min(1).max(99) }).strict(),
    ),
    asyncHandler(commerce.updateCart),
  );
  router.delete(
    "/customers/:customerId/cart/items/:itemId",
    asyncHandler(commerce.removeCart),
  );
  router.post(
    "/customers/:customerId/checkout/states/:stateId/preview",
    validateBody(checkoutPreviewSchema),
    asyncHandler(commerce.preview),
  );
  router.post(
    "/customers/:customerId/checkout/states/:stateId/confirm",
    validateBody(checkoutConfirmSchema),
    asyncHandler(commerce.confirm),
  );
  // Negotiation on behalf of an assisted customer.
  router.get("/negotiations/active-count", asyncHandler(negotiations.activeCount));
  router.get("/customers/:customerId/negotiations", asyncHandler(negotiations.list));
  router.get("/customers/:customerId/negotiations-active", asyncHandler(negotiations.active));
  router.post(
    "/customers/:customerId/negotiations",
    validateBody(negotiationCreateSchema),
    asyncHandler(negotiations.create),
  );
  router.get("/customers/:customerId/negotiations/:id", asyncHandler(negotiations.detail));
  router.post(
    "/customers/:customerId/negotiations/:id/offers",
    validateBody(negotiationOfferSchema),
    asyncHandler(negotiations.offer),
  );
  router.post("/customers/:customerId/negotiations/:id/accept", asyncHandler(negotiations.accept));
  router.post("/customers/:customerId/negotiations/:id/close", asyncHandler(negotiations.close));

  router.get("/orders", asyncHandler(commerce.orders));
  router.get("/fulfilment/custody", asyncHandler(fulfilment.partnerCustodyList));
  router.get("/fulfilment/custody/:orderId", asyncHandler(fulfilment.partnerCustody));
  router.post("/fulfilment/custody/:id/receive", validateBody(z.object({ idempotencyKey: z.string().min(8).optional() }).strict()), withIdempotency({ operation: 'POST /fulfilment/custody/:id/receive', tier: 'financial' }), asyncHandler(fulfilment.receiveCustody));
  router.post("/fulfilment/custody/:id/release", validateBody(z.object({ code: z.string().regex(/^\d{6}$/), idempotencyKey: z.string().min(8).optional() }).strict()), withIdempotency({ operation: 'POST /fulfilment/custody/:id/release', tier: 'financial' }), asyncHandler(fulfilment.releaseCustody));
  router.get("/commerce/config", asyncHandler(commerce.commerceConfig));
  router.post(
    "/orders/:orderId/payment-instructions",
    asyncHandler(commerce.paymentInstructions),
  );
  return router;
}
