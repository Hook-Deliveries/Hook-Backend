import { BaseEntity, createModel, createSchema } from '@models/base.model';

export type CreditEntryType =
  | 'welcome_bonus'
  | 'referral_signup'
  | 'referral_bonus'
  | 'order_spend'
  | 'order_refund'
  | 'order_earn'
  | 'admin_adjustment'
  | 'waitlist_bonus';

/**
 * Append-only. A user's balance is the sum of amountMinor over their entries,
 * never a mutable field, so a failed write can never leave a balance that
 * disagrees with its history. Credits spent are negative entries.
 */
export interface CreditLedger extends BaseEntity {
  userId: string;
  type: CreditEntryType;
  amountMinor: number;
  orderId?: string;
  referralId?: string;
  actorId?: string;
  note?: string;
  idempotencyKey: string;
}

const schema = createSchema<CreditLedger>({
  userId: { type: String, required: true, index: true },
  type: {
    type: String,
    enum: ['welcome_bonus', 'referral_signup', 'referral_bonus', 'order_spend', 'order_refund', 'order_earn', 'admin_adjustment', 'waitlist_bonus'],
    required: true,
    index: true,
  },
  amountMinor: { type: Number, required: true },
  orderId: { type: String, index: true },
  referralId: { type: String, index: true },
  actorId: { type: String },
  note: { type: String, maxlength: 300 },
  idempotencyKey: { type: String, required: true, unique: true },
  deletedAt: { type: Date },
});

schema.index({ userId: 1, createdAt: -1 });

export const CreditLedger = createModel<CreditLedger>('CreditLedger', schema);
