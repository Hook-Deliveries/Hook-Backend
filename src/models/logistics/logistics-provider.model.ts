import { BaseEntity, createModel, createSchema } from '@models/base.model';

/** Admin-managed courier the customer can pick at checkout; distinct from LogisticsProviderName, which names the runtime booking adapters. */
export interface LogisticsProvider extends BaseEntity {
  publicId: string;
  code: string;
  name: string;
  logoUrl?: string;
  description?: string;
  feeMinor: number;
  status: 'active' | 'inactive';
  sortOrder: number;
  createdBy?: string;
}

const schema = createSchema<LogisticsProvider>({
  publicId: { type: String, unique: true, sparse: true, index: true },
  code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 40 },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  logoUrl: { type: String },
  description: { type: String, maxlength: 300 },
  // Deprecated: delivery is priced per State (OperationState.deliveryFeeMinor).
  feeMinor: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
  sortOrder: { type: Number, default: 0 },
  createdBy: { type: String },
  deletedAt: { type: Date },
});

schema.index({ status: 1, sortOrder: 1, name: 1 });

export const LogisticsProvider = createModel<LogisticsProvider>('LogisticsProvider', schema);
