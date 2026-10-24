import { Request, Response } from 'express';
import { AppDataSource } from '@config/data-source';
import { DeviceToken } from '@models/notifications/device-token.model';
import { Notification } from '@models/notifications/notification.model';
import { WebPushSubscription } from '@models/notifications/web-push-subscription.model';
import { NotificationService } from '@modules/notifications/notification.service';
import { sendSuccess } from '@utils/http';
import { routeParam } from '@lib/api-utils';

/** Notifications addressed to the authenticated staff account only. */
export class AdminNotificationsController {
  private readonly notifications = new NotificationService(
    AppDataSource.getRepository(DeviceToken),
    AppDataSource.getRepository(Notification),
  );

  list = async (req: Request, res: Response) => {
    sendSuccess(res, await this.notifications.list({ userId: req.user!.sub }, {
      limit: Number(req.query.limit || 30),
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
    }));
  };

  markRead = async (req: Request, res: Response) => {
    sendSuccess(res, await this.notifications.markRead({ userId: req.user!.sub }, routeParam(req.params.id)));
  };

  markAllRead = async (req: Request, res: Response) => {
    sendSuccess(res, await this.notifications.markAllRead({ userId: req.user!.sub }));
  };

  subscribePush = async (req: Request, res: Response) => {
    const { endpoint, keys } = req.body as { endpoint: string; keys: { p256dh: string; auth: string } };
    await WebPushSubscription.findOneAndUpdate(
      { endpoint },
      { $set: { userId: req.user!.sub, p256dh: keys.p256dh, auth: keys.auth, isActive: true, lastSeenAt: new Date() } },
      { upsert: true },
    );
    sendSuccess(res, { subscribed: true });
  };

  unsubscribePush = async (req: Request, res: Response) => {
    const { endpoint } = req.body as { endpoint: string };
    await WebPushSubscription.updateOne({ endpoint, userId: req.user!.sub }, { $set: { isActive: false } });
    sendSuccess(res, { subscribed: false });
  };
}
