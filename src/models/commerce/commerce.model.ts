import { BaseEntity, createModel, createSchema } from "@models/base.model";

export interface CustomerAddress extends BaseEntity {
  publicId: string;
  customerId: string;
  label: string;
  recipientName: string;
  phone: string;
  line1: string;
  line2?: string;
  landmark?: string;
  stateId: string;
  cityId?: string;
  localGovernmentAreaId?: string;
  postalCode?: string;
  coordinates?: { latitude: number; longitude: number };
  formattedAddress?: string;
  stateCode: string;
  stateName: string;
  cityName: string;
  localGovernmentArea?: string;
  deliveryDistanceKm?: number;
  deliveryPricingSnapshot?: Record<string, unknown>;
  isDefault: boolean;
  status: "active" | "archived";
}

export interface CheckoutPreview extends BaseEntity {
  tokenHash: string;
  publicTokenId: string;
  actorType: "customer" | "partner";
  actorId: string;
  customerId: string;
  partnerId?: string;
  stateId: string;
  sourceStateIds?: string[];
  fulfilmentGroups?: Array<Record<string, unknown>>;
  cartId: string;
  cartVersion: number;
  channel: "SHOPPER_APP" | "PARTNER_ASSISTED";
  deliveryMethod: "HOME_DELIVERY" | "PARTNER_PICKUP";
  paymentMethod: "PREPAID" | "PAY_AT_HANDOVER";
  addressId?: string;
  addressSnapshot?: Record<string, unknown>;
  pickupPartnerSnapshot?: Record<string, unknown>;
  lines: Array<Record<string, unknown>>;
  subtotalMinor: number;
  vatRate: number;
  vatMinor: number;
  taxSnapshot?: Record<string, unknown>;
  deliveryFeeMinor: number;
  deliveryPricing?: Record<string, unknown>;
  logisticsProviderId?: string;
  logisticsProviderSnapshot?: Record<string, unknown>;
  couponId?: string;
  couponCode?: string;
  deliveryNote?: string;
  couponDiscountMinor: number;
  creditsAppliedMinor: number;
  totalMinor: number;
  currency: string;
  policyVersions: Record<string, string>;
  podDecision: Record<string, unknown>;
  /** Pay on Delivery: extra charge and the amount paid online now (delivery fee plus surcharge). */
  podSurchargeMinor?: number;
  podFeeDueNowMinor?: number;
  expiresAt: Date;
  consumedAt?: Date;
  orderId?: string;
}

export interface CommerceSettings extends BaseEntity {
  key: "commerce";
  currency: string;
  defaultDeliveryFeeMinor: number;
  podEnabled: boolean;
  defaultPodLimitMinor: number;
  previewTtlMinutes: number;
  catalogAvailabilityCheckDays: number;
  /** Ceiling on how much of one order's subtotal Hook credit may cover. */
  creditSpendCapPercent: number;
  /** Credits granted to every new customer account. */
  welcomeBonusMinor: number;
  /** Share of an order's subtotal returned as Hook credit once it is paid. */
  orderEarnPercent: number;
  /** Optional ceiling on a single order's earn. 0 means no cap. */
  orderEarnMaxMinor: number;
  orderEarnEnabled: boolean;
  referralSignupBonusMinor: number;
  referralReferrerBonusMinor: number;
  negotiationEnabled: boolean;
  negotiationSessionMode: "fixed" | "unlimited";
  negotiationSessionMinutes: number;
  negotiationMaximumOffers: number;
  negotiationQuoteMinutes: number;
  negotiationAzureWordingEnabled: boolean;
  paymentProviders: Array<{
    provider: "paystack" | "monnify";
    enabled: boolean;
    displayOrder: number;
    isDefault: boolean;
  }>;
  lowStockThreshold: number;
  /** Smallest cart subtotal (kobo) that may be checked out. Smaller carts can be saved but not bought. */
  minimumCheckoutMinor: number;
  /** Pay on Delivery is only offered on orders at or above this subtotal (kobo). */
  podMinimumOrderMinor: number;
  podSurchargeType: "flat" | "percent";
  /** Kobo when flat, percent of the subtotal when percent. */
  podSurchargeValue: number;
  podAutoApproveEnabled: boolean;
  /** Refused Pay on Delivery parcels before the customer loses the option. */
  podRefusalSuspendCount: number;
  /** VAT charged on products, as a percent. */
  vatRatePercent: number;
  activePolicyVersions: Record<string, string>;
  updatedBy?: string;
}

export interface CommercePolicyVersion extends BaseEntity {
  publicId: string;
  type: "TERMS" | "PRIVACY" | "RETURNS";
  version: string;
  status: "draft" | "active" | "retired";
  effectiveAt: Date;
  contentUrl?: string;
}

export interface PaymentWebhookEvent extends BaseEntity {
  provider: "paystack" | "monnify";
  providerEventId: string;
  payloadHash: string;
  eventType: string;
  reference?: string;
  signatureVerified: boolean;
  processingStatus: "received" | "processed" | "ignored" | "failed";
  processedAt?: Date;
  failureCode?: string;
}

export const OUTBOX_EVENT_TYPES = [
  "ORDER_APPROVED_FOR_FULFILMENT",
  "PAYMENT_CONFIRMED_EFFECTS",
  "ORDER_CREATED_EFFECTS",
  "REFUND_PROCESSED_EFFECTS",
] as const;
export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

export interface CommerceOutboxEvent extends BaseEntity {
  publicId: string;
  aggregateType: "order" | "payment" | "refund";
  aggregateId: string;
  eventType: OutboxEventType;
  eventVersion: number;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "published" | "dead_letter";
  attempts: number;
  availableAt: Date;
  processedAt?: Date;
  lastError?: string;
  firstFailedAt?: Date;
  lockedUntil?: Date;
  lockToken?: string;
  dispatchedAt?: Date;
}

export interface IntegrationException extends BaseEntity {
  provider: "paystack" | "monnify";
  type:
    | "signature"
    | "reference"
    | "amount"
    | "currency"
    | "status"
    | "network"
    | "replay";
  reference?: string;
  paymentId?: string;
  orderId?: string;
  requestId?: string;
  details: Record<string, unknown>;
  status: "open" | "resolved" | "ignored";
  resolvedBy?: string;
  resolvedAt?: Date;
}

export interface PodCallRecord extends BaseEntity {
  orderId: string;
  outcome: "CONFIRMED" | "NO_ANSWER" | "DECLINED" | "INVALID_CONTACT";
  notes?: string;
  actorId: string;
  calledAt: Date;
}

export interface PodOverride extends BaseEntity {
  orderId: string;
  reason: string;
  actorId: string;
  approvedAt: Date;
  amountMinor: number;
}

const addressSchema = createSchema<CustomerAddress>({
  publicId: { type: String, required: true, unique: true, index: true },
  customerId: { type: String, required: true, index: true },
  label: { type: String, required: true, maxlength: 60 },
  recipientName: { type: String, required: true, maxlength: 120 },
  phone: { type: String, required: true, maxlength: 30 },
  line1: { type: String, required: true, maxlength: 240 },
  line2: { type: String, maxlength: 240 },
  landmark: { type: String, maxlength: 240 },
  stateId: { type: String, required: true, index: true },
  cityId: { type: String, index: true, sparse: true },
  localGovernmentAreaId: { type: String, index: true, sparse: true },
  postalCode: { type: String, maxlength: 20 },
  coordinates: { type: Object },
  formattedAddress: { type: String, maxlength: 500 },
  stateCode: { type: String, required: true, uppercase: true, index: true },
  stateName: { type: String, required: true },
  cityName: { type: String, required: true },
  localGovernmentArea: { type: String },
  deliveryDistanceKm: { type: Number, min: 0 },
  deliveryPricingSnapshot: { type: Object },
  isDefault: { type: Boolean, default: false, index: true },
  status: {
    type: String,
    enum: ["active", "archived"],
    default: "active",
    index: true,
  },
  deletedAt: { type: Date },
});
addressSchema.index({ customerId: 1, status: 1, isDefault: -1, createdAt: -1 });

const previewSchema = createSchema<CheckoutPreview>({
  tokenHash: { type: String, required: true, unique: true, select: false },
  publicTokenId: { type: String, required: true, unique: true, index: true },
  actorType: { type: String, enum: ["customer", "partner"], required: true },
  actorId: { type: String, required: true, index: true },
  customerId: { type: String, required: true, index: true },
  partnerId: { type: String, index: true },
  stateId: { type: String, required: true, index: true },
  sourceStateIds: { type: [String], default: [] },
  fulfilmentGroups: { type: [Object], default: [] },
  cartId: { type: String, required: true, index: true },
  cartVersion: { type: Number, required: true },
  channel: {
    type: String,
    enum: ["SHOPPER_APP", "PARTNER_ASSISTED"],
    required: true,
  },
  deliveryMethod: {
    type: String,
    enum: ["HOME_DELIVERY", "PARTNER_PICKUP"],
    required: true,
  },
  paymentMethod: {
    type: String,
    enum: ["PREPAID", "PAY_AT_HANDOVER"],
    required: true,
  },
  addressId: { type: String },
  addressSnapshot: { type: Object },
  pickupPartnerSnapshot: { type: Object },
  lines: { type: [Object], required: true },
  subtotalMinor: { type: Number, required: true, min: 0 },
  vatRate: { type: Number, required: true, min: 0, default: 0.075 },
  vatMinor: { type: Number, required: true, min: 0, default: 0 },
  taxSnapshot: { type: Object },
  deliveryFeeMinor: { type: Number, required: true, min: 0 },
  deliveryPricing: { type: Object },
  logisticsProviderId: { type: String },
  logisticsProviderSnapshot: { type: Object },
  couponId: { type: String },
  couponCode: { type: String, uppercase: true },
  deliveryNote: { type: String, maxlength: 300 },
  couponDiscountMinor: { type: Number, default: 0, min: 0 },
  creditsAppliedMinor: { type: Number, default: 0, min: 0 },
  totalMinor: { type: Number, required: true, min: 0 },
  currency: { type: String, default: "NGN" },
  policyVersions: { type: Object, required: true },
  podDecision: { type: Object, default: {} },
  podSurchargeMinor: { type: Number, default: 0, min: 0 },
  podFeeDueNowMinor: { type: Number, default: 0, min: 0 },
  expiresAt: { type: Date, required: true },
  consumedAt: { type: Date },
  orderId: { type: String, index: true },
  deletedAt: { type: Date },
});
previewSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });

const settingsSchema = createSchema<CommerceSettings>({
  key: { type: String, enum: ["commerce"], unique: true, default: "commerce" },
  currency: { type: String, default: "NGN" },
  defaultDeliveryFeeMinor: { type: Number, default: 300000, min: 0 },
  podEnabled: { type: Boolean, default: false },
  defaultPodLimitMinor: { type: Number, default: 10000000, min: 0 },
  previewTtlMinutes: { type: Number, default: 10, min: 2, max: 30 },
  catalogAvailabilityCheckDays: { type: Number, default: 4, min: 1, max: 30 },
  creditSpendCapPercent: { type: Number, default: 20, min: 0, max: 100 },
  welcomeBonusMinor: { type: Number, default: 30000, min: 0 },
  orderEarnPercent: { type: Number, default: 1, min: 0, max: 100 },
  orderEarnMaxMinor: { type: Number, default: 0, min: 0 },
  orderEarnEnabled: { type: Boolean, default: true },
  referralSignupBonusMinor: { type: Number, default: 30000, min: 0 },
  referralReferrerBonusMinor: { type: Number, default: 100000, min: 0 },
  negotiationEnabled: { type: Boolean, default: true },
  negotiationSessionMode: { type: String, enum: ["fixed", "unlimited"], default: "fixed" },
  negotiationSessionMinutes: { type: Number, default: 10, min: 1, max: 1440 },
  negotiationMaximumOffers: { type: Number, default: 3, min: 1, max: 10 },
  negotiationQuoteMinutes: { type: Number, default: 30, min: 1, max: 1440 },
  negotiationAzureWordingEnabled: { type: Boolean, default: true },
  paymentProviders: {
    type: [Object],
    default: [
      { provider: "paystack", enabled: true, displayOrder: 1, isDefault: true },
    ],
  },
  lowStockThreshold: { type: Number, default: 5, min: 0, max: 100 },
  minimumCheckoutMinor: { type: Number, default: 1800000, min: 0 },
  podMinimumOrderMinor: { type: Number, default: 3000000, min: 0 },
  podSurchargeType: { type: String, enum: ["flat", "percent"], default: "flat" },
  podSurchargeValue: { type: Number, default: 0, min: 0 },
  podAutoApproveEnabled: { type: Boolean, default: true },
  podRefusalSuspendCount: { type: Number, default: 2, min: 1, max: 20 },
  vatRatePercent: { type: Number, default: 7.5, min: 0, max: 30 },
  activePolicyVersions: { type: Object, default: {} },
  updatedBy: { type: String },
  deletedAt: { type: Date },
});
const policySchema = createSchema<CommercePolicyVersion>({
  publicId: { type: String, required: true, unique: true },
  type: {
    type: String,
    enum: ["TERMS", "PRIVACY", "RETURNS"],
    required: true,
    index: true,
  },
  version: { type: String, required: true },
  status: {
    type: String,
    enum: ["draft", "active", "retired"],
    default: "draft",
    index: true,
  },
  effectiveAt: { type: Date, required: true },
  contentUrl: { type: String },
  deletedAt: { type: Date },
});
policySchema.index({ type: 1, version: 1 }, { unique: true });
const webhookSchema = createSchema<PaymentWebhookEvent>({
  provider: { type: String, enum: ["paystack", "monnify"], required: true },
  providerEventId: { type: String, required: true },
  payloadHash: { type: String, required: true },
  eventType: { type: String, required: true },
  reference: { type: String, index: true },
  signatureVerified: { type: Boolean, required: true },
  processingStatus: {
    type: String,
    enum: ["received", "processed", "ignored", "failed"],
    default: "received",
  },
  processedAt: { type: Date },
  failureCode: { type: String },
  deletedAt: { type: Date },
});
webhookSchema.index({ provider: 1, providerEventId: 1 }, { unique: true });
const outboxSchema = createSchema<CommerceOutboxEvent>({
  publicId: { type: String, required: true, unique: true, index: true },
  aggregateType: { type: String, enum: ["order", "payment", "refund"], default: "order" },
  aggregateId: { type: String, required: true, index: true },
  eventType: {
    type: String,
    enum: [...OUTBOX_EVENT_TYPES],
    required: true,
  },
  eventVersion: { type: Number, default: 1 },
  payload: { type: Object, required: true },
  status: {
    type: String,
    enum: ["pending", "processing", "published", "dead_letter"],
    default: "pending",
    index: true,
  },
  attempts: { type: Number, default: 0 },
  availableAt: { type: Date, default: Date.now, index: true },
  processedAt: { type: Date },
  lastError: { type: String, maxlength: 1000 },
  firstFailedAt: { type: Date },
  lockedUntil: { type: Date, index: true },
  lockToken: { type: String, index: true, sparse: true },
  dispatchedAt: { type: Date },
  deletedAt: { type: Date },
});
outboxSchema.index(
  { aggregateId: 1, eventType: 1, eventVersion: 1 },
  { unique: true },
);
const exceptionSchema = createSchema<IntegrationException>({
  provider: { type: String, enum: ["paystack", "monnify"], default: "paystack" },
  type: {
    type: String,
    enum: [
      "signature",
      "reference",
      "amount",
      "currency",
      "status",
      "network",
      "replay",
    ],
    required: true,
  },
  reference: { type: String, index: true },
  paymentId: { type: String, index: true },
  orderId: { type: String, index: true },
  requestId: { type: String },
  details: { type: Object, default: {} },
  status: {
    type: String,
    enum: ["open", "resolved", "ignored"],
    default: "open",
    index: true,
  },
  resolvedBy: { type: String },
  resolvedAt: { type: Date },
  deletedAt: { type: Date },
});
// One open exception per (provider, reference, type), so retried webhooks don't add a fresh row each attempt; resolved rows are exempt.
exceptionSchema.index(
  { provider: 1, reference: 1, type: 1 },
  { unique: true, partialFilterExpression: { status: "open", reference: { $type: "string" } } },
);
const podCallSchema = createSchema<PodCallRecord>({
  orderId: { type: String, required: true, index: true },
  outcome: {
    type: String,
    enum: ["CONFIRMED", "NO_ANSWER", "DECLINED", "INVALID_CONTACT"],
    required: true,
  },
  notes: { type: String, maxlength: 1000 },
  actorId: { type: String, required: true },
  calledAt: { type: Date, default: Date.now },
  deletedAt: { type: Date },
});
const podOverrideSchema = createSchema<PodOverride>({
  orderId: { type: String, required: true, unique: true, index: true },
  reason: { type: String, required: true, maxlength: 1000 },
  actorId: { type: String, required: true },
  approvedAt: { type: Date, default: Date.now },
  amountMinor: { type: Number, required: true, min: 0 },
  deletedAt: { type: Date },
});

export const CustomerAddress = createModel<CustomerAddress>(
  "CustomerAddress",
  addressSchema,
);
export const CheckoutPreview = createModel<CheckoutPreview>(
  "CheckoutPreview",
  previewSchema,
);
export const CommerceSettings = createModel<CommerceSettings>(
  "CommerceSettings",
  settingsSchema,
);
export const CommercePolicyVersion = createModel<CommercePolicyVersion>(
  "CommercePolicyVersion",
  policySchema,
);
export const PaymentWebhookEvent = createModel<PaymentWebhookEvent>(
  "PaymentWebhookEvent",
  webhookSchema,
);
export const CommerceOutboxEvent = createModel<CommerceOutboxEvent>(
  "CommerceOutboxEvent",
  outboxSchema,
);
export const IntegrationException = createModel<IntegrationException>(
  "IntegrationException",
  exceptionSchema,
);
export const PodCallRecord = createModel<PodCallRecord>(
  "PodCallRecord",
  podCallSchema,
);
export const PodOverride = createModel<PodOverride>(
  "PodOverride",
  podOverrideSchema,
);
