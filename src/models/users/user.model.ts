import { AccountStatus, AccountType, ScopeType, UserRole } from '@lib/constants';
import { BaseEntity, createModel, createSchema } from '@models/base.model';

export interface User extends BaseEntity {
  email: string;
  phone?: string;
  password?: string;
  authProvider?: 'password' | 'google' | 'apple';
  googleId?: string;
  appleId?: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  publicId?: string;
  accountType?: AccountType;
  accountStatus?: AccountStatus;
  roleIds?: string[];
  scopeType?: ScopeType;
  assignedStateIds?: string[];
  assignedHubIds?: string[];
  isEmailVerified: boolean;
  isPhoneVerified: boolean;
  avatarUrl?: string;
  address?: Record<string, unknown>;
  preferences?: Record<string, unknown>;
  permissions?: string[];
  assignedCategoryIds?: string[];
  operationalStateCode?: string;
  operationalStateName?: string;
  isActive: boolean;
  lastLoginAt?: Date;
  refreshToken?: string;
  failedLoginAttempts?: number;
  lockedUntil?: Date;
  passwordChangedAt?: Date;
  migratedFrom?: { model: string; sourceId: string; migratedAt: Date };
  originatingGuestId?: string;
  /** Minted on first use by ReferralService.ensureCode(), not at signup. */
  referralCode?: string;
}

const UserSchema = createSchema<User>({
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  phone: { type: String, sparse: true, trim: true },
  password: { type: String },
  authProvider: { type: String, enum: ['password', 'google', 'apple'], default: 'password', index: true },
  googleId: { type: String, sparse: true, unique: true, index: true },
  appleId: { type: String, sparse: true, unique: true, index: true },
  firstName: { type: String, default: '' },
  lastName: { type: String, default: '' },
  role: { type: String, enum: Object.values(UserRole), default: UserRole.SHOPPER, index: true },
  publicId: { type: String, unique: true, sparse: true, index: true },
  accountType: { type: String, enum: Object.values(AccountType), index: true },
  accountStatus: { type: String, enum: Object.values(AccountStatus), default: AccountStatus.ACTIVE, index: true },
  roleIds: { type: [String], default: [], index: true },
  scopeType: { type: String, enum: Object.values(ScopeType), default: ScopeType.SELF, index: true },
  assignedStateIds: { type: [String], default: [], index: true },
  assignedHubIds: { type: [String], default: [], index: true },
  isEmailVerified: { type: Boolean, default: false },
  isPhoneVerified: { type: Boolean, default: false },
  avatarUrl: { type: String },
  address: { type: Object },
  preferences: { type: Object },
  permissions: { type: [String], default: [] },
  assignedCategoryIds: { type: [String], default: [] },
  operationalStateCode: { type: String, uppercase: true, trim: true, index: true },
  operationalStateName: { type: String, trim: true },
  isActive: { type: Boolean, default: true, index: true },
  lastLoginAt: { type: Date },
  refreshToken: { type: String, index: true },
  failedLoginAttempts: { type: Number, default: 0 },
  lockedUntil: { type: Date },
  passwordChangedAt: { type: Date },
  migratedFrom: { type: Object },
  originatingGuestId: { type: String, sparse: true, index: true },
  referralCode: { type: String, unique: true, sparse: true, index: true, uppercase: true, maxlength: 20 },
  deletedAt: { type: Date },
});

UserSchema.index({ role: 1, isActive: 1 });
UserSchema.index({ role: 1, operationalStateCode: 1 });
UserSchema.index({ accountType: 1, accountStatus: 1 });

export const User = createModel<User>('User', UserSchema);
