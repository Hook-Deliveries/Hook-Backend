import { legacyProductOptions } from '@lib/legacy-product-options';
import { ProductVariant } from '@models/catalog/catalog.model';
import { HttpError } from '@utils/http';

export async function ensureLegacyProductOptions(product: Parameters<typeof legacyProductOptions>[0], variantId?: string) {
  if (!variantId?.startsWith('legacy_opt_')) return;
  const options = legacyProductOptions(product);
  if (!options.some((option) => option.publicId === variantId)) throw new HttpError(409, 'Selected product options changed. Refresh the product.', undefined, 'PRODUCT_VARIANT_UNAVAILABLE');
  const materialized = await ProductVariant.exists({ publicId: variantId, productId: product._id.toString(), active: true });
  if (materialized) return; // Avoid rewriting the whole legacy option grid on every cart add.
  const existing = await ProductVariant.exists({ productId: product._id.toString(), migrationSource: { $ne: 'legacy_negotiation_options' } });
  if (existing) return; // Never override a managed catalog variant set.
  try {
    await ProductVariant.bulkWrite(options.map((option) => ({ updateOne: {
      filter: { publicId: option.publicId }, upsert: true,
      update: { $setOnInsert: { ...option, productId: product._id.toString(), sku: option.publicId.toUpperCase(), attributes: {}, active: true, migrationSource: 'legacy_negotiation_options' } },
    } })), { ordered: false });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 11000)) throw error;
  }
}
