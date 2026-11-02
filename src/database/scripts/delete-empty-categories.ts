import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { Category } from '@models/categories/category.model';
import { ProductSubmission } from '@models/catalog/catalog.model';
import { Product } from '@models/products/product.model';

dotenv.config({ quiet: true });
const execute = process.argv.includes('--execute');

/**
 * Deletes categories with nothing in them: sub-categories with no products or
 * submissions, then any top-level category left with no sub-categories and no
 * products of its own. A JSON backup is written before deleting. Re-running
 * `npm run seed:categories` would recreate them, so change the tree first if
 * they should stay gone.
 */
async function main() {
  await connectDatabase();
  const all = await Category.find({ deletedAt: { $exists: false } }).lean();
  const used = async (id: string) =>
    (await Product.countDocuments({ categoryId: id, deletedAt: { $exists: false } })) +
    (await ProductSubmission.countDocuments({ $or: [{ categorySuggestionId: id }, { categoryId: id }] } as never));

  const doomed: typeof all = [];
  for (const child of all.filter((item) => item.parentId)) {
    if (!(await used(String(child._id)))) doomed.push(child);
  }
  const doomedIds = new Set(doomed.map((item) => String(item._id)));
  for (const root of all.filter((item) => !item.parentId)) {
    const remaining = all.filter((item) => String(item.parentId) === String(root._id) && !doomedIds.has(String(item._id)));
    if (!remaining.length && !(await used(String(root._id)))) doomed.push(root);
  }
  const names = (items: typeof all) => items.map((item) => (item.parentId ? `${all.find((p) => String(p._id) === String(item.parentId))?.name} > ${item.name}` : item.name));
  console.log(`${execute ? 'Deleting' : 'Would delete'} ${doomed.length}:`);
  for (const name of names(doomed)) console.log('  ', name);
  if (!execute) return;
  if (!doomed.length) return;
  fs.mkdirSync(path.join(process.cwd(), '.backups'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), '.backups', `deleted-empty-categories-${Date.now()}.json`), JSON.stringify(doomed));
  const result = await mongoose.connection.db!.collection('categories').deleteMany({ _id: { $in: doomed.map((item) => item._id) } } as never);
  console.log(`Deleted ${result.deletedCount}.`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => disconnectDatabase());
