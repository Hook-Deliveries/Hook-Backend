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
  // Registered ahead of the generic /logistics/:provider route below, since
  // Express would otherwise match "fez" against :provider first.
  router.post('/logistics/fez', validateBody(z.object({ orderNumber: z.string(), status: z.string() })), asyncHandler(fulfilment.fezWebhook));
  router.post('/logistics/:provider', validateBody(z.record(z.string(), z.unknown())), asyncHandler(fulfilment.logisticsWebhook));

  return router;
}
