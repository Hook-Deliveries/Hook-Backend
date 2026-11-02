import { BaseEntity, createModel, createSchema } from '@models/base.model';

/** One thing a product in this category asks for: a size, a colour, or any other detail. */
export type CategoryAttributeType = 'size' | 'colour' | 'select' | 'text';
export type SizePreset = 'clothing' | 'uk-dress' | 'shoes' | 'kids-shoes' | 'bra' | 'general';
export interface CategoryAttribute {
  key: string;
  label: string;
  type: CategoryAttributeType;
  required: boolean;
  /** Allowed values for `select` (and `size` when not using a preset). */
  options?: string[];
  preset?: SizePreset;
  /** True when different values are different purchasable variants (size, colour, capacity). */
  variantAxis: boolean;
}

export interface Category extends BaseEntity {
  publicId?: string;
  name: string;
  slug: string;
  iconUrl?: string;
  description?: string;
  sortOrder: number;
  isActive: boolean;
  /** The parent category's id. Only two levels exist: a category and its sub-categories. */
  parentId?: string;
  /** 0 for a top-level category, 1 for a sub-category. */
  level?: number;
  /** Slug path, e.g. `shoes/shoes-sneakers-male`. */
  path?: string;
  /** `attributes` (CategoryAttribute[]) and `sizingGuide`. A sub-category inherits its parent's attributes when it defines none. */
  attributeSchema?: Record<string, unknown>;
  requiredAttributes?: string[];
  optionalAttributes?: string[];
  variantAttributes?: string[];
  parent?: any;
  children?: any[];
  products?: any[];
}

const CategorySchema = createSchema<Category>({
  publicId: { type: String, unique: true, sparse: true, index: true },
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true, trim: true },
  iconUrl: { type: String },
  description: { type: String },
  sortOrder: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true, index: true },
  parentId: { type: String, index: true },
  level: { type: Number, default: 0, index: true },
  path: { type: String },
  attributeSchema: { type: Object, default: {} },
  requiredAttributes: { type: [String], default: [] },
  optionalAttributes: { type: [String], default: [] },
  variantAttributes: { type: [String], default: [] },
  deletedAt: { type: Date },
});

// A name only has to be unique among its siblings ("Dresses" can sit under Clothing and elsewhere).
CategorySchema.index({ parentId: 1, name: 1 }, { unique: true });

export const Category = createModel<Category>('Category', CategorySchema);
