import { Notification } from "@models/notifications/notification.model";
import { publishRealtime } from "@modules/platform/realtime.service";
import { notifyPush } from "@services/push.service";
import { definitionFor } from "../notifications/catalog";

export async function createCommerceNotification(input: {
  eventKey: string;
  userId: string;
  title: string;
  body: string;
  type: string;
  data?: Record<string, unknown>;
}) {
  const definition = definitionFor(input.type);
  const result = await Notification.findOneAndUpdate(
    { eventKey: input.eventKey },
    { $setOnInsert: { ...input, isRead: false, group: definition.group, priority: definition.priority } },
    { upsert: true, returnDocument: "after", includeResultMetadata: true },
  );
  // Replays still invalidate the bell's cache (cheap, keeps counts correct), but only
  // a genuine first insert carries title/body/href — that's what lets the frontend pop
  // a toast without a second round-trip, and a replay must not toast twice.
  const isNew = !result.lastErrorObject?.updatedExisting;
  publishRealtime(
    { type: "notification.created", entityId: input.eventKey, version: 1, data: isNew ? { title: input.title, body: input.body, href: (input.data as { href?: string } | undefined)?.href } : undefined },
    { accountId: input.userId },
  );
  // Push only when this call created the notification. Callers run inside
  // at-least-once outbox consumers, so a replay must not buzz the phone again.
  if (isNew) {
    // The push says where to go: the app opens `screen` with `params` (and
    // still reads orderId at the top level for older app versions).
    const notificationId = (result.value as { _id?: { toString(): string } } | null)?._id?.toString();
    void notifyPush(input.userId, {
      title: input.title,
      body: input.body,
      data: { type: input.type, group: definition.group, screen: definition.screen, params: input.data || {}, notificationId, ...(input.data || {}) },
    }).then(() => notificationId ? Notification.updateOne({ _id: notificationId }, { $set: { pushedAt: new Date() } }) : undefined).catch(() => undefined);
  }
  return result.value;
}
