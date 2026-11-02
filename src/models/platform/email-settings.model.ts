import { BaseEntity, createModel, createSchema } from '@models/base.model';

export interface EmailSettings extends BaseEntity {
  key: 'email';
  supportEmail?: string;
  hookOpsEmail?: string;
  appName?: string;
  appUrl?: string;
  // Where "Help & Support" opens across every client (app, Market Associate portal, Partner portal).
  supportUrl?: string;
  updatedBy?: string;
}

const emailSettingsSchema = createSchema<EmailSettings>({
  key: { type: String, enum: ['email'], unique: true, default: 'email' },
  supportEmail: { type: String },
  hookOpsEmail: { type: String },
  appName: { type: String },
  appUrl: { type: String },
  supportUrl: { type: String },
  updatedBy: { type: String },
});

export const EmailSettings = createModel<EmailSettings>('EmailSettings', emailSettingsSchema);
