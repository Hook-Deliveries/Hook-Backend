import { BaseEntity, createModel, createSchema } from '@models/base.model';

export type RecordStatus = 'active' | 'inactive';

export interface OperationState extends BaseEntity {
  publicId: string;
  name: string;
  capitalName: string;
  code: string;
  countryCode: string;
  status: RecordStatus;
  timezone: string;
  currency: string;
  deliveryPromiseHours: number;
  deliveryFeeMinor?: number;
  deliveryEnabled: boolean;
  operationsEnabled: boolean;
  deliveryPricingRuleId?: string;
  configuration?: Record<string, unknown>;
  legacy?: Record<string, unknown>;
}

export interface OperationCity extends BaseEntity {
  publicId: string;
  stateId: string;
  name: string;
  code: string;
  status: RecordStatus;
  defaultHubId?: string;
}

export interface OperationLocalGovernment extends BaseEntity {
  publicId: string;
  stateId: string;
  name: string;
  normalizedName: string;
  code?: string;
  status: RecordStatus;
  source: 'nga-states-lga' | 'fallback' | 'admin';
  sourceUpdatedAt?: Date;
}

export interface ServiceZone extends BaseEntity {
  publicId: string;
  stateId: string;
  cityId: string;
  name: string;
  code: string;
  status: RecordStatus;
  areaRules?: Record<string, unknown>;
  geometry?: Record<string, unknown>;
  deliveryEligible: boolean;
  deliveryFeeMinor?: number;
  deliveryPricingRuleId?: string;
}

const stateSchema = createSchema<OperationState>({
  publicId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true, trim: true },
  capitalName: { type: String, required: true, trim: true },
  code: { type: String, required: true, uppercase: true, trim: true, unique: true, index: true },
  countryCode: { type: String, default: 'NG', uppercase: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'inactive', index: true },
  timezone: { type: String, default: 'Africa/Lagos' },
  currency: { type: String, default: 'NGN' },
  deliveryPromiseHours: { type: Number, default: 24, min: 1 },
  deliveryFeeMinor: { type: Number, min: 0 },
  deliveryEnabled: { type: Boolean, default: true, index: true },
  operationsEnabled: { type: Boolean, default: false, index: true },
  deliveryPricingRuleId: { type: String, index: true, sparse: true },
  configuration: { type: Object },
  legacy: { type: Object },
});

const citySchema = createSchema<OperationCity>({
  publicId: { type: String, required: true, unique: true, index: true },
  stateId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, uppercase: true, trim: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'inactive', index: true },
  defaultHubId: { type: String, index: true },
});
citySchema.index({ stateId: 1, code: 1 }, { unique: true });

const localGovernmentSchema = createSchema<OperationLocalGovernment>({
  publicId: { type: String, required: true, unique: true, index: true },
  stateId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true },
  normalizedName: { type: String, required: true, trim: true },
  code: { type: String, trim: true, uppercase: true, sparse: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
  source: { type: String, enum: ['nga-states-lga', 'fallback', 'admin'], default: 'fallback' },
  sourceUpdatedAt: { type: Date },
  deletedAt: { type: Date },
});
localGovernmentSchema.index({ stateId: 1, normalizedName: 1 }, { unique: true });
localGovernmentSchema.index({ stateId: 1, status: 1, name: 1 });

const zoneSchema = createSchema<ServiceZone>({
  publicId: { type: String, required: true, unique: true, index: true },
  stateId: { type: String, required: true, index: true },
  cityId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, uppercase: true, trim: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'inactive', index: true },
  areaRules: { type: Object },
  geometry: { type: Object },
  deliveryEligible: { type: Boolean, default: false, index: true },
  deliveryFeeMinor: { type: Number, min: 0 },
  deliveryPricingRuleId: { type: String, index: true, sparse: true },
});
zoneSchema.index({ cityId: 1, code: 1 }, { unique: true });

export const OperationState = createModel<OperationState>('OperationState', stateSchema);
export const OperationCity = createModel<OperationCity>('OperationCity', citySchema);
export const OperationLocalGovernment = createModel<OperationLocalGovernment>('OperationLocalGovernment', localGovernmentSchema);
export const ServiceZone = createModel<ServiceZone>('ServiceZone', zoneSchema);
