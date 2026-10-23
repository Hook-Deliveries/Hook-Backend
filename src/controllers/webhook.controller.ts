import { Request, Response } from 'express';
import { AppDataSource } from '@config/data-source';
import { Order } from '@models/orders/order.model';
import { Payment } from '@models/payments/payment.model';
import { EscrowLedger } from '@models/payments/escrow-ledger.model';
import { PaymentService } from '@modules/payments/payment.service';
import { sendError } from '@utils/http';

export class WebhookController {
  private readonly payments = new PaymentService(
    AppDataSource.getRepository(Payment),
    AppDataSource.getRepository(Order),
    AppDataSource.getRepository(EscrowLedger),
  );

  payment = async (req: Request, res: Response) => {
    sendError(res, 410, 'INVALID_STATE_TRANSITION', 'Legacy payment webhooks are no longer active');
  };
}
