import { createHash, randomUUID } from "crypto";
import { categoryService } from "@modules/catalog";
import { classifyNegotiationMessage, negotiationMoneyFromMessage } from "@lib/negotiation-intent";
import { Negotiation } from "@models/negotiations/negotiation.model";
import { Product } from "@models/products/product.model";
import { ProductVariant, NegotiatedQuote } from "@models/catalog/catalog.model";
import {
  NegotiationStatus,
  ProductStatus,
  ProductAvailabilityStatus,
  NegotiatedQuoteStatus,
} from "@lib/constants";
import { HttpError } from "@utils/http";
import {
  NegotiationService,
  type NegotiationIdentity,
} from "@modules/negotiation/negotiation.service";
import { CartService } from "@modules/orders";
import { publishRealtime } from "@modules/platform";
import {
  AzureNegotiationService,
  detectNegotiationLanguage,
} from "@modules/negotiation/azure-negotiation.service";
import { Category } from "@models/categories/category.model";
import { CommerceSettings } from '@models/commerce/commerce.model';
import { assertAzureConfigured } from '@modules/negotiation/azure-negotiation.service';
import { negotiationContext } from '@modules/negotiation/negotiation-context.service';
import { negotiationWriteFence } from '@lib/negotiation-execution';

export class NegotiationShoppingService {
  private readonly negotiations = new NegotiationService();

  private async owned(identity: NegotiationIdentity, id: string) {
    const session = await Negotiation.findOne({
      publicId: id,
      customerId: identity.customerId,
      ...(identity.partnerId
        ? { initiatingPartnerId: identity.partnerId }
        : {}),
    }).lean();
    if (!session)
      throw new HttpError(404, "Negotiation not found", undefined, "NOT_FOUND");
    return session;
  }

  async message(
    identity: NegotiationIdentity,
    id: string,
    message: string,
    key: string,
  ) {
    if (key.length < 8 || key.length > 200)
      throw new HttpError(
        400,
        "Idempotency-Key required",
        undefined,
        "VALIDATION_ERROR",
      );
    const session = await this.owned(identity, id);
    const hash = createHash("sha256").update(message).digest("hex");
    const previous = session.idempotencyResults?.find(
      (entry) => entry.key === key,
    );
    if (previous) {
      if (!previous.response.entry)
        return this.negotiations.offer(identity, id, undefined, key, message);
      if (previous.requestHash !== hash)
        throw new HttpError(
          409,
          "Request key already used",
          undefined,
          "IDEMPOTENCY_CONFLICT",
        );
      return previous.response;
    }
    const settings = await CommerceSettings.findOne({ key: 'commerce' }).select('negotiationEnabled negotiationAzureWordingEnabled').lean();
    assertAzureConfigured(settings?.negotiationEnabled !== false && settings?.negotiationAzureWordingEnabled !== false && session.rulesSnapshot?.azureWordingEnabled !== false);
    const hint = await new AzureNegotiationService().shoppingIntent(message);
    const classification = classifyNegotiationMessage(message);
    classification.intent = hint.intent;
    classification.quantity = hint.quantity;
    if (hint.intent === 'alternatives') classification.budgetMinor = negotiationMoneyFromMessage(message) || classification.budgetMinor;
    if (hint.intent === 'offer' && !negotiationMoneyFromMessage(message)) classification.intent = 'conversation';
    if (classification.intent === 'offer') return this.negotiations.offer(identity, id, undefined, key, message, 'offer');
    if (
      ![NegotiationStatus.ACTIVE, NegotiationStatus.AGREED].includes(
        session.status,
      )
    ) {
      throw new HttpError(
        409,
        "This conversation is closed",
        undefined,
        "INVALID_STATE_TRANSITION",
      );
    }
    if (
      session.status === NegotiationStatus.ACTIVE &&
      session.expiresAt &&
      session.expiresAt <= new Date()
    )
      throw new HttpError(
        410,
        "This negotiation expired",
        undefined,
        "NEGOTIATION_QUOTE_EXPIRED",
      );
    const product = await Product.findById(session.productId).lean();
    if (!product)
      throw new HttpError(404, "Product unavailable", undefined, "NOT_FOUND");
    let reply: string;
    let productIds: string[] | undefined;
    let action:
      | { id: string; state: "pending"; quantity: number; quoteId: string }
      | undefined;
    if (classification.intent === "alternatives") {
      const categories = await Category.find({ deletedAt: null, isActive: true })
        .select("name")
        .lean();
      // The most specific name wins ("Sneakers male" over "Shoes").
      const requestedCategory = categories
        .filter((category) => message.toLowerCase().includes(category.name.toLowerCase()))
        .sort((a, b) => b.name.length - a.name.length)[0];
      // A parent such as "Shoes" covers every sub-category beneath it.
      const categoryScope = requestedCategory
        ? await categoryService.descendantIds(requestedCategory._id.toString())
        : [product.categoryId];
      const budget =
        classification.budgetMinor ||
        session.lastCounterPriceMinor ||
        product.sellingPriceMinor ||
        0;
      const candidates = await Product.aggregate([
        {
          $match: {
            categoryId: { $in: categoryScope },
            _id: { $ne: product._id },
            status: ProductStatus.PUBLISHED,
            availabilityStatus: {
              $in: [
                ProductAvailabilityStatus.AVAILABLE,
                ProductAvailabilityStatus.LIMITED,
              ],
            },
            deletedAt: { $exists: false },
          },
        },
        {
          $set: {
            price: {
              $subtract: [
                { $ifNull: ["$sellingPriceMinor", 0] },
                { $ifNull: ["$discountMinor", 0] },
              ],
            },
          },
        },
        { $match: { price: { $gt: 0 } } },
        {
          $set: {
            overBudget: { $cond: [{ $lte: ["$price", budget] }, 0, 1] },
            distance: { $abs: { $subtract: ["$price", budget] } },
            otherMarket: {
              $cond: [{ $eq: ["$marketId", product.marketId || ""] }, 0, 1],
            },
          },
        },
        { $sort: { overBudget: 1, otherMarket: 1, distance: 1, publicId: 1 } },
        { $limit: 4 },
        { $project: { publicId: 1 } },
      ]);
      productIds = candidates
        .map((entry) => String(entry.publicId))
        .filter((value) => value !== "undefined");
      reply = productIds.length
        ? `Here are available alternatives ${requestedCategory ? `in ${requestedCategory.name}` : "in the same category"} near your budget. Select one to review its options.`
        : "No available alternatives match this category right now.";
    } else if (classification.intent === "selection") {
      const group = [...session.transcript]
        .reverse()
        .find((entry) => entry.productIds?.length);
      const selected =
        classification.selection !== undefined
          ? group?.productIds?.[classification.selection]
          : undefined;
      productIds = selected ? [selected] : undefined;
      reply = selected
        ? "Here is that product. Open it to choose your colour and size and start its own negotiation."
        : "Please tap a product card so I know exactly which item you mean.";
    } else if (classification.intent === "checkout") {
      reply =
        "Use Proceed to checkout to review your cart and pay securely. Nothing is added without your confirmation.";
    } else if (classification.intent === "conversation") {
      reply = 'Answer the relevant shopping question using supplied facts, clarify ambiguity, or redirect unrelated requests to negotiation.';
    } else {
      const quantity = classification.quantity || session.quantity;
      if (quantity < 1 || quantity > 20)
        reply = "Choose a quantity between 1 and 20.";
      else if (quantity !== session.quantity)
        reply = `This price belongs to quantity ${session.quantity}. Choose quantity ${quantity} in the product summary to start or resume a matching negotiation; the current quote will not transfer.`;
      else if (!session.quoteId || session.status !== NegotiationStatus.AGREED)
        reply =
          "Accept the displayed approved price first. Then I can prepare a cart confirmation for you.";
      else {
        const quote = await NegotiatedQuote.findOne({
          _id: session.quoteId,
          customerId: identity.customerId,
          quantity,
          status: NegotiatedQuoteStatus.ACTIVE,
          expiresAt: { $gt: new Date() },
        }).lean();
        if (!quote)
          throw new HttpError(
            409,
            "Your quote has expired. Start a new negotiation.",
            undefined,
            "NEGOTIATION_QUOTE_EXPIRED",
          );
        action = {
          id: randomUUID(),
          state: "pending",
          quantity,
          quoteId: quote.publicId!,
        };
        reply =
          "Review your product, options, quantity and locked price before confirming. Your cart has not changed yet.";
      }
    }
    // Deterministic branches establish permitted facts/actions, never customer
    // wording. Azure must successfully phrase every conversational reply.
    const facts = await negotiationContext(session);
    const guidance = await new AzureNegotiationService().guide({
      customerMessage: message, language: detectNegotiationLanguage(message),
      productTitle: product.title, productDescription: product.description,
      currentPriceMinor: session.agreedPriceMinor || Math.max(0, Number(product.sellingPriceMinor || 0) - Number(product.discountMinor || 0)),
      conversation: session.transcript.slice(-12), enabled: true,
      facts: { ...facts, suggestedProductIds: productIds, pendingAction: action ? { quantity: action.quantity, confirmationRequired: true } : undefined },
      instruction: `Server-authorised response guidance: ${reply} Do not claim anything has been added or priced anew.`,
    });
    reply = guidance.message;
    const entry = {
      id: randomUUID(),
      sequence: session.transcript.length + 2,
      kind: action ? "action" : productIds?.length ? "suggestions" : "text",
      role: "hook",
      message: reply,
      productIds,
      actionId: action?.id,
      quantity: action?.quantity,
      createdAt: new Date(),
    };
    const response = {
      negotiationId: id,
      status: session.status,
      message: reply,
      entry,
    };
    const updated = await Negotiation.updateOne(
      { _id: session._id, version: session.version, ...negotiationWriteFence() },
      {
        $inc: { version: 1 },
        $push: {
          transcript: {
            $each: [
              {
                id: randomUUID(),
                sequence: session.transcript.length + 1,
                requestId: key,
                kind: "text",
                role: "customer",
                message,
                createdAt: new Date(),
              },
              entry,
            ],
          },
          idempotencyResults: {
            key,
            requestHash: hash,
            response,
            createdAt: new Date(),
          },
          ...(action ? { shoppingActions: action } : {}),
          providerTelemetry: guidance.telemetry,
        },
      },
    );
    if (!updated.modifiedCount)
      throw new HttpError(
        409,
        "Conversation changed; retry your message",
        undefined,
        "IDEMPOTENCY_CONFLICT",
      );
    return response;
  }

  async confirm(
    identity: NegotiationIdentity,
    id: string,
    actionId: string,
    quantity: number,
    variantId: string,
  ) {
    const session = await this.owned(identity, id);
    const action = session.shoppingActions?.find(
      (entry) => entry.id === actionId,
    );
    if (!action)
      throw new HttpError(404, "Action not found", undefined, "NOT_FOUND");
    const variant = await ProductVariant.findOne({
      _id: session.variantId,
      publicId: variantId,
      productId: session.productId,
      active: true,
      deletedAt: { $exists: false },
    }).lean();
    if (
      !variant ||
      quantity !== session.quantity ||
      quantity !== action.quantity
    )
      throw new HttpError(
        409,
        "Options or quantity do not match the quote",
        undefined,
        "PRODUCT_VARIANT_UNAVAILABLE",
      );
    if (action.state === "completed") return action.receipt;
    if (session.status !== NegotiationStatus.AGREED)
      throw new HttpError(
        409,
        "Negotiation is not agreed",
        undefined,
        "INVALID_STATE_TRANSITION",
      );
    const executionId = randomUUID();
    const locked = await Negotiation.updateOne(
      {
        _id: session._id,
        shoppingActions: {
          $elemMatch: {
            id: actionId,
            $or: [
              { state: "pending" },
              { state: "executing", leaseUntil: { $lt: new Date() } },
            ],
          },
        },
      },
      {
        $set: {
          "shoppingActions.$.state": "executing",
          "shoppingActions.$.executionId": executionId,
          "shoppingActions.$.leaseUntil": new Date(Date.now() + 120000),
        },
      },
    );
    if (!locked.modifiedCount)
      throw new HttpError(
        409,
        "Confirmation is already processing. Refresh before retrying.",
        undefined,
        "ACTION_IN_PROGRESS",
      );
    // Quoted cart writes set (rather than increment) the exact quantity. Replaying
    // after a process failure therefore cannot duplicate the quoted line.
    let receipt;
    try {
      receipt = await new CartService().addItem(
        { userId: identity.customerId },
        session.productId,
        quantity,
        undefined,
        variantId,
        action.quoteId,
      );
    } catch (error) {
      await Negotiation.updateOne(
        {
          _id: session._id,
          shoppingActions: { $elemMatch: { id: actionId, executionId } },
        },
        { $set: { "shoppingActions.$.state": "pending" } },
      );
      throw error;
    }
    const result = {
      actionId,
      message: "Your confirmed product has been added to your cart.",
      receipt,
    };
    await Negotiation.updateOne(
      {
        _id: session._id,
        shoppingActions: {
          $elemMatch: { id: actionId, executionId, state: "executing" },
        },
      },
      {
        $set: {
          "shoppingActions.$.state": "completed",
          "shoppingActions.$.receipt": result,
        },
        $inc: { version: 1 },
        $push: {
          transcript: {
            id: randomUUID(),
            sequence: session.transcript.length + 1,
            kind: "receipt",
            role: "hook",
            message: result.message,
            actionId,
            createdAt: new Date(),
          },
        },
      },
    );
    publishRealtime({ type: 'negotiation.updated', entityId: id }, { accountId: identity.customerId });
    return result;
  }
}
