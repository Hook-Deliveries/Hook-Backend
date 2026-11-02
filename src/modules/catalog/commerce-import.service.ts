import { createHash } from "crypto";

import { CartService } from "@modules/orders";
import { CommerceImport } from "@models/commerce/commerce-import.model";
import { ProductLike } from "@models/products/product-like.model";
import { Product } from "@models/products/product.model";
import { ProductStatus } from "@lib/constants";
import { publicCart } from "@lib/public-resource";
import { HttpError } from "@utils/http";

export type CommerceImportInput = {
  schemaVersion: 1;
  cartItems: Array<{
    clientLineId: string;
    productId: string;
    variantId?: string;
    selectedVariants?: Record<string, string | undefined>;
    quantity: number;
  }>;
  likedProductIds: string[];
};

function payloadHash(input: CommerceImportInput) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export class CommerceImportService {
  private readonly cart = new CartService();

  async import(customerId: string, key: string, input: CommerceImportInput) {
    if (key.length < 12) {
      throw new HttpError(400, "A valid Idempotency-Key is required", undefined, "IDEMPOTENCY_CONFLICT");
    }
    const digest = payloadHash(input);
    const previous = await CommerceImport.findOne({ customerId, idempotencyKey: key }).lean();
    if (previous) {
      if (previous.payloadHash !== digest) {
        throw new HttpError(409, "Idempotency key was used with different data", undefined, "IDEMPOTENCY_CONFLICT");
      }
      return previous.response;
    }

    const rejected: Array<Record<string, unknown>> = [];
    const acceptedCartLineIds: string[] = [];
    for (const line of input.cartItems) {
      try {
        await this.cart.addItem(
          { userId: customerId },
          line.productId,
          line.quantity,
          line.selectedVariants,
          line.variantId,
          undefined,
          { deferRecalculation: true },
        );
        acceptedCartLineIds.push(line.clientLineId);
      } catch (error) {
        rejected.push({
          kind: "cart",
          clientId: line.clientLineId,
          productId: line.productId,
          code: error instanceof HttpError ? error.code : "IMPORT_FAILED",
          message: error instanceof Error ? error.message : "Product could not be imported",
        });
      }
    }

    const products = await Product.find({
      publicId: { $in: input.likedProductIds },
      status: ProductStatus.PUBLISHED,
      deletedAt: null,
    }).select("_id publicId").lean();
    const validLikes = new Set(products.map((product) => product.publicId));
    if (products.length) {
      await ProductLike.bulkWrite(products.map((product) => ({
        updateOne: {
          filter: { userId: customerId, productId: String(product._id) },
          update: { $setOnInsert: { userId: customerId, productId: String(product._id), productPublicId: product.publicId } },
          upsert: true,
        },
      })), { ordered: false });
    }
    for (const productId of input.likedProductIds) {
      if (!validLikes.has(productId)) {
        rejected.push({ kind: "like", productId, code: "PRODUCT_NOT_AVAILABLE", message: "Product is no longer available" });
      }
    }

    const cart = publicCart(await this.cart.getCart({ userId: customerId }));
    const likes = await ProductLike.find({ userId: customerId }).select("productPublicId").lean();
    const response = {
      cart,
      likes: { productIds: likes.map((like) => like.productPublicId) },
      imported: { cartItemCount: acceptedCartLineIds.length, likeCount: validLikes.size },
      acceptedCartLineIds,
      acceptedLikedProductIds: [...validLikes],
      rejected,
    };
    try {
      await CommerceImport.create({ customerId, idempotencyKey: key, payloadHash: digest, response });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const raced = await CommerceImport.findOne({ customerId, idempotencyKey: key }).lean();
      if (raced?.payloadHash === digest) return raced.response;
      throw new HttpError(409, "Commerce import was already processed", undefined, "IDEMPOTENCY_CONFLICT");
    }
    return response;
  }
}
