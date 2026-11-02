import {
  NegotiatedQuoteStatus,
  ProductAvailabilityStatus,
  ProductSubmissionStatus,
} from '@lib/constants';
import { BaseEntity, createModel, createSchema } from '@models/base.model';

export interface SubmissionVariant {
  size?: string;
  colour?: string;
  attributes: Record<string, string>;
  active: boolean;
}

export interface ReviewNote {
  action: 'submitted' | 'review_started' | 'changes_requested' | 'approved' | 'rejected' | 'comment';
  message?: string;
  fields?: string[];
  actorId: string;
  actorPublicId?: string;
  createdAt: Date;
}

export interface ProductSubmission extends BaseEntity {
  publicId: string;
  marketAssociateId: string;
  marketId: string;
  marketVendorId?: string;
  sourceStateId: string;
  categorySuggestionId: string;
  basicTitle: string;
  notes?: string;
  mediaIds: string[];
  mediaViews?: { front?: string; side?: string; back?: string };
  captureChecklistConfirmed?: boolean;
  basePriceMinor: number;
  currency: string;
  variants: SubmissionVariant[];
  availabilityStatus: ProductAvailabilityStatus;
  availabilityNote?: string;
  /** When the Market Associate confirmed on the market that this item is available (set on submit). */
  availabilityVerifiedAt?: Date;
  /** Derived from the source supplier when the capture is saved; never typed in by hand. */
  internalSellerReference?: string;
  status: ProductSubmissionStatus;
  reviewNotes: ReviewNote[];
  submittedAt?: Date;
  reviewStartedAt?: Date;
  reviewedAt?: Date;
  reviewedBy?: string;
  productId?: string;
  version: number;
}

export interface CatalogMediaAsset extends BaseEntity {
  publicId: string;
  provider: 'cloudinary' | 'legacy_external';
  providerPublicId: string;
  resourceType: 'image';
  deliveryType: 'authenticated' | 'upload' | 'external';
  secureUrl?: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
  uploaderAccountId: string;
  ownerType: 'submission' | 'product';
  ownerId?: string;
  uploadIntentId: string;
  status: 'pending' | 'ready' | 'rejected' | 'removed';
  order: number;
  metadata?: Record<string, unknown>;
}

export interface ProductVariant extends BaseEntity {
  publicId: string;
  productId: string;
  sku: string;
  size?: string;
  colour?: string;
  attributes: Record<string, string>;
  active: boolean;
  mediaAssetIds: string[];
  migrationSource?: string;
}

export interface NegotiatedQuote extends BaseEntity {
  publicId: string;
  negotiationId: string;
  customerId: string;
  productId: string;
  variantId: string;
  quantity: number;
  currency: string;
  originalPriceMinor: number;
  agreedPriceMinor: number;
  expiresAt: Date;
  status: NegotiatedQuoteStatus;
  version?: number;
  reservedByCheckoutPreviewId?: string;
  reservedUntil?: Date;
  usedByOrderId?: string;
  usedAt?: Date;
}

const submissionSchema = createSchema<ProductSubmission>({
  publicId: { type: String, required: true, unique: true, index: true },
  marketAssociateId: { type: String, required: true, index: true },
  marketId: { type: String, required: true, index: true },
  marketVendorId: { type: String, index: true },
  sourceStateId: { type: String, required: true, index: true },
  categorySuggestionId: { type: String, required: true, index: true },
  basicTitle: { type: String, required: true, trim: true, maxlength: 180 },
  notes: { type: String, maxlength: 2000 },
  mediaIds: { type: [String], default: [] },
  mediaViews: { type: Object, default: {} },
  captureChecklistConfirmed: { type: Boolean, default: false },
  basePriceMinor: { type: Number, required: true, min: 1 },
  currency: { type: String, required: true, uppercase: true, default: 'NGN' },
  variants: { type: [Object], default: [] },
  availabilityStatus: {
    type: String,
    enum: Object.values(ProductAvailabilityStatus),
    default: ProductAvailabilityStatus.UNCONFIRMED,
    index: true,
  },
  availabilityNote: { type: String, maxlength: 500 },
  availabilityVerifiedAt: { type: Date },
  internalSellerReference: { type: String, maxlength: 300 },
  status: {
    type: String,
    enum: Object.values(ProductSubmissionStatus),
    default: ProductSubmissionStatus.DRAFT,
    index: true,
  },
  reviewNotes: { type: [Object], default: [] },
  submittedAt: { type: Date },
  reviewStartedAt: { type: Date },
  reviewedAt: { type: Date },
  reviewedBy: { type: String, index: true },
  productId: { type: String, index: true },
  version: { type: Number, default: 1, min: 1 },
  deletedAt: { type: Date },
});
submissionSchema.index({ marketAssociateId: 1, status: 1, updatedAt: -1 });
submissionSchema.index({ sourceStateId: 1, marketId: 1, status: 1 });
submissionSchema.index({ basicTitle: 'text', publicId: 'text' });

const mediaSchema = createSchema<CatalogMediaAsset>({
  publicId: { type: String, required: true, unique: true, index: true },
  provider: { type: String, enum: ['cloudinary', 'legacy_external'], required: true },
  providerPublicId: { type: String, required: true, unique: true, index: true },
  resourceType: { type: String, enum: ['image'], default: 'image' },
  deliveryType: { type: String, enum: ['authenticated', 'upload', 'external'], required: true },
  secureUrl: { type: String },
  format: { type: String, required: true },
  width: { type: Number, required: true, min: 1 },
  height: { type: Number, required: true, min: 1 },
  bytes: { type: Number, required: true, min: 1 },
  uploaderAccountId: { type: String, required: true, index: true },
  ownerType: { type: String, enum: ['submission', 'product'], required: true, index: true },
  ownerId: { type: String, index: true },
  uploadIntentId: { type: String, required: true, unique: true, index: true },
  status: { type: String, enum: ['pending', 'ready', 'rejected', 'removed'], default: 'pending', index: true },
  order: { type: Number, default: 0 },
  metadata: { type: Object },
  deletedAt: { type: Date },
});
mediaSchema.index({ ownerType: 1, ownerId: 1, status: 1, order: 1 });

const variantSchema = createSchema<ProductVariant>({
  publicId: { type: String, required: true, unique: true, index: true },
  productId: { type: String, required: true, index: true },
  sku: { type: String, required: true, unique: true, trim: true, uppercase: true },
  size: { type: String, trim: true },
  colour: { type: String, trim: true },
  attributes: { type: Object, default: {} },
  active: { type: Boolean, default: true, index: true },
  mediaAssetIds: { type: [String], default: [] },
  migrationSource: { type: String, index: true, sparse: true },
  deletedAt: { type: Date },
});
variantSchema.index(
  { productId: 1, size: 1, colour: 1, attributes: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

const quoteSchema = createSchema<NegotiatedQuote>({
  publicId: { type: String, required: true, unique: true, index: true },
  negotiationId: { type: String, required: true, unique: true, index: true },
  customerId: { type: String, required: true, index: true },
  productId: { type: String, required: true, index: true },
  variantId: { type: String, required: true, index: true },
  quantity: { type: Number, required: true, min: 1 },
  currency: { type: String, required: true, uppercase: true },
  originalPriceMinor: { type: Number, required: true, min: 1 },
  agreedPriceMinor: { type: Number, required: true, min: 1 },
  expiresAt: { type: Date, required: true, index: true },
  status: { type: String, enum: Object.values(NegotiatedQuoteStatus), default: NegotiatedQuoteStatus.ACTIVE, index: true },
  version: { type: Number, default: 1, min: 1 },
  reservedByCheckoutPreviewId: { type: String, index: true, sparse: true },
  reservedUntil: { type: Date, index: true },
  usedByOrderId: { type: String, index: true, sparse: true },
  usedAt: { type: Date },
  deletedAt: { type: Date },
});
quoteSchema.index({ customerId: 1, status: 1, expiresAt: 1 });

export const ProductSubmission = createModel<ProductSubmission>('ProductSubmission', submissionSchema);
export const CatalogMediaAsset = createModel<CatalogMediaAsset>('CatalogMediaAsset', mediaSchema);
export const ProductVariant = createModel<ProductVariant>('ProductVariant', variantSchema);
export const NegotiatedQuote = createModel<NegotiatedQuote>('NegotiatedQuote', quoteSchema);
