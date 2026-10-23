import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { Category } from '@models/categories/category.model';
import { nextPublicId } from '@modules/platform/public-id.service';
import { CATEGORY_TREE, type CategoryNode } from '../category-tree';

/**
 * Creates (or brings up to date) the Hook category tree and each category's
 * product attribute template. Safe to re-run: categories are matched by slug,
 * sizing-guide data is preserved, and nothing is deleted.
 *   npm run seed:categories               (dry run)
 *   npm run seed:categories -- --execute
 */
const execute = process.argv.includes('--execute');
const slugify = (value: string) => value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

async function upsert(node: CategoryNode, parent: { id: string; slug: string } | undefined, sortOrder: number) {
  const slug = parent ? `${parent.slug}-${slugify(node.name)}` : slugify(node.name);
  const existing = await Category.findOne({ slug, deletedAt: { $exists: false } });
  const attributeSchema = {
    ...((existing?.attributeSchema as Record<string, unknown>) || {}),
    ...(node.attributes ? { attributes: node.attributes } : { attributes: undefined }),
  };
  if (!node.attributes) delete (attributeSchema as Record<string, unknown>).attributes;
  // Seed the guide once; an admin's later edits (or switching it off) are never overwritten.
  if (node.sizingGuide && !(attributeSchema as { sizingGuide?: { summary?: string } }).sizingGuide?.summary) {
    (attributeSchema as Record<string, unknown>).sizingGuide = node.sizingGuide;
  }
  const fields = {
    name: node.name,
    slug,
    description: node.description || existing?.description || '',
    sortOrder,
    isActive: true,
    level: parent ? 1 : 0,
    parentId: parent?.id,
    path: parent ? `${parent.slug}/${slug}` : slug,
    attributeSchema,
  };
  if (existing) {
    console.log(`  update  ${parent ? '   ' : ''}${node.name}`);
    if (execute) await Category.updateOne({ _id: existing._id }, { $set: fields, ...(parent ? {} : { $unset: { parentId: 1 } }) });
    return { id: existing._id.toString(), slug };
  }
  console.log(`  create  ${parent ? '   ' : ''}${node.name}`);
  if (!execute) return { id: `dry-${slug}`, slug };
  const created = await Category.create({ ...fields, publicId: await nextPublicId('category') });
  return { id: created._id.toString(), slug };
}

async function main() {
  await connectDatabase();
  console.log(`${execute ? 'Applying' : 'Dry run of'} the category tree:\n`);
  let order = 0;
  for (const node of CATEGORY_TREE) {
    const parent = await upsert(node, undefined, (order += 1));
    let childOrder = 0;
    for (const child of node.children || []) await upsert(child, parent, (childOrder += 1));
  }
  if (!execute) console.log('\nNo data changed. Run with --execute to apply.');
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => disconnectDatabase());
