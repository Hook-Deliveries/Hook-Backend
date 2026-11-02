import { BaseEntity, createModel, createSchema } from '@models/base.model';

/**
 * Expo answers a push send with a "ticket" per message; whether the phone
 * actually accepted it (or the token is dead) only shows up later in a
 * "receipt". Tickets are kept just long enough to collect their receipts.
 */
export interface PushTicket extends BaseEntity {
  ticketId: string;
  expoPushToken: string;
}

const schema = createSchema<PushTicket>({
  ticketId: { type: String, required: true, unique: true },
  expoPushToken: { type: String, required: true },
  deletedAt: { type: Date },
});
// Expo only keeps receipts for 24 hours, so nothing older is worth asking about.
schema.index({ createdAt: 1 }, { expireAfterSeconds: 36 * 60 * 60 });

export const PushTicket = createModel<PushTicket>('PushTicket', schema);
