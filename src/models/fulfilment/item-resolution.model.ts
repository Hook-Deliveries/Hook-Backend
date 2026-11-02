import { BaseEntity, createModel, createSchema } from '@models/base.model';

export const ITEM_RESOLUTION_STATUSES = [
  'OPEN', 'ADMIN_REVIEW', 'CUSTOMER_APPROVAL_PENDING', 'PAYMENT_PENDING',
  'REFUND_PENDING', 'APPROVED', 'DECLINED', 'RESOLVED', 'CANCELLED',
] as const;

export type ItemResolutionStatus = typeof ITEM_RESOLUTION_STATUSES[number];

export interface ItemResolution extends BaseEntity {
  publicId: string;
  orderId: string;
  taskId: string;
  orderItemId: string;
  marketId: string;
  type: string;
  summary: string;
  evidence: Array<Record<string, unknown>>;
  originalSnapshot: Record<string, unknown>;
  proposal?: Record<string, unknown>;
  status: ItemResolutionStatus;
  reportedBy: string;
  customerId?: string;
  customerDecision?: 'ACCEPTED' | 'DECLINED';
  customerDecidedAt?: Date;
  adjustmentMinor: number;
  adjustmentStatus?: 'NOT_REQUIRED' | 'PENDING' | 'CONFIRMED' | 'FAILED';
  /** The same hosted checkout page a normal order/delivery payment uses (/payment/{token}) — see PaymentLinkService.createForSubstitution. The backing Payment is found by Payment.itemResolutionId, not stored here. */
  adjustmentAuthorizationUrl?: string;
  adjustmentProviderReference?: string;
  adjustmentProcessedAt?: Date;
  idempotencyKey: string;
  version: number;
  history: Array<Record<string, unknown>>;
}

const schema = createSchema<ItemResolution>({
  publicId: { type: String, required: true, unique: true, index: true },
  orderId: { type: String, required: true, index: true },
  taskId: { type: String, required: true, index: true },
  orderItemId: { type: String, required: true, index: true },
  marketId: { type: String, required: true, index: true },
  type: { type: String, required: true },
  summary: { type: String, required: true },
  evidence: { type: [Object], default: [] },
  originalSnapshot: { type: Object, required: true },
  proposal: { type: Object },
  status: { type: String, enum: ITEM_RESOLUTION_STATUSES, default: 'OPEN', index: true },
  reportedBy: { type: String, required: true },
  customerId: { type: String, index: true, sparse: true },
  customerDecision: { type: String, enum: ['ACCEPTED', 'DECLINED'] },
  customerDecidedAt: { type: Date },
  adjustmentMinor: { type: Number, default: 0 },
  adjustmentStatus: { type: String, enum: ['NOT_REQUIRED', 'PENDING', 'CONFIRMED', 'FAILED'] },
  adjustmentAuthorizationUrl: { type: String },
  adjustmentProviderReference: { type: String },
  adjustmentProcessedAt: { type: Date },
  idempotencyKey: { type: String, required: true, unique: true, index: true },
  version: { type: Number, default: 1, min: 1 },
  history: { type: [Object], default: [] },
});

schema.index(
  { taskId: 1, orderItemId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['OPEN', 'ADMIN_REVIEW', 'CUSTOMER_APPROVAL_PENDING', 'PAYMENT_PENDING', 'REFUND_PENDING', 'APPROVED'] } } },
);
schema.index({ customerId: 1, status: 1, createdAt: -1 });

export const ItemResolution = createModel<ItemResolution>('ItemResolution', schema);
