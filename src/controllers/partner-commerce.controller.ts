import { Request, Response } from "express";
import {
  AccountStatus,
  AccountType,
  ScopeType,
  UserRole,
} from "@lib/constants";
import { CartService } from "@modules/orders/cart.service";
import { publicCart } from "@lib/public-resource";
import { CheckoutService } from "@modules/orders/checkout.service";
import { PaymentService } from "@modules/payments/payment.service";
import { nextPublicId } from "@modules/platform/public-id.service";
import { HookPartner } from "@models/platform/operations-accounts.model";
import { User } from "@models/users/user.model";
import { Order } from "@models/orders/order.model";
import { CommerceSettings } from "@models/commerce/commerce.model";
import { recordAudit } from "@modules/platform/platform-audit.service";
import { issueCustomerAccountSetup } from "@modules/identity/account-invitation.service";
import { HttpError, sendCreated, sendSuccess } from "@utils/http";
import { routeParam } from "@lib/api-utils";
import { createCommerceNotification } from "@modules/notifications/commerce-notification.service";
import { notifyStaffByPermission } from "@modules/notifications/staff-notifications.service";

export class PartnerCommerceController {
  private cart = new CartService();
  private checkout = new CheckoutService();
  private payments = new PaymentService();

  private async partner(accountId: string) {
    const partner = await HookPartner.findOne({
      accountId,
      status: "active",
    }).lean({ virtuals: true });
    if (!partner)
      throw new HttpError(
        403,
        "Hook Partner is not active",
        undefined,
        "ACCESS_DENIED",
      );
    return partner;
  }

  lookupCustomer = async (req: Request, res: Response) => {
    await this.partner(req.user!.sub);
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();
    if (!email) throw new HttpError(400, "Exact customer email is required");
    const customer = await User.findOne({
      email,
      accountType: AccountType.CUSTOMER,
    }).lean({ virtuals: true });
    sendSuccess(
      res,
      customer
        ? {
            found: true,
            customer: {
              id: customer.publicId,
              firstName: customer.firstName,
              lastName: customer.lastName,
              email: customer.email,
              phone: customer.phone,
              emailVerified: customer.isEmailVerified,
            },
          }
        : { found: false },
    );
  };

  createCustomer = async (req: Request, res: Response) => {
    const partner = await this.partner(req.user!.sub);
    const settings = await CommerceSettings.findOne({ key: "commerce" }).lean();
    const activePolicies = settings?.activePolicyVersions || {};
    for (const policy of ["TERMS", "PRIVACY", "RETURNS"]) {
      if (!activePolicies[policy] || req.body.policyVersions[policy] !== activePolicies[policy])
        throw new HttpError(409, "Current Hook policies must be presented and accepted", { required: activePolicies }, "POLICY_ACCEPTANCE_REQUIRED");
    }
    const email = req.body.email.toLowerCase().trim();
    if (await User.exists({ email }))
      throw new HttpError(
        409,
        "A customer with this email already exists",
        undefined,
        "CONFLICT",
      );
    const customer = await User.create({
      publicId: await nextPublicId("customer"),
      email,
      phone: req.body.phone,
      firstName: req.body.firstName,
      lastName: req.body.lastName,
      role: UserRole.SHOPPER,
      accountType: AccountType.CUSTOMER,
      accountStatus: AccountStatus.PENDING_PASSWORD,
      scopeType: ScopeType.SELF,
      isEmailVerified: false,
      isPhoneVerified: false,
      isActive: true,
      preferences: {
        partnerAttestation: {
          partnerId: partner.id,
          partnerPublicId: partner.publicId,
          consent: req.body.consent,
          policyVersions: req.body.policyVersions,
          attestedAt: new Date(),
          actorId: req.user!.sub,
        },
      },
    });
    await recordAudit(req, {
      action: "partner.customer.attest",
      entityType: "customer",
      entityId: customer.id,
      entityPublicId: customer.publicId,
      stateId: partner.stateId,
      after: {
        partnerId: partner.publicId,
        policyVersions: req.body.policyVersions,
        consent: true,
      },
    });
    await issueCustomerAccountSetup({
      accountId: customer.id,
      email: customer.email,
      name: customer.firstName || "there",
      partnerName: partner.name,
    });
    sendCreated(res, {
      id: customer.publicId,
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email,
      phone: customer.phone,
      emailVerified: false,
      directLoginEnabled: false,
    });
  };

  getCart = async (req: Request, res: Response) => {
    const partner = await this.partner(req.user!.sub);
    const customer = await this.resolveCustomer(
      routeParam(req.params.customerId),
    );
    sendSuccess(
      res,
      publicCart(
        await this.cart.getCart({
          partnerId: partner.id,
          assistedCustomerId: customer.id,
        }),
      ),
    );
  };
  addCart = async (req: Request, res: Response) => {
    const partner = await this.partner(req.user!.sub);
    const customer = await this.resolveCustomer(
      routeParam(req.params.customerId),
    );
    void this.noticeCustomer(partner, customer);
    sendCreated(
      res,
      publicCart(await this.cart.addItem(
        { partnerId: partner.id, assistedCustomerId: customer.id },
        req.body.productId,
        req.body.quantity,
        req.body.selectedVariants,
        req.body.variantId,
        req.body.quoteId,
      )),
      "Item added to cart successfully",
    );
  };
  updateCart = async (req: Request, res: Response) => {
    const partner = await this.partner(req.user!.sub);
    const customer = await this.resolveCustomer(
      routeParam(req.params.customerId),
    );
    sendSuccess(
      res,
      publicCart(await this.cart.updateItem(
        { partnerId: partner.id, assistedCustomerId: customer.id },
        routeParam(req.params.itemId),
        req.body.quantity,
      )),
      "Cart updated successfully",
    );
  };
  removeCart = async (req: Request, res: Response) => {
    const partner = await this.partner(req.user!.sub);
    const customer = await this.resolveCustomer(
      routeParam(req.params.customerId),
    );
    sendSuccess(
      res,
      publicCart(await this.cart.removeItem(
        { partnerId: partner.id, assistedCustomerId: customer.id },
        routeParam(req.params.itemId),
      )),
      "Item removed from cart successfully",
    );
  };
  preview = async (req: Request, res: Response) => {
    const partner = await this.partner(req.user!.sub);
    const customer = await this.resolveCustomer(
      routeParam(req.params.customerId),
    );
    sendCreated(
      res,
      await this.checkout.preview(
        {
          type: "partner",
          actorId: req.user!.sub,
          customerId: customer.id,
          partnerId: partner.id,
        },
        routeParam(req.params.stateId),
        req.body,
      ),
    );
  };
  confirm = async (req: Request, res: Response) => {
    const partner = await this.partner(req.user!.sub);
    const customer = await this.resolveCustomer(
      routeParam(req.params.customerId),
    );
    const result = await this.checkout.confirm(
      {
        type: "partner",
        actorId: req.user!.sub,
        customerId: customer.id,
        partnerId: partner.id,
      },
      req.body.previewToken,
      String(req.header("idempotency-key") || ""),
    );
    sendCreated(res, result);
    await notifyStaffByPermission({
      permission: "orders.edit",
      stateId: (result as { sourceStateId?: string }).sourceStateId,
      eventKeyPrefix: `partner-order:${result.publicId}:created`,
      title: "Partner created an order",
      body: `${partner.name || "A Hook Partner"} started an order for a customer`,
      type: "order_updated",
      data: { orderId: result.publicId, href: `/dashboard/orders/${result.publicId}` },
    });
  };
  orders = async (req: Request, res: Response) => {
    const partner = await this.partner(req.user!.sub);
    const rows = await Order.find({ initiatingPartnerId: partner.id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean({ virtuals: true });
    // A partner sees what they need to run the sale, not the order's internal fields.
    const customers = await User.find({ _id: { $in: [...new Set(rows.map((row: any) => String(row.userId || row.customerId || "")).filter((id) => /^[a-f\d]{24}$/i.test(id)))] } })
      .select("firstName lastName")
      .lean();
    const nameOf = new Map(customers.map((customer: any) => [String(customer._id), `${customer.firstName || ""} ${customer.lastName || ""}`.trim()]));
    sendSuccess(
      res,
      rows.map((row: any) => ({
        id: row.publicId || String(row._id),
        publicId: row.publicId,
        orderNumber: row.orderNumber || row.publicId,
        commerceStatus: row.commerceStatus,
        commercePaymentStatus: row.commercePaymentStatus,
        orderCode: row.orderCode,
        status: row.status,
        paymentStatus: row.paymentStatus,
        paymentMethod: row.paymentMethod,
        currency: row.currency,
        subtotalMinor: row.subtotalMinor,
        deliveryFeeMinor: row.deliveryFeeMinor,
        taxMinor: row.taxMinor,
        totalMinor: row.totalMinor ?? row.grandTotalMinor,
        awaitingDeliveryFee: row.commerceStatus === "AWAITING_DELIVERY_FEE",
        podFeeDueNowMinor: row.podFeeDueNowMinor,
        podFeePaid: row.podFeePaid,
        customerName: nameOf.get(String(row.userId || row.customerId || "")) || undefined,
        createdAt: row.createdAt,
      })),
    );
  };
  commerceConfig = async (req: Request, res: Response) => {
    await this.partner(req.user!.sub);
    const settings = await CommerceSettings.findOne({ key: "commerce" }).lean();
    sendSuccess(res, {
      currency: settings?.currency || "NGN",
      policyVersions: settings?.activePolicyVersions || {},
    });
  };
  paymentInstructions = async (req: Request, res: Response) => {
    const partner = await this.partner(req.user!.sub);
    sendCreated(
      res,
      await this.payments.initializeForPartner(
        partner.id,
        routeParam(req.params.orderId),
      ),
    );
  };

  /**
   * Tells the customer, once a day per partner, that a Hook Partner is preparing an order for them.
   * A partner acts on a customer's account, so the customer must never be surprised by it.
   */
  private async noticeCustomer(partner: { id: string; name?: string }, customer: { id: string; firstName?: string }) {
    const day = new Date().toISOString().slice(0, 10);
    await createCommerceNotification({
      eventKey: `partner-assist:${partner.id}:${customer.id}:${day}`,
      userId: customer.id,
      title: "A Hook Partner is helping with your order",
      body: `${partner.name || "A Hook Partner"} is putting an order together for you. If you did not ask for this, contact Hook support.`,
      type: "partner_assist",
    }).catch(() => undefined);
  }

  private async resolveCustomer(identifier: string) {
    const customer = await User.findOne({
      $or: [
        { publicId: identifier },
        ...(identifier.match(/^[a-f\d]{24}$/i) ? [{ _id: identifier }] : []),
      ],
      accountType: AccountType.CUSTOMER,
    }).lean({ virtuals: true });
    if (!customer) throw new HttpError(404, "Customer not found");
    return customer;
  }
}
