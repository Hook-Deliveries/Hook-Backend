import { BaseEntity, createModel, createSchema } from '@models/base.model';

export type DeletionStatus =
  | 'requested'
  | 'identity_verified'
  | 'cooling_off'
  | 'approved'
  | 'erasing'
  | 'anonymized'
  | 'cancelled';

/** Statuses that mean "a deletion is in flight for this person". At most one may exist. */
export const LIVE_DELETION_STATUSES: DeletionStatus[] = ['requested', 'identity_verified', 'cooling_off', 'approved', 'erasing'];

export interface AccountDeletionRequest extends BaseEntity {
  userId: string;
  reason?: string;
  status: DeletionStatus;
  source?: 'web' | 'app' | 'admin';
  assignedTo?: string;
  identityVerifiedAt?: Date;
  /** When erasure becomes due. Kept under its original name for existing rows. */
  coolingOffUntil: Date;
  /** SHA-256 of the single-use token in the "cancel deletion" email link. */
  cancelTokenHash?: string;
  reminderSentAt?: Date;
  /** An admin has frozen automatic erasure. */
  paused?: boolean;
  deferredUntil?: Date;
  deferReason?: string;
  /** Erasure steps already completed, so a crashed run resumes instead of repeating. */
  erasureSteps?: string[];
  erasureStartedAt?: Date;
  anonymizedAt?: Date;
  cancelledAt?: Date;
  cancelledBy?: 'customer' | 'admin';
}
const schema = createSchema<AccountDeletionRequest>({
  userId: { type: String, required: true, index: true },
  reason: { type: String, maxlength: 1000 },
  status: { type: String, enum: ['requested', 'identity_verified', 'cooling_off', 'approved', 'erasing', 'anonymized', 'cancelled'], default: 'requested', index: true },
  source: { type: String, enum: ['web', 'app', 'admin'], default: 'app' },
  assignedTo: { type: String, index: true },
  identityVerifiedAt: { type: Date },
  coolingOffUntil: { type: Date, required: true, index: true },
  cancelTokenHash: { type: String, select: false },
  reminderSentAt: { type: Date },
  paused: { type: Boolean, default: false },
  deferredUntil: { type: Date },
  deferReason: { type: String, maxlength: 300 },
  erasureSteps: { type: [String], default: [] },
  erasureStartedAt: { type: Date },
  anonymizedAt: { type: Date },
  cancelledAt: { type: Date },
  cancelledBy: { type: String, enum: ['customer', 'admin'] },
  deletedAt: { type: Date },
});
schema.index({ userId: 1, status: 1 });
schema.index({ cancelTokenHash: 1 }, { sparse: true });
// The database, not a read-then-write, guarantees one live request per person.
schema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: LIVE_DELETION_STATUSES } }, name: 'one_live_deletion_per_user' },
);
export const AccountDeletionRequest = createModel<AccountDeletionRequest>('AccountDeletionRequest', schema);
