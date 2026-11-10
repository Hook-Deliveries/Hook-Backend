import { createHash, randomUUID } from 'crypto';
import { withOnSale } from "@lib/product-availability";
import mongoose from 'mongoose';
import { AccountType, NegotiatedQuoteStatus, NegotiationStatus, ProductAvailabilityStatus, ProductStatus } from '@lib/constants';
import { NegotiatedQuote, ProductVariant } from '@models/catalog/catalog.model';
import { CommerceSettings } from '@models/commerce/commerce.model';
import { Negotiation } from '@models/negotiations/negotiation.model';
import { Product } from '@models/products/product.model';
import { User } from '@models/users/user.model';
import { nextPublicId } from '@modules/platform';
import { AzureNegotiationService, detectNegotiationLanguage, assertAzureConfigured, fallbackPhrase, negotiationUnavailable } from '@modules/negotiation/azure-negotiation.service';
import { negotiationContext } from '@modules/negotiation/negotiation-context.service';
import { negotiationWriteFence } from '@lib/negotiation-execution';
import { PricingEngine } from '@modules/catalog';
import type { PricingDecision } from '@modules/catalog/pricing-engine.service';
import { closeSessionForProduct, reconcileQuote } from '@modules/negotiation/negotiation-reconcile.service';
import { assertMayStartNegotiation, MAX_CHAT_TURNS_PER_SESSION } from '@modules/negotiation/negotiation-abuse.service';
import { clampToLive, deriveLiveRules, loadLiveRules, pricingInputs, type LiveRules } from '@modules/negotiation/negotiation-live-rules.service';
import { createCommerceNotification } from '@modules/notifications';
import { EmailService } from '@emails/email.service';
import { HttpError, isDuplicateKeyError } from '@utils/http';
import { CartService } from '@modules/orders/cart.service';
import { classifyNegotiationMessage, groundedOfferMinor, negotiationMoneyFromMessage } from '@lib/negotiation-intent';
import { ensureLegacyProductOptions } from '@modules/catalog';
import { publishRealtime } from '@modules/platform';

/**
 * `partnerId` is set only for partner-assisted sessions. The negotiation is
 * still owned by `customerId` (the shopper being helped) — the partner is
 * recorded as the initiator so admin can audit who negotiated on whose behalf.
 */
export interface NegotiationIdentity {
  customerId: string;
  partnerId?: string;
}

function identityFilter(identity: NegotiationIdentity) {
  if (!identity.customerId) {
    throw new HttpError(401, 'Customer account required', undefined, 'AUTHENTICATION_REQUIRED');
  }
  // A Partner only ever sees the sessions they themselves initiated for this
  // customer — never the customer's own self-serve negotiations.
  return identity.partnerId
    ? { customerId: identity.customerId, initiatingPartnerId: identity.partnerId }
    : { customerId: identity.customerId };
}

function identifier(identifier: string) {
  return /^[a-f\d]{24}$/i.test(identifier)
    ? { $or: [{ _id: identifier }, { publicId: identifier }] }
    : { publicId: identifier };
}

function requestHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function amountFromMessage(message?: string) {
  if (!message || ['quantity', 'cart', 'selection', 'alternatives', 'checkout'].includes(classifyNegotiationMessage(message).intent)) return undefined;
  return negotiationMoneyFromMessage(message);
}

function productCard(product?: any) {
  if (!product) return null;
  return {
    id: product.publicId,
    title: product.title || product.name,
    imageUrl: product.images?.[0] || null,
    effectivePriceMinor: product.effectivePriceMinor ?? Math.max(0, Number(product.sellingPriceMinor || 0) - Number(product.discountMinor || 0)),
    currency: product.currency || 'NGN',
  };
}

function present(session: any, response?: Record<string, unknown>, product?: any) {
  return {
    negotiationId: session.publicId,
    status: session.status,
    quantity: session.quantity,
    shoppingEnabled: true,
    offerCount: session.offerCount,
    maximumOffers: session.maximumOffers,
    remainingOffers: Math.max(0, session.maximumOffers - session.offerCount),
    transcript: (session.transcript || []).map((entry: Record<string, unknown>, index: number) => ({ ...entry, id: entry.id || `${session.publicId}:legacy:${index + 1}`, sequence: entry.sequence || index + 1 })),
    version: session.version,
    processing: Boolean(session.commandLock && new Date(session.commandLock.expiresAt) > new Date()),
    expiresAt: session.expiresAt,
    quoteId: session.quoteId,
    language: session.language || 'english',
    sessionMode: session.rulesSnapshot?.sessionMode || 'fixed',
    agreedPriceMinor: session.agreedPriceMinor,
    lastDecision: session.lastDecision,
    lastCounterPriceMinor: session.lastCounterPriceMinor,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.endReason ? { endReason: session.endReason } : {}),
    product: productCard(product),
    ...response,
  };
}

export class NegotiationService {
  private pricingInstance?: PricingEngine;
  private get pricing() {
    return (this.pricingInstance ??= new PricingEngine());
  }
  private readonly language = new AzureNegotiationService();
  private readonly email = new EmailService();

  private async notifyQuoteAgreed(session: { publicId?: string; productId: string; customerId: string }, agreedPriceMinor: number, expiresAt: Date | string) {
    const [product, customer] = await Promise.all([
      Product.findById(session.productId).select('title').lean(),
      User.findById(session.customerId).select('email firstName').lean(),
    ]);
    const productTitle = (product as any)?.title || 'your product';
    await createCommerceNotification({
      eventKey: `negotiation:${session.publicId}:agreed`,
      userId: session.customerId,
      title: 'Your price is locked in',
      body: `Your negotiated price for ${productTitle} is confirmed. Checkout before your quote expires.`,
      type: 'negotiation_agreed',
      data: { negotiationId: session.publicId, agreedPriceMinor },
    }).catch(() => undefined);
    if ((customer as any)?.email) {
      await this.email.sendNegotiationAccepted({
        to: (customer as any).email,
        name: (customer as any).firstName,
        productTitle,
        agreedPriceMinor,
        quoteExpiresAt: expiresAt,
      }).catch(() => undefined);
    }
  }

  /** Ends a live session whose product can no longer be negotiated, and tells the customer. */
  private endUnavailable(session: any, reason: 'PRODUCT_UNAVAILABLE' | 'NEGOTIATION_DISABLED') {
    return closeSessionForProduct(session, reason);
  }

  /** A quote as the customer should see it today: repriced when the list price dropped, cancelled when it can no longer stand. */
  private async presentQuote(quote: any) {
    let status = quote.status;
    let agreedPriceMinor = quote.agreedPriceMinor;
    let voidReason = quote.voidReason as string | undefined;
    if (quote.status === NegotiatedQuoteStatus.ACTIVE) {
      const resolution = await reconcileQuote(quote);
      if (!resolution.valid) {
        status = NegotiatedQuoteStatus.CANCELLED;
        voidReason = resolution.reason;
      } else {
        agreedPriceMinor = resolution.unitPriceMinor;
      }
    }
    return {
      id: quote.publicId,
      agreedPriceMinor,
      originalPriceMinor: quote.originalPriceMinor,
      expiresAt: quote.expiresAt,
      status,
      ...(voidReason ? { voidReason } : {}),
    };
  }

  /** The rules as they are now. A session cannot continue once the product is off sale or no longer negotiable. */
  private async liveFor(session: any): Promise<LiveRules> {
    const live = await loadLiveRules(session.productId, session.variantId);
    if (!live.onSale || !live.enabled) {
      await this.endUnavailable(session, live.onSale ? 'NEGOTIATION_DISABLED' : 'PRODUCT_UNAVAILABLE');
      throw new HttpError(409, 'This product is no longer available for negotiation', undefined, 'NEGOTIATION_PRODUCT_UNAVAILABLE');
    }
    return live;
  }

  async start(identity: NegotiationIdentity, input: { productId: string; variantId: string; quantity: number; message?: string }) {
    const settings = await CommerceSettings.findOne({ key: 'commerce' }).lean();
    // Pricing is deterministic and the model only words replies, so starting never waits on the AI provider.
    if (settings?.negotiationEnabled === false) throw negotiationUnavailable();
    const product = await Product.findOne({
      ...withOnSale(identifier(input.productId)),
      'negotiationRules.enabled': true,
      deletedAt: { $exists: false },
    }).lean({ virtuals: true });
    if (!product) throw new HttpError(404, 'Negotiable product not found', undefined, 'NOT_FOUND');
    await ensureLegacyProductOptions(product, input.variantId);
    const variant = await ProductVariant.findOne({
      ...identifier(input.variantId),
      productId: product._id.toString(),
      active: true,
      deletedAt: { $exists: false },
    }).lean({ virtuals: true });
    if (!variant) throw new HttpError(404, 'Product variant not found', undefined, 'NOT_FOUND');
    const active = await Negotiation.findOne({
      // Scoped so a Partner session does not collide with the customer's own.
      ...identityFilter(identity),
      productId: product._id.toString(),
      variantId: variant._id.toString(),
      quantity: input.quantity,
      status: NegotiationStatus.ACTIVE,
      $or: [{ expiresAt: { $gt: new Date() } }, { expiresAt: { $exists: false } }],
    }).lean({ virtuals: true });
    if (active) {
      throw new HttpError(409, 'You already have an active negotiation for this product option', present(active), 'ACTIVE_NEGOTIATION_EXISTS');
    }
    // A customer who already holds a valid locked price for this product uses it (at any quantity or option)
    // instead of negotiating again.
    const heldQuote = await NegotiatedQuote.findOne({
      customerId: identity.customerId,
      productId: product._id.toString(),
      status: NegotiatedQuoteStatus.ACTIVE,
      expiresAt: { $gt: new Date() },
    }).lean({ virtuals: true });
    if (heldQuote) {
      const shown = await this.presentQuote(heldQuote);
      if (shown.status === NegotiatedQuoteStatus.ACTIVE) {
        throw new HttpError(409, 'You already have a locked price for this product', { quote: shown }, 'ACTIVE_QUOTE_EXISTS');
      }
    }
    // Re-rolling for a better price is limited. Partner-assisted sessions are the Partner's counter work, not a retry.
    if (!identity.partnerId) {
      await assertMayStartNegotiation(identity.customerId, product._id.toString(), variant._id.toString(), {
        cooldownMinutes: settings?.negotiationCooldownMinutes,
        maxSessionsPerDay: settings?.negotiationMaxSessionsPerDay,
      });
    }
    const live = deriveLiveRules(product);
    if (!live.enabled) {
      throw new HttpError(409, 'Negotiation is not configured for this product', undefined, 'NEGOTIATION_DISABLED');
    }
    const inputs = pricingInputs(live);
    // The list price is already at the lowest price the business accepts, so there is nothing to negotiate.
    if (!inputs.needed) {
      throw new HttpError(409, 'This product is already at its best price', undefined, 'NEGOTIATION_NOT_NEEDED');
    }
    const maximumOffers = Math.min(10, Math.max(1, settings?.negotiationMaximumOffers || 3));
    const sessionMode = settings?.negotiationSessionMode || 'fixed';
    const sessionMinutes = settings?.negotiationSessionMinutes || 10;
    const quoteMinutes = settings?.negotiationQuoteMinutes || 30;
    const language = detectNegotiationLanguage(input.message);
    // A session that ran out of time but has not been swept yet must not block (or collide with) the new one.
    await Negotiation.updateMany(
      { ...identityFilter(identity), productId: product._id.toString(), variantId: variant._id.toString(), quantity: input.quantity, status: NegotiationStatus.ACTIVE, expiresAt: { $lte: new Date() } },
      { $set: { status: NegotiationStatus.EXPIRED } },
    );
    const publicId = await nextPublicId('negotiation');
    const session = await Negotiation.create({
      publicId,
      sourceStateId: product.sourceStateId,
      marketId: product.marketId,
      startNotificationPending: true,
      // Also supplies initiatingPartnerId for partner-assisted sessions.
      ...identityFilter(identity),
      channel: identity.partnerId ? 'partner_assisted' : 'shopper',
      productId: product._id.toString(),
      variantId: variant._id.toString(),
      quantity: input.quantity,
      currency: product.currency || 'NGN',
      status: NegotiationStatus.ACTIVE,
      offerCount: 0,
      maximumOffers,
      transcript: input.message ? [{ id: randomUUID(), sequence: 1, kind: 'text', role: 'customer', message: input.message, createdAt: new Date() }] : [],
      language,
      rulesSnapshot: {
        // Priced on what the customer would pay today (selling price minus discount).
        priceBasis: 'effective',
        sellingPriceMinor: inputs.sellingPriceMinor,
        minimumNegotiablePriceMinor: inputs.minimumNegotiablePriceMinor,
        maximumDiscountMinor: inputs.maximumDiscountMinor,
        maximumOffers,
        sessionMode,
        sessionMinutes,
        quoteMinutes,
        azureWordingEnabled: settings?.negotiationAzureWordingEnabled !== false,
      },
      ...(sessionMode === 'fixed' ? { expiresAt: new Date(Date.now() + sessionMinutes * 60 * 1000) } : {}),
      version: 1,
    }).catch((error) => {
      // The unique index on live sessions caught a concurrent start for the same item.
      if (isDuplicateKeyError(error)) throw new HttpError(409, 'You already have an active negotiation for this product option', undefined, 'ACTIVE_NEGOTIATION_EXISTS');
      throw error;
    });
    return present(session.toJSON());
  }

  async offer(
    identity: NegotiationIdentity,
    negotiationIdentifier: string,
    submittedPriceMinor: number | undefined,
    idempotencyKey: string,
    customerMessage?: string,
    resolvedIntent?: 'offer' | 'conversation',
    // What the model understood from the message. Deliberately kept out of the idempotency hash.
    understood?: { offerMinor?: number },
  ) {
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new HttpError(400, 'A valid Idempotency-Key header is required', undefined, 'VALIDATION_ERROR');
    }
    const session = await Negotiation.findOne({
      ...identifier(negotiationIdentifier),
      ...identityFilter(identity),
    }).lean({ virtuals: true });
    if (!session) throw new HttpError(404, 'Negotiation not found', undefined, 'NOT_FOUND');
    const hash = requestHash({ submittedPriceMinor, customerMessage });
    const prior = session.idempotencyResults?.find((entry) => entry.key === idempotencyKey);
    if (prior) {
      if (prior.requestHash !== hash && prior.requestHash !== requestHash({ offeredPriceMinor: submittedPriceMinor || amountFromMessage(customerMessage), customerMessage })) {
        throw new HttpError(409, 'This idempotency key was used with another offer', undefined, 'IDEMPOTENCY_CONFLICT');
      }
      return prior.response;
    }
    if (session.status !== NegotiationStatus.ACTIVE) {
      throw new HttpError(409, 'This negotiation is no longer active', undefined, 'INVALID_STATE_TRANSITION');
    }
    if (session.expiresAt && session.expiresAt <= new Date()) {
      await Negotiation.updateOne({ _id: session._id, status: NegotiationStatus.ACTIVE }, { $set: { status: NegotiationStatus.EXPIRED } });
      throw new HttpError(410, 'This negotiation has expired', undefined, 'NEGOTIATION_QUOTE_EXPIRED');
    }
    if (!session.rulesSnapshot) throw new HttpError(409, 'Negotiation pricing snapshot is unavailable', undefined, 'PRICING_BOUNDARY_VIOLATION');
    // Admin can change prices, rules or availability at any time: every offer is judged on today's rules.
    const live = await this.liveFor(session);
    const inputs = pricingInputs(live);
    const stored = session.rulesSnapshot;
    const priceChange = stored.priceBasis === 'effective' && inputs.sellingPriceMinor !== Number(stored.sellingPriceMinor)
      ? { fromMinor: Number(stored.sellingPriceMinor), toMinor: inputs.sellingPriceMinor }
      : undefined;
    const snapshot: NonNullable<typeof session.rulesSnapshot> = {
      ...stored,
      priceBasis: 'effective',
      sellingPriceMinor: inputs.sellingPriceMinor,
      minimumNegotiablePriceMinor: inputs.minimumNegotiablePriceMinor,
      maximumDiscountMinor: inputs.maximumDiscountMinor,
    };
    const liveSession = { ...session, rulesSnapshot: snapshot };
    const settings = await CommerceSettings.findOne({ key: 'commerce' }).select('negotiationEnabled negotiationAzureWordingEnabled').lean();
    if (settings?.negotiationEnabled === false) throw negotiationUnavailable();
    // A priced offer is decided by the pricing engine; only free-text messages need the AI provider to be available.
    if (!submittedPriceMinor) assertAzureConfigured(settings?.negotiationAzureWordingEnabled !== false && session.rulesSnapshot.azureWordingEnabled !== false);
    let intent: string | undefined = submittedPriceMinor ? 'offer' : resolvedIntent;
    let understoodOfferMinor = understood?.offerMinor;
    if (!intent) {
      const hint = await this.language.shoppingIntent(customerMessage || '', session.quantity);
      intent = hint.intent;
      if (hint.intent === 'offer') understoodOfferMinor = groundedOfferMinor(customerMessage || '', hint.offerNaira, hint.priceIsTotal, session.quantity);
    }
    const offeredPriceMinor = submittedPriceMinor || understoodOfferMinor || (intent === 'offer' ? amountFromMessage(customerMessage) : undefined);
    if (!offeredPriceMinor) {
      const chatTurns = (session.transcript || []).filter((entry) => entry.role === 'customer' && !entry.offeredPriceMinor).length;
      if (chatTurns >= MAX_CHAT_TURNS_PER_SESSION) {
        throw new HttpError(429, 'This conversation is getting long. Make an offer or start a new one.', undefined, 'NEGOTIATION_MESSAGE_LIMIT');
      }
      const product = await Product.findById(session.productId)
        .select('title description sellingPriceMinor discountMinor')
        .lean();
      const language = detectNegotiationLanguage(customerMessage);
      const guidance = await this.language.guide({
        quantity: session.quantity,
        customerMessage: customerMessage || '',
        language,
        productTitle: product?.title || 'this product',
        productDescription: product?.description,
        currentPriceMinor: Math.max(
          0,
          Number(product?.sellingPriceMinor || 0) - Number(product?.discountMinor || 0),
        ),
        conversation: (session.transcript || []).slice(-8).map((entry) => ({
          role: entry.role,
          message: entry.message,
        })),
        enabled: session.rulesSnapshot.azureWordingEnabled !== false,
        facts: await negotiationContext(session),
      });
      const response = {
        negotiationId: session.publicId,
        status: session.status,
        message: guidance.message,
        remainingOffers: Math.max(0, session.maximumOffers - session.offerCount),
        providerFallback: guidance.fallbackUsed,
      };
      const updated = await Negotiation.findOneAndUpdate(
        { _id: session._id, version: session.version, ...negotiationWriteFence(), 'idempotencyResults.key': { $ne: idempotencyKey } },
        {
          $set: { language },
          $inc: { version: 1 },
          $push: {
            transcript: {
              $each: [
                { id: randomUUID(), sequence: session.transcript.length + 1, kind: 'text', requestId: idempotencyKey, role: 'customer', message: customerMessage, createdAt: new Date() },
                { id: randomUUID(), sequence: session.transcript.length + 2, kind: 'text', role: 'hook', message: guidance.message, createdAt: new Date() },
              ],
            },
            providerTelemetry: guidance.telemetry,
            idempotencyResults: { key: idempotencyKey, requestHash: hash, response, createdAt: new Date() },
          },
        },
        { returnDocument: 'after' },
      ).lean({ virtuals: true });
      if (!updated) throw new HttpError(409, 'The negotiation changed before this message completed', undefined, 'IDEMPOTENCY_CONFLICT');
      return response;
    }
    if (session.offerCount >= session.maximumOffers) {
      throw new HttpError(409, 'You have used every offer in this negotiation', undefined, 'OFFER_LIMIT_REACHED');
    }
    const offerNumber = session.offerCount + 1;
    const previousCustomerOfferMinor = Math.max(
      0,
      ...(session.transcript || [])
        .filter((entry) => entry.role === 'customer')
        .map((entry) => Number(entry.offeredPriceMinor || 0)),
    );
    // Earlier counters and agreed prices are pulled back inside what is allowed today.
    const priorCounterPrice = clampToLive(Number(session.lastCounterPriceMinor || 0), live);
    const priorAgreedPrice = clampToLive(Number(session.agreedPriceMinor || 0), live);
    const decision: PricingDecision = inputs.needed
      ? this.pricing.decide({
        sellingPriceMinor: inputs.sellingPriceMinor,
        minimumNegotiablePriceMinor: inputs.minimumNegotiablePriceMinor,
        maximumDiscountMinor: inputs.maximumDiscountMinor,
        maximumOffers: Number(snapshot.maximumOffers),
        customerOfferMinor: offeredPriceMinor,
        offerNumber,
        currency: session.currency,
        previousCustomerOfferMinor,
        previousCounterPriceMinor: priorCounterPrice,
      })
      // The price dropped to (or below) the minimum mid-session: the list price is the best price on offer.
      : { decision: 'ACCEPT', acceptedPriceMinor: inputs.sellingPriceMinor, reasonCode: 'LIST_PRICE_AT_FLOOR', remainingOffers: 0 };
    const acceptedPrice = Number(decision.acceptedPriceMinor || 0);
    const bestAgreedPrice = acceptedPrice
      ? priorAgreedPrice
        ? Math.min(priorAgreedPrice, acceptedPrice)
        : acceptedPrice
      : priorAgreedPrice;
    const offersExhausted = decision.remainingOffers === 0;
    const availablePrices = [bestAgreedPrice, priorCounterPrice, Number(decision.counterPriceMinor || 0)]
      .filter((value) => value > 0);
    const bestAvailablePrice = availablePrices.length ? Math.min(...availablePrices) : 0;
    const shouldLockBestPrice = offersExhausted && bestAvailablePrice > 0;
    const responseStatus = shouldLockBestPrice
      ? NegotiationStatus.AGREED
      : decision.decision === 'DECLINE'
        ? NegotiationStatus.DECLINED
        : NegotiationStatus.ACTIVE;
    const language = detectNegotiationLanguage(customerMessage);
    const product = await Product.findById(session.productId).select('title description').lean();
    const wordingContext = {
      quantity: session.quantity,
      customerMessage,
      language,
      quoteMinutes: session.rulesSnapshot.quoteMinutes || 30,
      enabled: session.rulesSnapshot.azureWordingEnabled !== false,
      playfulLowOffer: offeredPriceMinor < inputs.sellingPriceMinor * 0.3,
      productTitle: product?.title,
      productDescription: product?.description,
      conversation: (session.transcript || []).slice(-8).map((entry) => ({ role: entry.role, message: entry.message })),
      remainingOffers: decision.remainingOffers,
      bestPriceMinor: shouldLockBestPrice ? bestAvailablePrice : bestAgreedPrice || decision.counterPriceMinor,
      finalized: responseStatus !== NegotiationStatus.ACTIVE,
      facts: await negotiationContext(liveSession),
    };
    let wording: Awaited<ReturnType<AzureNegotiationService['phrase']>>;
    try {
      wording = await this.language.phrase(decision, wordingContext);
    } catch (error) {
      // The decision and price are already settled. If the AI provider is down, say so with fixed wording instead of
      // failing the customer's offer.
      if (!(submittedPriceMinor && error instanceof HttpError && error.code === 'NEGOTIATION_UNAVAILABLE')) throw error;
      wording = {
        message: fallbackPhrase(decision, { language, quoteMinutes: wordingContext.quoteMinutes, remainingOffers: decision.remainingOffers, finalized: wordingContext.finalized, approvedPriceMinor: wordingContext.bestPriceMinor, quantity: session.quantity }),
        telemetry: { provider: 'fallback', failed: true, failureCode: 'PROVIDER_UNAVAILABLE' },
        fallbackUsed: true,
      };
    }
    const responseMessage = wording.message;
    const response: Record<string, unknown> = {
      negotiationId: session.publicId,
      decision: decision.decision,
      message: responseMessage,
      ...(decision.acceptedPriceMinor ? { acceptedPriceMinor: decision.acceptedPriceMinor } : {}),
      ...(decision.counterPriceMinor ? { counterPriceMinor: decision.counterPriceMinor } : {}),
      ...(shouldLockBestPrice
        ? { agreedPriceMinor: bestAvailablePrice }
        : bestAgreedPrice
          ? { agreedPriceMinor: bestAgreedPrice }
          : {}),
      remainingOffers: decision.remainingOffers,
      ...(priceChange ? { priceChanged: priceChange } : {}),
      status: responseStatus,
      canContinue: responseStatus === NegotiationStatus.ACTIVE && decision.remainingOffers > 0,
      providerFallback: wording.fallbackUsed,
    };

    let quote: any;
    const transaction = await mongoose.startSession();
    try {
      await transaction.withTransaction(async () => {
        if (shouldLockBestPrice) {
          quote = await this.createQuote(liveSession, identity.customerId, bestAvailablePrice, transaction, live);
          response.quoteId = quote.publicId;
          response.quoteExpiresAt = quote.expiresAt;
        }
        const updated = await Negotiation.findOneAndUpdate(
          { _id: session._id, version: session.version, ...negotiationWriteFence(), 'idempotencyResults.key': { $ne: idempotencyKey } },
          {
            $set: {
              status: response.status,
              language,
              'rulesSnapshot.priceBasis': 'effective',
              'rulesSnapshot.sellingPriceMinor': inputs.sellingPriceMinor,
              'rulesSnapshot.minimumNegotiablePriceMinor': inputs.minimumNegotiablePriceMinor,
              'rulesSnapshot.maximumDiscountMinor': inputs.maximumDiscountMinor,
              lastDecision: decision.decision,
              lastCounterPriceMinor: decision.counterPriceMinor,
              ...(shouldLockBestPrice
                ? { agreedPriceMinor: bestAvailablePrice }
                : bestAgreedPrice
                  ? { agreedPriceMinor: bestAgreedPrice }
                  : {}),
              ...(quote ? { quoteId: quote._id.toString() } : {}),
            },
            $inc: { offerCount: 1, version: 1 },
            $push: {
              transcript: {
                $each: [
                  ...(priceChange ? [{ id: randomUUID(), sequence: session.transcript.length + 1, kind: 'text', role: 'hook', message: `The price of this item changed to ₦${Math.round(priceChange.toMinor / 100).toLocaleString('en-NG')}. Your offer is judged on the new price.`, createdAt: new Date() }] : []),
                  { id: randomUUID(), sequence: session.transcript.length + (priceChange ? 2 : 1), kind: 'text', requestId: idempotencyKey, role: 'customer', message: customerMessage || 'Customer submitted an offer.', offeredPriceMinor, createdAt: new Date() },
                  { id: randomUUID(), sequence: session.transcript.length + (priceChange ? 3 : 2), kind: 'text', role: 'hook', message: responseMessage, decision: decision.decision, ...(decision.counterPriceMinor ? { counterPriceMinor: decision.counterPriceMinor } : {}), ...(decision.acceptedPriceMinor ? { acceptedPriceMinor: decision.acceptedPriceMinor } : {}), createdAt: new Date() },
                ],
              },
              providerTelemetry: wording.telemetry,
              idempotencyResults: { key: idempotencyKey, requestHash: hash, response, createdAt: new Date() },
            },
          },
          { returnDocument: 'after', session: transaction },
        ).lean({ virtuals: true });
        if (!updated) throw new HttpError(409, 'The negotiation changed before this offer completed', undefined, 'IDEMPOTENCY_CONFLICT');
      });
      if (shouldLockBestPrice && identity.customerId && quote) {
        // The offer is committed; a notification problem must never turn it into an error for the customer.
        await this.notifyQuoteAgreed({ publicId: session.publicId, productId: session.productId, customerId: identity.customerId }, bestAvailablePrice, quote.expiresAt).catch(() => undefined);
        // The locked price applies to this product's lines already in the cart straight away.
        await new CartService().applyLockedPrice(identity.customerId, quote).catch(() => undefined);
      }
      return response;
    } finally {
      await transaction.endSession();
    }
  }

  async accept(identity: NegotiationIdentity, negotiationIdentifier: string) {
    if (!identity.customerId) {
      throw new HttpError(403, 'Verify your customer account before saving an accepted quote', undefined, 'NEGOTIATION_OWNERSHIP_REQUIRED');
    }
    /**
     * Self-serve shoppers must have a verified, active account before a quote
     * is locked to them. Partner-assisted customers are created at the counter
     * and are intentionally unverified, so the Partner's own authenticated
     * session is the accountable party there.
     */
    const customer = await User.findOne({
      _id: identity.customerId,
      accountType: AccountType.CUSTOMER,
      ...(identity.partnerId ? {} : { isEmailVerified: true }),
      isActive: true,
    }).lean();
    if (!customer) throw new HttpError(403, 'A verified customer account is required', undefined, 'NEGOTIATION_OWNERSHIP_REQUIRED');
    const session = await Negotiation.findOne({
      ...identifier(negotiationIdentifier),
      customerId: identity.customerId,
      status: NegotiationStatus.ACTIVE,
      // A Partner may only accept quotes from sessions they initiated.
      ...(identity.partnerId ? { initiatingPartnerId: identity.partnerId } : {}),
    }).lean({ virtuals: true });
    if (!session) throw new HttpError(404, 'Active negotiation not found', undefined, 'NOT_FOUND');
    const prices = [session.agreedPriceMinor, session.lastCounterPriceMinor]
      .map((value) => Number(value || 0))
      .filter((value) => value > 0);
    if (!prices.length || !session.rulesSnapshot) {
      throw new HttpError(409, 'There is no agreed price to use yet', undefined, 'INVALID_STATE_TRANSITION');
    }
    // Lock the best price that is still allowed today, never one the product has since moved away from.
    const live = await this.liveFor(session);
    const bestPrice = clampToLive(Math.min(...prices), live);
    const quoteMinutes = Number(session.rulesSnapshot.quoteMinutes || 30);
    if (session.expiresAt && session.expiresAt <= new Date()) {
      await Negotiation.updateOne({ _id: session._id }, { $set: { status: NegotiationStatus.EXPIRED } });
      throw new HttpError(410, 'This negotiation has expired', undefined, 'NEGOTIATION_QUOTE_EXPIRED');
    }
    const transaction = await mongoose.startSession();
    try {
      let quote: any;
      await transaction.withTransaction(async () => {
        quote = await this.createQuote(session, identity.customerId, bestPrice, transaction, live);
        const updated = await Negotiation.updateOne(
          { _id: session._id, version: session.version, status: NegotiationStatus.ACTIVE },
          {
            $set: {
              status: NegotiationStatus.AGREED,
              agreedPriceMinor: bestPrice,
              quoteId: quote._id.toString(),
              lastDecision: 'ACCEPT',
            },
            $push: {
              transcript: {
                id: randomUUID(), sequence: session.transcript.length + 1, kind: 'receipt',
                role: 'hook',
                message: `Your best price of ₦${Math.round(bestPrice / 100).toLocaleString('en-NG')} is locked for ${quoteMinutes} minutes.`,
                decision: 'ACCEPT',
                createdAt: new Date(),
              },
            },
            $inc: { version: 1 },
          },
          { session: transaction },
        );
        if (!updated.modifiedCount) throw new HttpError(409, 'Negotiation state changed before acceptance', undefined, 'INVALID_STATE_TRANSITION');
      });
      await this.notifyQuoteAgreed({ publicId: session.publicId, productId: session.productId, customerId: identity.customerId }, bestPrice, quote.expiresAt).catch(() => undefined);
      await new CartService().applyLockedPrice(identity.customerId, quote).catch(() => undefined);
      publishRealtime({ type: 'negotiation.updated', entityId: session.publicId }, { accountId: identity.customerId });
      return {
        negotiationId: session.publicId,
        status: NegotiationStatus.AGREED,
        quoteId: quote.publicId,
        agreedPriceMinor: quote.agreedPriceMinor,
        expiresAt: quote.expiresAt,
      };
    } finally {
      await transaction.endSession();
    }
  }

  async close(identity: NegotiationIdentity, negotiationIdentifier: string) {
    const updated = await Negotiation.findOneAndUpdate(
      { ...identifier(negotiationIdentifier), ...identityFilter(identity), status: NegotiationStatus.ACTIVE },
      { $set: { status: NegotiationStatus.CLOSED }, $inc: { version: 1 } },
      { returnDocument: 'after' },
    ).lean({ virtuals: true });
    if (!updated) throw new HttpError(404, 'Active negotiation not found', undefined, 'NOT_FOUND');
    publishRealtime({ type: 'negotiation.updated', entityId: updated.publicId }, { accountId: identity.customerId });
    return present(updated);
  }

  async detail(identity: NegotiationIdentity, negotiationIdentifier: string) {
    const session = await Negotiation.findOne({
      ...identifier(negotiationIdentifier),
      ...identityFilter(identity),
    }).lean({ virtuals: true });
    if (!session) throw new HttpError(404, 'Negotiation not found', undefined, 'NOT_FOUND');
    if (session.status === NegotiationStatus.ACTIVE && session.expiresAt && session.expiresAt <= new Date()) {
      await Negotiation.updateOne({ _id: session._id }, { $set: { status: NegotiationStatus.EXPIRED } });
      session.status = NegotiationStatus.EXPIRED;
    }
    const [product, variant] = await Promise.all([
      Product.findById(session.productId).select('publicId title name images effectivePriceMinor sellingPriceMinor discountMinor currency').lean(),
      session.variantId ? ProductVariant.findById(session.variantId).select('publicId').lean() : null,
    ]);
    let quote;
    if (session.quoteId) quote = await NegotiatedQuote.findById(session.quoteId).select('publicId customerId negotiationId productId variantId agreedPriceMinor originalPriceMinor expiresAt status voidReason').lean();
    const peopleNegotiating = await Negotiation.distinct('customerId', { productId: session.productId, status: NegotiationStatus.ACTIVE, $or: [{ expiresAt: { $gt: new Date() } }, { expiresAt: { $exists: false } }] });
    return present(session, { peopleNegotiating: peopleNegotiating.length, variantId: variant?.publicId, ...(quote ? { quote: await this.presentQuote(quote) } : {}) }, product);
  }

  async list(identity: NegotiationIdentity) {
    const sessions = await Negotiation.find(identityFilter(identity)).sort({ createdAt: -1 }).limit(50).lean({ virtuals: true });
    const products = await Product.find({ _id: { $in: sessions.map((session) => session.productId) } }).select('publicId title name images effectivePriceMinor sellingPriceMinor currency').lean();
    const variants = await ProductVariant.find({ _id: { $in: sessions.map((session) => session.variantId).filter(Boolean) } }).select('publicId').lean();
    const productById = new Map(products.map((product) => [product._id.toString(), product]));
    const variantById = new Map(variants.map((variant) => [variant._id.toString(), variant.publicId]));
    return sessions.map((session) => present(session, { variantId: variantById.get(session.variantId || '') }, productById.get(session.productId)));
  }

  /**
   * Active negotiation count across every customer a Partner has assisted —
   * unlike list()/detail(), this is not scoped to one customer, so it powers
   * a header-level badge rather than a single conversation thread.
   */
  async countActiveForPartner(partnerId: string) {
    return Negotiation.countDocuments({
      initiatingPartnerId: partnerId,
      status: NegotiationStatus.ACTIVE,
      $or: [{ expiresAt: { $gt: new Date() } }, { expiresAt: { $exists: false } }],
    });
  }

  async active(identity: NegotiationIdentity, input: { productId: string; variantId: string; quantity: number }) {
    const product = await Product.findOne(identifier(input.productId)).select('_id publicId title name images effectivePriceMinor sellingPriceMinor currency').lean();
    if (!product) return null;
    const variant = await ProductVariant.findOne(identifier(input.variantId)).select('_id').lean();
    if (!variant) return null;
    const customer = identityFilter(identity);
    const acceptedSession = await Negotiation.findOne({
      ...customer,
      productId: product._id.toString(),
      variantId: variant._id.toString(),
      status: { $in: [NegotiationStatus.AGREED, NegotiationStatus.ACCEPTED] },
      quoteId: { $exists: true },
    }).sort({ updatedAt: -1 }).lean({ virtuals: true });
    if (acceptedSession?.quoteId) {
      const quote = await NegotiatedQuote.findOne({
        _id: acceptedSession.quoteId,
        customerId: identity.customerId,
        status: NegotiatedQuoteStatus.ACTIVE,
        expiresAt: { $gt: new Date() },
      }).select('publicId customerId negotiationId productId variantId agreedPriceMinor originalPriceMinor expiresAt status voidReason').lean();
      if (quote) {
        const shown = await this.presentQuote(quote);
        // A quote cancelled by a product change is reported once on the session, never offered as a usable price.
        if (shown.status === NegotiatedQuoteStatus.ACTIVE) {
          return present(acceptedSession, { variantId: variant.publicId, quote: shown }, product);
        }
      }
    }
    const session = await Negotiation.findOne({
      ...customer,
      productId: product._id.toString(),
      variantId: variant._id.toString(),
      quantity: input.quantity,
      status: NegotiationStatus.ACTIVE,
      $or: [{ expiresAt: { $gt: new Date() } }, { expiresAt: { $exists: false } }],
    }).lean({ virtuals: true });
    return session ? present(session, { variantId: variant.publicId }, product) : null;
  }

  private async createQuote(session: any, customerId: string, agreedPriceMinor: number, mongoSession: mongoose.ClientSession, live: LiveRules) {
    const existing = await NegotiatedQuote.findOne({ negotiationId: session._id.toString() }).session(mongoSession);
    if (existing) return existing;
    const publicId = await nextPublicId('quote');
    const records = await NegotiatedQuote.create([{
      publicId,
      negotiationId: session._id.toString(),
      customerId,
      productId: session.productId,
      variantId: session.variantId,
      quantity: session.quantity,
      currency: session.currency,
      originalPriceMinor: live.effectivePriceMinor,
      agreedPriceMinor,
      productVersion: live.catalogVersion,
      expiresAt: new Date(Date.now() + Number(session.rulesSnapshot.quoteMinutes || 30) * 60 * 1000),
      status: NegotiatedQuoteStatus.ACTIVE,
    }], { session: mongoSession });
    return records[0];
  }
}

export async function expireNegotiationsAndQuotes(now = new Date()) {
  const [sessions, quotes] = await Promise.all([
    Negotiation.updateMany(
      { status: NegotiationStatus.ACTIVE, expiresAt: { $lte: now } },
      { $set: { status: NegotiationStatus.EXPIRED } },
    ),
    NegotiatedQuote.updateMany(
      { status: NegotiatedQuoteStatus.ACTIVE, expiresAt: { $lte: now } },
      { $set: { status: NegotiatedQuoteStatus.EXPIRED } },
    ),
  ]);
  return { sessions: sessions.modifiedCount, quotes: quotes.modifiedCount };
}
