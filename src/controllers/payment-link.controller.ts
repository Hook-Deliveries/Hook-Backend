import type { Request, Response } from "express";
import { PaymentLinkService } from "@modules/payments/payment-link.service";
import { HttpError, sendCreated, sendSuccess } from "@utils/http";

function param(value: string | string[] | undefined) {
  if (typeof value !== "string") throw new HttpError(400, "Invalid route parameter");
  return value;
}

export class PaymentLinkController {
  private readonly service = new PaymentLinkService();

  create = async (req: Request, res: Response) => {
    if (!req.user?.sub) throw new HttpError(401, "Customer authentication required");
    sendCreated(res, await this.service.create(req.user.sub, req.body.orderId, req.body.fulfilmentGroupId));
  };

  detail = async (req: Request, res: Response) => {
    sendSuccess(res, await this.service.detail(param(req.params.token)));
  };

  initialize = async (req: Request, res: Response) => {
    sendCreated(res, await this.service.initialize(
      param(req.params.token),
      req.body.provider,
      String(req.header("idempotency-key") || ""),
      Boolean(req.body.appReturn),
    ));
  };

  status = async (req: Request, res: Response) => {
    sendSuccess(res, await this.service.status(param(req.params.token)));
  };

  revoke = async (req: Request, res: Response) => {
    if (!req.user?.sub) throw new HttpError(401, "Customer authentication required");
    sendSuccess(res, await this.service.revoke(req.user.sub, param(req.params.id)));
  };
}
