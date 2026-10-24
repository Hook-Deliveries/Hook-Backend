import { createHash, randomBytes } from "crypto";
import mongoose, { isValidObjectId } from "mongoose";
import { ProductVariant } from "@models/catalog/catalog.model";
import {
  CommerceChannel,
  CommerceOrderStatus,
  CommercePaymentMethod,
  CommercePaymentStatus,
  DEFAULT_DELIVERY_FEE_MINOR,
  DEFAULT_POD_LIMIT_MINOR,
  DeliveryMethod,
  NegotiatedQuoteStatus,
  OrderStatus,
  OrderType,
  PaymentMode,
  PaymentStatus,
  ProductAvailabilityStatus,
  ProductStatus,
} from "@lib/constants";
import { Cart } from "@models/cart/cart.model";
import { CartItem } from "@models/cart/cart-item.model";
import { NegotiatedQuote } from "@models/catalog/catalog.model";
import {
  CheckoutPreview,
  CommercePolicyVersion,
  CommerceSettings,
} from "@models/commerce/commerce.model";
import { OrderItem } from "@models/orders/order-item.model";
import { Order } from "@models/orders/order.model";
import { OrderFulfilmentGroup } from "@models/orders/order-fulfilment-group.model";
import { Payment } from "@models/payments/payment.model";
import { OperationState } from "@models/platform/geography.model";
import { HookPartner } from "@models/platform/operations-accounts.model";
import { Product } from "@models/products/product.model";
import { User } from "@models/users/user.model";
import { AddressService } from "@modules/identity";
import {
  calculateDeliveryPricing,
  resolveDeliveryState,
} from "@modules/orders/delivery-pricing.service";
import { nextPublicId } from "@modules/platform";
import { createCommerceNotification } from "@modules/notifications";
import { EmailService } from "@emails/email.service";
import { CouponService } from "@modules/orders/coupon.service";
import { CreditService } from "@modules/orders/credit.service";
import { LogisticsProviderService } from "@modules/fulfilment";
import { HttpError, isDuplicateKeyError } from "@utils/http";
import { emitOutbox } from "@modules/platform";
import { wakeOutbox } from "../../jobs/wake";
import { timelineEntry } from "@lib/order-timeline";
import { defaultProviderName } from "@modules/payments";

type PreviewInput = {
  addressId?: string;
  deliveryMethod: DeliveryMethod;
  paymentMethod: CommercePaymentMethod;
  policyVersions: Record<string, string>;
  logisticsProviderId?: string;
  couponCode?: string;
  useCredits?: boolean;
  deliveryNote?: string;
};

type CheckoutActor = {
  type: "customer" | "partner";
  actorId: string;
  customerId: string;
  partnerId?: string;
};

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function idFilter(value: string) {
  return isValidObjectId(value)
    ? { $or: [{ _id: value }, { publicId: value }] }
    : { publicId: value };
}

function recordId(record: { _id?: unknown; id?: string }) {
  return String(record._id || record.id);
}

function storedStateIdentifiers(state: { _id?: unknown; publicId?: string }, fallback?: string) {
  return [...new Set(
    [state._id, state.publicId, fallback]
      .filter((value) => value != null && String(value).length > 0)
      .map(String),
  )];
}

export class CheckoutService {
  private addresses = new AddressService();
  private email = new EmailService();
  private coupons = new CouponService();
  private credits = new CreditService();
  private logisticsProviders = new LogisticsProviderService();

  /** Single source of truth for checkout money — preview() and confirm() both call this so totals never drift; coupons discount the subtotal (or the delivery fee, if free-delivery), and credits apply last, capped, never below zero. */
  private async calculateMoney(input: {
    customerId: string;
    subtotalMinor: number;
    deliveryFeeMinor: number;
    paymentMethod: CommercePaymentMethod;
    couponCode?: string;
    useCredits?: boolean;
    /** VAT as a fraction (0.075 = 7.5%). Comes from settings, locked at preview. */
    vatRate?: number;
    /** Extra charge for Pay on Delivery, collected with the delivery fee up front. */
    podSurchargeMinor?: number;
  }) {
    const coupon = await this.coupons.tryValidate(input.couponCode, {
      userId: input.customerId,
      subtotalMinor: input.subtotalMinor,
      deliveryFeeMinor: input.deliveryFeeMinor,
    });

    const couponDiscountMinor = coupon?.discountMinor ?? 0;
    const deliveryDiscountMinor = coupon?.appliesToDelivery ? couponDiscountMinor : 0;
    const itemDiscountMinor = coupon?.appliesToDelivery ? 0 : couponDiscountMinor;

    const deliveryFeeMinor = Math.max(0, input.deliveryFeeMinor - deliveryDiscountMinor);
    const vatRate = input.vatRate ?? 0.075;
    const podSurchargeMinor = Math.max(0, Number(input.podSurchargeMinor || 0));
    const vatBasisMinor = Math.max(0, input.subtotalMinor - itemDiscountMinor);
    const vatMinor = Math.round(vatBasisMinor * vatRate);
    const taxSnapshot = {
      jurisdiction: "NG",
      name: "VAT",
      rate: vatRate,
      basis: "product_subtotal",
      version: `ng-vat-${Number((vatRate * 100).toFixed(2))}-v1`,
    };

    const payableBeforeCredits = Math.max(
      0,
      input.subtotalMinor - itemDiscountMinor + vatMinor + deliveryFeeMinor + podSurchargeMinor,
    );
    // Credits are a prepayment instrument, so they don't apply on Pay at Handover — there's nothing collected up front for them to reduce.
    const creditsEligible = input.paymentMethod === CommercePaymentMethod.PREPAID;
    const creditsAppliedMinor = input.useCredits && creditsEligible
      ? Math.min(
          await this.credits.spendableFor(input.customerId, input.subtotalMinor),
          payableBeforeCredits,
        )
      : 0;

    if (input.useCredits && !creditsEligible) {
      throw new HttpError(
        409,
        "Hook credit can only be used when you pay now",
        undefined,
        "CREDITS_REQUIRE_PREPAYMENT",
      );
    }

    return {
      coupon,
      couponDiscountMinor,
      itemDiscountMinor,
      creditsEligible,
      creditsAppliedMinor,
      vatRate,
      vatMinor,
      taxSnapshot,
      deliveryFeeMinor,
      podSurchargeMinor,
      totalMinor: Math.max(0, payableBeforeCredits - creditsAppliedMinor),
    };
  }

  async preview(
    actor: CheckoutActor,
    stateIdentifier: string,
    input: PreviewInput,
  ) {
    const combined = actor.type === "customer" && stateIdentifier === "all";
    const combinedCart = combined
      ? await Cart.findOne({ customerId: actor.customerId, ownerType: "customer", status: "active", isCheckedOut: false }).lean({ virtuals: true })
      : null;
    const firstCombinedItem = combinedCart
      ? await CartItem.findOne({ cartId: recordId(combinedCart) }).select("stateId").lean()
      : null;
    const resolvedStateIdentifier = combined
      ? String(firstCombinedItem?.stateId || "")
      : stateIdentifier;
    if (combined && !resolvedStateIdentifier) {
      throw new HttpError(409, "Cart is empty", undefined, "CART_EMPTY");
    }
    const customer = await User.findById(actor.customerId).lean({
      virtuals: true,
    });
    if (!customer || customer.accountType !== "customer" || !customer.isActive)
      throw new HttpError(404, "Customer not found");
    if (actor.type === "customer" && !customer.isEmailVerified)
      throw new HttpError(
        403,
        "Verify your email before checkout",
        undefined,
        "EMAIL_VERIFICATION_REQUIRED",
      );
    const state = await OperationState.findOne({
      ...idFilter(resolvedStateIdentifier),
      status: "active",
    }).lean({ virtuals: true });
    if (!state)
      throw new HttpError(
        409,
        "Selected State is not available",
        undefined,
        "CHECKOUT_STATE_UNAVAILABLE",
      );
    const stateId = recordId(state);
    const stateIdentifiers = storedStateIdentifiers(state, resolvedStateIdentifier);
    const partner = actor.partnerId
      ? await HookPartner.findOne({
          _id: actor.partnerId,
          status: "active",
        }).lean({ virtuals: true })
      : null;
    if (actor.type === "partner" && (!partner || partner.stateId !== stateId))
      throw new HttpError(
        403,
        "Partner cannot checkout this State group",
        undefined,
        "STATE_SCOPE_DENIED",
      );
    if (
      actor.type === "partner" &&
      input.paymentMethod !== CommercePaymentMethod.PREPAID
    )
      throw new HttpError(
        409,
        "Partner-assisted Orders require prepayment",
        undefined,
        "PAYMENT_METHOD_NOT_ALLOWED",
      );
    if (
      actor.type === "customer" &&
      input.deliveryMethod !== DeliveryMethod.HOME_DELIVERY
    )
      throw new HttpError(
        409,
        "Shopper App Orders support home delivery only",
        undefined,
        "DELIVERY_METHOD_NOT_ALLOWED",
      );
    if (
      actor.type === "partner" &&
      input.deliveryMethod === DeliveryMethod.PARTNER_PICKUP &&
      !partner
    )
      throw new HttpError(409, "Pickup Partner is unavailable");

    const cart = combinedCart || await Cart.findOne({
      ...(actor.type === "customer"
        ? { customerId: actor.customerId, ownerType: "customer" }
        : {
            partnerId: actor.partnerId,
            assistedCustomerId: actor.customerId,
            ownerType: "partner_assisted",
          }),
      status: "active",
      isCheckedOut: false,
    }).lean({ virtuals: true });
    if (!cart)
      throw new HttpError(409, "Basket is empty", undefined, "CART_EMPTY");
    const cartId = recordId(cart);
    const cartItems = await CartItem.find({
      cartId,
      ...(combined ? {} : { stateId: { $in: stateIdentifiers } }),
    }).lean({ virtuals: true });
    if (!cartItems.length)
      throw new HttpError(
        409,
        "This State basket is empty",
        undefined,
        "CART_EMPTY",
      );
    const lines = await this.revalidateLines(actor.customerId, cartItems);
    const groupedLines = [...lines.reduce((groups, line) => {
      const key = String(line.stateId);
      const group = groups.get(key) || { sourceStateId: key, lines: [], subtotalMinor: 0 };
      group.lines.push(line);
      group.subtotalMinor += Number(line.totalPriceMinor);
      groups.set(key, group);
      return groups;
    }, new Map<string, { sourceStateId: string; lines: typeof lines; subtotalMinor: number }>()).values()];

    let addressSnapshot: Record<string, unknown> | undefined;
    let deliveryState = state;
    if (input.deliveryMethod === DeliveryMethod.HOME_DELIVERY) {
      if (!input.addressId)
        throw new HttpError(400, "Delivery address is required");
      const address = await this.addresses.getOwned(
        actor.customerId,
        input.addressId,
      );
      const resolvedDeliveryState = await resolveDeliveryState(
        String(address.stateId),
      );
      if (
        !resolvedDeliveryState ||
        resolvedDeliveryState.deliveryEnabled === false
      )
        throw new HttpError(
          409,
          "Delivery is not available in this State",
          undefined,
          "ADDRESS_OUTSIDE_COVERAGE",
        );
      deliveryState = resolvedDeliveryState;
      addressSnapshot = {
        publicId: address.publicId,
        label: address.label,
        recipientName: address.recipientName,
        phone: address.phone,
        line1: address.line1,
        line2: address.line2,
        landmark: address.landmark,
        stateId: deliveryState.publicId,
        cityId: address.cityId,
        localGovernmentAreaId: address.localGovernmentAreaId,
        postalCode: address.postalCode,
        coordinates: address.coordinates,
        formattedAddress: address.formattedAddress,
        stateCode: address.stateCode,
        stateName: address.stateName,
        cityName: address.cityName,
        localGovernmentArea: address.localGovernmentArea,
      };
    }

    const settings = await this.getSettings();
    await this.validatePolicies(
      input.policyVersions,
      settings.activePolicyVersions,
    );
    const subtotalMinor = lines.reduce(
      (sum, line) => sum + Number(line.totalPriceMinor),
      0,
    );
    const minimumCheckoutMinor = Number(settings.minimumCheckoutMinor ?? 1_800_000);
    if (minimumCheckoutMinor > 0 && subtotalMinor < minimumCheckoutMinor) {
      throw new HttpError(
        409,
        `Add items worth at least ₦${(minimumCheckoutMinor / 100).toLocaleString("en-NG")} to check out. Smaller carts can be saved but not bought.`,
        { minimumCheckoutMinor, subtotalMinor },
        "MINIMUM_ORDER_NOT_MET",
      );
    }
    const logisticsProvider = input.logisticsProviderId
      ? await this.logisticsProviders.getSelectable(input.logisticsProviderId)
      : undefined;
    const deliveryPricing = input.deliveryMethod === DeliveryMethod.PARTNER_PICKUP
      ? { scope: "partner" as const, mode: "flat" as const, feeMinor: 0, ruleVersion: "partner-pickup-v1" }
      : await calculateDeliveryPricing({
            state: deliveryState,
            coordinates: addressSnapshot?.coordinates as { latitude: number; longitude: number } | undefined,
            defaultFeeMinor: settings.defaultDeliveryFeeMinor ?? DEFAULT_DELIVERY_FEE_MINOR,
          });
    const isPod = input.paymentMethod === CommercePaymentMethod.PAY_AT_HANDOVER;
    // VAT and the Pay on Delivery surcharge are admin settings, locked into the preview so confirm charges what was shown.
    const vatFraction = Number(settings.vatRatePercent ?? 7.5) / 100;
    const surchargeValue = Number(settings.podSurchargeValue || 0);
    const podSurchargeMinor = isPod
      ? settings.podSurchargeType === "percent" ? Math.round((subtotalMinor * surchargeValue) / 100) : Math.round(surchargeValue)
      : 0;
    const money = await this.calculateMoney({
      customerId: actor.customerId,
      subtotalMinor,
      deliveryFeeMinor: deliveryPricing.feeMinor,
      paymentMethod: input.paymentMethod,
      couponCode: input.couponCode,
      useCredits: input.useCredits,
      vatRate: vatFraction,
      podSurchargeMinor,
    });
    const { vatRate, vatMinor, taxSnapshot, deliveryFeeMinor, couponDiscountMinor, creditsAppliedMinor, totalMinor, coupon } = money;
    // What is paid online now on a Pay on Delivery order: the delivery fee plus the surcharge. The rest is paid at the door.
    const podFeeDueNowMinor = isPod ? deliveryFeeMinor + podSurchargeMinor : 0;
    const podLimitMinor = Number(
      deliveryState.podLimitMinor ??
        settings.defaultPodLimitMinor ??
        DEFAULT_POD_LIMIT_MINOR,
    );
    // A State can ask for a higher (or lower) minimum than the global one.
    const podMinimumMinor = Number((deliveryState as any).podMinimumOrderMinor ?? settings.podMinimumOrderMinor ?? 3_000_000);
    // The minimum is judged on the order's real value (goods after discount, VAT and delivery) — the POD surcharge and Hook credit are excluded so choosing either never changes eligibility.
    const orderValueMinor = Math.max(0, subtotalMinor - (coupon?.appliesToDelivery ? 0 : couponDiscountMinor) + vatMinor + deliveryFeeMinor);
    const podEnabled = Boolean(
      settings.podEnabled &&
      deliveryState.podEnabled &&
      customer.podEligible !== false &&
      orderValueMinor >= podMinimumMinor,
    );
    if (isPod && orderValueMinor < podMinimumMinor && settings.podEnabled && deliveryState.podEnabled && customer.podEligible !== false)
      throw new HttpError(
        409,
        `Pay on Delivery is for orders of ₦${(podMinimumMinor / 100).toLocaleString("en-NG")} or more, including delivery and VAT. Yours comes to ₦${(orderValueMinor / 100).toLocaleString("en-NG")}.`,
        { podMinimumOrderMinor: podMinimumMinor, orderValueMinor, subtotalMinor },
        "POD_NOT_ELIGIBLE",
      );
    if (isPod && !podEnabled)
      throw new HttpError(
        409,
        "Pay at Handover is not available for this Order",
        undefined,
        "POD_NOT_ELIGIBLE",
      );
    const highValue =
      input.paymentMethod === CommercePaymentMethod.PAY_AT_HANDOVER &&
      totalMinor > podLimitMinor;
    const rawToken = randomBytes(32).toString("base64url");
    const publicTokenId = randomBytes(10).toString("hex");
    const expiresAt = new Date(
      Date.now() + settings.previewTtlMinutes * 60_000,
    );
    const preview = await CheckoutPreview.create({
      tokenHash: hash(rawToken),
      publicTokenId,
      actorType: actor.type,
      actorId: actor.actorId,
      customerId: actor.customerId,
      partnerId: actor.partnerId,
      stateId,
      sourceStateIds: groupedLines.map((group) => group.sourceStateId),
      fulfilmentGroups: groupedLines.map((group) => ({ sourceStateId: group.sourceStateId, subtotalMinor: group.subtotalMinor })),
      cartId,
      cartVersion: cart.version || 1,
      channel:
        actor.type === "partner"
          ? CommerceChannel.PARTNER_ASSISTED
          : CommerceChannel.SHOPPER_APP,
      deliveryMethod: input.deliveryMethod,
      paymentMethod: input.paymentMethod,
      addressId: input.addressId,
      addressSnapshot,
      pickupPartnerSnapshot:
        input.deliveryMethod === DeliveryMethod.PARTNER_PICKUP && partner
          ? {
              publicId: partner.publicId,
              name: partner.name,
              address: partner.address,
              contact: partner.contact,
              stateId: state.publicId,
            }
          : undefined,
      lines,
      subtotalMinor,
      vatRate,
      vatMinor,
      taxSnapshot,
      deliveryFeeMinor,
      deliveryPricing,
      logisticsProviderId: logisticsProvider?.publicId,
      logisticsProviderSnapshot: logisticsProvider
        ? { publicId: logisticsProvider.publicId, code: logisticsProvider.code, name: logisticsProvider.name }
        : undefined,
      couponId: coupon?.couponId,
      couponCode: coupon?.code,
      deliveryNote: input.deliveryNote || undefined,
      couponDiscountMinor,
      creditsAppliedMinor,
      totalMinor,
      currency: "NGN",
      policyVersions: settings.activePolicyVersions,
      podDecision: {
        eligible: podEnabled,
        orderValueMinor,
        minimumOrderMinor: podMinimumMinor,
        limitMinor: podLimitMinor,
        highValue,
        requiresOverride: highValue,
        requiresConfirmationCall:
          input.paymentMethod === CommercePaymentMethod.PAY_AT_HANDOVER,
        feeDueNowMinor: podFeeDueNowMinor,
        surchargeMinor: podSurchargeMinor,
        // A paid fee auto-approves the order when the admin allows it, it isn't high value, and the customer is in good standing; anything else keeps the manual confirmation call.
        autoApprove: isPod && settings.podAutoApproveEnabled !== false && !highValue,
      },
      podSurchargeMinor,
      podFeeDueNowMinor,
      expiresAt,
    });
    return {
      previewToken: `${publicTokenId}.${rawToken}`,
      expiresAt,
      state: { id: state.publicId, name: state.name, code: state.code },
      channel: preview.channel,
      deliveryMethod: preview.deliveryMethod,
      paymentMethod: preview.paymentMethod,
      lines,
      fulfilmentGroups: groupedLines,
      sourceStateCount: groupedLines.length,
      subtotalMinor,
      vatRate,
      vatMinor,
      taxSnapshot,
      deliveryFeeMinor,
      deliveryPricing,
      logisticsProvider: logisticsProvider
        ? { id: logisticsProvider.publicId, code: logisticsProvider.code, name: logisticsProvider.name }
        : undefined,
      coupon: coupon ? { code: coupon.code, type: coupon.type, discountMinor: coupon.discountMinor } : undefined,
      couponDiscountMinor,
      creditsAppliedMinor,
      totalMinor,
      podFeeDueNowMinor,
      podSurchargeMinor,
      balanceDueOnDeliveryMinor: isPod ? Math.max(0, totalMinor - podFeeDueNowMinor) : 0,
      currency: "NGN",
      podDecision: preview.podDecision,
      policyVersions: preview.policyVersions,
    };
  }

  async confirm(
    actor: CheckoutActor,
    previewToken: string,
    idempotencyKey: string,
  ) {
    if (!idempotencyKey || idempotencyKey.length < 12)
      throw new HttpError(
        400,
        "A valid Idempotency-Key is required",
        undefined,
        "IDEMPOTENCY_CONFLICT",
      );
    const existing = await Order.findOne({ idempotencyKey }).lean({
      virtuals: true,
    });
    if (existing) {
      if (
        existing.userId !== actor.customerId ||
        existing.initiatingPartnerId !== actor.partnerId
      )
        throw new HttpError(
          409,
          "Idempotency key was used for another checkout",
          undefined,
          "IDEMPOTENCY_CONFLICT",
        );
      return this.orderResult(existing.id);
    }
    const [publicTokenId, rawToken] = previewToken.split(".");
    if (!publicTokenId || !rawToken)
      throw new HttpError(
        400,
        "Checkout preview token is invalid",
        undefined,
        "CHECKOUT_PREVIEW_INVALID",
      );
    const preview = await CheckoutPreview.findOne({ publicTokenId }).select(
      "+tokenHash",
    );
    if (
      !preview ||
      preview.tokenHash !== hash(rawToken) ||
      preview.expiresAt <= new Date()
    )
      throw new HttpError(
        409,
        "Checkout preview has expired",
        undefined,
        "CHECKOUT_PREVIEW_EXPIRED",
      );
    if (
      preview.consumedAt ||
      preview.actorId !== actor.actorId ||
      preview.customerId !== actor.customerId ||
      preview.partnerId !== actor.partnerId
    )
      throw new HttpError(
        409,
        "Checkout preview cannot be used",
        undefined,
        "CHECKOUT_PREVIEW_INVALID",
      );
    const cart = await Cart.findOne({
      _id: preview.cartId,
      status: "active",
      version: preview.cartVersion,
    });
    if (!cart)
      throw new HttpError(
        409,
        "Basket changed. Review checkout again.",
        undefined,
        "CART_VERSION_CHANGED",
      );
    const previewState = await OperationState.findOne({
      ...idFilter(preview.stateId),
      status: "active",
    })
      .select("_id publicId")
      .lean();
    const stateIdentifiers = storedStateIdentifiers(previewState || {}, preview.stateId);
    const combined = Array.isArray(preview.sourceStateIds) && preview.sourceStateIds.length > 1;
    const cartItems = await CartItem.find({
      cartId: cart.id,
      ...(combined ? {} : { stateId: { $in: stateIdentifiers } }),
    }).lean({ virtuals: true });
    const currentLines = await this.revalidateLines(
      actor.customerId,
      cartItems,
    );
    if (JSON.stringify(currentLines) !== JSON.stringify(preview.lines))
      throw new HttpError(
        409,
        "Product or quote details changed. Review checkout again.",
        undefined,
        "CHECKOUT_REVALIDATION_REQUIRED",
      );

    const currentSubtotalMinor = currentLines.reduce(
      (sum, line) => sum + Number(line.totalPriceMinor),
      0,
    );
    // calculateMoney() applies any free-delivery coupon itself, so this must be the pre-discount gross fee — preview.deliveryFeeMinor is already net of it.
    let currentGrossDeliveryFeeMinor = Number(
      (preview.deliveryPricing as any)?.feeMinor ?? preview.deliveryFeeMinor,
    );
    if (preview.logisticsProviderId) {
      // Re-resolve the courier in case an admin withdrew it since the quote; the delivery State sets the price, not the courier.
      await this.logisticsProviders.getSelectable(String(preview.logisticsProviderId));
    }
    if (preview.deliveryMethod === DeliveryMethod.HOME_DELIVERY) {
      const address = await this.addresses.getOwned(actor.customerId, String(preview.addressId || ""));
      const deliveryState = await resolveDeliveryState(String(address.stateId));
      if (!deliveryState || deliveryState.deliveryEnabled === false)
        throw new HttpError(409, "Delivery is no longer available in this State", undefined, "ADDRESS_OUTSIDE_COVERAGE");
      const settings = await this.getSettings();
      const pricing = await calculateDeliveryPricing({
        state: deliveryState,
        defaultFeeMinor: settings.defaultDeliveryFeeMinor ?? DEFAULT_DELIVERY_FEE_MINOR,
      });
      currentGrossDeliveryFeeMinor = pricing.feeMinor;
      if (pricing.ruleVersion !== (preview.deliveryPricing as any)?.ruleVersion)
        throw new HttpError(409, "Delivery pricing changed. Review checkout again.", undefined, "CHECKOUT_REVALIDATION_REQUIRED");
    }

    // The minimum can be raised while a preview is open; a token must not slip under the new floor.
    const minimumNow = Number((await this.getSettings()).minimumCheckoutMinor ?? 1_800_000);
    if (minimumNow > 0 && currentSubtotalMinor < minimumNow) {
      throw new HttpError(
        409,
        `Add items worth at least ₦${(minimumNow / 100).toLocaleString("en-NG")} to check out.`,
        { minimumCheckoutMinor: minimumNow, subtotalMinor: currentSubtotalMinor },
        "MINIMUM_ORDER_NOT_MET",
      );
    }

    // Re-run the same money math the quote used; this also re-validates the coupon so an expired/capped one throws instead of under-charging.
    const currentMoney = await this.calculateMoney({
      customerId: actor.customerId,
      subtotalMinor: currentSubtotalMinor,
      deliveryFeeMinor: currentGrossDeliveryFeeMinor,
      paymentMethod: preview.paymentMethod as CommercePaymentMethod,
      couponCode: preview.couponCode,
      useCredits: Number(preview.creditsAppliedMinor || 0) > 0,
      // Charge exactly what the preview showed, even if an admin changed VAT or the surcharge meanwhile.
      vatRate: Number((preview.taxSnapshot as any)?.rate ?? 0.075),
      podSurchargeMinor: Number(preview.podSurchargeMinor || 0),
    });

    if (
      currentSubtotalMinor !== Number(preview.subtotalMinor) ||
      currentMoney.vatMinor !== Number(preview.vatMinor) ||
      currentMoney.deliveryFeeMinor !== Number(preview.deliveryFeeMinor) ||
      currentMoney.couponDiscountMinor !== Number(preview.couponDiscountMinor || 0) ||
      currentMoney.creditsAppliedMinor !== Number(preview.creditsAppliedMinor || 0) ||
      currentMoney.totalMinor !== Number(preview.totalMinor)
    )
      throw new HttpError(409, "Order totals changed. Review checkout again.", undefined, "CHECKOUT_REVALIDATION_REQUIRED");

    const groupSnapshots = (preview.fulfilmentGroups || []).map((group: any) => ({
      sourceStateId: String(group.sourceStateId),
      subtotalMinor: Number(group.subtotalMinor || 0),
    }));
    const effectiveGroups = groupSnapshots.length ? groupSnapshots : [{ sourceStateId: preview.stateId, subtotalMinor: Number(preview.subtotalMinor) }];
    const groupIds = await Promise.all(effectiveGroups.map(() => nextPublicId("orderFulfilmentGroup")));
    const pod = preview.paymentMethod === CommercePaymentMethod.PAY_AT_HANDOVER;
    // Pay on Delivery: one balance payment per group (paid at the door) plus one online payment for the delivery fee and surcharge.
    const paymentIds = await Promise.all((pod ? [...effectiveGroups, null] : [null]).map(() => nextPublicId("payment")));
    const feePaymentPublicId = pod ? paymentIds[effectiveGroups.length] : undefined;
    let allocatedFee = 0;
    let allocatedVat = 0;
    let allocatedDiscount = 0;
    let allocatedCredits = 0;
    const previewSubtotal = Math.max(Number(preview.subtotalMinor), 1);
    // Money lines are split across per-state groups by subtotal share, remainder on the last group, so discounts/credits stay consistent with VAT/delivery and parts sum to the order total.
    const share = (total: number, groupSubtotal: number, allocated: number, isLast: boolean) =>
      isLast ? total - allocated : Math.floor((total * groupSubtotal) / previewSubtotal);
    const groupPlans = effectiveGroups.map((group, index) => {
      const isLast = index === effectiveGroups.length - 1;
      const feeShare = share(Number(preview.deliveryFeeMinor), group.subtotalMinor, allocatedFee, isLast);
      allocatedFee += feeShare;
      const vatShare = share(Number(preview.vatMinor || 0), group.subtotalMinor, allocatedVat, isLast);
      allocatedVat += vatShare;
      const discountShare = share(Number(preview.couponDiscountMinor || 0), group.subtotalMinor, allocatedDiscount, isLast);
      allocatedDiscount += discountShare;
      const creditShare = share(Number(preview.creditsAppliedMinor || 0), group.subtotalMinor, allocatedCredits, isLast);
      allocatedCredits += creditShare;
      return {
        ...group,
        publicId: groupIds[index],
        vatShareMinor: vatShare,
        deliveryFeeShareMinor: feeShare,
        couponDiscountShareMinor: discountShare,
        creditsAppliedShareMinor: creditShare,
        paymentPublicId: pod ? paymentIds[index] : undefined,
      };
    });
    const ids = {
      order: await nextPublicId("order"),
      payment: paymentIds[0],
      items: await Promise.all(
        currentLines.map(() => nextPublicId("orderItem")),
      ),
    };
    const providerName = await defaultProviderName();
    const referencePrefix = providerName === "monnify" ? "MNF" : "PSK";
    const session = await mongoose.startSession();
    let orderId = "";
    try {
      await session.withTransaction(async () => {
        const highValue = Boolean((preview.podDecision as any)?.highValue);
        // Pay on Delivery starts by waiting for the online delivery fee; review follows once it is paid.
        const commerceStatus = pod
          ? CommerceOrderStatus.AWAITING_DELIVERY_FEE
          : CommerceOrderStatus.AWAITING_PAYMENT;
        const order = new Order({
          publicId: ids.order,
          orderCode: ids.order,
          userId: actor.customerId,
          channel: preview.channel,
          sourceStateId: preview.stateId,
          sourceStateIds: groupPlans.map((group) => group.sourceStateId),
          fulfilmentGroupIds: groupPlans.map((group) => group.publicId),
          initiatingPartnerId: actor.partnerId,
          deliveryMethod: preview.deliveryMethod,
          commercePaymentMethod: preview.paymentMethod,
          commerceStatus,
          commercePaymentStatus: pod
            ? CommercePaymentStatus.DUE_AT_HANDOVER
            : CommercePaymentStatus.PENDING,
          subtotalMinor: preview.subtotalMinor,
          vatRate: preview.vatRate,
          vatMinor: preview.vatMinor,
          taxSnapshot: preview.taxSnapshot,
          deliveryFeeMinor: preview.deliveryFeeMinor,
          deliveryPricing: preview.deliveryPricing,
          logisticsProviderId: preview.logisticsProviderId,
          logisticsProviderSnapshot: preview.logisticsProviderSnapshot,
          couponId: preview.couponId,
          couponCode: preview.couponCode,
          couponDiscountMinor: Number(preview.couponDiscountMinor || 0),
          creditsAppliedMinor: Number(preview.creditsAppliedMinor || 0),
          totalMinor: preview.totalMinor,
          deliveryNotes: preview.deliveryNote || undefined,
          currency: preview.currency,
          subtotal: preview.subtotalMinor / 100,
          deliveryFee: preview.deliveryFeeMinor / 100,
          // Legacy major-unit mirror of everything taken off the order.
          discount:
            (Number(preview.couponDiscountMinor || 0) + Number(preview.creditsAppliedMinor || 0)) / 100,
          total: preview.totalMinor / 100,
          vendorCount: 0,
          status: OrderStatus.AWAITING_PAYMENT,
          podFeeDueNowMinor: pod ? Number(preview.podFeeDueNowMinor || 0) : 0,
          podFeePaid: false,
          paymentStatus: PaymentStatus.PENDING,
          paymentMode: pod ? PaymentMode.PAY_ON_DELIVERY : PaymentMode.PAY_NOW,
          orderType: OrderType.STANDARD,
          deliveryAddress: preview.addressSnapshot || {
            street: String(
              (preview.pickupPartnerSnapshot as any)?.address || "",
            ),
            city: "",
            state: "",
            phone: String(
              (preview.pickupPartnerSnapshot as any)?.contact?.phone || "",
            ),
          },
          addressSnapshot: preview.addressSnapshot,
          pickupPartnerSnapshot: preview.pickupPartnerSnapshot,
          customerSnapshot: await this.customerSnapshot(actor.customerId),
          policyVersions: preview.policyVersions,
          checkoutPreviewId: preview.id,
          idempotencyKey,
          podReview: preview.podDecision,
          partialFulfilment: false,
          deliverySubsidy: 0,
          timeline: [timelineEntry(commerceStatus, actor.actorId, { channel: preview.channel })],
        });
        await order.save({ session });
        orderId = order.id;
        const createdItems = await OrderItem.insertMany(
          currentLines.map((line, index) => ({
            publicId: ids.items[index],
            orderId: order.id,
            productId: line.productId,
            variantId: line.variantId,
            marketId: line.marketId,
            stateId: line.stateId,
            fulfilmentGroupId: groupPlans.find((group) => group.sourceStateId === String(line.stateId))?.publicId,
            quoteId: line.quoteId,
            productTitle: (line.productSnapshot as any).title,
            productImage: (line.productSnapshot as any).image,
            quantity: line.quantity,
            unitPriceMinor: line.unitPriceMinor,
            totalPriceMinor: line.totalPriceMinor,
            currency: line.currency,
            unitPrice: Number(line.unitPriceMinor) / 100,
            totalPrice: Number(line.totalPriceMinor) / 100,
            selectedVariants: line.variantSnapshot,
            productSnapshot: line.productSnapshot,
            variantSnapshot: line.variantSnapshot,
            quoteSnapshot: line.quoteSnapshot,
            commissionAmount: 0,
          })),
          { session },
        );
        await OrderFulfilmentGroup.insertMany(
          groupPlans.map((group) => ({
            publicId: group.publicId,
            orderId: order.id,
            sourceStateId: group.sourceStateId,
            orderItemIds: createdItems.filter((item) => item.fulfilmentGroupId === group.publicId).map((item) => item.publicId || item.id),
            subtotalMinor: group.subtotalMinor,
            vatShareMinor: group.vatShareMinor,
            deliveryFeeShareMinor: group.deliveryFeeShareMinor,
            couponDiscountShareMinor: group.couponDiscountShareMinor,
            creditsAppliedShareMinor: group.creditsAppliedShareMinor,
            status: "PENDING",
          })),
          { session },
        );
        await Payment.create(
          (pod ? groupPlans : [{
            publicId: undefined,
            subtotalMinor: Number(preview.subtotalMinor),
            vatShareMinor: Number(preview.vatMinor || 0),
            deliveryFeeShareMinor: Number(preview.deliveryFeeMinor),
            couponDiscountShareMinor: Number(preview.couponDiscountMinor || 0),
            creditsAppliedShareMinor: Number(preview.creditsAppliedMinor || 0),
            paymentPublicId: ids.payment,
          }]).map((group) => {
            // Charge the discounted figure: item-level coupon and credits come off what the gateway collects; a free-delivery coupon is already netted into the delivery fee, so subtracting it again would double-discount.
            const itemDiscountShareMinor = currentMoney.coupon?.appliesToDelivery ? 0 : group.couponDiscountShareMinor;
            // On Pay on Delivery, the fee and surcharge were paid online, so what's left at the door covers only the goods and VAT.
            const payableMinor = Math.max(
              0,
              group.subtotalMinor
                + group.vatShareMinor
                + (pod ? 0 : group.deliveryFeeShareMinor)
                - itemDiscountShareMinor
                - group.creditsAppliedShareMinor,
            );
            return {
              publicId: group.paymentPublicId,
              orderId: order.id,
              fulfilmentGroupId: group.publicId,
              resourceType: "order",
              transactionRef: `${referencePrefix}-${group.paymentPublicId}`,
              gateway: providerName,
              paymentMethod: pod ? "pos" : "card",
              amount: payableMinor / 100,
              amountMinor: payableMinor,
              currency: preview.currency,
              gatewayFee: 0,
              amountSettled: 0,
              status: PaymentStatus.PENDING,
              commerceStatus: pod
                ? CommercePaymentStatus.DUE_AT_HANDOVER
                : CommercePaymentStatus.PENDING,
              refundedAmount: 0,
            };
          }).concat(pod ? [{
            publicId: feePaymentPublicId,
            orderId: order.id,
            fulfilmentGroupId: undefined as any,
            resourceType: "order",
            transactionRef: `${referencePrefix}-${feePaymentPublicId}`,
            gateway: providerName,
            paymentMethod: "card",
            amount: Number(preview.podFeeDueNowMinor || 0) / 100,
            amountMinor: Number(preview.podFeeDueNowMinor || 0),
            currency: preview.currency,
            gatewayFee: 0,
            amountSettled: 0,
            status: PaymentStatus.PENDING,
            commerceStatus: CommercePaymentStatus.PENDING,
            refundedAmount: 0,
          }] : []) as any,
          { session },
        );
        if (pod) {
          const payments = await Payment.find({ orderId: order.id }).session(session).select("_id publicId fulfilmentGroupId").lean();
          for (const payment of payments) {
            // The delivery-fee payment belongs to the order, not to a fulfilment group.
            if (!payment.fulfilmentGroupId) continue;
            await OrderFulfilmentGroup.updateOne(
              { publicId: payment.fulfilmentGroupId },
              { $set: { paymentId: payment.publicId || String(payment._id) } },
              { session },
            );
          }
        }
        for (const line of currentLines)
          if (line.quoteId) {
            const quoteUpdate = await NegotiatedQuote.updateOne(
              {
                _id: line.quoteId,
                status: NegotiatedQuoteStatus.ACTIVE,
                expiresAt: { $gt: new Date() },
              },
              {
                $set: {
                  status: NegotiatedQuoteStatus.USED,
                  usedByOrderId: order.id,
                  usedAt: new Date(),
                },
              },
              { session },
            );
            if (!quoteUpdate.modifiedCount)
              throw new HttpError(
                409,
                "Negotiated quote is no longer available",
                undefined,
                "NEGOTIATION_QUOTE_EXPIRED",
              );
          }
        // Remove exactly the lines that became order items; anything added after the preview stays in the cart.
        await CartItem.deleteMany(
          { cartId: cart.id, _id: { $in: currentLines.map((line) => line.cartItemId) } },
          { session },
        );
        const cartUpdate = await Cart.updateOne(
          { _id: cart.id, version: preview.cartVersion },
          { $inc: { version: 1 } },
          { session },
        );
        if (!cartUpdate.matchedCount)
          throw new HttpError(409, "Your cart changed while ordering. Review it and try again.", undefined, "CART_VERSION_CHANGED");
        const previewUpdate = await CheckoutPreview.updateOne(
          { _id: preview.id, consumedAt: null },
          { $set: { consumedAt: new Date(), orderId: order.id } },
          { session },
        );
        if (!previewUpdate.modifiedCount)
          throw new HttpError(409, "Checkout preview has already been used", undefined, "CHECKOUT_PREVIEW_INVALID");
        // Coupon redemption and credit debit commit with the order (previously ran after commit with errors swallowed); both are keyed on idempotencyKey so a retried confirm is a no-op.
        if (preview.couponId && Number(preview.couponDiscountMinor || 0) > 0) {
          await this.coupons.redeem({
            couponId: String(preview.couponId),
            couponCode: String(preview.couponCode),
            userId: actor.customerId,
            orderId,
            discountMinor: Number(preview.couponDiscountMinor),
            idempotencyKey,
          }, session);
        }
        if (Number(preview.creditsAppliedMinor || 0) > 0) {
          await this.credits.spend({
            userId: actor.customerId,
            amountMinor: Number(preview.creditsAppliedMinor),
            orderId,
            idempotencyKey,
          }, session);
        }
        await emitOutbox([{
          aggregateType: "order",
          aggregateId: order.id,
          eventType: "ORDER_CREATED_EFFECTS",
          payload: {
            orderId: ids.order,
            customerId: actor.customerId,
            paymentMethod: preview.paymentMethod,
            stateId: preview.stateId,
          },
        }], session);
      });
    } catch (error) {
      // A concurrent confirm with the same key lost the unique-index race (or hit a write conflict); return the winner's order instead of erroring.
      if (isDuplicateKeyError(error) || (error as any)?.hasErrorLabel?.("TransientTransactionError")) {
        const winner = await Order.findOne({ idempotencyKey }).lean({ virtuals: true });
        if (winner && winner.userId === actor.customerId) return this.orderResult(winner.id);
        // Same preview confirmed twice with different keys: one order already exists for it.
        if (isDuplicateKeyError(error)) throw new HttpError(409, "This checkout was already completed", undefined, "CHECKOUT_PREVIEW_INVALID");
      }
      throw error;
    } finally {
      await session.endSession();
    }

    wakeOutbox();
    const result = await this.orderResult(orderId);
    return result;
  }

  /** Outbox consumer for ORDER_CREATED_EFFECTS, run after the checkout transaction commits; keyed on the order so a replay can't double-notify and failures retry. */
  async deliverOrderCreatedEffects(event: { payload: Record<string, any> }) {
    const { orderId, customerId, paymentMethod, stateId } = event.payload;
    if (!customerId) return;
    const prepaid = paymentMethod === CommercePaymentMethod.PREPAID;
    await createCommerceNotification({
      eventKey: `order:${orderId}:created`,
      userId: customerId,
      title: prepaid ? "Complete your payment" : "Order under review",
      body: prepaid
        ? "Your State Order is ready for secure Paystack payment."
        : "Hook Operations will review your Pay-at-Handover request.",
      type: "order_created",
      data: { orderId, stateId },
    });
    const order = await Order.findOne({ publicId: orderId }).lean({ virtuals: true }) as any;
    const customer = await User.findById(customerId).select("email firstName").lean() as any;
    if (order && customer?.email) {
      const itemCount = await OrderItem.countDocuments({ orderId: String(order._id) });
      await this.email.sendOrderConfirmation({
        to: customer.email,
        name: customer.firstName,
        orderCode: orderId,
        amount: Number(order.totalMinor || 0) / 100,
        itemCount,
      });
    }
  }

  private async revalidateLines(customerId: string, items: any[]) {
    const products = await Product.find({
      _id: { $in: items.map((item) => item.productId) },
      status: ProductStatus.PUBLISHED,
      availabilityStatus: { $in: [ProductAvailabilityStatus.AVAILABLE, ProductAvailabilityStatus.LIMITED] },
    }).lean({ virtuals: true });
    const map = new Map(
      products.map((product) => [recordId(product), product]),
    );
    // A chosen option that was switched off or removed since it went into the cart can no longer be bought.
    const variantIds = [...new Set(items.map((item) => item.variantId).filter((id): id is string => Boolean(id) && isValidObjectId(id)))];
    const liveVariants = variantIds.length
      ? new Set((await ProductVariant.find({ _id: { $in: variantIds }, active: true, deletedAt: { $exists: false } } as never).select("_id").lean()).map((variant: any) => String(variant._id)))
      : new Set<string>();
    const lines: any[] = [];
    for (const item of items) {
      if (item.variantId && !liveVariants.has(String(item.variantId)))
        throw new HttpError(409, "A basket option is no longer available", undefined, "CHECKOUT_REVALIDATION_REQUIRED");
      const product = map.get(item.productId);
      if (
        !product ||
        product.catalogVersion !== item.productVersion ||
        !product.marketId ||
        !product.sourceStateId
      )
        throw new HttpError(
          409,
          "A basket product changed or is unavailable",
          undefined,
          "CHECKOUT_REVALIDATION_REQUIRED",
        );
      let quote: any;
      if (item.quoteId) {
        const productId = recordId(product);
        quote = await NegotiatedQuote.findOne({
          _id: item.quoteId,
          customerId,
          productId,
          ...(item.variantId ? { variantId: item.variantId } : {}),
          // The agreed price was for this exact quantity.
          quantity: item.quantity,
          status: NegotiatedQuoteStatus.ACTIVE,
          expiresAt: { $gt: new Date() },
        }).lean({ virtuals: true });
        if (!quote)
          throw new HttpError(
            409,
            "A negotiated quote expired or no longer matches the quantity",
            undefined,
            "NEGOTIATION_QUOTE_EXPIRED",
          );
      }
      const unitPriceMinor = Number(
        quote?.agreedPriceMinor ??
          Number(product.sellingPriceMinor) -
            Number(product.discountMinor || 0),
      );
      lines.push({
        cartItemId: recordId(item),
        productId: recordId(product),
        productPublicId: product.publicId,
        variantId: item.variantId,
        marketId: product.marketId,
        stateId: product.sourceStateId,
        quoteId: quote ? recordId(quote) : undefined,
        quantity: item.quantity,
        unitPriceMinor,
        totalPriceMinor: unitPriceMinor * item.quantity,
        currency: product.currency || "NGN",
        productVersion: product.catalogVersion,
        quoteVersion: quote?.version,
        productSnapshot: {
          publicId: product.publicId,
          title: product.title,
          slug: product.slug,
          image: product.images?.[0],
          catalogVersion: product.catalogVersion,
        },
        variantSnapshot: item.selectedVariants || {},
        quoteSnapshot: quote
          ? {
              publicId: quote.publicId,
              agreedPriceMinor: quote.agreedPriceMinor,
              expiresAt: quote.expiresAt,
              version: quote.version,
            }
          : undefined,
      });
    }
    return lines;
  }

  // Read on every preview and confirm; a few seconds of caching avoids a database write per request.
  private static settingsCache: { value: any; until: number } | null = null;

  static clearSettingsCache() {
    CheckoutService.settingsCache = null;
  }

  private async getSettings(): Promise<any> {
    const cached = CheckoutService.settingsCache;
    if (cached && cached.until > Date.now()) return cached.value;
    const existing = await CommerceSettings.findOne({ key: "commerce" }).lean({ virtuals: true });
    if (existing) {
      CheckoutService.settingsCache = { value: existing, until: Date.now() + 5_000 };
      return existing;
    }
    return CommerceSettings.findOneAndUpdate(
      { key: "commerce" },
      {
        $setOnInsert: {
          key: "commerce",
          currency: "NGN",
          defaultDeliveryFeeMinor: DEFAULT_DELIVERY_FEE_MINOR,
          podEnabled: false,
          defaultPodLimitMinor: DEFAULT_POD_LIMIT_MINOR,
          previewTtlMinutes: 10,
          activePolicyVersions: {},
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    ).lean({ virtuals: true }) as Promise<any>;
  }

  private async validatePolicies(
    provided: Record<string, string>,
    configured: Record<string, string>,
  ) {
    const active = Object.keys(configured).length
      ? configured
      : Object.fromEntries(
          (
            await CommercePolicyVersion.find({
              status: "active",
              effectiveAt: { $lte: new Date() },
            })
              .sort({ effectiveAt: -1 })
              .lean()
          ).map((policy) => [policy.type, policy.version]),
        );
    for (const key of ["TERMS", "PRIVACY", "RETURNS"])
      if (!active[key] || provided[key] !== active[key])
        throw new HttpError(
          409,
          "Current policies must be accepted before checkout",
          { required: active },
          "POLICY_ACCEPTANCE_REQUIRED",
        );
  }

  private async customerSnapshot(customerId: string) {
    const user = await User.findById(customerId).lean();
    return {
      publicId: user?.publicId,
      email: user?.email,
      phone: user?.phone,
      name: `${user?.firstName || ""} ${user?.lastName || ""}`.trim(),
      emailVerified: user?.isEmailVerified,
    };
  }

  private async orderResult(id: string) {
    const [order, items, payments, fulfilmentGroups] = await Promise.all([
      Order.findById(id).lean({ virtuals: true }),
      OrderItem.find({ orderId: id }).lean({ virtuals: true }),
      Payment.find({ orderId: id }).lean({ virtuals: true }),
      OrderFulfilmentGroup.find({ orderId: id }).sort({ createdAt: 1 }).lean({ virtuals: true }),
    ]);
    return {
      ...order,
      id: order?.publicId,
      items: items.map((item) => ({ ...item, id: item.publicId })),
      payment: payments[0] ? { ...payments[0], id: payments[0].publicId } : undefined,
      payments: payments.map((payment) => ({ ...payment, id: payment.publicId })),
      fulfilmentGroups: fulfilmentGroups.map((group) => ({ ...group, id: group.publicId })),
    };
  }
}
