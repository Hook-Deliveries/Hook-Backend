import { BaseEntity, createModel, createSchema } from "@models/base.model";

export interface OrderFulfilmentGroup extends BaseEntity {
  publicId: string;
  orderId: string;
  sourceStateId: string;
  hubId?: string;
  orderItemIds: string[];
  subtotalMinor: number;
  vatShareMinor: number;
  couponDiscountShareMinor?: number;
  creditsAppliedShareMinor?: number;
  deliveryFeeShareMinor: number;
  status: "PENDING" | "IN_FULFILMENT" | "READY_FOR_DISPATCH" | "IN_TRANSIT" | "DELIVERED" | "COMPLETED" | "ON_HOLD";
  paymentId?: string;
  consolidationId?: string;
  shipmentId?: string;
}

const schema = createSchema<OrderFulfilmentGroup>({
  publicId: { type: String, required: true, unique: true, index: true },
  orderId: { type: String, required: true, index: true },
  sourceStateId: { type: String, required: true, index: true },
  hubId: { type: String, index: true, sparse: true },
  orderItemIds: { type: [String], default: [] },
  subtotalMinor: { type: Number, required: true, min: 0 },
  vatShareMinor: { type: Number, required: true, min: 0, default: 0 },
  couponDiscountShareMinor: { type: Number, default: 0, min: 0 },
  creditsAppliedShareMinor: { type: Number, default: 0, min: 0 },
  deliveryFeeShareMinor: { type: Number, required: true, min: 0 },
  status: {
    type: String,
    enum: ["PENDING", "IN_FULFILMENT", "READY_FOR_DISPATCH", "IN_TRANSIT", "DELIVERED", "COMPLETED", "ON_HOLD"],
    default: "PENDING",
    index: true,
  },
  paymentId: { type: String, index: true, sparse: true },
  consolidationId: { type: String, index: true, sparse: true },
  shipmentId: { type: String, index: true, sparse: true },
  deletedAt: { type: Date },
});

// Deliberately NOT unique. An order may have several groups in the same state
// once an admin splits it into multiple deliveries; uniqueness on the group
// itself is already enforced by publicId. This index exists only to make the
// per-state lookups fast.
schema.index({ orderId: 1, sourceStateId: 1 });

export const OrderFulfilmentGroup = createModel<OrderFulfilmentGroup>(
  "OrderFulfilmentGroup",
  schema,
);
