import { z } from "zod";
import { CommercePaymentMethod, DeliveryMethod } from "@lib/constants";

const publicId = z.string().trim().min(3).max(40);
const variantIdentifier = z.union([publicId, z.string().trim().regex(/^legacy_opt_[a-f0-9]{32}$/)]);
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{7,24}$/);

export const addressCreateSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    recipientName: z.string().trim().min(2).max(120),
    phone,
    line1: z.string().trim().min(4).max(240),
    line2: z.string().trim().max(240).optional(),
    landmark: z.string().trim().max(240).optional(),
    stateId: publicId,
    cityId: publicId.optional(),
    localGovernmentAreaId: publicId,
    formattedAddress: z.string().trim().min(4).max(500).optional(),
    stateCode: z.string().trim().regex(/^[A-Za-z]{2,3}$/),
    stateName: z.string().trim().min(2).max(100),
    cityName: z.string().trim().min(2).max(120),
    localGovernmentArea: z.string().trim().max(120).optional(),
    postalCode: z.string().trim().max(20).optional(),
    coordinates: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      })
      .optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();
export const addressUpdateSchema = addressCreateSchema
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one field is required",
  );

/**
 * What a customer picked for a product: colour and size as before, plus whatever
 * else the category asks for (capacity, length, phone model...). Keys are the
 * category's attribute keys, so this is an open map, not a fixed pair. The server
 * takes the authoritative details from the chosen variant; this is the fallback.
 */
export const selectedVariantsSchema = z
  .record(z.string().trim().min(1).max(40).regex(/^[a-zA-Z][a-zA-Z0-9]*$/), z.string().trim().max(80))
  .refine((value) => Object.keys(value).length <= 12, 'Too many options');

export const commerceCartItemSchema = z
  .object({
    productId: publicId,
    quantity: z.coerce.number().int().min(1).max(99),
    variantId: variantIdentifier.optional(),
    quoteId: publicId.optional(),
    selectedVariants: selectedVariantsSchema.optional(),
  })
  .strict();

export const commerceImportSchema = z.object({
  schemaVersion: z.literal(1),
  cartItems: z.array(z.object({
    clientLineId: z.string().trim().min(1).max(120),
    productId: publicId,
    variantId: variantIdentifier.optional(),
    selectedVariants: selectedVariantsSchema.optional(),
    quantity: z.number().int().min(1).max(99),
  }).strict()).max(100),
  likedProductIds: z.array(publicId).max(500),
}).strict();

export const checkoutPreviewSchema = z
  .object({
    addressId: publicId.optional(),
    deliveryMethod: z.nativeEnum(DeliveryMethod),
    paymentMethod: z.nativeEnum(CommercePaymentMethod),
    policyVersions: z
      .object({
        TERMS: z.string().min(1),
        PRIVACY: z.string().min(1),
        RETURNS: z.string().min(1),
      })
      .strict(),
    logisticsProviderId: publicId.optional(),
    couponCode: z.string().trim().min(3).max(40).optional(),
    useCredits: z.boolean().optional(),
    // Instructions for the courier ("call me at the gate"). Kept on the order.
    deliveryNote: z.string().trim().max(300).optional(),
  })
  .strict();

export const checkoutConfirmSchema = z
  .object({ previewToken: z.string().min(40).max(300) })
  .strict();
export const paymentInitializeV4Schema = z
  .object({ orderId: publicId, fulfilmentGroupId: publicId.optional() })
  .strict();

export const paymentLinkCreateSchema = z.object({
  orderId: publicId,
  fulfilmentGroupId: publicId.optional(),
}).strict();

export const paymentLinkInitializeSchema = z.object({
  provider: z.enum(["paystack", "monnify"]),
  appReturn: z.boolean().optional().default(false),
}).strict();

export const paymentProviderSettingsSchema = z.object({
  providers: z.array(z.object({
    provider: z.enum(["paystack", "monnify"]),
    enabled: z.boolean(),
    displayOrder: z.number().int().min(1).max(10),
    isDefault: z.boolean(),
  }).strict()).min(1),
  reason: z.string().trim().min(5).max(500),
}).strict();

// Sender identity (brevoFromEmail/brevoFromName) is env-only (BREVO_FROM_EMAIL/BREVO_FROM_NAME) — not settable here.
export const emailSettingsSchema = z.object({
  supportEmail: z.string().trim().email().optional(),
  hookOpsEmail: z.string().trim().email().optional(),
  appName: z.string().trim().min(1).max(80).optional(),
  appUrl: z.string().trim().url().optional(),
  // Where "Help & Support" opens; falls back to a mailto: to supportEmail when unset.
  supportUrl: z.string().trim().url().optional(),
  reason: z.string().trim().min(5).max(500),
}).strict();

export const checkoutSettingsSchema = z.object({
  /** Naira-in-kobo: 1_800_000 is N18,000. 0 switches the minimum off. */
  minimumCheckoutMinor: z.coerce.number().int().min(0).max(100_000_000),
  reason: z.string().trim().min(5).max(500),
}).strict();

/** Pricing the admin controls: VAT and the platform default delivery fee. Every field optional; a reason is always required. */
export const pricingConfigSchema = z.object({
  vatRatePercent: z.coerce.number().min(0).max(30).optional(),
  defaultDeliveryFeeMinor: z.coerce.number().int().min(0).max(100_000_000).optional(),
  reason: z.string().trim().min(5).max(500),
}).strict();

export const inventorySettingsSchema = z.object({
  lowStockThreshold: z.coerce.number().int().min(0).max(100),
  reason: z.string().trim().min(5).max(500),
}).strict();

/**
 * Hook credit economics. Every field optional so the admin screen can PATCH one
 * value at a time; `.strict()` so a typo is rejected rather than silently
 * ignored. orderEarnMaxMinor 0 means "no cap", not "earn nothing".
 */
export const hookCoinSettingsSchema = z.object({
  orderEarnEnabled: z.boolean().optional(),
  orderEarnPercent: z.coerce.number().min(0).max(100).optional(),
  orderEarnMaxMinor: z.coerce.number().int().min(0).optional(),
  creditSpendCapPercent: z.coerce.number().int().min(0).max(100).optional(),
  welcomeBonusMinor: z.coerce.number().int().min(0).optional(),
  /** Credit a new customer gets for signing up through a referral. */
  referralSignupBonusMinor: z.coerce.number().int().min(0).max(100_000_000).optional(),
  /** Credit the referrer gets once that friend completes a first order. */
  referralReferrerBonusMinor: z.coerce.number().int().min(0).max(100_000_000).optional(),
  reason: z.string().trim().min(5).max(500),
}).strict();

/** Delivery-detail corrections an admin may make to a live order. */
export const adminOrderUpdateSchema = z.object({
  deliveryNotes: z.string().trim().max(1000).optional(),
  scheduledDeliveryAt: z.string().datetime().nullable().optional(),
  recipientName: z.string().trim().min(2).max(120).optional(),
  recipientPhone: z.string().trim().min(7).max(20).optional(),
  formattedAddress: z.string().trim().min(5).max(500).optional(),
  reason: z.string().trim().min(3).max(500),
}).strict();

/** Admin-chosen split: which items travel in which delivery. */
export const adminOrderSplitSchema = z.object({
  groups: z.array(z.object({
    orderItemIds: z.array(z.string().trim().min(1)).min(1),
  })).min(2).max(10),
  reason: z.string().trim().min(3).max(500),
}).strict();

/** A cancellation always needs a reason — the customer is told what it says. */
export const adminOrderCancelSchema = z.object({
  reason: z.string().trim().min(3).max(500),
}).strict();

export const commerceSettingsSchema = z
  .object({
    defaultDeliveryFeeMinor: z.number().int().min(0).optional(),
    previewTtlMinutes: z.number().int().min(2).max(30).optional(),
  })
  .strict();
