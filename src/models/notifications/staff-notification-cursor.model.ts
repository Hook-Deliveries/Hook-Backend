import { BaseEntity, createModel, createSchema } from '@models/base.model';

/** How far a staff account's notifications have been caught up, so missed ones are sent once and cleared ones are not resurrected. */
export interface StaffNotificationCursor extends BaseEntity {
  accountId: string;
  syncedUntil: Date;
  /** Rules this account was permitted for at the last sync; a newly permitted rule is caught up from scratch. */
  rules: string[];
}

const schema = createSchema<StaffNotificationCursor>({
  accountId: { type: String, required: true, unique: true, index: true },
  syncedUntil: { type: Date, required: true },
  rules: { type: [String], default: [] },
});

export const StaffNotificationCursor = createModel<StaffNotificationCursor>('StaffNotificationCursor', schema);
