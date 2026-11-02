import fs from 'node:fs';
import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { Category } from '@models/categories/category.model';
import { Product } from '@models/products/product.model';
import { ProductSubmission, ProductVariant } from '@models/catalog/catalog.model';
import { categoryService } from '@modules/catalog/category.service';

/**
 * Read-only. Lists every saved product variant and submission variant that breaks its category's current rules (a clothing
 * size on a shoe, a size on a category that has none, an option that is no longer offered), so a person can review them.
 * Nothing is changed or deleted.
 *   npm run report:variants -- <output.csv>
 */
const out = process.argv.slice(2).find((arg) => !arg.startsWith('-')) || 'variant-mismatches.csv';
const cell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;

async function main() {
  await connectDatabase();
  const categories = new Map<string, any>((await Category.find({ deletedAt: { $exists: false } }).lean() as any[]).map((row) => [String(row._id), row]));
  const rows: string[][] = [];
  const check = async (kind: string, id: string, title: string, categoryId: string, variant: { size?: string; colour?: string; attributes?: Record<string, string> }) => {
    const category = categories.get(String(categoryId));
    if (!category) return;
    try {
      await categoryService.validateVariants(category, [variant]);
    } catch (error) {
      rows.push([kind, id, title, category.slug, variant.size || '', variant.colour || '', JSON.stringify(variant.attributes || {}), error instanceof Error ? error.message : String(error)]);
    }
  };
  const products = await Product.find({ deletedAt: { $exists: false } }).select('publicId title categoryId').lean() as any[];
  const byProduct = new Map(products.map((product) => [String(product._id), product]));
  for (const variant of await ProductVariant.find({ deletedAt: { $exists: false }, active: true }).select('productId sku size colour attributes').lean() as any[]) {
    const product = byProduct.get(String(variant.productId));
    if (product) await check('product', `${product.publicId} (${variant.sku})`, product.title, product.categoryId, variant);
  }
  for (const submission of await ProductSubmission.find({ deletedAt: { $exists: false }, status: { $in: ['draft', 'submitted', 'in_review', 'changes_requested'] } }).select('publicId basicTitle categorySuggestionId variants').lean() as any[]) {
    for (const variant of (submission.variants || []).filter((item: any) => item.active !== false)) await check('submission', submission.publicId, submission.basicTitle, submission.categorySuggestionId, variant);
  }
  const header = ['kind', 'reference', 'title', 'category', 'size', 'colour', 'other options', 'problem'];
  fs.writeFileSync(out, [header, ...rows].map((row) => row.map(cell).join(',')).join('\n'));
  console.log(`${rows.length} variants break their category rules. Written to ${out}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => disconnectDatabase());
