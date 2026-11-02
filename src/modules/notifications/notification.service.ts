import type { MongoRepository as Repository } from '@lib/mongo-repository';
import { DeviceToken } from '@models/notifications/device-token.model';
import { Notification } from '@models/notifications/notification.model';
import { publishRealtime } from '@modules/platform';
import { HttpError } from '@utils/http';
import { sendPushMessages } from '@modules/notifications/push.service';

type NotificationOwner = { userId: string };

const NOTIFICATION_LIST_FIELDS = 'title body type data isRead readAt createdAt';
const NOTIFICATION_DETAIL_FIELDS = `${NOTIFICATION_LIST_FIELDS} data`;

export class NotificationService {
  constructor(
    private readonly devices: Repository<DeviceToken>,
    private readonly notifications: Repository<Notification>,
  ) {}

  async registerDevice(owner: NotificationOwner, body: Partial<DeviceToken>) {
    if (!body.expoPushToken?.startsWith('ExponentPushToken[') && !body.expoPushToken?.startsWith('ExpoPushToken[')) {
      throw new HttpError(400, 'Invalid Expo push token');
    }

    const existing = await this.devices.findOne({ where: { expoPushToken: body.expoPushToken } });
    const payload = {
      userId: owner.userId,
      expoPushToken: body.expoPushToken,
      platform: body.platform || 'unknown',
      deviceName: body.deviceName,
      deviceId: body.deviceId,
      sessionId: body.sessionId,
      isActive: true,
      lastSeenAt: new Date(),
    };

    if (existing) {
      await this.devices.update(existing.id, payload);
      return this.devices.findOne({ where: { id: existing.id } });
    }

    return this.devices.save(this.devices.create(payload));
  }

  async unregisterDevice(owner: NotificationOwner, expoPushToken?: string) {
    if (expoPushToken) {
      const existing = await this.devices.findOne({ where: { expoPushToken, userId: owner.userId } });
      if (existing) await this.devices.update(existing.id, { isActive: false });
      return { message: 'Device unregistered.' };
    }

    const tokens = await this.findOwnerDevices(owner);
    await Promise.all(tokens.map((token) => this.devices.update(token.id, { isActive: false })));
    return { message: 'Devices unregistered.' };
  }

  async create(owner: NotificationOwner, title: string, body: string, type = 'general', data?: Record<string, unknown>) {
    const notification = await this.notifications.save(this.notifications.create({
      ...owner,
      title,
      body,
      type,
      data,
      isRead: false,
    }));
    publishRealtime(
      { type: 'notification.created', entityId: notification?.id, version: 1 },
      { accountId: owner.userId },
    );
    return notification;
  }

  async list(owner: NotificationOwner, options: { limit?: number; cursor?: string } = {}) {
    const where = this.ownerWhere(owner);
    const limit = Math.min(Math.max(Number(options.limit || 30), 1), 100);
    const pageWhere = options.cursor
      ? { ...where, createdAt: { $lt: new Date(options.cursor) } }
      : where;
    const [rows, unread, total] = await Promise.all([
      this.notifications.find({ where: pageWhere, order: { createdAt: 'DESC' }, take: limit + 1, select: NOTIFICATION_LIST_FIELDS }),
      this.notifications.count({ where: { ...where, isRead: false } }),
      this.notifications.count({ where }),
    ]);
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit);
    const last = data[data.length - 1];
    return {
      data,
      unread,
      total,
      hasMore,
      nextCursor: hasMore && last?.createdAt ? new Date(last.createdAt).toISOString() : null,
    };
  }

  async detail(owner: NotificationOwner, id: string) {
    const notification = await this.notifications.findOne({ where: { id, ...this.ownerWhere(owner) }, select: NOTIFICATION_DETAIL_FIELDS });
    if (!notification) throw new HttpError(404, 'Notification not found');
    return notification;
  }

  async markRead(owner: NotificationOwner, id: string) {
    const notification = await this.notifications.findOne({ where: { id, ...this.ownerWhere(owner) }, select: NOTIFICATION_LIST_FIELDS });
    if (!notification) throw new HttpError(404, 'Notification not found');
    await this.notifications.update(notification.id, { isRead: true, readAt: new Date() });
    this.publishNotificationUpdate(owner, notification.id);
    return this.notifications.findOne({ where: { id: notification.id }, select: NOTIFICATION_DETAIL_FIELDS });
  }

  async markAllRead(owner: NotificationOwner) {
    const where = this.ownerWhere(owner);
    await this.notifications.update({ ...where, isRead: false }, { isRead: true, readAt: new Date() });
    this.publishNotificationUpdate(owner);
    return this.list(owner);
  }

  async delete(owner: NotificationOwner, id: string) {
    const notification = await this.notifications.findOne({ where: { id, ...this.ownerWhere(owner) }, select: NOTIFICATION_LIST_FIELDS });
    if (!notification) throw new HttpError(404, 'Notification not found');
    await this.notifications.delete({ id: notification.id });
    this.publishNotificationUpdate(owner, notification.id);
    return { message: 'Notification deleted.' };
  }

  async clearAll(owner: NotificationOwner) {
    await this.notifications.delete(this.ownerWhere(owner));
    this.publishNotificationUpdate(owner);
    return { message: 'Notifications cleared.', data: [], unread: 0, total: 0 };
  }

  async sendWelcome(owner: NotificationOwner, name?: string) {
    const title = 'Welcome to Hook';
    const body = `Welcome${name ? `, ${name}` : ''}. Your marketplace is ready.`;
    await this.create(owner, title, body, 'welcome');
    await this.sendPushToOwner(owner, title, body, { type: 'welcome' });
  }

  async sendPushToOwner(owner: NotificationOwner, title: string, body: string, data?: Record<string, unknown>) {
    const devices = await this.findOwnerDevices(owner);
    await Promise.all(devices.map((device) => this.sendExpoPush(device.expoPushToken, title, body, data)));
  }

  async sendPushToDevice(expoPushToken: string, title: string, body: string, data?: Record<string, unknown>) {
    await this.sendExpoPush(expoPushToken, title, body, data);
  }

  private ownerWhere(owner: NotificationOwner) {
    return { userId: owner.userId };
  }

  private publishNotificationUpdate(owner: NotificationOwner, id?: string) {
    publishRealtime(
      { type: 'notification.updated', entityId: id, version: 1 },
      { accountId: owner.userId },
    );
  }

  private findOwnerDevices(owner: NotificationOwner) {
    return this.devices.find({ where: { userId: owner.userId, isActive: true } });
  }

  private async sendExpoPush(expoPushToken: string, title: string, body: string, data?: Record<string, unknown>) {
    await sendPushMessages([{ to: expoPushToken, title, body, data }]);
  }
}
