import { Request, Response } from "express";
import { Types } from "mongoose";

import { ProductLike } from "@models/products/product-like.model";
import { Product } from "@models/products/product.model";
import { ProductAvailabilityStatus, ProductStatus } from "@lib/constants";
import { routeParam } from "@lib/api-utils";
import { publicProductRepresentations } from "@modules/catalog/commercial-catalog.service";
import { HttpError, sendSuccess } from "@utils/http";

function productFilter(identifier: string) {
  return Types.ObjectId.isValid(identifier)
    ? {
        $or: [
          { _id: identifier },
          { publicId: identifier },
          { slug: identifier },
        ],
      }
    : { $or: [{ publicId: identifier }, { slug: identifier }] };
}

async function resolvePublishedProduct(identifier: string) {
  const product = await Product.findOne({
    $and: [
      productFilter(identifier),
      { status: ProductStatus.PUBLISHED },
      { availabilityStatus: { $in: [ProductAvailabilityStatus.AVAILABLE, ProductAvailabilityStatus.LIMITED] } },
      { deletedAt: { $exists: false } },
    ],
  })
    .select("_id publicId")
    .lean({ virtuals: true });

  if (!product?.publicId) {
    throw new HttpError(
      404,
      "Product is not available to save",
      undefined,
      "PRODUCT_NOT_AVAILABLE",
    );
  }

  return {
    id: product._id.toString(),
    publicId: product.publicId,
  };
}

export class ProductLikesController {
  list = async (req: Request, res: Response) => {
    const likes = await ProductLike.find({ userId: req.user!.sub })
      .sort({ createdAt: -1 })
      .select("productPublicId createdAt")
      .lean();

    const products = await Product.find({
      publicId: { $in: likes.map((like) => like.productPublicId) },
      publishedAt: { $exists: true, $lte: new Date() },
      deletedAt: { $exists: false },
    })
      .select('publicId title slug description images mediaAssetIds marketId sourceStateId categoryId sellingPriceMinor discountMinor currency negotiationRules status availabilityStatus customerAvailabilityNote publishedAt quantity reservedQuantity')
      .lean({ virtuals: true });
    const presentations = await publicProductRepresentations(products as any[], { compact: true });
    const productMap = new Map(
      presentations.map((product: any) => [product.publicId, product]),
    );

    sendSuccess(res, {
      productIds: likes.map((like) => like.productPublicId),
      items: await Promise.all(
        likes.map(async (like) => ({
          productId: like.productPublicId,
          createdAt: like.createdAt,
          product: productMap.get(like.productPublicId) || null,
        })),
      ),
    });
  };

  add = async (req: Request, res: Response) => {
    const product = await resolvePublishedProduct(
      routeParam(req.params.productId),
    );
    await ProductLike.updateOne(
      { userId: req.user!.sub, productId: product.id },
      {
        $setOnInsert: {
          userId: req.user!.sub,
          productId: product.id,
          productPublicId: product.publicId,
        },
      },
      { upsert: true },
    );

    sendSuccess(res, { productId: product.publicId, liked: true });
  };

  remove = async (req: Request, res: Response) => {
    const productPublicId = routeParam(req.params.productId);
    await ProductLike.deleteOne({ userId: req.user!.sub, productPublicId });
    sendSuccess(res, { productId: productPublicId, liked: false });
  };
}
