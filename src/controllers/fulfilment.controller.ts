import { Request, Response } from 'express';
import { fulfilmentService } from '@modules/fulfilment/fulfilment.service';
import { routeParam } from '@lib/api-utils';
import { sendCreated, sendSuccess } from '@utils/http';

function actor(req: Request) {
  return {
    accountId: req.user!.sub,
    publicId: req.user!.publicId,
    accountType: req.user!.accountType,
    stateIds: req.user!.assignedStateIds,
    hubIds: req.user!.assignedHubIds,
  };
}

export class FulfilmentController {
  marketAssociateDashboard = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.marketAssociateTasks(req.user!.sub, { limit: 100 }));
  marketAssociateTasks = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.marketAssociateTasks(req.user!.sub, req.query as Record<string, unknown>));
  marketAssociateTask = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.marketAssociateTask(req.user!.sub, routeParam(req.params.id)));
  marketAssociateAction = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.marketAssociateTransition(req.user!.sub, routeParam(req.params.id), routeParam(req.params.action), Number(req.body.version), req.body));
  regenerateHandoverCode = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.regenerateHandoverCode(req.user!.sub, routeParam(req.params.id)));
  marketAssociateIssue = async (req: Request, res: Response) => sendCreated(res, await fulfilmentService.marketAssociateIssue(req.user!.sub, routeParam(req.params.id), req.body));
  verifyItem = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.verifyItem(req.user!.sub, routeParam(req.params.id), routeParam(req.params.orderItemId), req.body));
  marketAssociateItemIssue = async (req: Request, res: Response) => sendCreated(res, await fulfilmentService.marketAssociateItemIssue(req.user!.sub, routeParam(req.params.id), routeParam(req.params.orderItemId), req.body));

  controlTower = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.controlTower(actor(req), req.query as Record<string, unknown>));
  adminTaskDetail = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.adminTaskDetail(actor(req), routeParam(req.params.id)));
  proposeItemResolution = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.proposeItemResolution(actor(req), routeParam(req.params.id), req.body));
  assignmentMarketAssociates = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.assignmentMarketAssociates(actor(req), req.query as Record<string, unknown>));
  assignmentHubs = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.assignmentHubs(actor(req), req.query as Record<string, unknown>));
  reassignTask = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.reassignTask(actor(req), routeParam(req.params.id), req.body));
  unblockTask = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.unblockTask(actor(req), routeParam(req.params.id), req.body));
  hubDashboard = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.hubDashboard(actor(req), req.query as Record<string, unknown>));
  adminConsolidations = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.consolidations(actor(req), req.query as Record<string, unknown>));
  receivePackage = async (req: Request, res: Response) => sendCreated(res, await fulfilmentService.receivePackage(actor(req), routeParam(req.params.id), req.body));
  reopenQualityCheck = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.reopenQualityCheck(actor(req), routeParam(req.params.id), req.body));
  resourceFailedPackage = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.resourceFailedPackage(actor(req), routeParam(req.params.id), req.body));
  publicParcelTracking = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.publicParcelTracking(routeParam(req.params.receipt), String(req.query.s || '')));
  qualityCheck = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.qualityCheck(actor(req), routeParam(req.params.id), req.body));
  consolidate = async (req: Request, res: Response) => sendCreated(res, await fulfilmentService.consolidate(actor(req), routeParam(req.params.id), req.body));
  orderReceipt = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.orderReceipt(actor(req), routeParam(req.params.id), req.query as Record<string, unknown>));
  recordReceiptPrint = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.recordReceiptPrint(actor(req), routeParam(req.params.id), req.body));
  customerReceipt = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.customerReceipt(req.user!.sub, routeParam(req.params.id)));
  sealConsolidation = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.sealConsolidation(actor(req), routeParam(req.params.id), req.body));
  createShipment = async (req: Request, res: Response) => sendCreated(res, await fulfilmentService.createManualShipment(actor(req), routeParam(req.params.id), req.body));
  updateShipment = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.updateShipment(actor(req), routeParam(req.params.id), req.body));
  partnerCustody = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.partnerCustody(actor(req), routeParam(req.params.orderId)));
  partnerCustodyList = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.partnerCustodyList(actor(req), req.query as Record<string, unknown>));
  receiveCustody = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.receiveCustody(actor(req), routeParam(req.params.id), String(req.header('idempotency-key') || req.body.idempotencyKey || '')));
  releaseCustody = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.releaseCustody(actor(req), routeParam(req.params.id), String(req.body.code || ''), String(req.header('idempotency-key') || req.body.idempotencyKey || '')));

  customerFulfilment = async (req: Request, res: Response) => {
    const order = await fulfilmentService.customerOrderProgress(req.user!.sub, routeParam(req.params.id));
    sendSuccess(res, order);
  };
  customerItemResolution = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.customerItemResolution(req.user!.sub, routeParam(req.params.orderId), routeParam(req.params.id), req.body));
  customerReturn = async (req: Request, res: Response) => sendCreated(res, await fulfilmentService.createReturn(actor(req), routeParam(req.params.id), req.body));

  adminReturnReview = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.reviewReturn(actor(req), routeParam(req.params.id), req.body));
  adminRefund = async (req: Request, res: Response) => sendCreated(res, await fulfilmentService.createRefund(actor(req), req.body));
  adminRefundProcess = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.processRefund(actor(req), routeParam(req.params.id), req.body));
  adminReturns = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.returns(actor(req), req.query as Record<string, unknown>));
  adminRefunds = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.refunds(actor(req), req.query as Record<string, unknown>));
  reassignShipmentCourier = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.reassignShipmentCourier(actor(req), routeParam(req.params.id), req.body));
  fulfilmentOverview = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.overview(actor(req), req.query as Record<string, unknown>));
  adminShipments = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.shipments(actor(req), req.query as Record<string, unknown>));
  logisticsReadiness = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.logisticsReadiness(actor(req)));
  logisticsWebhook = async (req: Request, res: Response) => sendSuccess(res, await fulfilmentService.logisticsWebhook(routeParam(req.params.provider), String(req.header('x-provider-event-id') || ''), req.body, String(req.header('x-provider-signature') || '')));

  // Fez's own webhook contract (X-Signature/X-Timestamp headers, {orderNumber, status}
  // body, no event id) doesn't fit the generic x-provider-* header scheme above, so it
  // gets its own route rather than forcing a mismatched contract through the shared one.
  fezWebhook = async (req: Request, res: Response) => {
    const body = req.body as { orderNumber?: string; status?: string };
    const eventId = `${body.orderNumber || ''}:${body.status || ''}`;
    const timestamp = String(req.header('x-timestamp') || '');
    sendSuccess(res, await fulfilmentService.logisticsWebhook('fez', eventId, body, String(req.header('x-signature') || ''), timestamp));
  };
}
