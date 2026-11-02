import { BaseEntity, createModel, createSchema } from '@models/base.model';

/**
 * One row per referred signup. The referrer's bonus is deliberately withheld
 * until the referee's first paid order (status 'qualified') so signups alone
 * cannot be farmed for credit.
 */
export interface Referral extends BaseEntity {
  publicId: string;
  referrerUserId: string;
  refereeUserId: string;
  code: string;
  status: 'pending' | 'qualified' | 'cancelled';
  signupBonusMinor: number;
  referrerBonusMinor: number;
  qualifiedAt?: Date;
  qualifyingOrderId?: string;
}

const schema = createSchema<Referral>({
  publicId: { type: String, unique: true, sparse: true, index: true },
  referrerUserId: { type: String, required: true, index: true },
  // A person can only ever be referred once.
  refereeUserId: { type: String, required: true, unique: true, index: true },
  code: { type: String, required: true, uppercase: true, index: true },
  status: { type: String, enum: ['pending', 'qualified', 'cancelled'], default: 'pending', index: true },
  signupBonusMinor: { type: Number, default: 0, min: 0 },
  referrerBonusMinor: { type: Number, default: 0, min: 0 },
  qualifiedAt: { type: Date },
  qualifyingOrderId: { type: String },
  deletedAt: { type: Date },
});

schema.index({ referrerUserId: 1, status: 1, createdAt: -1 });

export const Referral = createModel<Referral>('Referral', schema);
