import { Request, Response } from 'express';
import { ScopeType } from '@lib/constants';
import { routeParam } from '@lib/api-utils';
import { CommercialCatalogService } from '@modules/catalog/commercial-catalog.service';
import { recordAudit } from '@modules/platform/platform-audit.service';
import { sendSuccess } from '@utils/http';
import { presentCommercialSummary } from '@modules/catalog/catalog-presentation.service';
import { CatalogAvailabilityService } from '@modules/catalog/catalog-availability.service';

function stateScope(req: Request) {
  if (req.platformContext?.stateId) return [req.platformContext.stateId];
  return req.user?.scopeType === ScopeType.GLOBAL ? undefined : req.user?.assignedStateIds;
}

/** Product lifecycle/negotiation-rules/availability actions, now mounted under /admin/products/:id/* since the standalone Commercial Catalog page (and its other endpoints) was retired in favor of Product Inventory. */
export class AdminCommercialCatalogController {
  private readonly catalog = new CommercialCatalogService();
  private readonly availability = new CatalogAvailabilityService();

  rules = async (req: Request, res: Response) => {
    const before = await this.catalog.detail(routeParam(req.params.id), stateScope(req));
    const updated = await this.catalog.rules(routeParam(req.params.id), req.body, req.user!.sub, stateScope(req));
    await this.audit(req, 'catalog.product.negotiation_rules_updated', before.negotiationRules, updated.negotiationRules, req.body.reason, updated);
    sendSuccess(res, presentCommercialSummary(updated));
  };

  publish = async (req: Request, res: Response) => this.lifecycle(req, res, 'publish');
  pause = async (req: Request, res: Response) => this.lifecycle(req, res, 'pause');
  unpublish = async (req: Request, res: Response) => this.lifecycle(req, res, 'unpublish');
  availabilityUnconfirmed = async (req: Request, res: Response) => {
    const before = await this.catalog.detail(routeParam(req.params.id), stateScope(req));
    const updated = await this.availability.request(routeParam(req.params.id), req.body, req.user!.sub, stateScope(req));
    await this.audit(req, 'catalog.product.availability_unconfirmed', { status: before.status }, { status: updated.status, dueAt: updated.availabilityCheckDueAt }, req.body.reason, updated);
    sendSuccess(res, presentCommercialSummary(updated));
  };

  private lifecycle = async (
    req: Request,
    res: Response,
    action: 'publish' | 'pause' | 'unpublish' | 'availability_unconfirmed',
  ) => {
    const before = await this.catalog.detail(routeParam(req.params.id), stateScope(req));
    const updated = await this.catalog.lifecycle(routeParam(req.params.id), action, req.body, req.user!.sub, stateScope(req));
    await this.audit(req, `catalog.product.${action}`, { status: before.status }, { status: updated.status }, req.body.reason, updated);
    sendSuccess(res, presentCommercialSummary(updated));
  };

  private audit = async (
    req: Request,
    action: string,
    before: unknown,
    after: unknown,
    reason?: string,
    product?: any,
  ) => recordAudit(req, {
    action,
    entityType: 'product',
    entityId: product?._id || (after as any)?._id,
    entityPublicId: product?.publicId || (after as any)?.publicId,
    stateId: product?.sourceStateId || (after as any)?.sourceStateId,
    before,
    after,
    reason,
  });
}
