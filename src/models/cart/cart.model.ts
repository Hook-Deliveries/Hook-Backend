import { BaseEntity, createModel, createSchema } from "@models/base.model";

export interface Cart extends BaseEntity {
  publicId?: string;
  ownerType?: "customer" | "partner_assisted";
  customerId?: string;
  partnerId?: string;
  assistedCustomerId?: string;
  version?: number;
  status?: "active" | "converted" | "checked_out" | "abandoned";
  userId?: string;
  items?: any[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  isCheckedOut: boolean;
  boothId?: string;
  boothSessionVersion?: number;
  boothSource?: "code" | "qr";
  user?: any;
  commerceMigrationVersion?: number;
}

const CartSchema = createSchema<Cart>({
  publicId: { type: String, unique: true, sparse: true, index: true },
  ownerType: {
    type: String,
    enum: ["customer", "partner_assisted"],
    index: true,
  },
  customerId: { type: String, index: true, sparse: true },
  partnerId: { type: String, index: true, sparse: true },
  assistedCustomerId: { type: String, index: true, sparse: true },
  version: { type: Number, default: 1, min: 1 },
  status: {
    type: String,
    enum: ["active", "converted", "checked_out", "abandoned"],
    default: "active",
    index: true,
  },
  userId: { type: String, index: true },
  subtotal: { type: Number, default: 0 },
  deliveryFee: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  isCheckedOut: { type: Boolean, default: false },
  boothId: { type: String, index: true },
  boothSessionVersion: { type: Number },
  boothSource: { type: String, enum: ["code", "qr"] },
  commerceMigrationVersion: { type: Number, index: true },
  deletedAt: { type: Date },
});

CartSchema.index({ userId: 1, isCheckedOut: 1 });
// The abandoned-cart scan reads active carts by last touch.
CartSchema.index({ status: 1, updatedAt: 1 });
CartSchema.index({ customerId: 1, status: 1, isCheckedOut: 1 });
CartSchema.index({ ownerType: 1, customerId: 1, status: 1 });
CartSchema.index({
  ownerType: 1,
  partnerId: 1,
  assistedCustomerId: 1,
  status: 1,
});

export const Cart = createModel<Cart>("Cart", CartSchema);
