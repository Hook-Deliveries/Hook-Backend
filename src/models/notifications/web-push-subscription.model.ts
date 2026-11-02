import { BaseEntity, createModel, createSchema } from '@models/base.model';

/**
 * Browser (Web Push/VAPID) push subscription for a staff, Market Associate
 * or Partner account. Kept separate from DeviceToken, which is Expo-only and
 * required/unique on a single token string — a browser subscription's shape
 * (endpoint + two keys) doesn't fit that field.
 */
export interface WebPushSubscription extends BaseEntity {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  isActive: boolean;
  lastSeenAt: Date;
}

const schema = createSchema<WebPushSubscription>({
  userId: { type: String, required: true, index: true },
  endpoint: { type: String, required: true, unique: true, index: true },
  p256dh: { type: String, required: true },
  auth: { type: String, required: true },
  isActive: { type: Boolean, default: true, index: true },
  lastSeenAt: { type: Date, default: Date.now },
  deletedAt: { type: Date },
});

schema.index({ userId: 1, isActive: 1 });

export const WebPushSubscription = createModel<WebPushSubscription>('WebPushSubscription', schema);
