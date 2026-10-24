import { Request, Response } from 'express';
import { announce } from '@modules/notifications/engagement-notifications.service';
import { UserRole } from '@lib/constants';
import { HttpError, sendCreated, sendSuccess } from '@utils/http';
import { adminRepos, actor, routeParam } from './admin.helpers';
import { nextPublicId } from '@modules/platform/public-id.service';
import { publishRealtime } from '@modules/platform/realtime.service';
import { Product } from '@models/products/product.model';
import { User } from '@models/users/user.model';
import { adminCategoryCache } from '@lib/ttl-cache';
import { Category } from '@models/categories/category.model';
import { categoryService } from '@modules/catalog/category.service';

const MANAGER_ROLES: UserRole[] = [UserRole.SUPPORT, UserRole.ADMIN];

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'category';
}

function toManager(user: any) {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phone: user.phone || null,
    role: user.role,
  };
}

function publishCategoryUpdate(category: any) {
  const event = {
    entityId: category.publicId || category.id,
    version: Number(category.version || 1),
  };
  publishRealtime({ type: 'catalog.updated', entityType: 'category', ...event }, { public: true, admin: true });
  publishRealtime({ type: 'home.updated', entityType: 'category', ...event }, { public: true, admin: true });
  publishRealtime({ type: 'admin.dashboard.updated', ...event }, { admin: true });
}

async function loadEnrichment() {
  const [products, users] = await Promise.all([
    Product.aggregate([
      { $match: { categoryId: { $exists: true }, deletedAt: { $exists: false } } },
      { $group: { _id: '$categoryId', count: { $sum: 1 } } },
    ]),
    User.find({ role: { $in: MANAGER_ROLES }, isActive: true, assignedCategoryIds: { $exists: true, $ne: [] } })
      .select('publicId firstName lastName email phone role assignedCategoryIds')
      .lean({ virtuals: true }),
  ]);

  const productCounts = new Map<string, number>();
  for (const product of products as any[]) {
    productCounts.set(String(product._id), Number(product.count || 0));
  }

  const managersByCategory = new Map<string, any[]>();
  for (const user of users as any[]) {
    if (!MANAGER_ROLES.includes(user.role)) continue;
    for (const categoryId of user.assignedCategoryIds || []) {
      const bucket = managersByCategory.get(categoryId) || [];
      bucket.push(toManager(user));
      managersByCategory.set(categoryId, bucket);
    }
  }

  return { productCounts, managersByCategory };
}

export class AdminCategoriesController {
  list = async (_req: Request, res: Response) => {
    const cached = adminCategoryCache.get('list');
    if (cached) {
      sendSuccess(res, { data: cached, total: cached.length });
      return;
    }
    const [categories, { productCounts, managersByCategory }] = await Promise.all([
      adminRepos.categories().find({ order: { sortOrder: 'ASC', name: 'ASC' } }),
      loadEnrichment(),
    ]);

    const rows = categories as any[];
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const directCount = (id: string) => productCounts.get(id) || 0;
    // A parent's count is the sum of its sub-categories' products plus any of its own.
    const rolledUp = (category: any) =>
      directCount(category.id) + rows.filter((row) => row.parentId === category.id).reduce((sum, row) => sum + directCount(row.id), 0);

    const data = rows.map((category) => ({
      id: category.id,
      publicId: category.publicId,
      name: category.name,
      slug: category.slug,
      description: category.description || '',
      iconUrl: category.iconUrl || null,
      sortOrder: category.sortOrder ?? 0,
      isActive: category.isActive,
      createdAt: category.createdAt,
      parentId: category.parentId || null,
      parentName: category.parentId ? byId.get(category.parentId)?.name || null : null,
      level: category.level ?? (category.parentId ? 1 : 0),
      childCount: rows.filter((row) => row.parentId === category.id).length,
      productCount: rolledUp(category),
      managers: managersByCategory.get(category.id) || [],
      hasSizingGuide: Boolean(category.attributeSchema?.sizingGuide?.summary) && category.attributeSchema?.sizingGuide?.enabled !== false,
      attributes: category.attributeSchema?.attributes || [],
      inheritsAttributes: !(category.attributeSchema?.attributes || []).length && Boolean(category.parentId),
      attributeSchema: { sizingGuide: category.attributeSchema?.sizingGuide || null },
    }));

    adminCategoryCache.set('list', data);
    sendSuccess(res, { data, total: data.length });
  };

  /** Staff who can be put in charge of a category, with who is in charge of this one now. */
  managerOptions = async (req: Request, res: Response) => {
    const category = await categoryService.require(routeParam(req.params.id));
    const id = String(category._id);
    const users = await User.find({ role: { $in: MANAGER_ROLES }, isActive: true })
      .select('publicId firstName lastName email phone role assignedCategoryIds')
      .sort({ firstName: 1 })
      .lean({ virtuals: true });
    sendSuccess(res, (users as any[]).map((user) => ({ ...toManager(user), assigned: (user.assignedCategoryIds || []).includes(id) })));
  };

  /** Replaces who is in charge of this category. Only the people named here keep it. */
  setManagers = async (req: Request, res: Response) => {
    const category = await categoryService.require(routeParam(req.params.id));
    const id = String(category._id);
    const wanted: string[] = req.body.userIds;
    const staff = await User.find({ publicId: { $in: wanted }, role: { $in: MANAGER_ROLES }, isActive: true }).select('_id').lean();
    if (staff.length !== new Set(wanted).size) throw new HttpError(400, 'One or more people cannot manage categories');
    const keep = staff.map((user: any) => user._id);
    await User.updateMany({ assignedCategoryIds: id, _id: { $nin: keep } }, { $pull: { assignedCategoryIds: id } });
    await User.updateMany({ _id: { $in: keep } }, { $addToSet: { assignedCategoryIds: id } });
    const auditLogs = adminRepos.auditLogs();
    await auditLogs.save(auditLogs.create({
      action: 'category.managers',
      resourceType: 'category',
      resourceId: id,
      details: `Set ${wanted.length} manager(s) for "${category.name}"`,
      status: 'success',
      ...actor(req),
    }));
    adminCategoryCache.clear?.();
    const { managersByCategory } = await loadEnrichment();
    sendSuccess(res, { managers: managersByCategory.get(id) || [] });
  };

  detail = async (req: Request, res: Response) => {
    const category: any = await adminRepos.categories().findOne({ where: { id: routeParam(req.params.id) } });
    if (!category) throw new HttpError(404, 'Category not found');

    const { productCounts, managersByCategory } = await loadEnrichment();

    sendSuccess(res, {
      ...category,
      productCount: productCounts.get(category.id) || 0,
      managers: managersByCategory.get(category.id) || [],
    });
  };

  create = async (req: Request, res: Response) => {
    const categories = adminRepos.categories();
    const name = String(req.body.name).trim();
    let parent: any;
    if (req.body.parentId) {
      parent = await categoryService.require(String(req.body.parentId));
      // Only two levels: a sub-category cannot have children of its own.
      if (parent.parentId) throw new HttpError(400, `"${parent.name}" is already a sub-category. Choose a top-level category as the parent.`);
      const productsOnParent = await Product.countDocuments({ categoryId: parent._id.toString(), deletedAt: { $exists: false } });
      if (productsOnParent > 0) throw new HttpError(409, `"${parent.name}" has ${productsOnParent} product(s) filed directly under it. Move them first, then add sub-categories.`);
    }
    const slug = parent ? `${parent.slug}-${slugify(name)}` : slugify(name);

    const existing: any = await categories.findOne({ where: [{ name }, { slug }] as any });
    if (existing) throw new HttpError(400, `A category named "${existing.name}" already exists`);

    const category = await categories.save(categories.create({
      publicId: await nextPublicId('category'),
      name,
      slug,
      description: req.body.description || '',
      iconUrl: req.body.iconUrl,
      sortOrder: req.body.sortOrder ?? 0,
      isActive: true,
      parentId: parent ? parent._id.toString() : undefined,
      level: parent ? 1 : 0,
      path: parent ? `${parent.slug}/${slug}` : slug,
      attributeSchema: {
        ...(req.body.sizingGuide ? { sizingGuide: req.body.sizingGuide } : {}),
        ...(req.body.attributes?.length ? { attributes: req.body.attributes } : {}),
      },
    }));

    const auditLogs = adminRepos.auditLogs();
    await auditLogs.save(auditLogs.create({
      action: 'category.create',
      resourceType: 'category',
      resourceId: (category as any).id,
      details: `Created ${parent ? 'sub-category' : 'category'} "${name}"${parent ? ` under "${parent.name}"` : ''}`,
      status: 'success',
      ...actor(req),
    }));

    publishCategoryUpdate(category);
    adminCategoryCache.clear();
    // A new sub-category is announced by its own name; a new top-level category likewise.
    void announce('new_category', (category as any).publicId || (category as any).id, { categoryName: name }, { data: { categoryId: (category as any).publicId } }).catch(() => undefined);
    sendCreated(res, category);
  };

  update = async (req: Request, res: Response) => {
    const categories = adminRepos.categories();
    const category: any = await categories.findOne({ where: { id: routeParam(req.params.id) } });
    if (!category) throw new HttpError(404, 'Category not found');

    if (req.body.name && String(req.body.name).trim() !== category.name) {
      const name = String(req.body.name).trim();
      const parentDoc: any = category.parentId ? await Category.findById(category.parentId).lean() : undefined;
      const slug = parentDoc ? `${parentDoc.slug}-${slugify(name)}` : slugify(name);
      const clash: any = await categories.findOne({ where: [{ name }, { slug }] as any });
      if (clash && clash.id !== category.id) {
        throw new HttpError(400, `A category named "${clash.name}" already exists`);
      }
      category.name = name;
      category.slug = slug;
    }
    if (req.body.description !== undefined) category.description = req.body.description;
    if (req.body.iconUrl !== undefined) category.iconUrl = req.body.iconUrl;
    if (req.body.sortOrder !== undefined) category.sortOrder = req.body.sortOrder;
    if (req.body.sizingGuide !== undefined) {
      category.attributeSchema = { ...(category.attributeSchema || {}), sizingGuide: req.body.sizingGuide };
    }
    if (req.body.attributes !== undefined) {
      // An empty list means "inherit from the parent" (or nothing, at the top level).
      const next: Record<string, unknown> = { ...(category.attributeSchema || {}) };
      if (req.body.attributes.length) next.attributes = req.body.attributes;
      else delete next.attributes;
      category.attributeSchema = next;
    }
    if (req.body.parentId !== undefined && req.body.parentId !== (category.parentId || undefined)) {
      const children = await Category.countDocuments({ parentId: category.id, deletedAt: { $exists: false } });
      if (children > 0) throw new HttpError(400, `"${category.name}" has sub-categories, so it cannot be moved under another category.`);
      const target: any = await categoryService.require(String(req.body.parentId));
      if (target.parentId) throw new HttpError(400, `"${target.name}" is already a sub-category.`);
      if (target._id.toString() === category.id) throw new HttpError(400, 'A category cannot be its own parent.');
      category.parentId = target._id.toString();
      category.level = 1;
      category.slug = `${target.slug}-${slugify(category.name)}`;
      category.path = `${target.slug}/${category.slug}`;
    }

    await categories.save(category);

    const auditLogs = adminRepos.auditLogs();
    await auditLogs.save(auditLogs.create({
      action: 'category.update',
      resourceType: 'category',
      resourceId: category.id,
      details: `Updated category "${category.name}"`,
      status: 'success',
      ...actor(req),
    }));

    publishCategoryUpdate(category);
    adminCategoryCache.clear();
    sendSuccess(res, category);
  };

  toggle = async (req: Request, res: Response) => {
    const categories = adminRepos.categories();
    const category: any = await categories.findOne({ where: { id: routeParam(req.params.id) } });
    if (!category) throw new HttpError(404, 'Category not found');

    category.isActive = !category.isActive;
    await categories.save(category);
    publishCategoryUpdate(category);
    adminCategoryCache.clear();
    sendSuccess(res, { id: category.id, isActive: category.isActive });
  };

  remove = async (req: Request, res: Response) => {
    const categories = adminRepos.categories();
    const category: any = await categories.findOne({ where: { id: routeParam(req.params.id) } });
    if (!category) throw new HttpError(404, 'Category not found');

    const childCount = await Category.countDocuments({ parentId: category.id, deletedAt: { $exists: false } });
    if (childCount > 0) {
      throw new HttpError(400, `"${category.name}" has ${childCount} sub-categor${childCount === 1 ? 'y' : 'ies'}. Delete or move them first.`);
    }
    const products = await adminRepos.products().find({ where: { categoryId: category.id } });
    if ((products as any[]).length > 0) {
      throw new HttpError(
        400,
        `"${category.name}" has ${(products as any[]).length} product(s). Deactivate it instead of deleting.`,
      );
    }

    category.deletedAt = new Date();
    await categories.save(category);

    // Strip the category from every staff member's assignment list
    const users = adminRepos.users();
    await User.updateMany(
      { assignedCategoryIds: category.id },
      { $pull: { assignedCategoryIds: category.id } },
    );

    const auditLogs = adminRepos.auditLogs();
    await auditLogs.save(auditLogs.create({
      action: 'category.delete',
      resourceType: 'category',
      resourceId: category.id,
      details: `Deleted empty category "${category.name}"`,
      status: 'success',
      ...actor(req),
    }));

    publishCategoryUpdate(category);
    adminCategoryCache.clear();
    sendSuccess(res, { id: category.id, deleted: true });
  };

  /**
   * Sets the display order for a set of sibling categories (all top-level, or all children of the same parent) to
   * match the order given — the position in `ids` becomes the new `sortOrder`, ten apart so a category can later be
   * inserted between two others without renumbering everything. Every category everywhere already reads this field
   * (`categoryService.tree()`, this controller's own `list`), so nothing else needs to change for the new order to
   * show up.
   */
  reorder = async (req: Request, res: Response) => {
    const ids: string[] = req.body.ids;
    const rows = await Category.find({ _id: { $in: ids }, deletedAt: { $exists: false } }).select('_id parentId').lean();
    if (rows.length !== ids.length) throw new HttpError(400, 'One or more categories could not be found', undefined, 'VALIDATION_ERROR');
    const parentIds = new Set(rows.map((row) => String(row.parentId || '')));
    if (parentIds.size > 1) throw new HttpError(400, 'All reordered categories must share the same parent', undefined, 'VALIDATION_ERROR');

    await Category.bulkWrite(ids.map((id, index) => ({
      updateOne: { filter: { _id: id }, update: { $set: { sortOrder: (index + 1) * 10 } } },
    })));

    const auditLogs = adminRepos.auditLogs();
    await auditLogs.save(auditLogs.create({
      action: 'category.reorder',
      resourceType: 'category',
      resourceId: ids[0],
      details: `Reordered ${ids.length} categor${ids.length === 1 ? 'y' : 'ies'}`,
      status: 'success',
      ...actor(req),
    }));

    publishRealtime({ type: 'catalog.updated', entityType: 'category', entityId: 'reorder', version: 1 }, { public: true, admin: true });
    adminCategoryCache.clear();
    sendSuccess(res, { reordered: ids.length });
  };
}
