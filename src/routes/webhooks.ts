import { Router } from 'express';
import { WebhookController } from '@controllers/webhook.controller';
import { asyncHandler } from '@utils/http';
import { z } from 'zod';
import { validateBody } from '@middleware/validate';
import { FulfilmentController } from '@controllers/fulfilment.controller';

export function createWebhookRouter() {
  const router = Router();
  const controller = new WebhookController();
  const fulfilment = new FulfilmentController();

  router.post('/payments/:gateway', asyncHandler(controller.payment));
  router.post('/logistics/fez', validateBody(z.object({ orderNumber: z.string(), status: z.string().optional(), orderStatus: z.string().optional() }).refine((body) => body.status || body.orderStatus, 'status is required')), asyncHandler(fulfilment.fezWebhook));

  return router;
}
