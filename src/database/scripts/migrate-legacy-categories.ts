import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { Category } from '@models/categories/category.model';
import { Product } from '@models/products/product.model';
import { CATEGORY_TREE } from '../category-tree';

/**
 * Run AFTER seed-category-tree. Hides the old flat categories that are not in
 * the new tree, and flags every product that is filed under a category that is
 * hidden or now has sub-categories, so staff can move them with the bulk tool
 * in Admin. Products stay live; nothing is deleted. Safe to re-run.
 *   npm run migrate:categories               (dry run)
 *   npm run migrate:categories -- --execute
 */
const execute = process.argv.includes('--execute');
const slugify = (value: string) => value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

async function main() {
  await connectDatabase();
  const treeSlugs = new Set(CATEGORY_TREE.flatMap((node) => [slugify(node.name), ...(node.children || []).map((child) => `${slugify(node.name)}-${slugify(child.name)}`)]));
  const categories = await Category.find({ deletedAt: { $exists: false } }).lean();
  const legacy = categories.filter((category) => !treeSlugs.has(category.slug));
  const parentIds = new Set(categories.filter((category) => category.parentId).map((category) => String(category.parentId)));
  const nonLeaf = categories.filter((category) => parentIds.has(String(category._id)));

  console.log(`${execute ? 'Applying' : 'Dry run of'} the legacy category migration:\n`);
  for (const category of legacy) {
    console.log(`  hide    ${category.name} (${category.slug})`);
    if (execute) await Category.updateOne({ _id: category._id }, { $set: { isActive: false } });
  }
  const affected = [...legacy, ...nonLeaf].map((category) => String(category._id));
  const count = await Product.countDocuments({ categoryId: { $in: affected }, deletedAt: { $exists: false } });
  console.log(`\n  ${count} product(s) filed under a hidden or parent category will be flagged "needs a sub-category".`);
  if (execute) await Product.updateMany({ categoryId: { $in: affected } }, { $set: { needsRecategorisation: true } });
  if (!execute) console.log('\nNo data changed. Run with --execute to apply.');
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => disconnectDatabase());
