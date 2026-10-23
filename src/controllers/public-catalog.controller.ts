import { Request, Response } from "express";
import { categoryService } from '@modules/catalog/category.service';
import { ProductAvailabilityStatus, ProductStatus } from "@lib/constants";
import { Category } from "@models/categories/category.model";
import { OperationState } from "@models/platform/geography.model";
import { Market } from "@models/platform/network.model";
import { Product } from "@models/products/product.model";
import {
  publicProductRepresentations,
  publicProductRepresentation,
} from "@modules/catalog/commercial-catalog.service";
import { routeParam } from "@lib/api-utils";
import { HttpError, sendSuccess } from "@utils/http";
import { sharedCache } from "@modules/platform/cache.service";

const PUBLIC_PRODUCT_CARD_FIELDS = [
  "publicId",
  "hookId",
  "title",
  "slug",
  "images",
  "mediaAssetIds",
  "categoryId",
  "marketId",
  "sourceStateId",
  "sellingPriceMinor",
  "discountMinor",
  "currency",
  "negotiationRules.enabled",
  "availabilityStatus",
  "status",
  "availabilityValidUntil",
  "publishedAt",
  "quantity",
  "reservedQuantity",
  "colors",
  "sizes",
].join(" ");
const PUBLIC_PRODUCT_FIELDS = `${PUBLIC_PRODUCT_CARD_FIELDS} description customerAvailabilityNote lastAvailabilityConfirmedAt`;

async function internalId(
  model: any,
  identifier?: string,
  extraFields: string[] = [],
) {
  if (!identifier) return undefined;
  const query = /^[a-f\d]{24}$/i.test(identifier)
    ? { $or: [{ _id: identifier }, { publicId: identifier }] }
    : {
        $or: [
          { publicId: identifier },
          ...extraFields.map((field) => ({ [field]: identifier })),
        ],
      };
  const record = await model.findOne(query).select("_id").lean();
  if (!record)
    throw new HttpError(404, "Filter record not found", undefined, "NOT_FOUND");
  return record._id.toString();
}

function baseFilter() {
  return {
    status: ProductStatus.PUBLISHED,
    publishedAt: { $lte: new Date() },
    deletedAt: { $exists: false },
  };
}

function queryKey(query: Record<string, unknown>) {
  return JSON.stringify(
    Object.keys(query)
      .sort()
      .map((key) => [key, query[key]]),
  );
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchClause(value: unknown) {
  const query = String(value || "")
    .normalize("NFKC")
    .trim()
    .slice(0, 80);
  if (!query) return undefined;

  const terms = [
    ...new Set(query.toLowerCase().split(/\s+/).filter(Boolean)),
  ].slice(0, 6);
  const clauses = terms.map((term) => {
    const expression = { $regex: escapeRegex(term), $options: "i" };
    return {
      $or: [
        { title: expression },
        { slug: expression },
        { description: expression },
      ],
    };
  });

  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

export class PublicCatalogController {
  discover = async (req: Request, res: Response) => {
    const cacheKey = `discover:${queryKey(req.query as Record<string, unknown>)}`;
    const lookup = await sharedCache.lookup<any>("catalog", cacheKey);
    if (lookup.hit) {
      sendSuccess(res, lookup.value);
      return;
    }
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 40);
    const offset = Math.min(Math.max(Number(req.query.offset || 0), 0), 2000);
    const filter: Record<string, any> = baseFilter();
    const [stateId, marketId, categoryId] = await Promise.all([
      internalId(
        OperationState,
        String(req.query.stateId || req.query.stateCode || "") || undefined,
        ["code"],
      ),
      internalId(Market, String(req.query.marketId || "") || undefined),
      internalId(Category, String(req.query.categoryId || "") || undefined),
    ]);
    if (stateId) filter.sourceStateId = stateId;
    if (marketId) filter.marketId = marketId;
    // A parent category covers all of its sub-categories.
    if (categoryId) filter.categoryId = { $in: await categoryService.descendantIds(categoryId) };
    const search = searchClause(req.query.q);
    if (search) filter.$and = [search];

    const [products, categories] = await Promise.all([
      Product.find(filter)
        .select(PUBLIC_PRODUCT_CARD_FIELDS)
        .sort({ publishedAt: -1, _id: -1 })
        .skip(offset)
        .limit(limit + 1)
        .lean({ virtuals: true }),
      // Top-level categories only; sub-categories come with /categories.
      Category.find({ isActive: true, deletedAt: { $exists: false }, parentId: { $exists: false } })
        .select("publicId name slug iconUrl")
        .sort({ sortOrder: 1, name: 1 })
        .lean({ virtuals: true }),
    ]);

    const payload = {
      categories: categories.map((item: any) => ({
        publicId: item.publicId,
        name: item.name,
        slug: item.slug,
        iconUrl: item.iconUrl || null,
      })),
      products: await publicProductRepresentations(products.slice(0, limit), { compact: true }),
      resultCount: Math.min(products.length, limit),
      hasMore: products.length > limit,
    };
    await lookup.store(payload);
    sendSuccess(res, payload);
  };

  products = async (req: Request, res: Response) => {
    const cacheKey = `products:${queryKey(req.query as Record<string, unknown>)}`;
    const lookup = await sharedCache.lookup<any>("catalog", cacheKey);
    if (lookup.hit) {
      sendSuccess(res, lookup.value);
      return;
    }
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 50);
    const filter: Record<string, any> = baseFilter();
    const [stateId, marketId, categoryId] = await Promise.all([
      internalId(
        OperationState,
        String(req.query.stateId || req.query.stateCode || "") || undefined,
        ["code"],
      ),
      internalId(Market, String(req.query.marketId || "") || undefined),
      internalId(Category, String(req.query.categoryId || "") || undefined),
    ]);
    if (stateId) filter.sourceStateId = stateId;
    if (marketId) filter.marketId = marketId;
    // A parent category covers all of its sub-categories.
    if (categoryId) filter.categoryId = { $in: await categoryService.descendantIds(categoryId) };
    if (req.query.minPriceMinor || req.query.maxPriceMinor) {
      filter.$expr = {
        $and: [
          ...(req.query.minPriceMinor
            ? [
                {
                  $gte: [
                    {
                      $subtract: [
                        "$sellingPriceMinor",
                        { $ifNull: ["$discountMinor", 0] },
                      ],
                    },
                    Number(req.query.minPriceMinor),
                  ],
                },
              ]
            : []),
          ...(req.query.maxPriceMinor
            ? [
                {
                  $lte: [
                    {
                      $subtract: [
                        "$sellingPriceMinor",
                        { $ifNull: ["$discountMinor", 0] },
                      ],
                    },
                    Number(req.query.maxPriceMinor),
                  ],
                },
              ]
            : []),
        ],
      };
    }
    const conditions: Record<string, unknown>[] = [];
    const search = searchClause(req.query.q);
    if (search) conditions.push(search);
    const sort: Record<string, 1 | -1> =
      req.query.sort === "price_asc"
        ? { sellingPriceMinor: 1 as const, _id: -1 as const }
        : req.query.sort === "price_desc"
          ? { sellingPriceMinor: -1 as const, _id: -1 as const }
          : { publishedAt: -1 as const, _id: -1 as const };
    const cursorMode =
      req.query.sort === "price_asc"
        ? "price_asc"
        : req.query.sort === "price_desc"
          ? "price_desc"
          : "published";
    const cursor = decodeCursor(req.query.cursor, cursorMode);
    if (cursor) {
      const field =
        cursorMode === "published" ? "publishedAt" : "sellingPriceMinor";
      const comparison = cursorMode === "price_asc" ? "$gt" : "$lt";
      conditions.push({
        $or: [
          { [field]: { [comparison]: cursor.value } },
          { [field]: cursor.value, _id: { $lt: cursor.id } },
        ],
      });
    }
    if (conditions.length) filter.$and = conditions;
    const rows = await Product.find(filter)
      .select(PUBLIC_PRODUCT_CARD_FIELDS)
      .sort(sort)
      .limit(limit + 1)
      .lean({ virtuals: true });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const response = {
      data: await publicProductRepresentations(page, { compact: true }),
      nextCursor:
        hasMore && page.length
          ? encodeCursor(page[page.length - 1], cursorMode)
          : null,
      hasMore,
    };
    await lookup.store(response);
    sendSuccess(res, response);
  };

  product = async (req: Request, res: Response) => {
    const id = routeParam(req.params.id);
    const cacheKey = `product:${id}`;
    const lookup = await sharedCache.lookup<any>("catalog", cacheKey);
    if (lookup.hit) {
      sendSuccess(res, lookup.value);
      return;
    }
    const identifier = /^[a-f\d]{24}$/i.test(id)
      ? { $or: [{ _id: id }, { publicId: id }, { slug: id }] }
      : { $or: [{ publicId: id }, { slug: id }] };
    const product = await Product.findOne({
      $and: [
        identifier,
        { publishedAt: { $exists: true, $lte: new Date() } },
        { deletedAt: { $exists: false } },
        {
          $or: [
            { status: ProductStatus.PUBLISHED },
            {
              status: {
                $in: [
                  ProductStatus.AVAILABILITY_UNCONFIRMED,
                  ProductStatus.PAUSED,
                ],
              },
              availabilityStatus: {
                $in: [
                  ProductAvailabilityStatus.UNCONFIRMED,
                  ProductAvailabilityStatus.UNAVAILABLE,
                ],
              },
            },
          ],
        },
      ],
    } as any)
      .select(PUBLIC_PRODUCT_FIELDS)
      .lean({ virtuals: true });
    if (!product)
      throw new HttpError(404, "Product not found", undefined, "NOT_FOUND");
    const response = await publicProductRepresentation(product);
    await lookup.store(response, 30_000);
    sendSuccess(res, response);
  };

  statuses = async (req: Request, res: Response) => {
    const ids = [
      ...new Set(
        String(req.query.ids || "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ].slice(0, 50);
    if (!ids.length) {
      sendSuccess(res, []);
      return;
    }
    const products = await Product.find({
      $or: [{ publicId: { $in: ids } }, { hookId: { $in: ids } }],
      publishedAt: { $exists: true, $lte: new Date() },
      deletedAt: { $exists: false },
    })
      .select(PUBLIC_PRODUCT_CARD_FIELDS)
      .lean({ virtuals: true });
    sendSuccess(
      res,
      await publicProductRepresentations(products, { compact: true }),
    );
  };

  categories = async (req: Request, res: Response) => {
    // The customer app asks for withProducts=true so empty categories never appear.
    // Market Associate and Partner forms need the full tree to file new products.
    const withProducts = req.query.withProducts === "true";
    const cacheKey = withProducts ? "categories:active:stocked" : "categories:active";
    const lookup = await sharedCache.lookup<any>("catalog", cacheKey);
    if (lookup.hit) {
      sendSuccess(res, lookup.value);
      return;
    }
    // Top-level categories, each with its sub-categories and the details a
    // product in it asks for. Children of an inactive parent are hidden.
    const [tree, counts] = await Promise.all([
      categoryService.tree(),
      withProducts
        ? Product.aggregate([{ $match: baseFilter() }, { $group: { _id: "$categoryId", count: { $sum: 1 } } }])
        : Promise.resolve([]),
    ]);
    const countOf = new Map<string, number>(counts.map((item: any) => [String(item._id), Number(item.count)]));
    const stocked = (node: any) => (countOf.get(node.internalId) || 0) + (node.children || []).reduce((sum: number, child: any) => sum + (countOf.get(child.internalId) || 0), 0);
    const visibleTree = withProducts ? tree.filter((root: any) => stocked(root) > 0).map((root: any) => ({ ...root, children: (root.children || []).filter((child: any) => (countOf.get(child.internalId) || 0) > 0) })) : tree;
    const present = (node: any) => ({
      publicId: node.publicId,
      name: node.name,
      slug: node.slug,
      iconUrl: node.iconUrl || null,
      description: node.description || "",
      sortOrder: 0,
      level: node.level,
      parentId: node.parentId || null,
      attributes: node.attributes,
      sizingGuide: node.sizingGuide || null,
    });
    const response = visibleTree.map((root: any, index: number) => ({
      ...present(root),
      sortOrder: index + 1,
      ...(withProducts ? { productCount: stocked(root) } : {}),
      children: (root.children || []).map((child: any, childIndex: number) => ({ ...present(child), sortOrder: childIndex + 1, ...(withProducts ? { productCount: countOf.get(child.internalId) || 0 } : {}) })),
    }));
    await lookup.store(response);
    sendSuccess(res, response);
  };

  search = async (req: Request, res: Response) => this.products(req, res);

  suggestions = async (req: Request, res: Response) => {
    const query = String(req.query.q || "")
      .normalize("NFKC")
      .trim()
      .slice(0, 80);
    if (!query) {
      sendSuccess(res, []);
      return;
    }

    const clause = searchClause(query);
    if (!clause) {
      sendSuccess(res, []);
      return;
    }
    const filter: Record<string, any> = { ...baseFilter(), $and: [clause] };
    const stateIdentifier =
      String(req.query.stateId || req.query.stateCode || "") || undefined;
    const stateId = await internalId(OperationState, stateIdentifier, ["code"]);
    if (stateId) filter.sourceStateId = stateId;
    const rows = await Product.find(filter)
      .select("title")
      .sort({ publishedAt: -1, _id: -1 })
      .limit(8)
      .lean();
    const seen = new Set<string>();
    const values = rows
      .map((row: any) => String(row.title || "").trim())
      .filter(
        (title) =>
          title &&
          !seen.has(title.toLowerCase()) &&
          seen.add(title.toLowerCase()),
      );
    sendSuccess(res, values);
  };

  home = async (req: Request, res: Response) => {
    const stateIdentifier =
      String(req.query.stateId || req.query.stateCode || "") || undefined;
    const cacheKey = `home:${stateIdentifier || "all"}`;
    const lookup = await sharedCache.lookup<any>("catalog", cacheKey);
    if (lookup.hit) {
      sendSuccess(res, lookup.value);
      return;
    }
    const stateId = await internalId(OperationState, stateIdentifier, ["code"]);
    const filter: Record<string, unknown> = baseFilter();
    if (stateId) filter.sourceStateId = stateId;
    const [featured, categories, markets] = await Promise.all([
      Product.find(filter)
        .select(PUBLIC_PRODUCT_CARD_FIELDS)
        .sort({ publishedAt: -1, _id: -1 })
        .limit(12)
        .lean({ virtuals: true }),
      Category.find({ isActive: true, deletedAt: { $exists: false }, parentId: { $exists: false } })
        .select("publicId name slug iconUrl")
        .sort({ sortOrder: 1 })
        .limit(12)
        .lean({ virtuals: true }),
      Market.find({ status: "active", ...(stateId ? { stateId } : {}) })
        .select(
          "publicId name shortDisplayName stateId cityId address imageUrl discoveryColor isFeatured displayPriority",
        )
        .sort({ isFeatured: -1, displayPriority: 1, name: 1 })
        .limit(20)
        .lean({ virtuals: true }),
    ]);
    const response = {
      featuredProducts: await publicProductRepresentations(featured, {
        compact: true,
      }),
      categories: categories.map((item: any) => ({
        publicId: item.publicId,
        name: item.name,
        slug: item.slug,
        iconUrl: item.iconUrl || null,
      })),
      markets: markets.map((item: any) => ({
        publicId: item.publicId,
        name: item.name,
        shortDisplayName: item.shortDisplayName || item.name,
        address: item.address || null,
        imageUrl: item.imageUrl || null,
        discoveryColor: item.discoveryColor || "#FF8A62",
        isFeatured: Boolean(item.isFeatured),
        displayPriority: item.displayPriority ?? 100,
      })),
    };
    await lookup.store(response);
    sendSuccess(res, response);
  };
}

type CursorMode = "published" | "price_asc" | "price_desc";
type PublicCursor = { mode: CursorMode; value: number; id: string };

function encodeCursor(row: any, mode: CursorMode) {
  const value: PublicCursor = {
    mode,
    value:
      mode === "published"
        ? new Date(row.publishedAt || 0).getTime()
        : Number(row.sellingPriceMinor || 0),
    id: row._id.toString(),
  };
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(
  value: unknown,
  mode: CursorMode,
): PublicCursor | undefined {
  if (typeof value !== "string" || value.length > 300) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<PublicCursor>;
    if (parsed.mode !== mode || !parsed.id || !/^[a-f\d]{24}$/i.test(parsed.id))
      return undefined;
    if (!Number.isFinite(parsed.value)) return undefined;
    return { mode, id: parsed.id, value: Number(parsed.value) };
  } catch {
    return undefined;
  }
}
