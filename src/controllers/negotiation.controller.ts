import { Request, Response } from 'express';
import { NegotiationService } from '@modules/negotiation/negotiation.service';
import { routeParam } from '@lib/api-utils';
import { sendCreated, sendSuccess } from '@utils/http';
import { recordAudit } from '@modules/platform/platform-audit.service';
import { NegotiationCommandService } from '@modules/negotiation/negotiation-command.service';
import { lockedPricesFor } from '@modules/negotiation/negotiation-locked-prices.service';
import { NegotiationOfferFlowService } from '@modules/negotiation/negotiation-offer-flow.service';

function identity(req: Request) {
  return { customerId: req.user!.sub };
}

export class NegotiationController {
  private readonly negotiations = new NegotiationService();
  private readonly offerFlow = new NegotiationOfferFlowService();

  /** Every price the customer has locked and can still use, for showing on any screen. */
  lockedPrices = async (req: Request, res: Response) => {
    sendSuccess(res, { prices: await lockedPricesFor(req.user!.sub) });
  };

  /** Everything the guided offer screen needs: prices, suggestions, Hook's counter, the locked price and history. */
  flow = async (req: Request, res: Response) => {
    sendSuccess(res, await this.offerFlow.flow(identity(req), routeParam(req.params.id)));
  };

  /** Offer as a total for the whole quantity. */
  offerTotal = async (req: Request, res: Response) => {
    const outcome = await this.offerFlow.submitTotal(identity(req), routeParam(req.params.id), req.body.totalPriceMinor, req.header('idempotency-key') || '');
    await recordAudit(req, {
      action: outcome.result.providerFallback ? 'negotiation.azure_fallback' : 'negotiation.offer_processed',
      entityType: 'negotiation',
      entityPublicId: routeParam(req.params.id),
      after: { decision: outcome.result.decision, status: outcome.flow.status, quoteId: outcome.flow.locked?.quoteId, providerFallback: outcome.result.providerFallback },
    });
    sendSuccess(res, outcome);
  };

  create = async (req: Request, res: Response) => {
    const created = await this.negotiations.start(identity(req), req.body);
    await recordAudit(req, {
      action: 'negotiation.started',
      entityType: 'negotiation',
      entityPublicId: created.negotiationId,
      after: { status: created.status, productId: req.body.productId, variantId: req.body.variantId, quantity: req.body.quantity },
    });
    sendCreated(res, created);
  };

  offer = async (req: Request, res: Response) => {
    const result = await new NegotiationCommandService().run(identity(req), routeParam(req.params.id), req.header('idempotency-key') || '', { offeredPriceMinor: req.body.offeredPriceMinor, message: req.body.message });
    const auditResult = result as Record<string, unknown>;
    await recordAudit(req, {
      action: auditResult.providerFallback ? 'negotiation.azure_fallback' : 'negotiation.offer_processed',
      entityType: 'negotiation',
      entityPublicId: routeParam(req.params.id),
      after: {
        decision: auditResult.decision,
        status: auditResult.status,
        quoteId: auditResult.quoteId,
        providerFallback: auditResult.providerFallback,
      },
    });
    sendSuccess(res, result);
  };

  detail = async (req: Request, res: Response) => {
    sendSuccess(res, await this.negotiations.detail(identity(req), routeParam(req.params.id)));
  };

  list = async (req: Request, res: Response) => {
    sendSuccess(res, await this.negotiations.list(identity(req)));
  };

  active = async (req: Request, res: Response) => {
    sendSuccess(res, await this.negotiations.active(identity(req), {
      productId: String(req.query.productId || ''),
      variantId: String(req.query.variantId || ''),
      quantity: Math.max(1, Number(req.query.quantity) || 1),
    }));
  };

  accept = async (req: Request, res: Response) => {
    const result = await this.negotiations.accept(identity(req), routeParam(req.params.id));
    await recordAudit(req, {
      action: 'negotiation.quote_created',
      entityType: 'negotiation',
      entityPublicId: routeParam(req.params.id),
      after: { status: result.status, quoteId: result.quoteId, expiresAt: result.expiresAt },
    });
    sendSuccess(res, result);
  };

  close = async (req: Request, res: Response) => {
    sendSuccess(res, await this.negotiations.close(identity(req), routeParam(req.params.id)));
  };
}
