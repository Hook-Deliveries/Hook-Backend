import { NegotiationStatus } from '@lib/constants';
import { BaseEntity, createModel, createSchema } from '@models/base.model';

export interface NegotiationMessage {
  sequence?: number;
  requestId?: string;
  id?: string;
  kind?: 'text' | 'suggestions' | 'action' | 'receipt';
  productIds?: string[];
  actionId?: string;
  quantity?: number;
  role: 'customer' | 'hook';
  message: string;
  offeredPriceMinor?: number;
  decision?: 'ACCEPT' | 'COUNTER' | 'DECLINE';
  createdAt: Date;
}

export interface Negotiation extends BaseEntity {
  commandLock?: { owner: string; expiresAt: Date };
  startNotificationPending?: boolean;
  shoppingActions?: Array<{ id: string; state: 'pending' | 'executing' | 'completed'; quantity: number; quoteId: string; leaseUntil?: Date; executionId?: string; receipt?: Record<string, unknown> }>;
  publicId?: string;
  customerId?: string;
  guestSessionId?: string;
  channel: 'shopper' | 'partner_assisted';
  initiatingPartnerId?: string;
  productId: string;
  sourceStateId?: string;
  marketId?: string;
  variantId?: string;
  quantity: number;
  currency: string;
  status: NegotiationStatus;
  offerCount: number;
  maximumOffers: number;
  transcript: NegotiationMessage[];
  rulesSnapshot?: {
    sellingPriceMinor: number;
    minimumNegotiablePriceMinor: number;
    maximumDiscountMinor: number;
    maximumOffers: number;
    sessionMode?: 'fixed' | 'unlimited';
    sessionMinutes?: number;
    quoteMinutes?: number;
    azureWordingEnabled?: boolean;
  };
  language?: 'english' | 'pidgin';
  lastDecision?: 'ACCEPT' | 'COUNTER' | 'DECLINE';
  lastCounterPriceMinor?: number;
  agreedPriceMinor?: number;
  providerTelemetry?: {
    provider: 'azure_openai' | 'fallback';
    requestId?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    failed?: boolean;
    failureCode?: string;
  }[];
  idempotencyResults?: Array<{
    key: string;
    requestHash: string;
    response: Record<string, unknown>;
    createdAt: Date;
  }>;
  expiresAt?: Date;
  quoteId?: string;
  version: number;

  // Legacy fields retained only for migration/read compatibility.
  userId?: string;
  guestId?: string;
  guestEmail?: string;
  guestName?: string;
  round?: number;
  offeredPrice?: number;
  counterPrice?: number;
  acceptedPrice?: number;
  costPrice?: number;
  sellingPrice?: number;
  minAcceptablePrice?: number;
  messageHistory?: Array<{ role: 'user' | 'bot'; message: string; price?: number; timestamp: string }>;
  expiredAt?: Date;
  acceptedAt?: Date;
  declineReason?: string;
  user?: unknown;
  product?: unknown;
}

const schema = createSchema<Negotiation>({
  commandLock: { type: Object },
  startNotificationPending: { type: Boolean, index: true },
  publicId: { type: String, unique: true, sparse: true, index: true },
  customerId: { type: String, index: true, sparse: true },
  guestSessionId: { type: String, index: true, sparse: true },
  channel: { type: String, enum: ['shopper', 'partner_assisted'], default: 'shopper', index: true },
  initiatingPartnerId: { type: String, index: true, sparse: true },
  productId: { type: String, required: true, index: true },
  sourceStateId: { type: String, index: true, sparse: true },
  marketId: { type: String, index: true, sparse: true },
  variantId: { type: String, index: true, sparse: true },
  quantity: { type: Number, default: 1, min: 1 },
  currency: { type: String, uppercase: true, default: 'NGN' },
  status: { type: String, enum: Object.values(NegotiationStatus), default: NegotiationStatus.ACTIVE, index: true },
  offerCount: { type: Number, default: 0, min: 0 },
  maximumOffers: { type: Number, default: 3, min: 1, max: 10 },
  transcript: { type: [Object], default: [] },
  shoppingActions: { type: [Object], default: [] },
  rulesSnapshot: { type: Object },
  language: { type: String, enum: ['english', 'pidgin'], default: 'english' },
  lastDecision: { type: String, enum: ['ACCEPT', 'COUNTER', 'DECLINE'] },
  lastCounterPriceMinor: { type: Number },
  agreedPriceMinor: { type: Number },
  providerTelemetry: { type: [Object], default: [] },
  idempotencyResults: { type: [Object], default: [] },
  expiresAt: { type: Date, index: true },
  quoteId: { type: String, index: true, sparse: true },
  version: { type: Number, default: 1, min: 1 },
  userId: { type: String, index: true, sparse: true },
  guestId: { type: String, index: true, sparse: true },
  guestEmail: { type: String, lowercase: true, trim: true },
  guestName: { type: String },
  round: { type: Number },
  offeredPrice: { type: Number },
  counterPrice: { type: Number },
  acceptedPrice: { type: Number },
  costPrice: { type: Number },
  sellingPrice: { type: Number },
  minAcceptablePrice: { type: Number },
  messageHistory: { type: [Object], default: [] },
  expiredAt: { type: Date },
  acceptedAt: { type: Date },
  declineReason: { type: String },
  deletedAt: { type: Date },
});
schema.index({ customerId: 1, productId: 1, variantId: 1, quantity: 1, status: 1 });
schema.index({ guestSessionId: 1, productId: 1, status: 1 });
schema.index({ sourceStateId: 1, status: 1, createdAt: -1 });

export const Negotiation = createModel<Negotiation>('Negotiation', schema);
