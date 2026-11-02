import { BaseEntity, createModel, createSchema } from '@models/base.model';

/** An audit trail row for an admin-composed push/email/inbox send — the fan-out itself isn't stored, only who sent what to how many. */
export interface Broadcast extends BaseEntity {
  publicId: string;
  title: string;
  body: string;
  channels: string[];
  audience: Record<string, unknown>;
  recipientCount: number;
  sentByUserId: string;
  sentAt: Date;
}

const schema = createSchema<Broadcast>({
  publicId: { type: String, required: true, unique: true, index: true },
  title: { type: String, required: true, maxlength: 150 },
  body: { type: String, required: true, maxlength: 2000 },
  channels: { type: [String], required: true },
  audience: { type: Object, required: true },
  recipientCount: { type: Number, required: true, min: 0 },
  sentByUserId: { type: String, required: true, index: true },
  sentAt: { type: Date, required: true, default: Date.now, index: true },
  deletedAt: { type: Date },
});

export const Broadcast = createModel<Broadcast>('Broadcast', schema);
