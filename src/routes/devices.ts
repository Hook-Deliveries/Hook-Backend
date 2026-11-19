import { Router } from 'express';
import { z } from 'zod';
import { DeviceController } from '@controllers/device.controller';
import { requireCustomerIdentity } from '@middleware/auth';
import { validateBody } from '@middleware/validate';
import { asyncHandler, sendSuccess } from '@utils/http';
import { WebPushSubscription } from '@models/notifications/web-push-subscription.model';

const deviceSchema = z.object({
  expoPushToken: z.string().min(10),
  platform: z.enum(['ios', 'android', 'web', 'unknown']).default('unknown'),
  deviceName: z.string().optional(),
  deviceId: z.string().min(8).optional(),
  sendWelcome: z.boolean().optional(),
});

export function createDeviceRouter() {
  const router = Router();
  const controller = new DeviceController();

  router.use(requireCustomerIdentity);
  router.post('/register', validateBody(deviceSchema), asyncHandler(controller.register));
  router.post('/unregister', validateBody(z.object({ expoPushToken: z.string().min(10).optional() })), asyncHandler(controller.unregister));
  router.post('/test-push', asyncHandler(controller.testPush));

  // Browser push for shoppers: the same Web Push (VAPID) delivery the staff portals use, keyed to the customer account.
  const webPushSchema = z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }) });
  router.post('/web-push', validateBody(webPushSchema), asyncHandler(async (req, res) => {
    await WebPushSubscription.findOneAndUpdate(
      { endpoint: req.body.endpoint },
      { $set: { userId: req.user!.sub, p256dh: req.body.keys.p256dh, auth: req.body.keys.auth, isActive: true, lastSeenAt: new Date() }, $unset: { deletedAt: 1 } },
      { upsert: true },
    );
    sendSuccess(res, { subscribed: true });
  }));
  router.post('/web-push/unsubscribe', validateBody(z.object({ endpoint: z.string().url() })), asyncHandler(async (req, res) => {
    await WebPushSubscription.updateOne({ endpoint: req.body.endpoint, userId: req.user!.sub }, { $set: { isActive: false } });
    sendSuccess(res, { subscribed: false });
  }));
  router.get('/', asyncHandler(controller.list));
  router.patch('/:id', validateBody(z.object({ deviceName: z.string().trim().min(2).max(80) })), asyncHandler(controller.rename));
  router.delete('/others', asyncHandler(controller.revokeOthers));
  router.delete('/:id', asyncHandler(controller.revoke));

  return router;
}
