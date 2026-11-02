import { BaseEntity, createModel, createSchema } from "@models/base.model";

export interface CartItem extends BaseEntity {
  publicId?: string;
  cartId: string;
  productId: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  selectedVariants?: Record<string, string | undefined>;
  variantKey: string;
  variantId?: string;
  marketId?: string;
  stateId?: string;
  quoteId?: string;
  unitPriceMinor?: number;
  totalPriceMinor?: number;
  currency?: string;
  productVersion?: number;
  quoteVersion?: number;
  product?: any;
  cart?: any;
  commerceMigrationVersion?: number;
}

const CartItemSchema = createSchema<CartItem>({
  publicId: { type: String, unique: true, sparse: true, index: true },
  cartId: { type: String, required: true, index: true },
  productId: { type: String, required: true, index: true },
  quantity: { type: Number, required: true },
  unitPrice: { type: Number, required: true },
  totalPrice: { type: Number, required: true },
  selectedVariants: { type: Object },
  variantKey: { type: String, required: true, default: "default" },
  variantId: { type: String, index: true, sparse: true },
  marketId: { type: String, index: true, sparse: true },
  stateId: { type: String, index: true, sparse: true },
  quoteId: { type: String, index: true, sparse: true },
  unitPriceMinor: { type: Number, min: 0 },
  totalPriceMinor: { type: Number, min: 0 },
  currency: { type: String, default: "NGN" },
  productVersion: { type: Number, min: 1 },
  quoteVersion: { type: Number, min: 1 },
  commerceMigrationVersion: { type: Number, index: true },
  deletedAt: { type: Date },
});

CartItemSchema.index(
  { cartId: 1, productId: 1, variantKey: 1 },
  { unique: true },
);
CartItemSchema.index({ cartId: 1, stateId: 1, createdAt: 1 });

export const CartItem = createModel<CartItem>("CartItem", CartItemSchema);
