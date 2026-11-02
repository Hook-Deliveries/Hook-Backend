import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { Category } from '@models/categories/category.model';
import { CATEGORY_TREE, type CategoryNode } from '../category-tree';

/**
 * Fills in size attributes and sizing guides on categories that already exist, matched by slug.
 * It never creates, renames, reorders or deletes a category, and never overwrites a guide or
 * attribute set that is already there.
 *   npm run seed:sizing               (dry run)
 *   npm run seed:sizing -- --execute
 */
const execute = process.argv.includes('--execute');
const slugify = (value: string) => value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

async function fill(node: CategoryNode, parentSlug?: string) {
  const slug = parentSlug ? `${parentSlug}-${slugify(node.name)}` : slugify(node.name);
  const existing = await Category.findOne({ slug, deletedAt: { $exists: false } });
  if (existing) {
    const schema = { ...((existing.attributeSchema as Record<string, unknown>) || {}) } as { attributes?: unknown[]; sizingGuide?: { summary?: string } };
    const changes: string[] = [];
    if (node.attributes && !schema.attributes?.length) { schema.attributes = node.attributes; changes.push('attributes'); }
    if (node.sizingGuide && !schema.sizingGuide?.summary) { schema.sizingGuide = node.sizingGuide as never; changes.push('sizing guide'); }
    if (changes.length) {
      console.log(`  ${execute ? 'filled ' : 'would fill'} ${slug}: ${changes.join(' + ')}`);
      if (execute) await Category.updateOne({ _id: existing._id }, { $set: { attributeSchema: schema } });
    }
  } else {
    console.log(`  skip — ${slug} is not in this database`);
  }
  for (const child of node.children || []) await fill(child, slug);
}

async function main() {
  await connectDatabase();
  console.log(`${execute ? 'Applying' : 'Dry run of'} sizing fill:\n`);
  for (const node of CATEGORY_TREE) await fill(node);
  if (!execute) console.log('\nNo data changed. Run with --execute to apply.');
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => void disconnectDatabase());
