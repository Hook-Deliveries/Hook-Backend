import { ProductAvailabilityStatus, ProductStatus } from '@lib/constants';
import { BaseEntity, createModel, createSchema } from '@models/base.model';
import { normalizeProductColors } from '@lib/product-color';

export interface Product extends BaseEntity {
  publicId?: string;
  sourceSubmissionId?: string;
  sourceMarketVendorId?: string;
  sourceMarketAssociateId?: string;
  /** Supplier id and name the product was captured from, for staff only. */
  internalSellerReference?: string;
  marketId?: string;
  sourceStateId?: string;
  title: string;
  slug: string;
  description?: string;
  costPrice: number;
  sellingPrice: number;
  discountedPrice?: number;
  minAcceptablePrice: number;
  basePriceMinor?: number;
  sellingPriceMinor?: number;
  markupMinor?: number;
  discountMinor?: number;
  currency?: string;
  mediaAssetIds?: string[];
  negotiationRules?: {
    enabled: boolean;
    minimumNegotiablePriceMinor?: number;
    maximumDiscountMinor?: number;
    maximumCustomerOffers: number;
    acceptedQuoteExpiryMinutes: number;
  };
  availabilityStatus?: ProductAvailabilityStatus;
  customerAvailabilityNote?: string;
  lastMarketVerifiedAt?: Date;
  lastPriceVerifiedAt?: Date;
  lastAvailabilityConfirmedAt?: Date;
  availabilityValidUntil?: Date;
  availabilityCheckRequestedAt?: Date;
  availabilityCheckDueAt?: Date;
  availabilityCheckRequestedBy?: string;
  availabilityEscalatedAt?: Date;
  availabilityPreviousStatus?: ProductStatus;
  availabilityCheckNote?: string;
  publishedAt?: Date;
  publishedBy?: string;
  commercialApproval?: {
    approved: boolean;
    approvedBy?: string;
    approvedAt?: Date;
  };
  catalogMigrationVersion?: number;
  catalogVersion?: number;
  quantity: number;
  reservedQuantity: number;
  colors?: string[];
  sizes?: string[];
  images: string[];
  videos?: string[];
  hookId?: string;
  status: ProductStatus;
  viewCount: number;
  orderCount: number;
  averageRating: number;
  /** Legacy source reference retained until Market/ProductSource migration. */
  vendorId?: string;
  categoryId: string;
  /** Set by the category migration for products filed under a category that is no longer a leaf. Staff move them into the new tree. */
  needsRecategorisation?: boolean;
  fieldAgentId?: string;
  source?: 'vendor' | 'field_agent' | 'admin';
  vendor?: any;
  category?: any;
}

const ProductSchema = createSchema<Product>({
  publicId: { type: String, unique: true, sparse: true, index: true },
  sourceSubmissionId: { type: String, unique: true, sparse: true, index: true },
  sourceMarketVendorId: { type: String, index: true, sparse: true },
  sourceMarketAssociateId: { type: String, index: true, sparse: true },
  internalSellerReference: { type: String, maxlength: 300 },
  marketId: { type: String, index: true, sparse: true },
  sourceStateId: { type: String, index: true, sparse: true },
  title: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true, trim: true },
  description: { type: String },
  costPrice: { type: Number, required: true },
  sellingPrice: { type: Number, required: true },
  discountedPrice: { type: Number },
  minAcceptablePrice: { type: Number, required: true },
  basePriceMinor: { type: Number, min: 0 },
  sellingPriceMinor: { type: Number, min: 0 },
  markupMinor: { type: Number, min: 0 },
  discountMinor: { type: Number, min: 0 },
  currency: { type: String, uppercase: true, default: 'NGN' },
  mediaAssetIds: { type: [String], default: [] },
  negotiationRules: {
    type: Object,
    default: {
      enabled: false,
      maximumCustomerOffers: 3,
      acceptedQuoteExpiryMinutes: 30,
    },
  },
  availabilityStatus: {
    type: String,
    enum: Object.values(ProductAvailabilityStatus),
    default: ProductAvailabilityStatus.UNCONFIRMED,
    index: true,
  },
  customerAvailabilityNote: { type: String, maxlength: 500 },
  lastMarketVerifiedAt: { type: Date },
  lastPriceVerifiedAt: { type: Date },
  lastAvailabilityConfirmedAt: { type: Date },
  availabilityValidUntil: { type: Date, index: true },
  availabilityCheckRequestedAt: { type: Date, index: true },
  availabilityCheckDueAt: { type: Date, index: true },
  availabilityCheckRequestedBy: { type: String },
  availabilityEscalatedAt: { type: Date, index: true },
  availabilityPreviousStatus: { type: String, enum: Object.values(ProductStatus) },
  availabilityCheckNote: { type: String, maxlength: 1000 },
  publishedAt: { type: Date, index: true },
  publishedBy: { type: String },
  commercialApproval: { type: Object, default: { approved: false } },
  catalogMigrationVersion: { type: Number, default: 0 },
  catalogVersion: { type: Number, default: 1, min: 1 },
  quantity: { type: Number, default: 0 },
  reservedQuantity: { type: Number, default: 0 },
  colors: [{ type: String }],
  sizes: [{ type: String }],
  images: [{ type: String }],
  videos: [{ type: String }],
  hookId: { type: String, unique: true, sparse: true },
  status: { type: String, enum: Object.values(ProductStatus), default: ProductStatus.DRAFT, index: true },
  viewCount: { type: Number, default: 0 },
  orderCount: { type: Number, default: 0 },
  averageRating: { type: Number, default: 0 },
  vendorId: { type: String, index: true, sparse: true },
  categoryId: { type: String, required: true, index: true },
  needsRecategorisation: { type: Boolean, index: true, sparse: true },
  fieldAgentId: { type: String, index: true, sparse: true },
  source: { type: String, enum: ['vendor', 'field_agent', 'admin'], default: 'admin' },
  deletedAt: { type: Date },
});

ProductSchema.index({ vendorId: 1, status: 1 });
ProductSchema.index({ title: 'text', description: 'text' });
ProductSchema.index({ sourceStateId: 1, marketId: 1, status: 1, publishedAt: -1 });
ProductSchema.index({ categoryId: 1, status: 1, publishedAt: -1 });
ProductSchema.index({ status: 1, availabilityStatus: 1, availabilityValidUntil: 1 });

ProductSchema.pre('validate', function normalizeColors() {
  this.colors = normalizeProductColors(this.colors);
});

export const Product = createModel<Product>('Product', ProductSchema);
