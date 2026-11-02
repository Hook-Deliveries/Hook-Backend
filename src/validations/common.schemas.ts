import { z } from 'zod';
import { normalizeProductColor } from '@lib/product-color';
import {
  BoothType,
  LogisticsStatus,
  NegotiationStatus,
  OrderStatus,
  OrderType,
  PaymentMode,
  PaymentStatus,
  ProductStatus,
  UserRole,
  VendorTier,
} from '@lib/constants';

// Entity ids are Mongo ObjectIds (24-char hex); accept UUIDs too for portability
export const idSchema = z.string().regex(
  /^([a-f0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  'Invalid id format',
);

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  guestId: z.string().min(12).optional(),
  deviceId: z.string().trim().min(1).max(120).optional(),
  deviceName: z.string().trim().min(1).max(120).optional(),
  platform: z.string().trim().min(1).max(40).optional(),
});

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const profileSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(6).optional(),
  avatarUrl: z.string().url().nullable().optional(),
  address: z.record(z.string(), z.unknown()).optional(),
  preferences: z.record(z.string(), z.unknown()).optional(),
});

export const passwordResetRequestSchema = z.object({ email: z.string().email() });
export const passwordResetSchema = z.object({
  email: z.string().email(),
  code: z.string().min(4),
  password: z.string().min(8),
  deviceId: z.string().trim().min(1).max(120).optional(),
  deviceName: z.string().trim().min(1).max(120).optional(),
  platform: z.string().trim().min(1).max(40).optional(),
});
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export const cartItemSchema = z.object({
  productId: idSchema,
  quantity: z.coerce.number().int().positive(),
  selectedVariants: z.record(z.string().min(1).max(40), z.string().max(80)).optional(),
});

export const cartQuantitySchema = z.object({ quantity: z.coerce.number().int().positive() });

export const checkoutSchema = z.object({
  guestEmail: z.string().email().optional(),
  guestName: z.string().min(2).optional(),
  deliveryAddress: z.object({
    street: z.string().min(1),
    city: z.string().min(1),
    state: z.string().min(1),
    landmark: z.string().optional(),
    coordinates: z.object({ lat: z.number(), lng: z.number() }).optional(),
    phone: z.string().min(6),
  }),
  deliveryNotes: z.string().optional(),
  scheduledDeliveryAt: z.coerce.date().optional(),
  paymentMode: z.nativeEnum(PaymentMode).default(PaymentMode.PAY_NOW),
  orderType: z.nativeEnum(OrderType).default(OrderType.STANDARD),
  giftRecipient: z.object({
    name: z.string().trim().min(2),
    email: z.string().email(),
    phone: z.string().trim().min(7),
    address: z.object({
      street: z.string().min(1), city: z.string().min(1), state: z.string().min(1),
      landmark: z.string().optional(), coordinates: z.object({ lat: z.number(), lng: z.number() }).optional(),
      phone: z.string().min(6),
    }),
    message: z.string().trim().max(500).optional(),
  }).optional(),
}).superRefine((data, ctx) => {
  if (data.orderType === OrderType.GIFT && !data.giftRecipient) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['giftRecipient'], message: 'Gift recipient delivery details are required' });
  }
  if (data.orderType === OrderType.GIFT && data.paymentMode !== PaymentMode.PAY_NOW) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paymentMode'], message: 'Gift orders must be paid before fulfilment' });
  }
});

export const negotiationSchema = z.object({
  productId: idSchema,
  offeredPrice: z.coerce.number().positive(),
  message: z.string().optional(),
}).strict();

export const paymentInitializeSchema = z.object({
  orderId: idSchema,
  gateway: z.enum(['paystack', 'monnify']).default('paystack'),
  paymentMethod: z.enum(['card', 'bank_transfer', 'ussd', 'pos']).default('card'),
  savePaymentMethod: z.boolean().default(false),
});

export const vendorRegistrationSchema = z.object({
  businessName: z.string().min(2),
  businessEmail: z.string().email().optional(),
  businessPhone: z.string().optional(),
  businessAddress: z.string().optional(),
  description: z.string().optional(),
});

export const vendorBankSchema = z.object({
  bankName: z.string().min(1),
  accountNumber: z.string().min(6),
  accountName: z.string().min(2),
  bankCode: z.string().min(1),
});

export const productBaseSchema = z.object({
  title: z.string().min(2),
  description: z.string().optional(),
  costPrice: z.coerce.number().positive(),
  sellingPrice: z.coerce.number().positive(),
  discountedPrice: z.coerce.number().positive().optional(),
  minAcceptablePrice: z.coerce.number().positive(),
  quantity: z.coerce.number().int().nonnegative().default(0),
  categoryId: z.string().trim().min(3).max(80),
  marketId: z.string().trim().min(3).max(80),
  images: z.array(z.string().url()).min(1, 'At least one product image is required'),
  colors: z.array(z.string().transform((value, ctx) => {
    const normalized = normalizeProductColor(value);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Colors must be a valid hex value such as #FFC809' });
      return z.NEVER;
    }
    return normalized;
  })).optional(),
  sizes: z.array(z.string()).optional(),
});

export function validateNegotiationFloor(
  data: { minAcceptablePrice?: number; sellingPrice?: number },
  ctx: z.RefinementCtx,
) {
  if (
    data.minAcceptablePrice !== undefined &&
    data.sellingPrice !== undefined &&
    data.minAcceptablePrice > data.sellingPrice
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['minAcceptablePrice'],
      message: 'Negotiation floor cannot exceed the Hook platform price',
    });
  }
}

export const productSchema = productBaseSchema.superRefine(validateNegotiationFloor);

export const adminVendorCreateSchema = z.object({
  ownerEmail: z.string().email(),
  ownerFirstName: z.string().min(1).default('Vendor'),
  ownerLastName: z.string().min(1).default('Owner'),
  ownerPhone: z.string().optional(),
  password: z.string().min(6).default('123456'),
  businessName: z.string().min(2),
  businessEmail: z.string().email().optional(),
  businessPhone: z.string().optional(),
  businessAddress: z.string().optional(),
  stateCode: z.string().trim().min(2).max(3).optional(),
  description: z.string().optional(),
  imageUrl: z.string().url().optional(),
  tier: z.nativeEnum(VendorTier).default(VendorTier.TIER_3),
  commissionPercentage: z.coerce.number().min(0).max(100).default(15),
  isApproved: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

export const adminVendorUpdateSchema = adminVendorCreateSchema.omit({
  ownerEmail: true,
  ownerFirstName: true,
  ownerLastName: true,
  ownerPhone: true,
  password: true,
}).partial();

export const adminProductCreateSchema = productBaseSchema.extend({
  status: z.enum([ProductStatus.DRAFT, ProductStatus.PUBLISHED]).default(ProductStatus.DRAFT),
}).superRefine(validateNegotiationFloor);

export const adminProductUpdateSchema = productBaseSchema.extend({
  status: z.enum([
    ProductStatus.DRAFT,
    ProductStatus.PUBLISHED,
    ProductStatus.PAUSED,
    ProductStatus.UNPUBLISHED,
    ProductStatus.DISABLED,
  ]).optional(),
  // Admin-only reassignment of the supplying market vendor; an empty string clears the link.
  sourceMarketVendorId: z.string().trim().max(80).optional(),
  // Required only when a price field changes, which the controller enforces since this schema can't see the stored value.
  reason: z.string().trim().min(5).max(500).optional(),
}).partial().superRefine(validateNegotiationFloor);

export const adminOrderCreateSchema = z.object({
  userId: idSchema,
  items: z.array(z.object({
    productId: idSchema,
    quantity: z.coerce.number().int().positive(),
    selectedVariants: z.object({
      color: z.string().optional(),
      size: z.string().optional(),
    }).optional(),
  })).min(1),
  deliveryAddress: checkoutSchema.shape.deliveryAddress,
  deliveryFee: z.coerce.number().nonnegative().default(0),
  discount: z.coerce.number().nonnegative().default(0),
  deliveryNotes: z.string().optional(),
  scheduledDeliveryAt: z.coerce.date().optional(),
  paymentStatus: z.nativeEnum(PaymentStatus).default(PaymentStatus.UNPAID),
  status: z.nativeEnum(OrderStatus).default(OrderStatus.PENDING),
});

export const adminOrderUpdateSchema = z.object({
  deliveryAddress: checkoutSchema.shape.deliveryAddress.optional(),
  deliveryFee: z.coerce.number().nonnegative().optional(),
  discount: z.coerce.number().nonnegative().optional(),
  deliveryNotes: z.string().optional(),
  scheduledDeliveryAt: z.coerce.date().optional(),
  paymentStatus: z.nativeEnum(PaymentStatus).optional(),
  status: z.nativeEnum(OrderStatus).optional(),
});

export const adminAssignDriverSchema = z.object({
  driverId: idSchema,
});

export const adminDriverCreateSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).default('123456'),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
  stateCode: z.string().trim().min(2).max(3).optional(),
  isActive: z.boolean().default(true),
});

export const adminBoothCreateSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  boothType: z.nativeEnum(BoothType).default(BoothType.PHYGITAL),
  location: z.object({
    address: z.string().min(1),
    lat: z.coerce.number().default(0),
    lng: z.coerce.number().default(0),
    stateCode: z.string().trim().min(2).max(3).optional(),
  }),
  fieldAgentId: idSchema.optional(),
  attendantUserId: idSchema.optional(),
  newAttendant: z.object({ firstName: z.string().min(1), lastName: z.string().min(1), email: z.string().email(), phone: z.string().regex(/^\+?[0-9\s-]{7,20}$/) }).optional(),
  previewImageUrl: z.string().url().optional(),
  isActive: z.boolean().default(true),
});

export const boothAttendantSchema = z.union([
  z.object({ attendantUserId: idSchema }),
  z.object({ firstName: z.string().min(1), lastName: z.string().min(1), email: z.string().email(), phone: z.string().regex(/^\+?[0-9\s-]{7,20}$/, 'Enter a valid phone number'), password: z.string().min(8).optional() }),
]);

export const operationalStateToggleSchema = z.object({
  isEnabled: z.boolean(),
});

export const operationalStateAssignSchema = z.object({
  stateCode: z.string().trim().min(2).max(3),
});

export const adminUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  role: z.nativeEnum(UserRole).default(UserRole.SHOPPER),
});

const sizingGuideSchema = z.object({
  /** Admin switch: false hides the guide everywhere without deleting it. */
  enabled: z.boolean().optional(),
  summary: z.string().max(200).optional(),
  howToMeasure: z.string().max(2000).optional(),
  presetGroups: z.array(z.enum(['clothing', 'uk-dress', 'shoes', 'kids-shoes', 'bra', 'general'])).max(5).default([]),
  chart: z.array(z.object({
    size: z.string().min(1).max(40),
    measurements: z.record(z.string(), z.string().max(60)).default({}),
  })).max(20).optional(),
}).strict().optional();

export const categoryAttributeSchema = z.object({
  key: z.string().trim().min(1).max(40).regex(/^[a-zA-Z][a-zA-Z0-9]*$/, 'Use letters and numbers only'),
  label: z.string().trim().min(1).max(60),
  type: z.enum(['size', 'colour', 'select', 'text']),
  required: z.boolean(),
  options: z.array(z.string().trim().min(1).max(60)).max(60).optional(),
  preset: z.enum(['clothing', 'uk-dress', 'shoes', 'kids-shoes', 'bra', 'general']).optional(),
  variantAxis: z.boolean(),
}).strict();

export const categoryCreateSchema = z.object({
  name: z.string().min(2).max(60),
  /** Public or internal id of the parent. Omit for a top-level category. */
  parentId: z.string().min(3).max(80).optional(),
  attributes: z.array(categoryAttributeSchema).max(12).optional(),
  description: z.string().max(300).optional(),
  iconUrl: z.string().url().optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
  sizingGuide: sizingGuideSchema,
});

export const categoryUpdateSchema = categoryCreateSchema.partial();

export const roleSchema = z.object({ role: z.nativeEnum(UserRole) });
export const orderStatusSchema = z.object({ status: z.nativeEnum(OrderStatus) });
export const fulfilmentDecisionSchema = z.object({
  reason: z.string().trim().min(3).max(500).optional(),
  idempotencyKey: z.string().trim().min(8).max(100),
});
export const giftCreateSchema = z.object({
  productId: idSchema,
  recipientEmail: z.string().email(),
  quantity: z.coerce.number().int().positive().default(1),
  message: z.string().trim().max(500).optional(),
});
export const giftClaimSchema = z.object({ token: z.string().min(32) });
export const boothInventorySchema = z.object({ productIds: z.array(idSchema).max(500) });
// Account deletion: ownership is proven with a password, or an emailed code for passwordless Google/Apple accounts.
const ownerProof = {
  password: z.string().min(1).max(200).optional(),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code').optional(),
};
const exactlyOneProof = (value: { password?: string; code?: string }) => (value.password !== undefined) !== (value.code !== undefined);
const proofMessage = { message: 'Provide either your password or the emailed code' };
const emailField = z.string().trim().toLowerCase().email().max(254);
export const publicDeletionRequestSchema = z
  .object({ email: emailField, ...ownerProof, reason: z.string().trim().max(1000).optional() })
  .strict()
  .refine(exactlyOneProof, proofMessage);
export const publicDeletionProofSchema = z
  .object({ email: emailField, ...ownerProof })
  .strict()
  .refine(exactlyOneProof, proofMessage);
export const publicDeletionCodeSchema = z.object({ email: emailField }).strict();
export const publicDeletionCancelSchema = z.union([
  z.object({ token: z.string().min(20).max(200) }).strict(),
  publicDeletionProofSchema,
]);
export const waitlistJoinSchema = z.object({
  email: emailField,
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().regex(/^\+?[0-9\s-]{7,20}$/, 'Enter a valid phone number'),
  city: z.string().trim().min(2).max(120),
  // Optional: the landing page's free-text prompt, not every signup will answer it.
  itemInterest: z.string().trim().max(1000).optional(),
  // A ticked consent checkbox so the landing page cannot join people without asking them first.
  consent: z.literal(true, { message: 'Consent to be contacted is required to join the waitlist' }),
}).strict();
export const waitlistBroadcastSchema = z.object({
  subject: z.string().trim().min(3).max(150),
  message: z.string().trim().min(3).max(5000),
  targetIds: z.array(z.string().trim().min(3).max(80)).max(5000).optional(),
}).strict();
export const waitlistGiftSchema = z.object({
  amountMinor: z.coerce.number().int().positive().max(100_000_000),
  reason: z.string().trim().min(5).max(300),
  targetIds: z.array(z.string().trim().min(3).max(80)).max(5000).optional(),
}).strict();
export const adminGiftCreditSchema = z.object({
  amountMinor: z.coerce.number().int().positive().max(100_000_000),
  reason: z.string().trim().min(5).max(300),
  idempotencyKey: z.string().trim().min(10).max(160),
}).strict();
const communicationsAudienceSchema = z.union([
  z.object({ segment: z.literal('customers') }).strict(),
  z.object({ segment: z.literal('market_associates'), stateIds: z.array(z.string().trim().min(1).max(80)).max(60).optional() }).strict(),
  z.object({ segment: z.literal('staff'), roleKey: z.string().trim().min(1).max(80).optional() }).strict(),
  z.object({ userIds: z.array(z.string().trim().min(3).max(80)).min(1).max(5000) }).strict(),
]);
export const communicationsPreviewSchema = z.object({
  audience: communicationsAudienceSchema,
}).strict();
export const communicationsSendSchema = z.object({
  title: z.string().trim().min(3).max(150),
  body: z.string().trim().min(3).max(2000),
  channels: z.array(z.enum(['push', 'email', 'inbox'])).min(1).max(3),
  audience: communicationsAudienceSchema,
}).strict();
export const faqCreateSchema = z.object({
  question: z.string().trim().min(3).max(200),
  answer: z.string().trim().min(3).max(2000),
  order: z.coerce.number().int().min(0).max(10000).optional(),
  isActive: z.boolean().optional(),
}).strict();
export const faqUpdateSchema = faqCreateSchema.partial();
export const deletionUpdateSchema = z
  .object({
    // erase_now skips the remaining cooling-off for a verified legal request, but still refuses mid-order or mid-refund.
    action: z.enum(['pause', 'resume', 'cancel', 'erase_now']).optional(),
    // Older admin builds send a status instead of an action.
    status: z.enum(['identity_verified', 'cooling_off', 'approved', 'anonymized', 'cancelled']).optional(),
    assignedTo: idSchema.optional(),
  })
  .refine((value) => value.action !== undefined || value.status !== undefined, { message: 'An action is required' });
export const logisticsStatusSchema = z.object({ status: z.nativeEnum(LogisticsStatus) });
export const productReviewSchema = z.object({
  status: z.nativeEnum(ProductStatus),
  adjustedSellingPrice: z.coerce.number().positive().optional(),
});
export const vendorTierSchema = z.object({
  tier: z.nativeEnum(VendorTier).optional(),
  commissionPercentage: z.coerce.number().min(0).max(100).optional(),
});
export const settlementTriggerSchema = z.object({
  reason: z.string().optional(),
  idempotencyKey: z.string().optional(),
});
export const refundSchema = z.object({
  amount: z.coerce.number().positive(),
  reason: z.string().trim().min(3).max(500),
  idempotencyKey: z.string().trim().min(8).max(100),
});
export const customerRefundRequestSchema = z.object({
  reasonType: z.enum(['not_delivered', 'damaged', 'wrong_item', 'other']),
  reason: z.string().trim().min(10).max(1000),
  evidenceUrls: z.array(z.string().url()).max(8).default([]),
  amount: z.coerce.number().positive().optional(),
  idempotencyKey: z.string().trim().min(8).max(100),
});
export const adminRefundReviewSchema = z.object({
  status: z.enum(['under_review', 'rejected']),
  assignedSupportUserId: idSchema.optional(),
  decisionNote: z.string().trim().min(3).max(1000),
});
export const settingsSchema = z.record(z.string(), z.unknown()).refine(
  (data) => typeof data.reason === 'string' && data.reason.trim().length >= 5,
  { message: 'A reason of at least 5 characters is required', path: ['reason'] },
);
export const reportSchema = z.object({ type: z.string().default('sales') });

export { NegotiationStatus, PaymentStatus };
