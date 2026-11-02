import { BaseEntity, createModel, createSchema } from '@models/base.model';

export type MarketVendorStatus = 'pending' | 'active' | 'inactive' | 'blocked';
export type VendorInvitationStatus = 'pending' | 'accepted' | 'expired' | 'cancelled';
export type VendorCollectionStatus = 'draft' | 'collected' | 'cancelled';
export type VendorPaymentStatus = 'unpaid' | 'recorded' | 'reconciled' | 'disputed';

export interface VendorPaymentProfile {
  method: 'cash' | 'bank_transfer' | 'other';
  bankName?: string;
  bankCode?: string;
  accountName?: string;
  accountNumberEncrypted?: string;
  accountNumberLast4?: string;
  verificationStatus: 'unverified' | 'pending' | 'verified' | 'rejected';
  updatedAt?: Date;
}

export interface MarketVendor extends BaseEntity {
  publicId: string;
  marketId: string;
  stateId: string;
  businessName: string;
  contactName: string;
  normalizedPhone: string;
  phone: string;
  email?: string;
  address?: string;
  preferredContactChannel: 'phone' | 'email' | 'whatsapp';
  paymentProfile?: VendorPaymentProfile;
  status: MarketVendorStatus;
  consentAt?: Date;
  invitedByMarketAssociateId?: string;
  lastContactedAt?: Date;
  notes?: string;
}

export interface VendorInvitation extends BaseEntity {
  publicId: string;
  vendorId: string;
  marketId: string;
  invitedByMarketAssociateId?: string;
  /** Set instead when admin staff onboard the vendor directly. */
  invitedByAccountId?: string;
  email?: string;
  tokenHash: string;
  status: VendorInvitationStatus;
  expiresAt: Date;
  emailSentAt?: Date;
  acceptedAt?: Date;
  cancelledAt?: Date;
}

export interface VendorCollection extends BaseEntity {
  publicId: string;
  marketVendorId: string;
  marketId: string;
  marketAssociateId: string;
  productSubmissionId: string;
  productId?: string;
  productTitleSnapshot: string;
  quantity: number;
  actualCostMinor: number;
  currency: string;
  status: VendorCollectionStatus;
  paymentStatus: VendorPaymentStatus;
  collectedAt?: Date;
  evidenceAssetIds: string[];
  notes?: string;
}

export interface VendorPaymentRecord extends BaseEntity {
  publicId: string;
  collectionId: string;
  marketVendorId: string;
  marketId: string;
  marketAssociateId: string;
  amountMinor: number;
  currency: string;
  method: 'cash' | 'bank_transfer' | 'other';
  status: VendorPaymentStatus;
  proofAssetIds: string[];
  reference?: string;
  recordedAt: Date;
  reconciledAt?: Date;
  reconciledBy?: string;
  notes?: string;
}

const paymentProfile = {
  method: { type: String, enum: ['cash', 'bank_transfer', 'other'], required: true },
  bankName: { type: String, trim: true },
  bankCode: { type: String, trim: true },
  accountName: { type: String, trim: true },
  accountNumberEncrypted: { type: String, select: false },
  accountNumberLast4: { type: String },
  verificationStatus: { type: String, enum: ['unverified', 'pending', 'verified', 'rejected'], default: 'unverified' },
  updatedAt: { type: Date },
};

const vendorSchema = createSchema<MarketVendor>({
  publicId: { type: String, required: true, unique: true, index: true },
  marketId: { type: String, required: true, index: true },
  stateId: { type: String, required: true, index: true },
  businessName: { type: String, required: true, trim: true, maxlength: 180 },
  contactName: { type: String, required: true, trim: true, maxlength: 120 },
  normalizedPhone: { type: String, required: true, trim: true },
  phone: { type: String, required: true, trim: true },
  email: { type: String, trim: true, lowercase: true },
  address: { type: String, trim: true, maxlength: 500 },
  preferredContactChannel: { type: String, enum: ['phone', 'email', 'whatsapp'], default: 'phone' },
  paymentProfile: { type: paymentProfile },
  status: { type: String, enum: ['pending', 'active', 'inactive', 'blocked'], default: 'pending', index: true },
  consentAt: { type: Date },
  invitedByMarketAssociateId: { type: String, index: true },
  lastContactedAt: { type: Date },
  notes: { type: String, maxlength: 1000 },
  deletedAt: { type: Date },
});
// MongoDB rejects `$exists: false` in a partial filter and refuses `sparse` combined
// with one, so these two indexes could never be built and vendor uniqueness was
// never enforced by the database. `deletedAt: null` matches a missing field, which
// is exactly "not soft-deleted", and the email condition replaces `sparse`.
vendorSchema.index({ marketId: 1, normalizedPhone: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
vendorSchema.index({ marketId: 1, email: 1 }, { unique: true, partialFilterExpression: { deletedAt: null, email: { $type: 'string' } } });
vendorSchema.index({ marketId: 1, status: 1, updatedAt: -1 });

const invitationSchema = createSchema<VendorInvitation>({
  publicId: { type: String, required: true, unique: true, index: true },
  vendorId: { type: String, required: true, index: true },
  marketId: { type: String, required: true, index: true },
  // Not required: admin staff can onboard a vendor directly, in which case
  // there is no Market Associate to attribute the invitation to. `invitedBy`
  // records who it actually was.
  invitedByMarketAssociateId: { type: String, index: true },
  invitedByAccountId: { type: String, index: true },
  email: { type: String, lowercase: true },
  tokenHash: { type: String, required: true, unique: true, select: false },
  status: { type: String, enum: ['pending', 'accepted', 'expired', 'cancelled'], default: 'pending', index: true },
  expiresAt: { type: Date, required: true, index: true },
  emailSentAt: { type: Date },
  acceptedAt: { type: Date },
  cancelledAt: { type: Date },
  deletedAt: { type: Date },
});
invitationSchema.index({ vendorId: 1, status: 1, expiresAt: 1 });

const collectionSchema = createSchema<VendorCollection>({
  publicId: { type: String, required: true, unique: true, index: true },
  marketVendorId: { type: String, required: true, index: true },
  marketId: { type: String, required: true, index: true },
  marketAssociateId: { type: String, required: true, index: true },
  productSubmissionId: { type: String, required: true, unique: true, index: true },
  productId: { type: String, index: true },
  productTitleSnapshot: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
  actualCostMinor: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'NGN', uppercase: true },
  status: { type: String, enum: ['draft', 'collected', 'cancelled'], default: 'draft', index: true },
  paymentStatus: { type: String, enum: ['unpaid', 'recorded', 'reconciled', 'disputed'], default: 'unpaid', index: true },
  collectedAt: { type: Date },
  evidenceAssetIds: { type: [String], default: [] },
  notes: { type: String, maxlength: 1000 },
  deletedAt: { type: Date },
});
collectionSchema.index({ marketId: 1, marketVendorId: 1, createdAt: -1 });

const paymentSchema = createSchema<VendorPaymentRecord>({
  publicId: { type: String, required: true, unique: true, index: true },
  collectionId: { type: String, required: true, unique: true, index: true },
  marketVendorId: { type: String, required: true, index: true },
  marketId: { type: String, required: true, index: true },
  marketAssociateId: { type: String, required: true, index: true },
  amountMinor: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'NGN', uppercase: true },
  method: { type: String, enum: ['cash', 'bank_transfer', 'other'], required: true },
  status: { type: String, enum: ['unpaid', 'recorded', 'reconciled', 'disputed'], default: 'recorded', index: true },
  proofAssetIds: { type: [String], default: [] },
  reference: { type: String, maxlength: 180 },
  recordedAt: { type: Date, default: Date.now },
  reconciledAt: { type: Date },
  reconciledBy: { type: String },
  notes: { type: String, maxlength: 1000 },
  deletedAt: { type: Date },
});
paymentSchema.index({ marketId: 1, status: 1, createdAt: -1 });

export const MarketVendor = createModel<MarketVendor>('MarketVendor', vendorSchema);
export const VendorInvitation = createModel<VendorInvitation>('VendorInvitation', invitationSchema);
export const VendorCollection = createModel<VendorCollection>('VendorCollection', collectionSchema);
export const VendorPaymentRecord = createModel<VendorPaymentRecord>('VendorPaymentRecord', paymentSchema);
