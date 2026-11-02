import { BaseEntity, createModel, createSchema } from '@models/base.model';

export type CouponType = 'percentage' | 'fixed' | 'free_delivery';

export interface Coupon extends BaseEntity {
  publicId: string;
  code: string;
  description?: string;
  type: CouponType;
  /** Percent (1-100) for 'percentage'; minor units for 'fixed'; ignored for 'free_delivery'. */
  value: number;
  maxDiscountMinor?: number;
  minSubtotalMinor?: number;
  startsAt?: Date;
  endsAt?: Date;
  totalUsageLimit?: number;
  perUserLimit: number;
  usedCount: number;
  status: 'active' | 'paused';
  createdBy?: string;
}

const schema = createSchema<Coupon>({
  publicId: { type: String, unique: true, sparse: true, index: true },
  code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 40 },
  description: { type: String, maxlength: 300 },
  type: { type: String, enum: ['percentage', 'fixed', 'free_delivery'], required: true },
  value: { type: Number, required: true, min: 0 },
  maxDiscountMinor: { type: Number, min: 0 },
  minSubtotalMinor: { type: Number, min: 0 },
  startsAt: { type: Date },
  endsAt: { type: Date, index: true },
  totalUsageLimit: { type: Number, min: 1 },
  perUserLimit: { type: Number, default: 1, min: 1 },
  usedCount: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: ['active', 'paused'], default: 'active', index: true },
  createdBy: { type: String },
  deletedAt: { type: Date },
});

schema.index({ status: 1, endsAt: 1 });

export const Coupon = createModel<Coupon>('Coupon', schema);
