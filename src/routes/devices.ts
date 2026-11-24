import { Router } from 'express';
import { z } from 'zod';
import { DeviceController } from '@controllers/device.controller';
import { requireCustomerIdentity } from '@middleware/auth';
import { validateBody } from '@middleware/validate';
import { asyncHandler } from '@utils/http';

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
  router.get('/', asyncHandler(controller.list));
  router.patch('/:id', validateBody(z.object({ deviceName: z.string().trim().min(2).max(80) })), asyncHandler(controller.rename));
  router.delete('/others', asyncHandler(controller.revokeOthers));
  router.delete('/:id', asyncHandler(controller.revoke));

  return router;
}
