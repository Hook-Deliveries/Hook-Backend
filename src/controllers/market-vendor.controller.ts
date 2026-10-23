import { Request, Response } from 'express';
import { routeParam } from '@lib/api-utils';
import { resolveAccessContext, assertScope } from '@services/access-control.service';
import { ScopeType } from '@lib/constants';
import { recordAudit } from '@modules/platform/platform-audit.service';
import { MarketVendorService } from '@services/market-vendor.service';
import { HttpError, sendCreated, sendSuccess } from '@utils/http';

const service = new MarketVendorService();

async function adminContext(req: Request) {
  return resolveAccessContext(req.user!.sub, req.user);
}

export class MarketAssociateMarketVendorController {
  market = async (req: Request, res: Response) => sendSuccess(res, await service.marketAssociateMarket(req.user!.sub, routeParam(req.params.id)));

  vendors = async (req: Request, res: Response) => sendSuccess(res, await service.listMarketAssociateVendors(req.user!.sub, routeParam(req.params.id), String(req.query.q || '')));

  create = async (req: Request, res: Response) => {
    const result = await service.createMarketAssociateVendor(req.user!.sub, routeParam(req.params.id), req.body);
    await recordAudit(req, { action: 'market.vendor.created', entityType: 'market_vendor', entityId: result.vendor.id, entityPublicId: result.vendor.publicId, stateId: result.vendor.stateId, after: result.vendor });
    await recordAudit(req, { action: 'market.vendor.invited', entityType: 'vendor_invitation', entityPublicId: result.invitation.publicId, stateId: result.vendor.stateId, after: { vendorId: result.vendor.publicId, delivery: result.invitation.delivery } });
    sendCreated(res, result);
  };

  detail = async (req: Request, res: Response) => {
    const vendor = await service.marketAssociateVendor(req.user!.sub, routeParam(req.params.id));
    sendSuccess(res, vendor);
  };

  update = async (req: Request, res: Response) => {
    const before = await service.marketAssociateVendor(req.user!.sub, routeParam(req.params.id));
    const updated = await service.updateMarketAssociateVendor(req.user!.sub, routeParam(req.params.id), req.body);
    await recordAudit(req, { action: 'market.vendor.updated', entityType: 'market_vendor', entityId: updated.id, entityPublicId: updated.publicId, stateId: updated.stateId, before, after: updated, reason: req.body.reason });
    sendSuccess(res, updated);
  };

  invite = async (req: Request, res: Response) => {
    const result = await service.resendInvitation(req.user!.sub, routeParam(req.params.id));
    await recordAudit(req, { action: 'market.vendor.invited', entityType: 'vendor_invitation', entityPublicId: result.publicId, after: { expiresAt: result.expiresAt, email: result.email } });
    sendSuccess(res, result);
  };

  collection = async (req: Request, res: Response) => {
    const result = await service.recordCollection(req.user!.sub, routeParam(req.params.id), req.body);
    await recordAudit(req, { action: 'market.vendor.collection_recorded', entityType: 'vendor_collection', entityId: result.collection.id, entityPublicId: result.collection.publicId, stateId: result.vendor.stateId, after: { ...result.collection.toObject(), payment: result.payment?.publicId } });
    sendCreated(res, result);
  };

  collections = async (req: Request, res: Response) => sendSuccess(res, await service.marketAssociateCollections(req.user!.sub, req.query.marketId ? String(req.query.marketId) : undefined));

  acceptInvitation = async (req: Request, res: Response) => sendSuccess(res, await service.acceptInvitation(routeParam(req.params.token), req.body || {}));
}

export class AdminMarketVendorController {
  /**
   * The global vendor directory. State-scoped staff only ever see vendors in
   * the States they are assigned to; global staff see everything.
   */
  directory = async (req: Request, res: Response) => {
    const context = await adminContext(req);
    sendSuccess(res, await service.adminVendorDirectory({
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 20,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      marketId: typeof req.query.marketId === 'string' ? req.query.marketId : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      stateIds: context.scopeType === ScopeType.GLOBAL ? undefined : context.stateIds,
    }));
  };

  create = async (req: Request, res: Response) => {
    const context = await adminContext(req);
    const market = await service.adminMarket(routeParam(req.params.id));
    assertScope(context, market.market.stateId, market.market.hubId);
    const result = await service.adminCreateVendor(req.user!.sub, routeParam(req.params.id), req.body);
    await recordAudit(req, {
      action: 'market.vendor.created',
      entityType: 'market_vendor',
      entityId: result.vendor.id,
      entityPublicId: result.vendor.publicId,
      stateId: result.vendor.stateId,
      after: result.vendor,
      reason: req.body.reason,
    });
    sendCreated(res, result);
  };

  invite = async (req: Request, res: Response) => {
    const context = await adminContext(req);
    const before = await service.adminVendor(routeParam(req.params.id));
    assertScope(context, before.vendor.stateId);
    const result = await service.adminInviteVendor(req.user!.sub, routeParam(req.params.id));
    await recordAudit(req, {
      action: 'market.vendor.invited',
      entityType: 'market_vendor',
      entityId: before.vendor.id,
      entityPublicId: before.vendor.publicId,
      stateId: before.vendor.stateId,
      after: { invitation: result.publicId },
    });
    sendSuccess(res, result);
  };

  market = async (req: Request, res: Response) => {
    const context = await adminContext(req);
    const response = await service.adminMarket(routeParam(req.params.id));
    assertScope(context, response.market.stateId, response.market.hubId);
    sendSuccess(res, response);
  };

  paymentDetails = async (req: Request, res: Response) => {
    const reason = String(req.query.reason || '').trim();
    if (reason.length < 3) throw new HttpError(400, 'An audit reason is required to view supplier payment details', undefined, 'VALIDATION_ERROR');
    const context = await adminContext(req);
    const response = await service.adminVendorPaymentDetails(routeParam(req.params.id));
    assertScope(context, response.vendor.stateId);
    await recordAudit(req, {
      action: 'market.vendor.payment_details_viewed',
      entityType: 'market_vendor',
      entityId: response.vendor.id,
      entityPublicId: response.vendor.publicId,
      stateId: response.vendor.stateId,
      after: { accountNumberLast4: response.vendor.paymentProfile.accountNumberLast4 },
      reason,
    });
    sendSuccess(res, response);
  };

  vendors = async (req: Request, res: Response) => {
    const context = await adminContext(req);
    const market = await service.adminMarket(routeParam(req.params.id));
    assertScope(context, market.market.stateId, market.market.hubId);
    sendSuccess(res, market.vendors);
  };

  detail = async (req: Request, res: Response) => {
    const context = await adminContext(req);
    const response = await service.adminVendor(routeParam(req.params.id));
    assertScope(context, response.vendor.stateId);
    sendSuccess(res, response);
  };

  update = async (req: Request, res: Response) => {
    const context = await adminContext(req);
    const before = await service.adminVendor(routeParam(req.params.id));
    assertScope(context, before.vendor.stateId);
    const updated = await service.adminUpdateVendor(routeParam(req.params.id), req.body);
    await recordAudit(req, { action: 'market.vendor.updated', entityType: 'market_vendor', entityId: updated.id, entityPublicId: updated.publicId, stateId: updated.stateId, before: before.vendor, after: updated, reason: req.body.reason });
    sendSuccess(res, updated);
  };

  collections = async (req: Request, res: Response) => {
    const context = await adminContext(req);
    const response = await service.adminCollections(req.query);
    response.data.forEach((item: any) => assertScope(context, item.stateId));
    sendSuccess(res, response);
  };

  reconcile = async (req: Request, res: Response) => {
    const context = await adminContext(req);
    const before = await service.adminCollection(routeParam(req.params.id));
    assertScope(context, before.stateId);
    const updated = await service.reconcileCollection(routeParam(req.params.id), req.user!.sub, req.body.status, req.body.notes);
    await recordAudit(req, { action: `market.vendor.payment.${req.body.status}`, entityType: 'vendor_payment', entityId: updated?.id, entityPublicId: updated?.publicId, stateId: before.stateId, before, after: updated, reason: req.body.reason });
    sendSuccess(res, updated);
  };
}
