import { Request, Response } from 'express';
import { adminReviewCache } from '@lib/ttl-cache';
import { publishRealtime } from '@modules/platform/realtime.service';
import { MarketAssociateCatalogService } from '@modules/catalog/catalog.service';
import { recordAudit } from '@modules/platform/platform-audit.service';
import { routeParam } from '@lib/api-utils';
import { sendCreated, sendSuccess } from '@utils/http';
import { presentSubmission, presentSubmissions } from '@modules/catalog/catalog-presentation.service';

export class MarketAssociateCatalogController {
  private readonly catalog = new MarketAssociateCatalogService();

  dashboard = async (req: Request, res: Response) => {
    sendSuccess(res, await this.catalog.dashboard(req.user!.sub));
  };

  list = async (req: Request, res: Response) => {
    const result = await this.catalog.list(req.user!.sub, req.query);
    sendSuccess(res, { ...result, data: await presentSubmissions(result.data) });
  };

  detail = async (req: Request, res: Response) => {
    sendSuccess(res, await presentSubmission(await this.catalog.detail(req.user!.sub, routeParam(req.params.id))));
  };

  create = async (req: Request, res: Response) => {
    const created = await this.catalog.create(req.user!.sub, req.body);
    await recordAudit(req, {
      action: 'catalog.submission.created',
      entityType: 'product_submission',
      entityId: created.id,
      entityPublicId: created.publicId,
      stateId: created.sourceStateId,
      after: created,
    });
    sendCreated(res, await presentSubmission(created));
  };

  update = async (req: Request, res: Response) => {
    const before = await this.catalog.detail(req.user!.sub, routeParam(req.params.id));
    const updated = await this.catalog.update(req.user!.sub, routeParam(req.params.id), req.body);
    await recordAudit(req, {
      action: 'catalog.submission.updated',
      entityType: 'product_submission',
      entityId: updated.id,
      entityPublicId: updated.publicId,
      stateId: updated.sourceStateId,
      before,
      after: updated,
    });
    sendSuccess(res, await presentSubmission(updated));
  };

  submit = async (req: Request, res: Response) => {
    const updated = await this.catalog.submit(req.user!.sub, routeParam(req.params.id), req.body.version);
    await recordAudit(req, {
      action: 'catalog.submission.submitted',
      entityType: 'product_submission',
      entityId: updated.id,
      entityPublicId: updated.publicId,
      stateId: updated.sourceStateId,
      after: { status: updated.status, submittedAt: updated.submittedAt },
    });
    // The review dashboard's "awaiting review" count must not lag behind a submission that just arrived.
    adminReviewCache.clear();
    publishRealtime({ type: 'admin.dashboard.updated', entityId: updated.publicId }, { admin: true });
    sendSuccess(res, await presentSubmission(updated));
  };
}
