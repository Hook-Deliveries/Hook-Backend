import { BaseEntity, createModel, createSchema } from '@models/base.model';

export interface LegalContent extends BaseEntity {
  type: 'terms' | 'privacy' | 'returns';
  title: string;
  bodyHtml: string;
  version: number;
  effectiveDate: Date;
  updatedBy?: string;
}

const legalContentSchema = createSchema<LegalContent>({
  type: { type: String, enum: ['terms', 'privacy', 'returns'], unique: true, required: true },
  title: { type: String, required: true, trim: true },
  bodyHtml: { type: String, required: true },
  version: { type: Number, default: 1, min: 1 },
  effectiveDate: { type: Date, required: true, default: Date.now },
  updatedBy: { type: String },
});

export const LegalContent = createModel<LegalContent>('LegalContent', legalContentSchema);
