import { z } from 'zod';
import { ProductAvailabilityStatus, ProductStatus } from '@lib/constants';
import { productBaseSchema, validateNegotiationFloor } from './common.schemas';

const publicOrInternalId = z.string().trim().min(3).max(80);
const moneyMinor = z.coerce.number().int().positive().max(10_000_000_000);
const variant = z.object({
  size: z.string().trim().max(80).optional(),
  colour: z.string().trim().max(80).optional(),
  attributes: z.record(z.string(), z.string().max(200)).default({}),
  active: z.boolean().default(true),
}).strict().refine((value) => Boolean(value.size || value.colour || Object.keys(value.attributes).length), {
  message: 'A variant must include a size, colour, or configured attribute',
});

export const marketAssociateSubmissionDraftSchema = z.object({
  marketId: publicOrInternalId,
  marketVendorId: publicOrInternalId,
  categorySuggestionId: publicOrInternalId,
  basicTitle: z.string().trim().min(2).max(180),
  notes: z.string().trim().max(2000).optional(),
  // Front, side and back are compulsory; up to four extra photos are optional.
  mediaIds: z.array(publicOrInternalId).max(7).default([]),
  mediaViews: z.object({
    front: publicOrInternalId.optional(),
    side: publicOrInternalId.optional(),
    back: publicOrInternalId.optional(),
  }).strict().default({}),
  captureChecklistConfirmed: z.boolean().default(false),
  basePriceMinor: moneyMinor,
  currency: z.literal('NGN').default('NGN'),
  // No minimum here — this schema also covers draft save/update, and a
  // Market Associate must be able to save incremental progress before
  // variants are added. The minimum is enforced at submit time instead.
  variants: z.array(variant).max(80).default([]),
  availabilityStatus: z.nativeEnum(ProductAvailabilityStatus),
  availabilityNote: z.string().trim().max(500).optional(),
  internalSellerReference: z.string().trim().max(300).optional(),
  version: z.coerce.number().int().positive().optional(),
}).strict().superRefine((value, context) => {
  for (const [view, mediaId] of Object.entries(value.mediaViews)) {
    if (mediaId && !value.mediaIds.includes(mediaId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mediaViews", view],
        message: "The assigned view must reference one of this submission's images",
      });
    }
  }
});

export const reviewReasonSchema = z.object({
  reason: z.string().trim().min(5).max(1000),
  fields: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  version: z.coerce.number().int().positive(),
}).strict();

export const reviewStartSchema = z.object({
  version: z.coerce.number().int().positive(),
}).strict();

// Approving a submission now creates the live Product directly, in the same
// shape Product Inventory's own "New Product" form submits — see
// CatalogReviewService.decide()'s approve branch. `version` here guards the
// ProductSubmission's optimistic concurrency, distinct from the Product's own
// catalogVersion (which the create path always initializes fresh).
export const submissionApproveAsProductSchema = productBaseSchema.extend({
  status: z.enum([ProductStatus.DRAFT, ProductStatus.PUBLISHED]).default(ProductStatus.PUBLISHED),
  version: z.coerce.number().int().positive(),
}).superRefine(validateNegotiationFloor);

export const negotiationRulesSchema = z.object({
  enabled: z.boolean(),
  minimumNegotiablePriceMinor: moneyMinor.optional(),
  maximumDiscountMinor: z.coerce.number().int().nonnegative().optional(),
  maximumCustomerOffers: z.literal(3).default(3),
  acceptedQuoteExpiryMinutes: z.literal(30).default(30),
  reason: z.string().trim().min(5).max(1000),
  version: z.coerce.number().int().positive(),
}).strict();

export const lifecycleReasonSchema = z.object({
  reason: z.string().trim().min(5).max(1000),
  version: z.coerce.number().int().positive(),
}).strict();

export const uploadIntentSchema = z.object({
  ownerType: z.enum(['submission', 'product']),
  ownerId: publicOrInternalId.optional(),
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/avif']),
  bytes: z.coerce.number().int().positive(),
}).strict();

export const uploadFinalizeSchema = z.object({
  uploadIntentId: z.string().uuid(),
  providerPublicId: z.string().trim().min(5).max(500),
  version: z.string().trim().min(5).max(100),
  ownerType: z.enum(['submission', 'product']),
  ownerId: publicOrInternalId.optional(),
}).strict();

export const negotiationCreateSchema = z.object({
  productId: publicOrInternalId,
  variantId: publicOrInternalId,
  quantity: z.coerce.number().int().min(1).max(20),
  message: z.string().trim().max(500).optional(),
}).strict();

export const negotiationOfferSchema = z.object({
  offeredPriceMinor: moneyMinor.optional(),
  message: z.string().trim().min(1).max(500),
}).strict().refine((value) => Boolean(value.message || value.offeredPriceMinor), {
  message: 'Enter a message or offer',
});
