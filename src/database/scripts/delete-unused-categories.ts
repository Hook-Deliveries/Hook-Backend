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
 * Deletes retired (inactive, top-level) categories that nothing uses any more:
 * no sub-categories, no products and no submissions point at them. Anything
 * still in use is kept and reported. A JSON backup is written before deleting.
 */
async function main() {
  await connectDatabase();
  const retired = await Category.find({ isActive: false, parentId: { $exists: false }, deletedAt: { $exists: false } }).lean();
  const removable: typeof retired = [];
  for (const category of retired) {
    const id = String(category._id);
    const [children, products, submissions] = await Promise.all([
      Category.countDocuments({ parentId: id, deletedAt: { $exists: false } }),
      Product.countDocuments({ categoryId: id, deletedAt: { $exists: false } }),
      ProductSubmission.countDocuments({ $or: [{ categorySuggestionId: id }, { categoryId: id }] } as never),
    ]);
    const inUse = children + products + submissions;
    console.log(`${inUse ? 'keep  ' : 'delete'}  ${category.name}${inUse ? `  (${children} sub-categories, ${products} products, ${submissions} submissions)` : ''}`);
    if (!inUse) removable.push(category);
  }
  if (!execute) { console.log(`\n${removable.length} to delete. Re-run with --execute.`); return; }
  if (removable.length) {
    const dir = path.join(process.cwd(), '.backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `deleted-categories-${Date.now()}.json`), JSON.stringify(removable));
    const result = await mongoose.connection.db!.collection('categories').deleteMany({ _id: { $in: removable.map((item) => item._id) } } as never);
    console.log(`Deleted ${result.deletedCount} unused categories.`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => disconnectDatabase());
