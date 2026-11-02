import { BaseEntity, createModel, createSchema } from '@models/base.model';

export interface StaffProfile extends BaseEntity {
  publicId: string;
  accountId: string;
  roleIds: string[];
  scopeType: string;
  stateIds: string[];
  hubIds: string[];
  status: 'invited' | 'active' | 'suspended' | 'disabled';
}

export interface MarketAssociateProfile extends BaseEntity {
  publicId: string;
  accountId: string;
  stateIds: string[];
  hubIds: string[];
  availability: 'available' | 'unavailable' | 'paused';
  status: 'invited' | 'active' | 'suspended' | 'disabled';
  performance?: Record<string, unknown>;
  legacy?: Record<string, unknown>;
}

export interface HookPartner extends BaseEntity {
  publicId: string;
  accountId: string;
  name: string;
  stateId: string;
  cityId: string;
  zoneId?: string;
  /** The Market this Partner location operates within — where it draws its assisted-checkout customers from. */
  marketId?: string;
  address: string;
  coordinates?: { lat: number; lng: number };
  contact: Record<string, unknown>;
  devicePolicy?: Record<string, unknown>;
  status: 'invited' | 'active' | 'suspended' | 'disabled';
  legacy?: Record<string, unknown>;
}

export interface MarketAssociateMarketAssignment extends BaseEntity {
  publicId?: string;
  marketAssociateId: string;
  marketId: string;
  stateId: string;
  preferredHubId?: string;
  priority: number;
  isPrimary: boolean;
  status: 'pending' | 'active' | 'paused' | 'ended';
  activeFrom: Date;
  activeTo?: Date;
  assignmentReason: string;
  createdBy: string;
  updatedBy?: string;
  history: Record<string, unknown>[];
}

const staffSchema = createSchema<StaffProfile>({
  publicId: { type: String, required: true, unique: true, index: true },
  accountId: { type: String, required: true, unique: true, index: true },
  roleIds: { type: [String], default: [], index: true },
  scopeType: { type: String, required: true, index: true },
  stateIds: { type: [String], default: [], index: true },
  hubIds: { type: [String], default: [], index: true },
  status: { type: String, enum: ['invited', 'active', 'suspended', 'disabled'], default: 'invited', index: true },
});

const marketAssociateSchema = createSchema<MarketAssociateProfile>({
  publicId: { type: String, required: true, unique: true, index: true },
  accountId: { type: String, required: true, unique: true, index: true },
  stateIds: { type: [String], default: [], index: true },
  hubIds: { type: [String], default: [], index: true },
  availability: { type: String, enum: ['available', 'unavailable', 'paused'], default: 'unavailable', index: true },
  status: { type: String, enum: ['invited', 'active', 'suspended', 'disabled'], default: 'invited', index: true },
  performance: { type: Object },
  legacy: { type: Object },
});

const partnerSchema = createSchema<HookPartner>({
  publicId: { type: String, required: true, unique: true, index: true },
  accountId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true, trim: true },
  stateId: { type: String, required: true, index: true },
  cityId: { type: String, required: true, index: true },
  zoneId: { type: String, index: true },
  marketId: { type: String, index: true },
  address: { type: String, required: true },
  coordinates: { type: Object },
  contact: { type: Object, required: true },
  devicePolicy: { type: Object },
  status: { type: String, enum: ['invited', 'active', 'suspended', 'disabled'], default: 'invited', index: true },
  legacy: { type: Object },
});

const assignmentSchema = createSchema<MarketAssociateMarketAssignment>({
  publicId: { type: String, unique: true, sparse: true, index: true },
  marketAssociateId: { type: String, required: true, index: true },
  marketId: { type: String, required: true, index: true },
  stateId: { type: String, required: true, index: true },
  preferredHubId: { type: String, index: true },
  priority: { type: Number, default: 100, min: 1 },
  isPrimary: { type: Boolean, default: false },
  status: { type: String, enum: ['pending', 'active', 'paused', 'ended'], default: 'pending', index: true },
  activeFrom: { type: Date, required: true },
  activeTo: { type: Date },
  assignmentReason: { type: String, required: true },
  createdBy: { type: String, required: true },
  updatedBy: { type: String },
  history: { type: [Object], default: [] },
});
assignmentSchema.index(
  { marketAssociateId: 1, stateId: 1, isPrimary: 1 },
  { unique: true, partialFilterExpression: { status: 'active', isPrimary: true } },
);
assignmentSchema.index({ marketAssociateId: 1, marketId: 1, status: 1 });

export const StaffProfile = createModel<StaffProfile>('StaffProfile', staffSchema);
export const MarketAssociateProfile = createModel<MarketAssociateProfile>('MarketAssociateProfile', marketAssociateSchema, 'marketassociateprofiles');
export const HookPartner = createModel<HookPartner>('HookPartner', partnerSchema);
export const MarketAssociateMarketAssignment = createModel<MarketAssociateMarketAssignment>('MarketAssociateMarketAssignment', assignmentSchema, 'marketassociatemarketassignments');
