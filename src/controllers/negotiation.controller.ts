import { Request, Response } from 'express';
import { NegotiationService } from '@services/negotiation.service';
import { routeParam } from '@lib/api-utils';
import { HttpError, sendCreated, sendSuccess } from '@utils/http';
import { recordAudit } from '@modules/platform/platform-audit.service';
import { NegotiationShoppingService } from '@services/negotiation-shopping.service';
import { NegotiationCommandService } from '@services/negotiation-command.service';

function identity(req: Request) {
  return { customerId: req.user!.sub };
}

export class NegotiationController {
  private readonly negotiations = new NegotiationService();
  private readonly shopping = new NegotiationShoppingService();

  message = async (req: Request, res: Response) => {
    const result = await new NegotiationCommandService().run(identity(req), routeParam(req.params.id), req.header('idempotency-key') || '', { message: req.body.message });
    const audit = result as Record<string, unknown>;
    const entry = audit.entry as { kind?: string; actionId?: string; productIds?: string[] } | undefined;
    await recordAudit(req, {
      action: audit.providerFallback ? 'negotiation.azure_fallback' : entry?.kind === 'suggestions' ? 'negotiation.suggestions_created' : entry?.kind === 'action' ? 'negotiation.confirmation_requested' : 'negotiation.message_processed',
      entityType: 'negotiation', entityPublicId: routeParam(req.params.id),
      after: { contentKind: entry?.kind, actionId: entry?.actionId, productIds: entry?.productIds, providerFallback: audit.providerFallback },
    });
    sendSuccess(res, result);
  };

  confirmAction = async (req: Request, res: Response) => {
    let result;
    try {
      result = await this.shopping.confirm(identity(req), routeParam(req.params.id), routeParam(req.params.actionId), req.body.quantity, req.body.variantId);
    } catch (error) {
      if (error instanceof HttpError) await recordAudit(req, { action: 'negotiation.confirmation_rejected', entityType: 'negotiation', entityPublicId: routeParam(req.params.id), after: { actionId: routeParam(req.params.actionId), code: error.code } });
      throw error;
    }
    await recordAudit(req, { action: 'negotiation.cart_confirmed', entityType: 'negotiation', entityPublicId: routeParam(req.params.id) });
    sendSuccess(res, result);
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
