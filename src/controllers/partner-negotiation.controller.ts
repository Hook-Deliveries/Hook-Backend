import { Request, Response } from 'express';
import { AccountType } from '@lib/constants';
import { routeParam } from '@lib/api-utils';
import { HookPartner } from '@models/platform/operations-accounts.model';
import { User } from '@models/users/user.model';
import { NegotiationService, type NegotiationIdentity } from '@services/negotiation.service';
import { recordAudit } from '@modules/platform/platform-audit.service';
import { HttpError, sendCreated, sendSuccess } from '@utils/http';
import { NegotiationCommandService } from '@services/negotiation-command.service';

function customerFilter(identifier: string) {
  return /^[a-f\d]{24}$/i.test(identifier)
    ? { $or: [{ _id: identifier }, { publicId: identifier }] }
    : { publicId: identifier };
}

/**
 * Negotiation on behalf of a walk-in customer. Sessions are owned by the
 * customer but stamped with the initiating Partner, so a Partner can only ever
 * see and act on the sessions they started.
 */
export class PartnerNegotiationController {
  private readonly negotiations = new NegotiationService();

  /** Resolve the authenticated, active Hook Partner behind this request. */
  private async partner(req: Request) {
    const partner = await HookPartner.findOne({
      accountId: req.user!.sub,
      status: 'active',
    }).lean({ virtuals: true });
    if (!partner) {
      throw new HttpError(403, 'Active Hook Partner required', undefined, 'ACCESS_DENIED');
    }
    return partner as { id: string };
  }

  /** Resolve the authenticated Partner and the customer they are assisting. */
  private async identity(req: Request): Promise<NegotiationIdentity> {
    const partner = await this.partner(req);
    const customer = await User.findOne({
      ...customerFilter(routeParam(req.params.customerId)),
      accountType: AccountType.CUSTOMER,
    })
      .select('_id')
      .lean();
    if (!customer) throw new HttpError(404, 'Customer not found', undefined, 'NOT_FOUND');
    return { customerId: customer._id.toString(), partnerId: partner.id };
  }

  /** Active negotiation count across every customer, for a header badge. */
  activeCount = async (req: Request, res: Response) => {
    const partner = await this.partner(req);
    sendSuccess(res, { count: await this.negotiations.countActiveForPartner(partner.id) });
  };

  create = async (req: Request, res: Response) => {
    const created = await this.negotiations.start(await this.identity(req), req.body);
    await recordAudit(req, {
      action: 'negotiation.started',
      entityType: 'negotiation',
      entityPublicId: created.negotiationId,
      after: {
        status: created.status,
        channel: 'partner_assisted',
        customerId: routeParam(req.params.customerId),
        productId: req.body.productId,
        variantId: req.body.variantId,
        quantity: req.body.quantity,
      },
    });
    sendCreated(res, created);
  };

  offer = async (req: Request, res: Response) => {
    const result = await new NegotiationCommandService().run(await this.identity(req), routeParam(req.params.id), req.header('idempotency-key') || '', { offeredPriceMinor: req.body.offeredPriceMinor, message: req.body.message });
    const auditResult = result as Record<string, unknown>;
    await recordAudit(req, {
      action: auditResult.providerFallback ? 'negotiation.azure_fallback' : 'negotiation.offer_processed',
      entityType: 'negotiation',
      entityPublicId: routeParam(req.params.id),
      after: {
        decision: auditResult.decision,
        status: auditResult.status,
        quoteId: auditResult.quoteId,
        channel: 'partner_assisted',
      },
    });
    sendSuccess(res, result);
  };

  detail = async (req: Request, res: Response) => {
    sendSuccess(res, await this.negotiations.detail(await this.identity(req), routeParam(req.params.id)));
  };

  list = async (req: Request, res: Response) => {
    sendSuccess(res, await this.negotiations.list(await this.identity(req)));
  };

  active = async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await this.negotiations.active(await this.identity(req), {
        productId: String(req.query.productId || ''),
        variantId: String(req.query.variantId || ''),
        quantity: Math.max(1, Number(req.query.quantity) || 1),
      }),
    );
  };

  accept = async (req: Request, res: Response) => {
    const result = await this.negotiations.accept(await this.identity(req), routeParam(req.params.id));
    await recordAudit(req, {
      action: 'negotiation.quote_created',
      entityType: 'negotiation',
      entityPublicId: routeParam(req.params.id),
      after: {
        status: result.status,
        quoteId: result.quoteId,
        expiresAt: result.expiresAt,
        channel: 'partner_assisted',
      },
    });
    sendSuccess(res, result);
  };

  close = async (req: Request, res: Response) => {
    sendSuccess(res, await this.negotiations.close(await this.identity(req), routeParam(req.params.id)));
  };
}
