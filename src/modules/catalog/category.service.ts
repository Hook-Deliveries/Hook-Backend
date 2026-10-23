import { isValidObjectId } from 'mongoose';
import { Category, type CategoryAttribute } from '@models/categories/category.model';
import { HttpError } from '@utils/http';
import { SIZE_PRESETS } from '../../database/category-tree';

type CategoryDoc = {
  _id: { toString(): string };
  id?: string;
  publicId?: string;
  name: string;
  slug: string;
  parentId?: string;
  level?: number;
  path?: string;
  isActive: boolean;
  deletedAt?: Date;
  sortOrder?: number;
  iconUrl?: string;
  description?: string;
  attributeSchema?: { attributes?: CategoryAttribute[]; sizingGuide?: unknown };
};

export type VariantInput = { size?: string; colour?: string; attributes?: Record<string, string> };

const idOf = (category: CategoryDoc) => category._id.toString();
const norm = (value: unknown) => String(value ?? '').trim().toLowerCase();

/**
 * Every rule about the category tree lives here: who a product may be filed
 * under, what it must be told about itself, and which categories a filter
 * on a parent should cover. Only two levels exist (category, sub-category).
 */
export class CategoryService {
  private async all(): Promise<CategoryDoc[]> {
    return Category.find({ deletedAt: { $exists: false } }).sort({ sortOrder: 1, name: 1 }).lean({ virtuals: true }) as unknown as Promise<CategoryDoc[]>;
  }

  async find(identifier: string): Promise<CategoryDoc | undefined> {
    const query = isValidObjectId(identifier) ? { $or: [{ _id: identifier }, { publicId: identifier }] } : { publicId: identifier };
    return (await Category.findOne({ ...query, deletedAt: { $exists: false } }).lean({ virtuals: true })) as unknown as CategoryDoc | undefined;
  }

  /** Resolves a public id, internal id or slug to a category, or throws 404. */
  async require(identifier: string): Promise<CategoryDoc> {
    const found = (await this.find(identifier))
      || ((await Category.findOne({ slug: identifier, deletedAt: { $exists: false } }).lean({ virtuals: true })) as unknown as CategoryDoc | undefined);
    if (!found) throw new HttpError(404, 'Category not found', undefined, 'NOT_FOUND');
    return found;
  }

  /** Attributes for a category: its own, or its parent's when it defines none. */
  resolveAttributes(category: CategoryDoc, byId: Map<string, CategoryDoc>): CategoryAttribute[] {
    const own = category.attributeSchema?.attributes;
    if (Array.isArray(own) && own.length) return own;
    const parent = category.parentId ? byId.get(category.parentId) : undefined;
    return parent ? this.resolveAttributes(parent, byId) : [];
  }

  /** The tree for customers and pickers. Inactive categories, and children of inactive parents, are hidden unless asked for. */
  /** The category's own sizing guide, else its parent's. Null when there is none or an admin switched it off. */
  guideFor(row: CategoryDoc, byId: Map<string, CategoryDoc>) {
    const usable = (guide: unknown) => {
      const value = guide as { enabled?: boolean; summary?: string; chart?: unknown[] } | undefined;
      return value && value.enabled !== false && (value.summary || value.chart?.length) ? value : null;
    };
    const own = row.attributeSchema?.sizingGuide as { enabled?: boolean } | undefined;
    if (own && own.enabled === false) return null;
    return usable(own) || (row.parentId ? usable(byId.get(row.parentId)?.attributeSchema?.sizingGuide) : null);
  }

  async tree(options: { includeInactive?: boolean } = {}) {
    const rows = await this.all();
    const byId = new Map(rows.map((row) => [idOf(row), row]));
    const visible = (row: CategoryDoc) => options.includeInactive || (row.isActive && (!row.parentId || byId.get(row.parentId)?.isActive));
    const present = (row: CategoryDoc) => ({
      id: row.publicId || idOf(row),
      internalId: idOf(row),
      publicId: row.publicId,
      name: row.name,
      slug: row.slug,
      level: row.level ?? (row.parentId ? 1 : 0),
      parentId: row.parentId ? byId.get(row.parentId)?.publicId || row.parentId : undefined,
      iconUrl: row.iconUrl,
      description: row.description,
      isActive: row.isActive,
      attributes: this.resolveAttributes(row, byId).map((attribute) => ({ ...attribute, options: this.optionsOf(attribute) })),
      sizingGuide: this.guideFor(row, byId),
    });
    const roots = rows.filter((row) => !row.parentId && visible(row));
    return roots.map((root) => ({
      ...present(root),
      children: rows.filter((row) => row.parentId === idOf(root) && visible(row)).map(present),
    }));
  }

  /**
   * Parent and resolved attributes for a set of categories, keyed by internal
   * id. Used to enrich product payloads with a breadcrumb and the product's
   * selectable details.
   */
  async describe(ids: string[]) {
    const rows = await this.all();
    const byId = new Map(rows.map((row) => [idOf(row), row]));
    const result = new Map<string, { sizingGuide: unknown; parent: { publicId?: string; name: string; slug: string } | null; attributes: Array<CategoryAttribute & { options?: string[] }> }>();
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) continue;
      const parent = row.parentId ? byId.get(row.parentId) : undefined;
      result.set(id, {
        sizingGuide: this.guideFor(row, byId),
        parent: parent ? { publicId: parent.publicId, name: parent.name, slug: parent.slug } : null,
        attributes: this.resolveAttributes(row, byId).map((attribute) => ({ ...attribute, options: this.optionsOf(attribute) })),
      });
    }
    return result;
  }

  /** Allowed values for an attribute: explicit options, or the size preset's list. */
  optionsOf(attribute: CategoryAttribute) {
    if (attribute.options?.length) return attribute.options;
    if (attribute.type === 'size' && attribute.preset) return SIZE_PRESETS[attribute.preset];
    return undefined;
  }

  /**
   * The category and everything beneath it, as the internal ids that
   * `Product.categoryId` stores. A filter on a parent must cover its leaves.
   */
  async descendantIds(identifier: string): Promise<string[]> {
    const category = await this.find(identifier);
    if (!category) return [identifier];
    const children = (await Category.find({ parentId: idOf(category), deletedAt: { $exists: false } }).select('_id').lean()) as Array<{ _id: { toString(): string } }>;
    return [idOf(category), ...children.map((child) => child._id.toString())];
  }

  /** Products may only be filed under an active leaf whose parent is active too. */
  async assertAssignable(identifier: string): Promise<CategoryDoc> {
    const category = await this.require(identifier);
    if (!category.isActive) throw new HttpError(409, 'The selected category is inactive', undefined, 'CONFLICT');
    const children = await Category.countDocuments({ parentId: idOf(category), isActive: true, deletedAt: { $exists: false } });
    if (children > 0) {
      throw new HttpError(409, `"${category.name}" has sub-categories. Choose one of them instead.`, { categoryId: idOf(category) }, 'CONFLICT');
    }
    if (category.parentId) {
      const parent = (await Category.findById(category.parentId).lean()) as CategoryDoc | null;
      if (!parent || parent.deletedAt || !parent.isActive) throw new HttpError(409, 'The parent category is inactive', undefined, 'CONFLICT');
    }
    return category;
  }

  /** Attributes that apply to a leaf, resolved through inheritance. */
  async attributesFor(category: CategoryDoc): Promise<CategoryAttribute[]> {
    const byId = new Map((await this.all()).map((row) => [idOf(row), row]));
    return this.resolveAttributes(category, byId);
  }

  /**
   * Checks variants against what the category asks for. A category with no
   * attribute template (older data) accepts anything, so nothing breaks
   * until an admin defines one.
   */
  async validateVariants(category: CategoryDoc, variants: VariantInput[]) {
    const attributes = await this.attributesFor(category);
    if (!attributes.length) return;
    const errors: string[] = [];
    const usesSize = attributes.some((attribute) => attribute.type === 'size' || attribute.key === 'size');
    const usesColour = attributes.some((attribute) => attribute.type === 'colour');
    // Keys a variant may carry: the category's own, plus the legacy colour/size spellings.
    const known = new Set([...attributes.map((attribute) => attribute.key), 'colour', 'color', 'size']);

    variants.forEach((variant, index) => {
      const row = variants.length > 1 ? `Variant ${index + 1}: ` : '';
      const valueOf = (attribute: CategoryAttribute) =>
        attribute.type === 'size' || attribute.key === 'size' ? variant.size
          : attribute.type === 'colour' ? variant.colour
            : variant.attributes?.[attribute.key];
      for (const attribute of attributes) {
        const value = valueOf(attribute);
        if (!String(value ?? '').trim()) {
          if (attribute.required) errors.push(`${row}${attribute.label} is required for ${category.name}`);
          continue;
        }
        const options = this.optionsOf(attribute);
        if (attribute.type === 'select' && options && !options.some((option) => norm(option) === norm(value))) {
          errors.push(`${row}${attribute.label} must be one of: ${options.join(', ')}`);
        }
      }
      if (!usesSize && String(variant.size ?? '').trim()) errors.push(`${row}${category.name} does not use sizes`);
      if (!usesColour && String(variant.colour ?? '').trim()) errors.push(`${row}${category.name} does not use a colour`);
      for (const [key, value] of Object.entries(variant.attributes || {})) {
        if (String(value ?? '').trim() && !known.has(key)) errors.push(`${row}${key} is not asked for by ${category.name}`);
      }
    });

    if (errors.length) throw new HttpError(400, errors[0], { errors }, 'VALIDATION_ERROR');
  }
}

export const categoryService = new CategoryService();
