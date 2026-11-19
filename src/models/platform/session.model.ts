import { AccountType } from '@lib/constants';
import { BaseEntity, createModel, createSchema } from '@models/base.model';

export interface AccountSession extends BaseEntity {
  accountId: string;
  accountType: AccountType;
  familyId: string;
  refreshTokenHash: string;
  deviceId?: string;
  deviceName?: string;
  platform?: string;
  ipAddress?: string;
  userAgent?: string;
  expiresAt: Date;
  lastUsedAt: Date;
  revokedAt?: Date;
  revokedBy?: string;
  revocationReason?: string;
  /** A vendor chose to keep the default password for this sign-in. Each new sign-in starts without it, so they are asked again. */
  defaultPasswordKeptAt?: Date;
}

const schema = createSchema<AccountSession>({
  accountId: { type: String, required: true, index: true },
  accountType: { type: String, enum: Object.values(AccountType), required: true, index: true },
  familyId: { type: String, required: true, index: true },
  refreshTokenHash: { type: String, required: true, unique: true, index: true },
  deviceId: { type: String, index: true },
  deviceName: { type: String },
  platform: { type: String },
  ipAddress: { type: String },
  userAgent: { type: String },
  expiresAt: { type: Date, required: true },
  lastUsedAt: { type: Date, required: true },
  revokedAt: { type: Date, index: true },
  revokedBy: { type: String },
  revocationReason: { type: String },
  defaultPasswordKeptAt: { type: Date },
});

schema.index({ accountId: 1, revokedAt: 1, expiresAt: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AccountSession = createModel<AccountSession>('AccountSession', schema);
