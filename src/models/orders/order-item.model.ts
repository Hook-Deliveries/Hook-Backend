import { BaseEntity, createModel, createSchema } from "@models/base.model";

export interface OrderItem extends BaseEntity {
  fulfilmentGroupId?: string;
  shipmentId?: string;
  deliveryStatus?: "PENDING" | "IN_FULFILMENT" | "IN_TRANSIT" | "DELIVERED" | "COLLECTED" | "RESOLVED";
  inTransitAt?: Date;
  deliveredAt?: Date;
  publicId?: string;
  orderId: string;
  productId: string;
  productTitle: string;
  productImage?: string;
  vendorId?: string;
  variantId?: string;
  marketId?: string;
  stateId?: string;
  quoteId?: string;
  unitPriceMinor?: number;
  totalPriceMinor?: number;
  currency?: string;
  productSnapshot?: Record<string, unknown>;
  variantSnapshot?: Record<string, unknown>;
  quoteSnapshot?: Record<string, unknown>;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  selectedVariants?: Record<string, string | undefined>;
  commissionAmount: number;
  product?: any;
  vendor?: any;
  order?: any;
  commerceMigrationVersion?: number;
  fulfilmentTaskId?: string;
  runnerPackageId?: string;
  hubPackageId?: string;
  fulfilmentStatus?: 'PENDING' | 'SOURCING' | 'SECURED' | 'PACKED' | 'RECEIVED' | 'QC_PASSED' | 'COMPLETED' | 'EXCEPTION' | 'REFUNDED';
  resolutionState?: 'OPEN' | 'REPLACEMENT_PENDING' | 'REFUND_PENDING' | 'RESOLVED';
  replacementSnapshot?: Record<string, unknown>;
  refundSnapshot?: Record<string, unknown>;
}

const OrderItemSchema = createSchema<OrderItem>({
  fulfilmentGroupId: { type: String, index: true, sparse: true },
  shipmentId: { type: String, index: true, sparse: true },
  deliveryStatus: { type: String, enum: ["PENDING", "IN_FULFILMENT", "IN_TRANSIT", "DELIVERED", "COLLECTED", "RESOLVED"], default: "PENDING", index: true },
  inTransitAt: { type: Date },
  deliveredAt: { type: Date },
  publicId: { type: String, unique: true, sparse: true, index: true },
  orderId: { type: String, required: true, index: true },
  productId: { type: String, required: true, index: true },
  productTitle: { type: String, required: true },
  productImage: { type: String },
  vendorId: { type: String, index: true, sparse: true },
  variantId: { type: String, index: true, sparse: true },
  marketId: { type: String, index: true, sparse: true },
  stateId: { type: String, index: true, sparse: true },
  quoteId: { type: String, index: true, sparse: true },
  unitPriceMinor: { type: Number, min: 0 },
  totalPriceMinor: { type: Number, min: 0 },
  currency: { type: String, default: "NGN" },
  productSnapshot: { type: Object },
  variantSnapshot: { type: Object },
  quoteSnapshot: { type: Object },
  quantity: { type: Number, required: true },
  unitPrice: { type: Number, required: true },
  totalPrice: { type: Number, required: true },
  selectedVariants: { type: Object },
  commissionAmount: { type: Number, default: 0 },
  commerceMigrationVersion: { type: Number, index: true },
  fulfilmentTaskId: { type: String, index: true, sparse: true },
  runnerPackageId: { type: String, index: true, sparse: true },
  hubPackageId: { type: String, index: true, sparse: true },
  fulfilmentStatus: { type: String, enum: ['PENDING', 'SOURCING', 'SECURED', 'PACKED', 'RECEIVED', 'QC_PASSED', 'COMPLETED', 'EXCEPTION', 'REFUNDED'], default: 'PENDING', index: true },
  resolutionState: { type: String, enum: ['OPEN', 'REPLACEMENT_PENDING', 'REFUND_PENDING', 'RESOLVED'], default: 'OPEN', index: true },
  replacementSnapshot: { type: Object },
  refundSnapshot: { type: Object },
  deletedAt: { type: Date },
});

export const OrderItem = createModel<OrderItem>("OrderItem", OrderItemSchema);
