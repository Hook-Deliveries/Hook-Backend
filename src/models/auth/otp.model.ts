import { BaseEntity, createModel, createSchema } from '@models/base.model';

export interface Otp extends BaseEntity {
  email: string;
  code: string;
  type: 'email_verification' | 'password_reset' | 'phone_verification' | 'account_deletion';
  /** Wrong guesses so far; the code is burned after too many. */
  attempts?: number;
  isUsed: boolean;
  expiresAt: Date;
  isValid: boolean;
}

const OtpSchema = createSchema<Otp>({
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  code: { type: String, required: true },
  type: { type: String, default: 'email_verification' },
  isUsed: { type: Boolean, default: false },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
  deletedAt: { type: Date },
});

OtpSchema.index({ email: 1, code: 1 });
OtpSchema.virtual('isValid').get(function isValid(this: Otp) {
  return !this.isUsed && new Date() < this.expiresAt;
});

export const Otp = createModel<Otp>('Otp', OtpSchema);
