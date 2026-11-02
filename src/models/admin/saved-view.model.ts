import { BaseEntity, createModel, createSchema } from '@models/base.model';

export interface AdminSavedView extends BaseEntity {
  publicId: string;
  adminUserId: string;
  /** Which admin list page this view applies to, e.g. "products". */
  page: string;
  name: string;
  /** The exact filter/sort query-string keys that page's useUrlFilters manages. */
  params: Record<string, string>;
}

const AdminSavedViewSchema = createSchema<AdminSavedView>({
  publicId: { type: String, required: true, unique: true, index: true },
  adminUserId: { type: String, required: true, index: true },
  page: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  params: { type: Object, required: true },
  deletedAt: { type: Date },
});

AdminSavedViewSchema.index({ adminUserId: 1, page: 1 });

export const AdminSavedView = createModel<AdminSavedView>('AdminSavedView', AdminSavedViewSchema);
