import { Router } from 'express';
import { z } from 'zod';
import { DeviceController } from '@controllers/device.controller';
import { requireCustomerIdentity } from '@middleware/auth';
import { validateBody } from '@middleware/validate';
import { asyncHandler, sendSuccess } from '@utils/http';
import { WebPushSubscription } from '@models/notifications/web-push-subscription.model';

const webPushEndpoint = z.string().max(4096).refine((value) => {
  const url = URL.canParse(value) ? new URL(value) : null;
  if (!url || url.protocol !== 'https:' || url.port || url.username || url.password) return false;
  const { hostname } = url;
  // Only accept browser push services. The backend makes an outbound request to this URL.
  return hostname === 'fcm.googleapis.com'
    || hostname === 'updates.push.services.mozilla.com'
    || hostname.endsWith('.push.apple.com')
    || hostname.endsWith('.notify.windows.com');
}, 'Unsupported browser push endpoint');

const webPushSubscriptionSchema = z.object({
  endpoint: webPushEndpoint,
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}=?$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}={0,2}$/),
  }),
});

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
  router.post('/web-push', validateBody(webPushSubscriptionSchema), asyncHandler(async (req, res) => {
    const { endpoint, keys } = req.body;
    await WebPushSubscription.updateOne(
      { endpoint },
      { $set: { userId: req.user!.sub, p256dh: keys.p256dh, auth: keys.auth, isActive: true, lastSeenAt: new Date() } },
      { upsert: true },
    );
    sendSuccess(res, { subscribed: true });
  }));
  router.post('/web-push/unsubscribe', validateBody(z.object({ endpoint: webPushEndpoint })), asyncHandler(async (req, res) => {
    await WebPushSubscription.updateOne(
      { endpoint: req.body.endpoint, userId: req.user!.sub },
      { $set: { isActive: false } },
    );
    sendSuccess(res, { subscribed: false });
  }));
  router.post('/register', validateBody(deviceSchema), asyncHandler(controller.register));
  router.post('/unregister', validateBody(z.object({ expoPushToken: z.string().min(10).optional() })), asyncHandler(controller.unregister));
  router.post('/test-push', asyncHandler(controller.testPush));
  router.get('/', asyncHandler(controller.list));
  router.patch('/:id', validateBody(z.object({ deviceName: z.string().trim().min(2).max(80) })), asyncHandler(controller.rename));
  router.delete('/others', asyncHandler(controller.revokeOthers));
  router.delete('/:id', asyncHandler(controller.revoke));

  return router;
}
