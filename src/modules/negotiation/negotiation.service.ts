import { createHash, randomUUID } from 'crypto';
import mongoose from 'mongoose';
import { AccountType, NegotiatedQuoteStatus, NegotiationStatus, ProductAvailabilityStatus, ProductStatus } from '@lib/constants';
import { NegotiatedQuote, ProductVariant } from '@models/catalog/catalog.model';
import { CommerceSettings } from '@models/commerce/commerce.model';
import { Negotiation } from '@models/negotiations/negotiation.model';
import { Product } from '@models/products/product.model';
import { User } from '@models/users/user.model';
import { nextPublicId } from '@modules/platform';
import { AzureNegotiationService, detectNegotiationLanguage, assertAzureConfigured } from '@modules/negotiation/azure-negotiation.service';
import { negotiationContext } from '@modules/negotiation/negotiation-context.service';
import { negotiationWriteFence } from '@lib/negotiation-execution';
import { PricingEngine } from '@modules/catalog';
import { createCommerceNotification } from '@modules/notifications';
import { EmailService } from '@emails/email.service';
import { HttpError } from '@utils/http';
import { classifyNegotiationMessage, negotiationMoneyFromMessage } from '@lib/negotiation-intent';
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

  async start(identity: NegotiationIdentity, input: { productId: string; variantId: string; quantity: number; message?: string }) {
    const settings = await CommerceSettings.findOne({ key: 'commerce' }).lean();
    assertAzureConfigured(settings?.negotiationEnabled !== false && settings?.negotiationAzureWordingEnabled !== false);
    const product = await Product.findOne({
      ...identifier(input.productId),
      status: ProductStatus.PUBLISHED,
      availabilityStatus: { $in: [ProductAvailabilityStatus.AVAILABLE, ProductAvailabilityStatus.LIMITED] },
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
    const rules = product.negotiationRules;
    if (
      !rules?.minimumNegotiablePriceMinor
      || rules.maximumDiscountMinor === undefined
      || !product.sellingPriceMinor
    ) {
      throw new HttpError(409, 'Negotiation is not configured for this product', undefined, 'NEGOTIATION_DISABLED');
    }
    const maximumOffers = Math.min(10, Math.max(1, settings?.negotiationMaximumOffers || 3));
    const sessionMode = settings?.negotiationSessionMode || 'fixed';
    const sessionMinutes = settings?.negotiationSessionMinutes || 10;
    const quoteMinutes = settings?.negotiationQuoteMinutes || 30;
    const language = detectNegotiationLanguage(input.message);
    await this.language.ready();
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
        sellingPriceMinor: product.sellingPriceMinor,
        minimumNegotiablePriceMinor: rules.minimumNegotiablePriceMinor,
        maximumDiscountMinor: rules.maximumDiscountMinor,
        maximumOffers,
        sessionMode,
        sessionMinutes,
        quoteMinutes,
        azureWordingEnabled: settings?.negotiationAzureWordingEnabled !== false,
      },
      ...(sessionMode === 'fixed' ? { expiresAt: new Date(Date.now() + sessionMinutes * 60 * 1000) } : {}),
      version: 1,
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
    const settings = await CommerceSettings.findOne({ key: 'commerce' }).select('negotiationEnabled negotiationAzureWordingEnabled').lean();
    assertAzureConfigured(settings?.negotiationEnabled !== false && settings?.negotiationAzureWordingEnabled !== false && session.rulesSnapshot.azureWordingEnabled !== false);
    const intent = submittedPriceMinor ? 'offer' : resolvedIntent || (await this.language.shoppingIntent(customerMessage || '')).intent;
    const offeredPriceMinor = submittedPriceMinor || (intent === 'offer' ? amountFromMessage(customerMessage) : undefined);
    if (!offeredPriceMinor) {
      const product = await Product.findById(session.productId)
        .select('title description sellingPriceMinor discountMinor')
        .lean();
      const language = detectNegotiationLanguage(customerMessage);
      const guidance = await this.language.guide({
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
    const decision = this.pricing.decide({
      ...session.rulesSnapshot,
      customerOfferMinor: offeredPriceMinor,
      offerNumber,
      currency: session.currency,
      previousCustomerOfferMinor,
      previousCounterPriceMinor: Number(session.lastCounterPriceMinor || 0),
    });
    const priorAgreedPrice = Number(session.agreedPriceMinor || 0);
    const acceptedPrice = Number(decision.acceptedPriceMinor || 0);
    const bestAgreedPrice = acceptedPrice
      ? priorAgreedPrice
        ? Math.min(priorAgreedPrice, acceptedPrice)
        : acceptedPrice
      : priorAgreedPrice;
    const offersExhausted = decision.remainingOffers === 0;
    const priorCounterPrice = Number(session.lastCounterPriceMinor || 0);
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
    const wording = await this.language.phrase(decision, {
      customerMessage,
      language,
      quoteMinutes: session.rulesSnapshot.quoteMinutes || 30,
      enabled: session.rulesSnapshot.azureWordingEnabled !== false,
      playfulLowOffer: offeredPriceMinor < Number(session.rulesSnapshot.sellingPriceMinor || 0) * 0.3,
      productTitle: product?.title,
      productDescription: product?.description,
      conversation: (session.transcript || []).slice(-8).map((entry) => ({ role: entry.role, message: entry.message })),
      remainingOffers: decision.remainingOffers,
      bestPriceMinor: shouldLockBestPrice ? bestAvailablePrice : bestAgreedPrice || decision.counterPriceMinor,
      finalized: responseStatus !== NegotiationStatus.ACTIVE,
      facts: await negotiationContext(session),
    });
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
      status: responseStatus,
      canContinue: responseStatus === NegotiationStatus.ACTIVE && decision.remainingOffers > 0,
      providerFallback: wording.fallbackUsed,
    };

    let quote: any;
    const transaction = await mongoose.startSession();
    try {
      await transaction.withTransaction(async () => {
        if (shouldLockBestPrice) {
          quote = await this.createQuote(session, identity.customerId, bestAvailablePrice, transaction);
          response.quoteId = quote.publicId;
          response.quoteExpiresAt = quote.expiresAt;
        }
        const updated = await Negotiation.findOneAndUpdate(
          { _id: session._id, version: session.version, ...negotiationWriteFence(), 'idempotencyResults.key': { $ne: idempotencyKey } },
          {
            $set: {
              status: response.status,
              language,
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
                  { id: randomUUID(), sequence: session.transcript.length + 1, kind: 'text', requestId: idempotencyKey, role: 'customer', message: customerMessage || 'Customer submitted an offer.', offeredPriceMinor, createdAt: new Date() },
                  { id: randomUUID(), sequence: session.transcript.length + 2, kind: 'text', role: 'hook', message: responseMessage, decision: decision.decision, createdAt: new Date() },
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
        await this.notifyQuoteAgreed({ publicId: session.publicId, productId: session.productId, customerId: identity.customerId }, bestAvailablePrice, quote.expiresAt);
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
    const bestPrice = prices.length ? Math.min(...prices) : 0;
    if (!bestPrice || !session.rulesSnapshot) {
      throw new HttpError(409, 'There is no agreed price to use yet', undefined, 'INVALID_STATE_TRANSITION');
    }
    const quoteMinutes = Number(session.rulesSnapshot.quoteMinutes || 30);
    if (session.expiresAt && session.expiresAt <= new Date()) {
      await Negotiation.updateOne({ _id: session._id }, { $set: { status: NegotiationStatus.EXPIRED } });
      throw new HttpError(410, 'This negotiation has expired', undefined, 'NEGOTIATION_QUOTE_EXPIRED');
    }
    const transaction = await mongoose.startSession();
    try {
      let quote: any;
      await transaction.withTransaction(async () => {
        quote = await this.createQuote(session, identity.customerId, bestPrice, transaction);
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
      await this.notifyQuoteAgreed({ publicId: session.publicId, productId: session.productId, customerId: identity.customerId }, bestPrice, quote.expiresAt);
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
    if (session.quoteId) quote = await NegotiatedQuote.findById(session.quoteId).select('publicId agreedPriceMinor originalPriceMinor expiresAt status').lean();
    const peopleNegotiating = await Negotiation.distinct('customerId', { productId: session.productId, status: NegotiationStatus.ACTIVE, $or: [{ expiresAt: { $gt: new Date() } }, { expiresAt: { $exists: false } }] });
    return present(session, { peopleNegotiating: peopleNegotiating.length, variantId: variant?.publicId, ...(quote ? { quote: { id: quote.publicId, agreedPriceMinor: quote.agreedPriceMinor, originalPriceMinor: quote.originalPriceMinor, expiresAt: quote.expiresAt, status: quote.status } } : {}) }, product);
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
      }).select('publicId agreedPriceMinor originalPriceMinor expiresAt status').lean();
      if (quote) {
        return present(acceptedSession, {
          variantId: variant.publicId,
          quote: {
            id: quote.publicId,
            agreedPriceMinor: quote.agreedPriceMinor,
            originalPriceMinor: quote.originalPriceMinor,
            expiresAt: quote.expiresAt,
            status: quote.status,
          },
        }, product);
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

  private async createQuote(session: any, customerId: string, agreedPriceMinor: number, mongoSession: mongoose.ClientSession) {
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
      originalPriceMinor: session.rulesSnapshot.sellingPriceMinor,
      agreedPriceMinor,
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
