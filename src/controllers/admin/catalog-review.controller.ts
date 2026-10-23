import { Request, Response } from 'express';
import { ScopeType } from '@lib/constants';
import { routeParam } from '@lib/api-utils';
import { CatalogReviewService } from '@services/catalog.service';
import { recordAudit } from '@modules/platform/platform-audit.service';
import { sendSuccess } from '@utils/http';
import { presentSubmission, presentSubmissions } from '@services/catalog-presentation.service';
import { adminReviewCache } from '@lib/ttl-cache';

function stateScope(req: Request) {
  if (req.platformContext?.stateId) return [req.platformContext.stateId];
  return req.user?.scopeType === ScopeType.GLOBAL ? undefined : req.user?.assignedStateIds;
}

export class AdminCatalogReviewController {
  private readonly review = new CatalogReviewService();

  dashboard = async (req: Request, res: Response) => sendSuccess(res, await this.review.dashboard(stateScope(req)));
  list = async (req: Request, res: Response) => {
    const result = await this.review.list(req.query, stateScope(req));
    sendSuccess(res, { ...result, data: await presentSubmissions(result.data) });
  };
  detail = async (req: Request, res: Response) => sendSuccess(
    res,
    await presentSubmission(await this.review.detail(routeParam(req.params.id), stateScope(req))),
  );

  start = async (req: Request, res: Response) => {
    const updated = await this.review.start(
      routeParam(req.params.id),
      req.user!.sub,
      req.user!.publicId,
      req.body.version,
      stateScope(req),
    );
    await recordAudit(req, {
      action: 'catalog.submission.review_started',
      entityType: 'product_submission',
      entityId: updated.id,
      entityPublicId: updated.publicId,
      stateId: updated.sourceStateId,
      after: { status: updated.status, reviewedBy: updated.reviewedBy },
    });
    adminReviewCache.clear();
    sendSuccess(res, await presentSubmission(updated));
  };

  requestChanges = async (req: Request, res: Response) => this.decide(req, res, 'changes_requested');
  approve = async (req: Request, res: Response) => this.decide(req, res, 'approved');
  reject = async (req: Request, res: Response) => this.decide(req, res, 'rejected');

  private decide = async (
    req: Request,
    res: Response,
    action: 'changes_requested' | 'approved' | 'rejected',
  ) => {
    const before = await this.review.detail(routeParam(req.params.id), stateScope(req));
    // action and req.body are only known together at runtime — each route
    // wires its own schema (reviewReasonSchema vs submissionApproveAsProductSchema)
    // via validateBody, so the shape is already guaranteed before this runs.
    const updated = await (this.review.decide as any)(
      routeParam(req.params.id),
      req.user!.sub,
      req.user!.publicId,
      action,
      req.body,
      stateScope(req),
    );
    await recordAudit(req, {
      action: `catalog.submission.${action}`,
      entityType: 'product_submission',
      entityId: updated.id,
      entityPublicId: updated.publicId,
      stateId: updated.sourceStateId,
      before: { status: before.status, version: before.version },
      after: { status: updated.status, version: updated.version },
      reason: req.body.reason,
    });
    adminReviewCache.clear();
    sendSuccess(res, await presentSubmission(updated));
  };
}
