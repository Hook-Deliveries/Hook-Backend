import { BaseEntity, createModel, createSchema } from '@models/base.model';

export interface CouponRedemption extends BaseEntity {
  publicId: string;
  couponId: string;
  couponCode: string;
  userId: string;
  orderId?: string;
  discountMinor: number;
  status: 'applied' | 'released';
  idempotencyKey: string;
  releasedAt?: Date;
}

const schema = createSchema<CouponRedemption>({
  publicId: { type: String, unique: true, sparse: true, index: true },
  couponId: { type: String, required: true, index: true },
  couponCode: { type: String, required: true, uppercase: true, index: true },
  userId: { type: String, required: true, index: true },
  orderId: { type: String, index: true },
  discountMinor: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['applied', 'released'], default: 'applied', index: true },
  idempotencyKey: { type: String, required: true, unique: true },
  releasedAt: { type: Date },
  deletedAt: { type: Date },
});

// Drives the per-user usage check in CouponService.validate().
schema.index({ couponId: 1, userId: 1, status: 1 });

export const CouponRedemption = createModel<CouponRedemption>('CouponRedemption', schema);
