import { z } from 'zod';

const moneyMinor = z.coerce.number().int().nonnegative().max(10_000_000_000);
const reason = z.string().trim().min(3).max(500).optional();
// Coupons affect what every customer pays, so unlike the optional `reason` above, an audit reason is mandatory here.
const couponReason = z.string().trim().min(5).max(500);

export const logisticsProviderCreateSchema = z.object({
  code: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(80),
  logoUrl: z.string().url().optional(),
  description: z.string().trim().max(300).optional(),
  feeMinor: moneyMinor.optional(),
  status: z.enum(['active', 'inactive']).default('active'),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
  reason,
}).strict();

export const logisticsProviderUpdateSchema = logisticsProviderCreateSchema.partial().strict();

export const couponCreateSchema = z.object({
  code: z.string().trim().min(3).max(40),
  description: z.string().trim().max(300).optional(),
  type: z.enum(['percentage', 'fixed', 'free_delivery']),
  value: z.coerce.number().nonnegative(),
  maxDiscountMinor: moneyMinor.optional(),
  minSubtotalMinor: moneyMinor.optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  totalUsageLimit: z.coerce.number().int().positive().optional(),
  perUserLimit: z.coerce.number().int().positive().default(1),
  status: z.enum(['active', 'paused']).default('active'),
  reason: couponReason,
}).strict().superRefine(validateCouponShape);

export const couponUpdateSchema = z.object({
  code: z.string().trim().min(3).max(40).optional(),
  description: z.string().trim().max(300).optional(),
  type: z.enum(['percentage', 'fixed', 'free_delivery']).optional(),
  value: z.coerce.number().nonnegative().optional(),
  maxDiscountMinor: moneyMinor.optional(),
  minSubtotalMinor: moneyMinor.optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  totalUsageLimit: z.coerce.number().int().positive().optional(),
  perUserLimit: z.coerce.number().int().positive().optional(),
  status: z.enum(['active', 'paused']).optional(),
  reason: couponReason,
}).strict().superRefine(validateCouponShape);

/** `value`'s bounds differ by type: a percentage above 100 would pay the customer, and a fixed amount of zero is a no-op. */
function validateCouponShape(
  data: { type?: string; value?: number; startsAt?: Date; endsAt?: Date },
  ctx: z.RefinementCtx,
) {
  if (data.type === 'percentage' && data.value !== undefined && (data.value <= 0 || data.value > 100)) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'A percentage coupon must be between 1 and 100' });
  }
  if (data.type === 'fixed' && data.value !== undefined && data.value <= 0) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'A fixed coupon needs an amount above zero (in minor units)' });
  }
  if (data.startsAt && data.endsAt && data.startsAt >= data.endsAt) {
    ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'The end date must come after the start date' });
  }
}
