import { Router } from 'express';
import { z } from 'zod';
import { FulfilmentController } from '@controllers/fulfilment.controller';
import { PublicController } from '@controllers/public.controller';
import { asyncHandler } from '@utils/http';
import { validateBody } from '@middleware/validate';
import { MarketAssociateMarketVendorController } from '@controllers/market-vendor.controller';
import { PaymentLinkController } from '@controllers/payment-link.controller';
import { paymentLinkInitializeSchema } from '@validations/commerce.schemas';
import { AppReleasesController } from '@controllers/admin/app-releases.controller';
import { AccountDeletionController } from '@controllers/account-deletion.controller';
import { rateLimit } from '@middleware/security';
import { sha256 } from '@modules/identity/account-deletion.service';
import {
  publicDeletionCancelSchema,
  publicDeletionCodeSchema,
  publicDeletionProofSchema,
  publicDeletionRequestSchema,
  waitlistJoinSchema,
} from '@validations/common.schemas';

// Deletion endpoints check passwords and are reachable without signing in, so
// they are throttled twice: per target email (stops guessing one account from
// many IPs) and per IP (stops sweeping many accounts from one).
const targetEmail = (req: { body?: { email?: unknown } }) => `email:${sha256(String(req.body?.email || '').toLowerCase().trim()).slice(0, 24)}`;
const deletionByEmail = rateLimit('deletion-email', { windowMs: 15 * 60_000, max: 8, key: targetEmail, message: 'Too many attempts for this account. Please try again in a few minutes.' });
const deletionByIp = rateLimit('deletion-ip', { windowMs: 15 * 60_000, max: 30, message: 'Too many attempts. Please try again in a few minutes.' });
const deletionCodeByEmail = rateLimit('deletion-code-email', { windowMs: 15 * 60_000, max: 3, key: targetEmail, message: 'A code was sent recently. Please check your email or wait a few minutes.' });
const waitlistByIp = rateLimit('waitlist-join', { windowMs: 60 * 60_000, max: 10, message: 'Too many attempts. Please try again later.' });

export function createPublicRouter() {
  const router = Router();
  const controller = new PublicController();
  const marketVendors = new MarketAssociateMarketVendorController();
  const paymentLinks = new PaymentLinkController();
  const fulfilment = new FulfilmentController();
  router.get('/public/app-release', asyncHandler(new AppReleasesController().publicPolicy));

  router.post('/public/waitlist', waitlistByIp, validateBody(waitlistJoinSchema), asyncHandler(controller.joinWaitlist));
  router.get('/public/waitlist/unsubscribe/:token', asyncHandler(controller.unsubscribeWaitlist));
  router.get('/public/legal/:type', asyncHandler(controller.getLegalContent));
  router.get('/public/credit-config', asyncHandler(controller.creditConfig));
  router.get('/public/support', asyncHandler(controller.support));
  router.get('/public/faqs', asyncHandler(controller.faqs));
  router.get('/public/parcels/:receipt', rateLimit('parcel-tracking', { windowMs: 60_000, max: 30, message: 'Too many lookups. Please wait a moment.' }), asyncHandler(fulfilment.publicParcelTracking));

  const accountDeletion = new AccountDeletionController();
  router.post('/public/account-deletion/code', deletionByIp, validateBody(publicDeletionCodeSchema), deletionCodeByEmail, asyncHandler(accountDeletion.sendCode));
  router.post('/public/account-deletion/request', deletionByIp, validateBody(publicDeletionRequestSchema), deletionByEmail, asyncHandler(accountDeletion.request));
  router.post('/public/account-deletion/status', deletionByIp, validateBody(publicDeletionProofSchema), deletionByEmail, asyncHandler(accountDeletion.status));
  router.post('/public/account-deletion/cancel', deletionByIp, validateBody(publicDeletionCancelSchema), deletionByEmail, asyncHandler(accountDeletion.cancel));

  router.get('/public/payment-links/:token', asyncHandler(paymentLinks.detail));
  router.post('/public/payment-links/:token/initialize', validateBody(paymentLinkInitializeSchema), asyncHandler(paymentLinks.initialize));
  router.get('/public/payment-links/:token/status', asyncHandler(paymentLinks.status));

  router.get('/products', asyncHandler(controller.getProducts));
  router.get('/products/:id', asyncHandler(controller.getProduct));
  router.get('/feed', asyncHandler(controller.homeFeed));
  router.get('/categories', asyncHandler(controller.getCategories));
  router.get('/categories/tree', asyncHandler(controller.getCategoryTree));
  router.get('/categories/:id', asyncHandler(controller.getCategory));
  router.get('/operating-states', asyncHandler(controller.getOperatingStates));
  router.get('/search', asyncHandler(controller.search));
  router.get('/search/suggestions', asyncHandler(controller.suggestions));
  router.post('/vendor-invitations/:token/accept', validateBody(z.object({
    contactName: z.string().trim().min(2).max(120).optional(),
    phone: z.string().trim().min(7).max(30).optional(),
    email: z.string().email().optional(),
  }).strict()), asyncHandler(marketVendors.acceptInvitation));

  return router;
}
