import {
  FulfilmentTaskStatus,
  HubPackageStatus,
  RunnerPackageStatus,
  ShipmentStatus,
} from '@lib/constants';
import { BaseEntity, createModel, createSchema } from '@models/base.model';

export type FulfilmentEvidence = {
  type: string;
  url?: string;
  assetId?: string;
  note?: string;
  capturedAt: Date;
};

export type ItemVerificationCheck = {
  productMatches: boolean;
  sizeMatches: boolean;
  colorMatches: boolean;
  quantityMatches: boolean;
  /** Every other detail the category asks for (capacity, length, phone model...). True when the item has none. */
  attributesMatch?: boolean;
};

export type ItemVerification = {
  orderItemId: string;
  photoUrl?: string;
  photos: Array<{ view: 'front' | 'side' | 'back'; url: string; assetId?: string }>;
  actualColor?: string;
  actualSize?: string;
  /** What was found for each non-size, non-colour detail the order asked for. */
  actualAttributes?: Record<string, string>;
  actualQuantity: number;
  unitCostMinor: number;
  supplierReference?: string;
  conditionNote: string;
  checks: ItemVerificationCheck;
  matched: boolean;
  reportedIssue?: { summary: string; note?: string; exceptionId?: string };
  verifiedAt: Date;
  verifiedBy: string;
  revisions?: Array<Record<string, unknown>>;
};

export interface FulfilmentTask extends BaseEntity {
  publicId: string;
  orderId: string;
  sourceStateId: string;
  marketId: string;
  hubId?: string;
  marketAssociateId?: string;
  orderItemIds: string[];
  status: FulfilmentTaskStatus;
  version: number;
  idempotencyKey: string;
  alertedAt?: Date;
  acceptedAt?: Date;
  sourcingStartedAt?: Date;
  productSecuredAt?: Date;
  packingStartedAt?: Date;
  packedAt?: Date;
  hubArrivedAt?: Date;
  hubReceivedAt?: Date;
  /** Items sent back to the Market Associate after a failed Hub check. */
  resourceItemIds?: string[];
  completedAt?: Date;
  actualCostMinor?: number;
  evidence: FulfilmentEvidence[];
  itemVerifications: ItemVerification[];
  issue?: Record<string, unknown>;
  assignmentHistory: Array<Record<string, unknown>>;
}

export interface RunnerPackage extends BaseEntity {
  publicId: string;
  orderId: string;
  taskId: string;
  marketAssociateId: string;
  hubId: string;
  status: RunnerPackageStatus;
  scanCredentialHash: string;
  scanCredentialHint: string;
  scanCredentialCiphertext?: string;
  credentialGeneratedAt?: Date;
  credentialVerifiedAt?: Date;
  credentialFailedAttempts: number;
  credentialLockedAt?: Date;
  itemIds: string[];
  labelReference?: string;
  packedAt?: Date;
  handedOverAt?: Date;
  evidence: FulfilmentEvidence[];
  version: number;
}

export interface HubPackage extends BaseEntity {
  publicId: string;
  orderId: string;
  taskId: string;
  runnerPackageId: string;
  hubId: string;
  marketAssociateId: string;
  status: HubPackageStatus;
  itemIds: string[];
  receivedAt?: Date;
  receivedBy?: string;
  qualityChecks: Array<Record<string, unknown>>;
  qcPassedAt?: Date;
  qcPassedBy?: string;
  custodyHistory: Array<Record<string, unknown>>;
  evidence: FulfilmentEvidence[];
  version: number;
  receiveIdempotencyKey?: string;
  /** Set while the package is on a courier shipment; cleared if that shipment is cancelled. */
  shipmentId?: string;
  /** Every time its Hook receipt was printed or downloaded, so a duplicate label can be traced. */
  receiptPrints?: Array<{ by: string; at: Date; size?: string }>;
}

export interface Consolidation extends BaseEntity {
  publicId: string;
  orderId: string;
  fulfilmentGroupId?: string;
  sourceStateId: string;
  hubId: string;
  hubPackageIds: string[];
  status: 'DRAFT' | 'SEALED' | 'HANDED_OVER' | 'CANCELLED';
  weightGrams?: number;
  dimensions?: { lengthCm: number; widthCm: number; heightCm: number };
  sealReference?: string;
  receiptPrints?: Array<{ by: string; at: Date; size?: string }>;
  evidence: FulfilmentEvidence[];
  sealedAt?: Date;
  sealedBy?: string;
  version: number;
}

export type LogisticsProviderKey = 'manual' | 'fez';

export interface Shipment extends BaseEntity {
  publicId: string;
  orderId: string;
  fulfilmentGroupId?: string;
  sourceStateId: string;
  hubId: string;
  /** Legacy: only shipments booked through the old consolidate-and-seal flow carry this. */
  consolidationId?: string;
  /** The hub packages this shipment carries. One order can ship together or in separate shipments. */
  hubPackageIds?: string[];
  fulfilmentGroupIds?: string[];
  weightGrams?: number;
  /** Value of the goods only (no delivery fee or VAT); what the courier insures against. */
  goodsValueMinor?: number;
  /** Hook receipt number for this parcel: RCT-<order>, then RCT-<order>-P2, -P3 for further shipments. */
  receiptNumber?: string;
  provider: LogisticsProviderKey;
  /**
   * The courier the customer actually chose and paid for at checkout, e.g.
   * 'GIG' / 'GUO' / 'DHL'. Kept separate from `provider` because that is the
   * runtime booking adapter (manual/simulated/gig/fez/other) and its enum
   * physically cannot hold an arbitrary courier code.
   */
  courierCode?: string;
  courierName?: string;
  /** Set only when staff booked someone other than the customer's choice. */
  substitutedFrom?: string;
  substitutionReason?: string;
  serviceName?: string;
  externalReference?: string;
  status: ShipmentStatus;
  deliveryAddressSnapshot: Record<string, unknown>;
  estimatedDeliveryAt?: Date;
  bookedAt?: Date;
  pickedUpAt?: Date;
  deliveredAt?: Date;
  failedAt?: Date;
  providerCostMinor?: number;
  providerQuoteMinor?: number;
  trackingNumber?: string;
  trackingEvents: Array<Record<string, unknown>>;
  evidence: FulfilmentEvidence[];
  bookingIdempotencyKey?: string;
  version: number;
}

export interface PickupManifest extends BaseEntity {
  publicId: string;
  hubId: string;
  provider: LogisticsProviderKey;
  shipmentIds: string[];
  status: 'OPEN' | 'HANDED_OVER' | 'CLOSED' | 'CANCELLED';
  handoverReference?: string;
  evidence: FulfilmentEvidence[];
  handedOverAt?: Date;
  handedOverBy?: string;
}

export interface PartnerCustody extends BaseEntity {
  publicId: string;
  orderId: string;
  shipmentId: string;
  partnerId: string;
  status: 'AWAITING_RECEIPT' | 'IN_CUSTODY' | 'RELEASED' | 'OVERDUE' | 'RECOVERY';
  collectionCodeHash?: string;
  collectionCodeHint?: string;
  codeAttempts: number;
  lastCodeAttemptAt?: Date;
  codeSentAt?: Date;
  receivedAt?: Date;
  releasedAt?: Date;
  expiresAt: Date;
  customerEmailSnapshot: string;
  idempotencyKey?: string;
  history: Array<Record<string, unknown>>;
}

export interface ReturnRequest extends BaseEntity {
  publicId: string;
  orderId: string;
  orderItemIds: string[];
  requestedBy: string;
  reasonType: 'DAMAGED' | 'WRONG_ITEM' | 'NOT_DELIVERED' | 'CUSTOMER_PREFERENCE' | 'OTHER';
  reason: string;
  evidenceAssetIds: string[];
  status: 'REQUESTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'AWAITING_HANDOVER' | 'RECEIVED' | 'COMPLETED' | 'EXPIRED';
  reportedAt: Date;
  handoverDueAt?: Date;
  reviewedBy?: string;
  decisionNote?: string;
  replacementSnapshot?: Record<string, unknown>;
  refundId?: string;
}

export interface FulfilmentRefund extends BaseEntity {
  publicId: string;
  orderId: string;
  paymentId?: string;
  returnRequestId?: string;
  amountMinor: number;
  currency: string;
  reason: string;
  status: 'REQUESTED' | 'APPROVED' | 'PROVIDER_PENDING' | 'PROVIDER_UNKNOWN' | 'REFUNDED' | 'FAILED';
  providerReference?: string;
  idempotencyKey: string;
  approvedBy?: string;
  processedAt?: Date;
  failureReason?: string;
}

export interface LogisticsWebhookEvent extends BaseEntity {
  provider: LogisticsProviderKey;
  providerEventId: string;
  payloadHash: string;
  shipmentId?: string;
  eventType: string;
  signatureVerified: boolean;
  status: 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED';
  receivedAt: Date;
  processedAt?: Date;
  /** Lease held by the delivery currently handling this event. */
  lockedUntil?: Date;
}

const evidence = { type: [Object], default: [] };

const taskSchema = createSchema<FulfilmentTask>({
  publicId: { type: String, required: true, unique: true, index: true },
  orderId: { type: String, required: true, index: true },
  sourceStateId: { type: String, required: true, index: true },
  marketId: { type: String, required: true, index: true },
  hubId: { type: String, index: true },
  marketAssociateId: { type: String, index: true },
  orderItemIds: { type: [String], default: [] },
  status: { type: String, enum: Object.values(FulfilmentTaskStatus), default: FulfilmentTaskStatus.UNASSIGNED, index: true },
  version: { type: Number, default: 1, min: 1 },
  idempotencyKey: { type: String, required: true, unique: true, index: true },
  alertedAt: { type: Date }, acceptedAt: { type: Date }, sourcingStartedAt: { type: Date },
  productSecuredAt: { type: Date }, packingStartedAt: { type: Date }, packedAt: { type: Date },
  hubArrivedAt: { type: Date }, hubReceivedAt: { type: Date }, resourceItemIds: { type: [String], default: undefined }, completedAt: { type: Date },
  actualCostMinor: { type: Number, min: 0 }, evidence, itemVerifications: { type: [Object], default: [] }, issue: { type: Object }, assignmentHistory: { type: [Object], default: [] },
});
taskSchema.index({ orderId: 1, marketId: 1 }, { unique: true });
taskSchema.index({ marketAssociateId: 1, status: 1, createdAt: 1 });

const runnerPackageSchema = createSchema<RunnerPackage>({
  publicId: { type: String, required: true, unique: true, index: true }, orderId: { type: String, required: true, index: true },
  taskId: { type: String, required: true, unique: true, index: true }, marketAssociateId: { type: String, required: true, index: true }, hubId: { type: String, required: true, index: true },
  status: { type: String, enum: Object.values(RunnerPackageStatus), default: RunnerPackageStatus.READY_FOR_HUB, index: true },
  scanCredentialHash: { type: String, required: true, select: false }, scanCredentialHint: { type: String, required: true }, scanCredentialCiphertext: { type: String, select: false }, credentialGeneratedAt: { type: Date }, credentialVerifiedAt: { type: Date }, credentialFailedAttempts: { type: Number, default: 0, min: 0 }, credentialLockedAt: { type: Date }, itemIds: { type: [String], default: [] },
  labelReference: { type: String }, packedAt: { type: Date }, handedOverAt: { type: Date }, evidence, version: { type: Number, default: 1, min: 1 },
});
runnerPackageSchema.index(
  { hubId: 1, scanCredentialHash: 1 },
  { unique: true, partialFilterExpression: { status: RunnerPackageStatus.READY_FOR_HUB } },
);

const hubPackageSchema = createSchema<HubPackage>({
  publicId: { type: String, required: true, unique: true, index: true }, orderId: { type: String, required: true, index: true }, taskId: { type: String, required: true, index: true }, runnerPackageId: { type: String, required: true, unique: true, index: true }, hubId: { type: String, required: true, index: true }, marketAssociateId: { type: String, required: true, index: true },
  status: { type: String, enum: Object.values(HubPackageStatus), default: HubPackageStatus.RECEIVED, index: true }, itemIds: { type: [String], default: [] }, receivedAt: { type: Date }, receivedBy: { type: String }, qualityChecks: { type: [Object], default: [] }, qcPassedAt: { type: Date }, qcPassedBy: { type: String }, custodyHistory: { type: [Object], default: [] }, evidence, version: { type: Number, default: 1, min: 1 }, receiveIdempotencyKey: { type: String, unique: true, sparse: true }, shipmentId: { type: String, index: true, sparse: true }, receiptPrints: { type: [Object], default: [] },
});

const consolidationSchema = createSchema<Consolidation>({
  publicId: { type: String, required: true, unique: true, index: true }, orderId: { type: String, required: true, index: true }, fulfilmentGroupId: { type: String, index: true, sparse: true }, sourceStateId: { type: String, required: true, index: true }, hubId: { type: String, required: true, index: true }, hubPackageIds: { type: [String], default: [] }, status: { type: String, enum: ['DRAFT', 'SEALED', 'HANDED_OVER', 'CANCELLED'], default: 'DRAFT', index: true }, weightGrams: { type: Number, min: 0 }, dimensions: { type: Object }, receiptPrints: { type: [Object], default: [] }, sealReference: { type: String }, evidence, sealedAt: { type: Date }, sealedBy: { type: String }, version: { type: Number, default: 1, min: 1 },
});
// Unique per fulfilment group, not per state: an order split into several
// deliveries has multiple groups in the same state. Sparse so legacy rows
// written before fulfilmentGroupId existed do not collide on null.
consolidationSchema.index({ orderId: 1, fulfilmentGroupId: 1 }, { unique: true, sparse: true });
consolidationSchema.index({ orderId: 1, sourceStateId: 1 });

const shipmentSchema = createSchema<Shipment>({
  publicId: { type: String, required: true, unique: true, index: true }, orderId: { type: String, required: true, index: true }, fulfilmentGroupId: { type: String, index: true, sparse: true }, sourceStateId: { type: String, required: true, index: true }, hubId: { type: String, required: true, index: true }, consolidationId: { type: String, index: true, sparse: true }, hubPackageIds: { type: [String], default: undefined, index: true }, fulfilmentGroupIds: { type: [String], default: undefined }, weightGrams: { type: Number, min: 0 }, goodsValueMinor: { type: Number, min: 0 }, receiptNumber: { type: String, index: true, sparse: true }, provider: { type: String, enum: ['manual', 'fez'], required: true, index: true }, courierCode: { type: String, index: true }, courierName: { type: String }, substitutedFrom: { type: String }, substitutionReason: { type: String }, serviceName: { type: String }, externalReference: { type: String, index: true, sparse: true }, status: { type: String, enum: Object.values(ShipmentStatus), default: ShipmentStatus.READY_FOR_BOOKING, index: true }, deliveryAddressSnapshot: { type: Object, required: true }, estimatedDeliveryAt: { type: Date }, bookedAt: { type: Date }, pickedUpAt: { type: Date }, deliveredAt: { type: Date }, failedAt: { type: Date }, providerCostMinor: { type: Number, min: 0 }, providerQuoteMinor: { type: Number, min: 0 }, trackingNumber: { type: String }, trackingEvents: { type: [Object], default: [] }, evidence, bookingIdempotencyKey: { type: String, unique: true, sparse: true }, version: { type: Number, default: 1, min: 1 },
});
// Not unique: an order can ship in several shipments, and a cancelled shipment
// is re-booked. Double booking is prevented by claiming the hub packages
// (HubPackage.status QC_PASSED -> SHIPPED) inside the booking transaction.
shipmentSchema.index({ orderId: 1, fulfilmentGroupId: 1 });
shipmentSchema.index({ orderId: 1, sourceStateId: 1 });

const manifestSchema = createSchema<PickupManifest>({
  publicId: { type: String, required: true, unique: true, index: true }, hubId: { type: String, required: true, index: true }, provider: { type: String, enum: ['manual', 'fez'], required: true }, shipmentIds: { type: [String], default: [] }, status: { type: String, enum: ['OPEN', 'HANDED_OVER', 'CLOSED', 'CANCELLED'], default: 'OPEN', index: true }, handoverReference: { type: String }, evidence, handedOverAt: { type: Date }, handedOverBy: { type: String },
});


const custodySchema = createSchema<PartnerCustody>({
  publicId: { type: String, required: true, unique: true, index: true }, orderId: { type: String, required: true, unique: true, index: true }, shipmentId: { type: String, required: true, index: true }, partnerId: { type: String, required: true, index: true }, status: { type: String, enum: ['AWAITING_RECEIPT', 'IN_CUSTODY', 'RELEASED', 'OVERDUE', 'RECOVERY'], default: 'AWAITING_RECEIPT', index: true }, collectionCodeHash: { type: String, select: false }, collectionCodeHint: { type: String }, codeAttempts: { type: Number, default: 0 }, lastCodeAttemptAt: { type: Date }, codeSentAt: { type: Date }, receivedAt: { type: Date }, releasedAt: { type: Date }, expiresAt: { type: Date, required: true, index: true }, customerEmailSnapshot: { type: String, required: true }, idempotencyKey: { type: String, unique: true, sparse: true }, history: { type: [Object], default: [] },
});

const returnSchema = createSchema<ReturnRequest>({
  publicId: { type: String, required: true, unique: true, index: true }, orderId: { type: String, required: true, index: true }, orderItemIds: { type: [String], default: [] }, requestedBy: { type: String, required: true, index: true }, reasonType: { type: String, enum: ['DAMAGED', 'WRONG_ITEM', 'NOT_DELIVERED', 'CUSTOMER_PREFERENCE', 'OTHER'], required: true }, reason: { type: String, required: true, maxlength: 2000 }, evidenceAssetIds: { type: [String], default: [] }, status: { type: String, enum: ['REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'AWAITING_HANDOVER', 'RECEIVED', 'COMPLETED', 'EXPIRED'], default: 'REQUESTED', index: true }, reportedAt: { type: Date, default: Date.now }, handoverDueAt: { type: Date }, reviewedBy: { type: String }, decisionNote: { type: String }, replacementSnapshot: { type: Object }, refundId: { type: String, index: true },
});

const refundSchema = createSchema<FulfilmentRefund>({
  publicId: { type: String, required: true, unique: true, index: true }, orderId: { type: String, required: true, index: true }, paymentId: { type: String, index: true }, returnRequestId: { type: String, index: true }, amountMinor: { type: Number, required: true, min: 1 }, currency: { type: String, default: 'NGN' }, reason: { type: String, required: true }, status: { type: String, enum: ['REQUESTED', 'APPROVED', 'PROVIDER_PENDING', 'PROVIDER_UNKNOWN', 'REFUNDED', 'FAILED'], default: 'REQUESTED', index: true }, providerReference: { type: String }, idempotencyKey: { type: String, required: true, unique: true }, approvedBy: { type: String }, processedAt: { type: Date }, failureReason: { type: String },
});

const logisticsEventSchema = createSchema<LogisticsWebhookEvent>({
  provider: { type: String, enum: ['manual', 'fez'], required: true }, providerEventId: { type: String, required: true }, payloadHash: { type: String, required: true }, shipmentId: { type: String, index: true }, eventType: { type: String, required: true }, signatureVerified: { type: Boolean, default: false }, status: { type: String, enum: ['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED'], default: 'RECEIVED', index: true }, receivedAt: { type: Date, default: Date.now }, processedAt: { type: Date }, lockedUntil: { type: Date },
});
logisticsEventSchema.index({ provider: 1, providerEventId: 1 }, { unique: true });

export const FulfilmentTask = createModel<FulfilmentTask>('FulfilmentTask', taskSchema);
export const RunnerPackage = createModel<RunnerPackage>('RunnerPackage', runnerPackageSchema);
export const HubPackage = createModel<HubPackage>('HubPackage', hubPackageSchema);
export const Consolidation = createModel<Consolidation>('Consolidation', consolidationSchema);
export const Shipment = createModel<Shipment>('Shipment', shipmentSchema);
export const PickupManifest = createModel<PickupManifest>('PickupManifest', manifestSchema);
export const PartnerCustody = createModel<PartnerCustody>('PartnerCustody', custodySchema);
export const ReturnRequest = createModel<ReturnRequest>('ReturnRequest', returnSchema);
export const FulfilmentRefund = createModel<FulfilmentRefund>('FulfilmentRefund', refundSchema);
export const LogisticsWebhookEvent = createModel<LogisticsWebhookEvent>('LogisticsWebhookEvent', logisticsEventSchema);
