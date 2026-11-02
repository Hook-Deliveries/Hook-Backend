import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { Product } from '@models/products/product.model';

const MINIMUM_PHOTOS = Number(process.argv.find((arg) => arg.startsWith('--minimum='))?.split('=')[1] || 3);

/**
 * Read-only report of live products with fewer than MINIMUM_PHOTOS images.
 * There is no fix to apply here automatically — a missing photo needs a real
 * photo, which only Hook's catalog team can supply. This just gives that team
 * (or an admin) a concrete worklist instead of discovering the gap one
 * product page at a time.
 */
async function main() {
  await connectDatabase();
  const thin = await Product.find({
    deletedAt: { $exists: false },
    $expr: { $lt: [{ $size: { $ifNull: ['$images', []] } }, MINIMUM_PHOTOS] },
  }).select('publicId title images status').lean();

  if (!thin.length) {
    console.log(`No products found with fewer than ${MINIMUM_PHOTOS} photos.`);
    return;
  }
  console.log(`${thin.length} product(s) with fewer than ${MINIMUM_PHOTOS} photo(s):\n`);
  for (const product of thin) {
    console.log(`  ${(product.images || []).length} photo(s) — ${product.title} (${product.publicId || product.id}) [${product.status}]`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => disconnectDatabase());
