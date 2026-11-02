import { BaseEntity, createModel, createSchema } from '@models/base.model';

export interface Faq extends BaseEntity {
  publicId: string;
  question: string;
  answer: string;
  order: number;
  isActive: boolean;
  updatedBy?: string;
}

const faqSchema = createSchema<Faq>({
  publicId: { type: String, required: true, unique: true, index: true },
  question: { type: String, required: true, trim: true, maxlength: 200 },
  answer: { type: String, required: true, trim: true, maxlength: 2000 },
  order: { type: Number, default: 0, index: true },
  isActive: { type: Boolean, default: true, index: true },
  updatedBy: { type: String },
});

export const Faq = createModel<Faq>('Faq', faqSchema);
