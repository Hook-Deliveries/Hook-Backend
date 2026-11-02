import { z } from 'zod';

export const itemVerifySchema = z.object({
  photos: z.array(z.object({
    view: z.enum(['front', 'side', 'back', 'extra1', 'extra2', 'extra3', 'extra4']),
    url: z.string().url(),
    assetId: z.string().trim().max(200).optional(),
  }).strict()).min(3).max(7).superRefine((photos, ctx) => {
    // Front, side and back are compulsory; up to four extra detail photos are optional.
    const views = new Set(photos.map((photo) => photo.view));
    if (views.size !== photos.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Each photo view can only be used once' });
    for (const required of ['front', 'side', 'back']) {
      if (!views.has(required as never)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Front, side and back photos are required' });
    }
  }),
  // Only the details the ordered item actually has are required; the service checks that per item.
  actualColor: z.string().trim().max(80).optional(),
  actualSize: z.string().trim().max(80).optional(),
  actualAttributes: z.record(z.string().min(1).max(40), z.string().trim().max(120)).optional(),
  actualQuantity: z.coerce.number().int().positive(),
  unitCostMinor: z.coerce.number().int().nonnegative(),
  supplierReference: z.string().trim().max(160).optional(),
  conditionNote: z.string().trim().min(3).max(500),
  checks: z.object({
    productMatches: z.boolean(),
    sizeMatches: z.boolean().optional(),
    colorMatches: z.boolean().optional(),
    attributesMatch: z.boolean().optional(),
    quantityMatches: z.boolean(),
  }),
}).strict();

export const itemIssueSchema = z.object({
  type: z.enum(['PRODUCT_UNAVAILABLE', 'COLOR_UNAVAILABLE', 'SIZE_UNAVAILABLE', 'INSUFFICIENT_QUANTITY', 'DAMAGED_PRODUCT', 'PRICE_CHANGED', 'WRONG_CATALOG_DETAILS', 'OTHER']),
  summary: z.string().trim().min(3).max(1000),
  evidence: z.array(z.object({ type: z.string().min(1), url: z.string().url().optional(), assetId: z.string().optional(), note: z.string().max(500).optional() }).strict()).max(10).default([]),
  idempotencyKey: z.string().trim().min(8).max(160),
}).strict();
