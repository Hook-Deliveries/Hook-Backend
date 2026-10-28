import { Request, Response } from 'express';
import { isValidObjectId } from 'mongoose';
import { AppDataSource } from '@config/data-source';
import { DeviceToken } from '@models/notifications/device-token.model';
import { Notification } from '@models/notifications/notification.model';
import { NotificationService } from '@modules/notifications/notification.service';
import { AccountSession } from '@models/platform/session.model';
import { User } from '@models/users/user.model';
import { realtime } from '@modules/platform/realtime.service';
import { HttpError } from '@utils/http';
import { sendSuccess } from '@utils/http';

const WELCOME_BACK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function owner(req: Request) {
  return { userId: req.user!.sub };
}

export class DeviceController {
  private readonly notifications = new NotificationService(
    AppDataSource.getRepository(DeviceToken),
    AppDataSource.getRepository(Notification),
  );

  register = async (req: Request, res: Response) => {
    const notificationOwner = owner(req);
    const device = await this.notifications.registerDevice(notificationOwner, { ...req.body, sessionId: req.user!.sid });
    if (req.user!.sid) {
      await AccountSession.updateOne({ _id: req.user!.sid, accountId: req.user!.sub }, { $set: {
        deviceId: req.body.deviceId,
        deviceName: req.body.deviceName,
        platform: req.body.platform,
      } });
    }
    // Sign-in greeting: "Welcome to Hook" the first time this device signs in,
    // "Welcome back" on later sign-ins. Spaced out so switching accounts or
    // signing in repeatedly never turns into a stream of greetings.
    if (req.body.sendWelcome && device) {
      const lastSent = (device as DeviceToken).welcomeSentAt;
      const first = !lastSent;
      const due = first || Date.now() - new Date(lastSent as Date).getTime() > WELCOME_BACK_INTERVAL_MS;
      if (due) {
        const user = first ? null : await User.findById(req.user!.sub).select('firstName').lean() as { firstName?: string } | null;
        const name = user?.firstName?.trim();
        await this.notifications.sendPushToDevice(
          req.body.expoPushToken,
          first ? 'Welcome to Hook' : name ? `Welcome back, ${name}` : 'Welcome back',
          first ? 'Your marketplace is ready.' : 'Pick up where you left off.',
          { type: first ? 'welcome' : 'welcome_back' },
        );
        await DeviceToken.updateOne({ _id: (device as DeviceToken).id }, { $set: { welcomeSentAt: new Date() } });
      }
    }
    sendSuccess(res, device);
  };

  unregister = async (req: Request, res: Response) => {
    sendSuccess(res, await this.notifications.unregisterDevice(owner(req), req.body.expoPushToken));
  };
  list = async (req: Request, res: Response) => {
    const sessions = await AccountSession.find({ accountId: req.user!.sub, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } })
      .select('deviceId deviceName platform createdAt lastUsedAt expiresAt')
      .sort({ lastUsedAt: -1 }).lean({ virtuals: true });
    sendSuccess(res, sessions.map((session) => ({
      id: session._id.toString(),
      deviceId: session.deviceId,
      deviceName: session.deviceName || 'Hook device',
      platform: session.platform || 'unknown',
      createdAt: session.createdAt,
      lastActiveAt: session.lastUsedAt,
      current: session.id === req.user!.sid,
    })));
  };

  rename = async (req: Request, res: Response) => {
    const session = await AccountSession.findOne({ _id: req.params.id, accountId: req.user!.sub, revokedAt: { $exists: false } });
    if (!session) throw new HttpError(404, 'Device not found');
    session.deviceName = req.body.deviceName.trim();
    await session.save();
    await DeviceToken.updateMany({ userId: req.user!.sub, sessionId: session.id }, { $set: { deviceName: session.deviceName } });
    sendSuccess(res, { id: session.id, deviceName: session.deviceName });
  };

  revoke = async (req: Request, res: Response) => {
    if (!req.params.id || !isValidObjectId(req.params.id)) {
      throw new HttpError(400, 'A device identifier is required');
    }
    if (req.params.id === req.user!.sid) throw new HttpError(409, 'Use logout to remove this device', undefined, 'INVALID_STATE_TRANSITION');
    const session = await AccountSession.findOneAndUpdate(
      { _id: req.params.id, accountId: req.user!.sub, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revokedBy: req.user!.sub, revocationReason: 'customer_device_removed' } },
      { returnDocument: 'after' },
    );
    if (!session) throw new HttpError(404, 'Device not found');
    await DeviceToken.updateMany({ userId: req.user!.sub, sessionId: session.id }, { $set: { isActive: false } });
    realtime.revokeSession(session.id, 'customer_device_removed');
    sendSuccess(res, { revoked: true });
  };

  revokeOthers = async (req: Request, res: Response) => {
    const sessions = await AccountSession.find({ accountId: req.user!.sub, _id: { $ne: req.user!.sid }, revokedAt: { $exists: false } }).select('_id').lean();
    const ids = sessions.map((session) => session._id.toString());
    await AccountSession.updateMany({ _id: { $in: ids } }, { $set: { revokedAt: new Date(), revokedBy: req.user!.sub, revocationReason: 'customer_revoked_other_devices' } });
    await DeviceToken.updateMany({ userId: req.user!.sub, sessionId: { $in: ids } }, { $set: { isActive: false } });
    ids.forEach((id) => realtime.revokeSession(id, 'customer_revoked_other_devices'));
    sendSuccess(res, { revokedCount: ids.length });
  };
}
