import { BaseEntity, createModel, createSchema } from "@models/base.model";

export type PaymentProviderName = "paystack" | "monnify";

export interface PaymentLink extends BaseEntity {
  publicId: string;
  tokenHash: string;
  paymentId: string;
  orderId: string;
  fulfilmentGroupId?: string;
  /** Set when this link pays a replacement-item top-up rather than a normal order/delivery payment. */
  itemResolutionId?: string;
  customerId: string;
  provider: PaymentProviderName;
  amountMinor: number;
  currency: string;
  status: "active" | "processing" | "paid" | "expired" | "revoked" | "cancelled";
  expiresAt: Date;
  usedAt?: Date;
  revokedAt?: Date;
  lastAccessedAt?: Date;
  createdBy: string;
}

export interface PaymentAttempt extends BaseEntity {
  publicId: string;
  paymentLinkId: string;
  paymentId: string;
  orderId: string;
  provider: PaymentProviderName;
  reference: string;
  idempotencyKey: string;
  requestHash: string;
  status: "initializing" | "processing" | "confirmed" | "failed" | "expired" | "cancelled";
  authorizationUrl?: string;
  providerReference?: string;
  errorCode?: string;
  expiresAt: Date;
  completedAt?: Date;
}

const paymentLinkSchema = createSchema<PaymentLink>({
  publicId: { type: String, required: true, unique: true, index: true },
  tokenHash: { type: String, required: true, unique: true, index: true, select: false },
  paymentId: { type: String, required: true, index: true },
  orderId: { type: String, required: true, index: true },
  fulfilmentGroupId: { type: String, index: true, sparse: true },
  itemResolutionId: { type: String, index: true, sparse: true },
  customerId: { type: String, required: true, index: true },
  // The interface declared this but the schema did not, so Mongoose silently
  // dropped it on every link — leaving provider undefined and the hosted
  // payment page with nothing to initialize against.
  provider: { type: String, enum: ["paystack", "monnify"], default: "paystack", index: true },
  amountMinor: { type: Number, required: true, min: 0 },
  currency: { type: String, required: true, default: "NGN" },
  status: {
    type: String,
    enum: ["active", "processing", "paid", "expired", "revoked", "cancelled"],
    default: "active",
    index: true,
  },
  expiresAt: { type: Date, required: true, index: true },
  usedAt: { type: Date },
  revokedAt: { type: Date },
  lastAccessedAt: { type: Date },
  createdBy: { type: String, required: true },
  deletedAt: { type: Date },
});
paymentLinkSchema.index({ paymentId: 1, status: 1, expiresAt: 1 });

const paymentAttemptSchema = createSchema<PaymentAttempt>({
  publicId: { type: String, required: true, unique: true, index: true },
  paymentLinkId: { type: String, required: true, index: true },
  paymentId: { type: String, required: true, index: true },
  orderId: { type: String, required: true, index: true },
  provider: { type: String, enum: ["paystack", "monnify"], required: true, index: true },
  reference: { type: String, required: true, unique: true, index: true },
  idempotencyKey: { type: String, required: true },
  requestHash: { type: String, required: true },
  status: {
    type: String,
    enum: ["initializing", "processing", "confirmed", "failed", "expired", "cancelled"],
    default: "initializing",
    index: true,
  },
  authorizationUrl: { type: String },
  providerReference: { type: String },
  errorCode: { type: String },
  expiresAt: { type: Date, required: true, index: true },
  completedAt: { type: Date },
  deletedAt: { type: Date },
});
paymentAttemptSchema.index({ paymentId: 1, status: 1 });
paymentAttemptSchema.index({ paymentLinkId: 1, idempotencyKey: 1 }, { unique: true });

export const PaymentLink = createModel<PaymentLink>("PaymentLink", paymentLinkSchema);
export const PaymentAttempt = createModel<PaymentAttempt>("PaymentAttempt", paymentAttemptSchema);
