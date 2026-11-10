import {
  NegotiatedQuoteStatus,
  ProductAvailabilityStatus,
  ProductStatus,
} from "@lib/constants";
import { isOnSale, withOnSale } from "@lib/product-availability";
import type { MongoRepository as Repository } from "@lib/mongo-repository";
import { Cart } from "@models/cart/cart.model";
import { CartItem } from "@models/cart/cart-item.model";
import { NegotiatedQuote, ProductVariant } from "@models/catalog/catalog.model";
import { OperationState } from "@models/platform/geography.model";
import { Product } from "@models/products/product.model";
import {
  nextCartItemPublicId,
  nextPublicId,
} from "@modules/platform";
import { HttpError } from "@utils/http";
import { Types } from "mongoose";
import { publishRealtime } from "@modules/platform";
import { ensureLegacyProductOptions } from '@modules/catalog';
import { Market } from '@models/platform/network.model';
import { deriveLiveRules, resolveQuote } from '@modules/negotiation/negotiation-live-rules.service';
import { voidQuote } from '@modules/negotiation/negotiation-reconcile.service';

function identifierFilter(identifier: string) {
  return Types.ObjectId.isValid(identifier)
    ? { $or: [{ _id: identifier }, { publicId: identifier }] }
    : { publicId: identifier };
}

export type CustomerOwner = {
  userId?: string;
  partnerId?: string;
  assistedCustomerId?: string;
  guestId?: string;
};

/**
 * What a customer sees for a chosen variant: colour and size as before, plus
 * every other detail the category asks for (capacity, length, connector...).
 */
function variantSnapshot(variant: { colour?: string; size?: string; attributes?: Record<string, string> }) {
  const snapshot: Record<string, string> = {};
  if (variant.colour) snapshot.color = variant.colour;
  if (variant.size) snapshot.size = variant.size;
  for (const [key, value] of Object.entries(variant.attributes || {})) {
    if (value && !(key in snapshot)) snapshot[key] = String(value);
  }
  return snapshot;
}

export class CartService {
  constructor(
    _carts?: Repository<Cart>,
    _items?: Repository<CartItem>,
    _products?: Repository<Product>,
  ) {}

  private async getOrCreateCart(owner: CustomerOwner) {
    const existing = await this.findActiveCart(owner);
    return existing || this.createCart(owner);
  }

  private findActiveCart(owner: CustomerOwner) {
    const ownerFilter = this.ownerWhere(owner);
    return Cart.findOne({
      ...ownerFilter,
      status: "active",
      isCheckedOut: false,
    })
      .select("_id publicId version")
      .lean({ virtuals: true });
  }

  private async createCart(owner: CustomerOwner) {
    const ownerFilter = this.ownerWhere(owner);
    return Cart.create({
      publicId: await nextPublicId("cart"),
      ...ownerFilter,
      ownerType: owner.partnerId
        ? "partner_assisted"
        : owner.userId
          ? "customer"
          : "customer",
      subtotal: 0,
      deliveryFee: 0,
      total: 0,
      version: 1,
      status: "active",
      isCheckedOut: false,
    });
  }

  async getCart(owner: CustomerOwner) {
    const existing = await Cart.findOne({
      ...this.ownerWhere(owner),
      status: "active",
      isCheckedOut: false,
    })
      .select("_id publicId version status isCheckedOut ownerType")
      .lean({ virtuals: true });
    const cart = existing || (await this.createCart(owner));
    return this.recalculate(String(cart._id || cart.id), cart);
  }

  async addItem(
    owner: CustomerOwner,
    productIdentifier: string,
    quantity: number,
    selectedVariants?: Record<string, string | undefined>,
    variantId?: string,
    quoteId?: string,
    options?: { deferRecalculation?: boolean },
  ) {
    // Validate the product and find the cart in parallel.
    const [product, existingCart] = await Promise.all([
      Product.findOne({
        ...withOnSale(identifierFilter(productIdentifier)),
        deletedAt: null,
      })
        .select(
          "_id publicId hookId marketId sourceStateId sellingPriceMinor discountMinor currency catalogVersion status availabilityStatus availabilityValidUntil negotiationRules colors sizes",
        )
        .lean({ virtuals: true }),
      this.findActiveCart(owner),
    ]);
    if (!product)
      throw new HttpError(
        404,
        "Product is not available",
        undefined,
        "PRODUCT_NOT_AVAILABLE",
      );
    const productId = product._id.toString();
    if (
      !product.marketId ||
      !product.sourceStateId ||
      !product.sellingPriceMinor
    ) {
      throw new HttpError(
        409,
        "Product commerce data is incomplete",
        undefined,
        "PRODUCT_NOT_AVAILABLE",
      );
    }
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new HttpError(
        400,
        "Quantity must be between 1 and 99",
        undefined,
        "VALIDATION_ERROR",
      );
    }
    // Market validation and option resolution are independent database reads.
    const [linkedMarket, variant] = await Promise.all([
      Market.findOne(identifierFilter(product.marketId)).select('_id name').lean(),
      (async () => {
        await ensureLegacyProductOptions(product, variantId);
        return variantId ? ProductVariant.findOne({ ...identifierFilter(variantId), productId, active: true }).lean({ virtuals: true }) : null;
      })(),
    ]);
    if (!linkedMarket?.name) throw new HttpError(409, 'Product market is unavailable. Refresh this product.', undefined, 'PRODUCT_NOT_AVAILABLE');
    product.marketId = linkedMarket._id.toString();
    if (variantId && !variant)
      throw new HttpError(
        409,
        "Selected product option is unavailable",
        undefined,
        "PRODUCT_VARIANT_UNAVAILABLE",
      );

    let quote: any = null;
    let quotedUnitPriceMinor: number | undefined;
    // A Partner shopping for a customer negotiates on that customer's behalf.
    const quoteOwner = owner.userId ?? owner.assistedCustomerId;
    const explicitQuote = Boolean(quoteId);
    if (quoteId) {
      // A locked price belongs to the product for its whole lifetime: any quantity, any option.
      quote = await NegotiatedQuote.findOne({
        ...identifierFilter(quoteId),
        productId,
        customerId: quoteOwner,
        status: NegotiatedQuoteStatus.ACTIVE,
        expiresAt: { $gt: new Date() },
      }).lean({ virtuals: true });
      if (!quote)
        throw new HttpError(
          409,
          "Negotiated quote is invalid or expired",
          undefined,
          "NEGOTIATION_QUOTE_EXPIRED",
        );
    } else if (quoteOwner) {
      // Every way of adding this product (a card, the quick-add sheet, the product page) gets the locked price.
      quote = await this.activeQuoteFor(quoteOwner, productId);
    }
    if (quote) {
      // The product may have changed since the price was agreed: the customer pays the lower of the agreed
      // and current price, and a quote that can no longer stand is cancelled rather than quietly honoured.
      const resolution = resolveQuote(Number(quote.agreedPriceMinor), deriveLiveRules(product));
      if (!resolution.valid) {
        await voidQuote(quote as never, resolution.reason);
        if (explicitQuote)
          throw new HttpError(
            409,
            "Your negotiated price is no longer valid for this product",
            { reason: resolution.reason },
            "NEGOTIATED_PRICE_VOIDED",
          );
        quote = null;
      } else {
        quotedUnitPriceMinor = resolution.unitPriceMinor;
      }
    }

    // Writes return a receipt; the client reconciles the cart in the background.
    const cart = existingCart || (await this.createCart(owner));
    const cartId = String(cart._id || cart.id);
    const variantKey =
      variant?._id.toString() || this.variantKey(selectedVariants);
    const unitPriceMinor = Number(
      quotedUnitPriceMinor ??
        product.sellingPriceMinor - Number(product.discountMinor || 0),
    );
    let changedItemPublicId: string | undefined;
    let reservedPublicId: string | undefined;
    let fastPathCompleted = false;

    if (!quote) {
      reservedPublicId = await nextCartItemPublicId();
      try {
        const updated = await CartItem.findOneAndUpdate(
          {
            cartId,
            productId,
            variantKey,
            // Preserve quoted and stale-price lines.
            $or: [{ quoteId: { $exists: false } }, { quoteId: null }],
            unitPriceMinor,
            totalPriceMinor: { $exists: true },
            totalPrice: { $exists: true },
            quantity: { $lte: 99 - quantity },
          },
          {
            $inc: {
              quantity,
              totalPriceMinor: unitPriceMinor * quantity,
              totalPrice: (unitPriceMinor * quantity) / 100,
            },
            $setOnInsert: {
              publicId: reservedPublicId,
              cartId,
              productId,
              variantId: variant?._id.toString(),
              marketId: product.marketId,
              stateId: product.sourceStateId,
              unitPriceMinor,
              currency: product.currency || "NGN",
              unitPrice: unitPriceMinor / 100,
              productVersion: product.catalogVersion || 1,
              selectedVariants: variant
                ? variantSnapshot(variant)
                : selectedVariants,
              variantKey,
            },
          },
          { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
        ).select(
          "publicId quantity quoteId quoteVersion unitPriceMinor totalPriceMinor totalPrice",
        );
        changedItemPublicId = updated?.publicId;
        fastPathCompleted = Boolean(updated);
      } catch (error) {
        // Retry through the validated path when the fast update misses.
        if ((error as { code?: number })?.code !== 11000) throw error;
      }
    }

    if (!fastPathCompleted) {
      const existing = await CartItem.findOne({
        cartId,
        productId,
        variantKey,
      }).select(
        "publicId quantity quoteId quoteVersion unitPriceMinor totalPriceMinor unitPrice totalPrice",
      );
      if (existing) {
        // Choosing a quantity with an explicit quote sets it exactly (so a retry cannot double it); every other add increments.
        const nextQuantity = explicitQuote && quote ? quantity : existing.quantity + quantity;
        if (nextQuantity > 99)
          throw new HttpError(
            400,
            "Quantity cannot exceed 99",
            undefined,
            "VALIDATION_ERROR",
          );
        if (quote) {
          existing.quoteId = quote._id.toString();
          existing.quoteVersion = quote.version || 1;
          existing.unitPriceMinor = unitPriceMinor;
          // The quote was just validated against the live product, so the line is current again.
          existing.productVersion = product.catalogVersion || 1;
        } else if (existing.quoteId) {
          existing.quoteId = undefined;
          existing.quoteVersion = undefined;
          existing.unitPriceMinor = Number(
            product.sellingPriceMinor - Number(product.discountMinor || 0),
          );
        } else {
          // Adding again is also the way to heal a line whose price or product version went stale.
          existing.unitPriceMinor = unitPriceMinor;
          existing.productVersion = product.catalogVersion || 1;
        }
        existing.quantity = nextQuantity;
        existing.marketId = product.marketId;
        existing.stateId = product.sourceStateId;
        existing.totalPriceMinor =
          nextQuantity * Number(existing.unitPriceMinor || unitPriceMinor);
        existing.unitPrice =
          Number(existing.unitPriceMinor || unitPriceMinor) / 100;
        existing.totalPrice = Number(existing.totalPriceMinor) / 100;
        await existing.save();
        changedItemPublicId = existing.publicId;
      } else {
        const created = await CartItem.create({
          publicId: reservedPublicId || (await nextCartItemPublicId()),
          cartId,
          productId,
          variantId: variant?._id.toString(),
          marketId: product.marketId,
          stateId: product.sourceStateId,
          quoteId: quote?._id.toString(),
          quantity,
          unitPriceMinor,
          totalPriceMinor: unitPriceMinor * quantity,
          currency: product.currency || "NGN",
          unitPrice: unitPriceMinor / 100,
          totalPrice: (unitPriceMinor * quantity) / 100,
          productVersion: product.catalogVersion || 1,
          quoteVersion: quote?.version || undefined,
          selectedVariants: variant
            ? variantSnapshot(variant)
            : selectedVariants,
          variantKey,
        });
        changedItemPublicId = created.publicId;
      }
    }
    const versionedCart = await Cart.findOneAndUpdate(
      { _id: cartId, status: "active", isCheckedOut: false },
      { $inc: { version: 1 } },
      { returnDocument: "after" },
    )
      .select("_id publicId version")
      .lean({ virtuals: true });
    if (!versionedCart)
      throw new HttpError(
        409,
        "Basket is no longer active",
        undefined,
        "CART_VERSION_CHANGED",
      );
    const nextVersion = Number(versionedCart.version || 1);
    const publicCartId = versionedCart.publicId || cart.publicId || cartId;

    if (options?.deferRecalculation) {
      publishRealtime(
        {
          type: "cart.updated",
          entityId: publicCartId,
          version: nextVersion,
        },
        owner.userId ? { accountId: owner.userId } : undefined,
      );
      // Refresh legacy totals without hydrating the cart.
      setImmediate(() => {
        void this.refreshSummary(cartId).catch((error) => {
          console.error("[cart] deferred summary refresh failed", error);
        });
      });
      return {
        cartId: publicCartId,
        itemId: changedItemPublicId,
        version: nextVersion,
        accepted: true,
      };
    }
    return this.changedCart(owner, cartId);
  }

  async updateItem(
    owner: CustomerOwner,
    itemId: string,
    quantity: number,
    options?: { deferRecalculation?: boolean },
  ) {
    const cart = await this.getOrCreateCart(owner);
    const cartId = String(cart._id || cart.id);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99)
      throw new HttpError(400, "Quantity must be between 1 and 99");
    const item = await CartItem.findOne({ ...identifierFilter(itemId), cartId })
      .select("quantity unitPriceMinor quoteId quoteVersion productId variantId")
      .lean();
    if (!item) throw new HttpError(404, "Cart item not found");
    const product = await Product.findById(item.productId)
      .select("status availabilityStatus availabilityValidUntil sellingPriceMinor discountMinor catalogVersion negotiationRules deletedAt")
      .lean();
    if (!product || !isOnSale(product))
      throw new HttpError(
        409,
        "Product is no longer available",
        undefined,
        "PRODUCT_NOT_AVAILABLE",
      );
    let unitPriceMinor = Number(item.unitPriceMinor || 0);
    let dropQuote = false;
    let refreshVersion = false;
    let attached: { _id: unknown; version?: number } | undefined;
    const quoteOwner = owner.userId ?? owner.assistedCustomerId;
    if (item.quoteId) {
      const quote = await NegotiatedQuote.findOne({
        _id: item.quoteId,
        customerId: quoteOwner,
        productId: item.productId,
        status: NegotiatedQuoteStatus.ACTIVE,
        expiresAt: { $gt: new Date() },
      })
        .select("_id publicId customerId negotiationId agreedPriceMinor")
        .lean();
      const cancelled = quote
        ? null
        : await NegotiatedQuote.exists({ _id: item.quoteId, status: NegotiatedQuoteStatus.CANCELLED });
      if (!quote && !cancelled)
        throw new HttpError(
          409,
          "Your negotiated price has expired",
          undefined,
          "NEGOTIATION_QUOTE_EXPIRED",
        );
      const resolution = quote ? resolveQuote(Number(quote.agreedPriceMinor), deriveLiveRules(product)) : null;
      if (quote && resolution?.valid) {
        // The locked price holds at any quantity until it expires.
        unitPriceMinor = resolution.unitPriceMinor;
      } else {
        if (quote && resolution && !resolution.valid) await voidQuote(quote as never, resolution.reason);
        // A cancelled quote no longer applies: the line goes back to the list price instead of quietly keeping it.
        dropQuote = true;
        unitPriceMinor = Number(product.sellingPriceMinor) - Number(product.discountMinor || 0);
      }
      // The line was just re-priced from the live product, so it is current again.
      refreshVersion = true;
    } else if (quoteOwner) {
      // A price locked after this line was added applies to it as well.
      const quote = await this.activeQuoteFor(quoteOwner, item.productId);
      if (quote) {
        const resolution = resolveQuote(Number(quote.agreedPriceMinor), deriveLiveRules(product));
        if (resolution.valid) {
          unitPriceMinor = resolution.unitPriceMinor;
          attached = { _id: quote._id, version: quote.version };
          refreshVersion = true;
        } else {
          await voidQuote(quote as never, resolution.reason);
        }
      }
    }
    const updated = await CartItem.findOneAndUpdate(
      { ...identifierFilter(itemId), cartId },
      {
        $set: {
          quantity,
          unitPriceMinor,
          unitPrice: unitPriceMinor / 100,
          totalPriceMinor: quantity * unitPriceMinor,
          totalPrice: (quantity * unitPriceMinor) / 100,
          ...(refreshVersion ? { productVersion: Number(product.catalogVersion || 1) } : {}),
          ...(attached ? { quoteId: String(attached._id), quoteVersion: attached.version || 1 } : {}),
        },
        ...(dropQuote ? { $unset: { quoteId: 1, quoteVersion: 1 } } : {}),
      },
      { returnDocument: "after" },
    )
      .select("publicId quantity unitPriceMinor totalPriceMinor totalPrice")
      .lean();
    if (!updated)
      throw new HttpError(
        409,
        "Cart changed before the quantity update completed",
        undefined,
        "CART_VERSION_CHANGED",
      );
    return this.finishMutation(
      owner,
      cartId,
      updated.publicId,
      options?.deferRecalculation === true,
    );
  }

  async removeItem(
    owner: CustomerOwner,
    itemId: string,
    options?: { deferRecalculation?: boolean },
  ) {
    const cart = await this.getOrCreateCart(owner);
    const cartId = String(cart._id || cart.id);
    const removed = await CartItem.findOneAndDelete({ ...identifierFilter(itemId), cartId })
      .select("publicId")
      .lean();
    if (!removed) throw new HttpError(404, "Cart item not found");
    return this.finishMutation(owner, cartId, removed.publicId, options?.deferRecalculation === true);
  }

  async clear(
    owner: CustomerOwner,
    stateId?: string,
    options?: { deferRecalculation?: boolean },
  ) {
    const cart = await this.getOrCreateCart(owner);
    const cartId = String(cart._id || cart.id);
    const storedStateId = stateId;
    if (stateId && !Types.ObjectId.isValid(stateId)) {
      const state = await OperationState.findOne({ publicId: stateId })
        .select("_id publicId")
        .lean();
      const stateIdentifiers = [state?._id?.toString(), state?.publicId, stateId].filter(Boolean) as string[];
      await CartItem.deleteMany({
        cartId,
        stateId: { $in: stateIdentifiers },
      });
      return this.finishMutation(owner, cartId, undefined, options?.deferRecalculation === true);
    }
    await CartItem.deleteMany({
      cartId,
      ...(storedStateId ? { stateId: storedStateId } : {}),
    });
    return this.finishMutation(owner, cartId, undefined, options?.deferRecalculation === true);
  }

  /** The customer's best still-valid locked price for a product, if any. */
  private activeQuoteFor(customerId: string, productId: string) {
    return NegotiatedQuote.findOne({
      customerId,
      productId,
      status: NegotiatedQuoteStatus.ACTIVE,
      expiresAt: { $gt: new Date() },
    })
      .sort({ agreedPriceMinor: 1 })
      .select("_id publicId customerId negotiationId agreedPriceMinor version")
      .lean({ virtuals: true });
  }

  /**
   * Called when a price has just been locked: lines for that product already in the customer's cart move to the
   * locked price right away, whatever their quantity or option. Best effort; a failure never undoes the lock.
   */
  async applyLockedPrice(customerId: string, quote: { _id: unknown; productId: string; agreedPriceMinor: number; version?: number }) {
    const cart = await Cart.findOne({ customerId, status: "active", isCheckedOut: false }).select("_id publicId").lean({ virtuals: true });
    if (!cart) return 0;
    const product = await Product.findById(quote.productId)
      .select("status availabilityStatus availabilityValidUntil sellingPriceMinor discountMinor catalogVersion negotiationRules deletedAt")
      .lean();
    if (!product) return 0;
    const resolution = resolveQuote(Number(quote.agreedPriceMinor), deriveLiveRules(product));
    if (!resolution.valid) return 0;
    const lines = await CartItem.find({ cartId: String(cart._id), productId: quote.productId, $or: [{ quoteId: { $exists: false } }, { quoteId: null }] })
      .select("_id quantity")
      .lean();
    for (const line of lines) {
      const total = resolution.unitPriceMinor * Number(line.quantity);
      await CartItem.updateOne(
        { _id: line._id },
        { $set: { quoteId: String(quote._id), quoteVersion: quote.version || 1, unitPriceMinor: resolution.unitPriceMinor, unitPrice: resolution.unitPriceMinor / 100, totalPriceMinor: total, totalPrice: total / 100, productVersion: Number(product.catalogVersion || 1) } },
      );
    }
    if (lines.length) {
      const updated = await Cart.findOneAndUpdate({ _id: cart._id }, { $inc: { version: 1 } }, { returnDocument: "after" }).select("version").lean();
      publishRealtime({ type: "cart.updated", entityId: cart.publicId || String(cart._id), version: Number(updated?.version || 1) }, { accountId: customerId });
    }
    return lines.length;
  }

  async recalculate(cartId: string, existingCart?: any) {
    const [cart, items] = await Promise.all([
      existingCart
        ? Promise.resolve(existingCart)
        : Cart.findById(cartId).select("_id publicId version status isCheckedOut ownerType").lean({ virtuals: true }),
      CartItem.find({ cartId })
        .select(
          "_id publicId productId quantity selectedVariants variantKey variantId marketId stateId quoteId quoteVersion unitPriceMinor totalPriceMinor currency productVersion createdAt",
        )
        .sort({ createdAt: 1 })
        .lean({ virtuals: true }),
    ]);
    if (!cart) throw new HttpError(404, "Cart not found");
    const productIds = [...new Set(items.map((item) => item.productId))];
    const stateIds = [...new Set(items.map((item) => String(item.stateId || "")).filter(Boolean))];
    const objectStateIds = stateIds.filter((stateId) => Types.ObjectId.isValid(stateId));
    const [products, states, quotes] = await Promise.all([
      productIds.length
        ? Product.find({ _id: { $in: productIds } })
            .select(
              "_id publicId hookId title slug images marketId sellingPriceMinor discountMinor currency catalogVersion status availabilityStatus availabilityValidUntil negotiationRules deletedAt customerAvailabilityNote",
            )
            .lean({ virtuals: true })
        : [],
      stateIds.length
        ? OperationState.find({
            $or: [
              { publicId: { $in: stateIds } },
              ...(objectStateIds.length ? [{ _id: { $in: objectStateIds } }] : []),
            ],
          } as any)
            .select("_id publicId name code")
            .lean({ virtuals: true })
        : [],
      NegotiatedQuote.find({ _id: { $in: items.map((item) => item.quoteId).filter(Boolean) } })
        .select('_id publicId originalPriceMinor agreedPriceMinor expiresAt status voidReason')
        .lean({ virtuals: true }),
    ]);
    const marketIds = [...new Set([...items.map((item) => item.marketId), ...products.map((product) => product.marketId)].filter((value): value is string => Boolean(value)))];
    const markets = marketIds.length ? await Market.find({ $or: [{ publicId: { $in: marketIds } }, { _id: { $in: marketIds.filter((id) => Types.ObjectId.isValid(id)) } }] }).select('_id publicId name').lean() : [];
    const marketMap = new Map<string, { publicId: string; name: string }>();
    for (const market of markets) {
      const value = { publicId: market.publicId, name: market.name };
      marketMap.set(market._id.toString(), value); marketMap.set(market.publicId, value);
    }
    const productMap = new Map(products.map((product) => [product._id.toString(), product]));
    const quoteMap = new Map(quotes.map((quote) => [quote._id.toString(), quote]));
    const stateMap = new Map<string, { publicId: string; name: string; code: string }>();
    for (const state of states) {
      const value = { publicId: state.publicId, name: state.name, code: state.code };
      stateMap.set(state._id.toString(), value);
      stateMap.set(state.publicId, value);
    }
    const groupsByState = new Map<string, any[]>();
    const enriched = items.map((item) => {
      const product = productMap.get(item.productId);
      const blockingReasons: string[] = [];
      if (!product || !isOnSale(product))
        blockingReasons.push("RUNNER_CONFIRMATION_REQUIRED");
      const quote = item.quoteId ? quoteMap.get(item.quoteId) : undefined;
      const resolution =
        product && quote && quote.status === NegotiatedQuoteStatus.ACTIVE
          ? resolveQuote(Number(quote.agreedPriceMinor), deriveLiveRules(product))
          : undefined;
      if (quote && (quote.status === NegotiatedQuoteStatus.CANCELLED || (resolution && !resolution.valid))) {
        // The negotiated price no longer stands. The customer re-confirms the line (same quantity) to continue.
        blockingReasons.push("NEGOTIATED_PRICE_VOIDED");
      } else if (product && product.catalogVersion !== item.productVersion && !resolution?.valid) {
        // A quoted line is judged on price, not on every unrelated catalogue edit.
        blockingReasons.push("PRODUCT_CHANGED");
      }
      // When the list price fell below the agreed price the customer pays the lower one.
      const repriced = resolution?.valid && resolution.reason === "PRICE_DROPPED" ? resolution.unitPriceMinor : undefined;
      const enrichedItem = {
        ...item,
        ...(repriced
          ? {
              unitPriceMinor: repriced,
              totalPriceMinor: repriced * Number(item.quantity),
              priceNote: "PRICE_DROPPED",
            }
          : {}),
        productId: product?.publicId || product?.hookId || item.productId,
        publicStateId: stateMap.get(String(item.stateId))?.publicId,
        marketId: item.marketId || product?.marketId,
        market: marketMap.get(String(item.marketId)) || marketMap.get(String(product?.marketId)),
        product: product ? this.cartProduct(product) : undefined,
        negotiatedQuote: item.quoteId && quoteMap.get(item.quoteId) ? {
          id: quoteMap.get(item.quoteId)!.publicId,
          originalPriceMinor: quoteMap.get(item.quoteId)!.originalPriceMinor,
          agreedPriceMinor: repriced ?? quoteMap.get(item.quoteId)!.agreedPriceMinor,
          expiresAt: quoteMap.get(item.quoteId)!.expiresAt,
          status: quoteMap.get(item.quoteId)!.status,
          ...(quoteMap.get(item.quoteId)!.status === NegotiatedQuoteStatus.CANCELLED || (resolution && !resolution.valid)
            ? { status: NegotiatedQuoteStatus.CANCELLED, voidReason: resolution && !resolution.valid ? resolution.reason : (quoteMap.get(item.quoteId) as { voidReason?: string }).voidReason }
            : {}),
        } : undefined,
        blockingReasons,
        checkoutEligible: blockingReasons.length === 0,
      };
      if (item.stateId) {
        const existing = groupsByState.get(String(item.stateId)) || [];
        existing.push(enrichedItem);
        groupsByState.set(String(item.stateId), existing);
      }
      return enrichedItem;
    });
    const groups = [...groupsByState.entries()].map(([stateId, groupItems]) => {
      const subtotalMinor = groupItems.reduce(
        (sum, item) => sum + Number(item.totalPriceMinor || 0),
        0,
      );
      const blockingReasons = [
        ...new Set(groupItems.flatMap((item) => item.blockingReasons)),
      ];
      return {
        stateId,
        publicStateId: stateMap.get(String(stateId))?.publicId,
        state: stateMap.get(String(stateId)),
        items: groupItems,
        subtotalMinor,
        currency: "NGN",
        checkoutEligible: blockingReasons.length === 0,
        blockingReasons,
      };
    });
    const subtotalMinor = enriched.reduce(
      (sum, item) => sum + Number(item.totalPriceMinor || 0),
      0,
    );
    return {
      ...cart,
      items: enriched,
      stateGroups: groups,
      subtotalMinor,
      currency: "NGN",
      itemCount: enriched.reduce((sum, item) => sum + item.quantity, 0),
    };
  }

  private async refreshSummary(cartId: string) {
    const [summary] = await CartItem.aggregate<{
      _id: null;
      subtotalMinor: number;
    }>([
      { $match: { cartId } },
      {
        $group: {
          _id: null,
          subtotalMinor: {
            $sum: {
              $ifNull: [
                "$totalPriceMinor",
                { $multiply: ["$unitPriceMinor", "$quantity"] },
              ],
            },
          },
        },
      },
    ]);
    const subtotalMinor = Number(summary?.subtotalMinor || 0);
    await Cart.updateOne(
      { _id: cartId },
      {
        $set: {
          subtotal: subtotalMinor / 100,
          deliveryFee: 0,
          total: subtotalMinor / 100,
        },
      },
    );
  }

  private cartProduct(product: any) {
    const images = Array.isArray(product.images)
      ? product.images
          .map((image: any) => (typeof image === "string" ? image : image?.url))
          .filter(Boolean)
      : [];
    return {
      id: product.hookId || product.publicId,
      publicId: product.publicId || product.hookId,
      title: product.title,
      slug: product.slug,
      imageUrl: images[0] || null,
    };
  }

  /** Key for a line with no catalog variant: every chosen detail, in a stable order. */
  private variantKey(selected?: Record<string, string | undefined>) {
    const entries = Object.entries(selected || {})
      .map(([key, value]) => [key.toLowerCase(), String(value ?? "").trim().toLowerCase()] as const)
      .filter(([, value]) => value)
      .sort(([a], [b]) => a.localeCompare(b));
    if (!entries.length) return "default";
    // Colour and size keep the historical `color::size` shape so existing lines still match.
    const only = entries.every(([key]) => key === "color" || key === "size");
    if (only) {
      const lookup = Object.fromEntries(entries);
      return `${lookup.color || "-"}::${lookup.size || "-"}`;
    }
    return entries.map(([key, value]) => `${key}=${value}`).join("|");
  }

  private async changedCart(owner: CustomerOwner, cartId: string) {
    const cart = await this.recalculate(cartId);
    publishRealtime({
      type: "cart.updated",
      entityId: cart.publicId || cart.id,
      version: Number(cart.version || 1),
    }, owner.userId ? { accountId: owner.userId } : undefined);
    return cart;
  }

  private async finishMutation(
    owner: CustomerOwner,
    cartId: string,
    itemId?: string,
    deferRecalculation = false,
  ) {
    const versionedCart = await Cart.findOneAndUpdate(
      { _id: cartId, status: "active", isCheckedOut: false },
      { $inc: { version: 1 } },
      { returnDocument: "after" },
    )
      .select("publicId version")
      .lean();
    if (!versionedCart)
      throw new HttpError(
        409,
        "Basket is no longer active",
        undefined,
        "CART_VERSION_CHANGED",
      );
    const receipt = {
      cartId: versionedCart.publicId || cartId,
      ...(itemId ? { itemId } : {}),
      version: Number(versionedCart.version || 1),
      accepted: true,
    };
    publishRealtime(
      {
        type: "cart.updated",
        entityId: receipt.cartId,
        version: receipt.version,
      },
      owner.userId ? { accountId: owner.userId } : undefined,
    );
    if (deferRecalculation) {
      setImmediate(() => {
        void this.refreshSummary(cartId).catch((error) => {
          console.error("[cart] summary refresh failed", error);
        });
      });
      return receipt;
    }
    return this.changedCart(owner, cartId);
  }

  private ownerWhere(owner: CustomerOwner) {
    if (owner.partnerId && owner.assistedCustomerId)
      return {
        partnerId: owner.partnerId,
        assistedCustomerId: owner.assistedCustomerId,
      };
    if (owner.userId) return { customerId: owner.userId };
    throw new HttpError(
      401,
      "Customer authentication required",
      undefined,
      "AUTHENTICATION_REQUIRED",
    );
  }
}
