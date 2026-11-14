import dotenv from 'dotenv';
import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { CatalogMediaAsset, ProductSubmission } from '@models/catalog/catalog.model';
import { Product } from '@models/products/product.model';
import { canonicalSubmissionMedia } from '@modules/catalog/catalog.service';
import { CatalogMediaService } from '@modules/catalog/catalog-media.service';

dotenv.config({ quiet: true });

const execute = process.argv.includes('--execute');

/**
 * Brings existing submissions, photos and products onto one photo order: front, side, back, then extras.
 *
 *  1. A submission with three or more photos and no recorded views gets front / side / back from its first three
 *     photos. Older captures were taken in that order, but this cannot be proven, so the "guidelines followed"
 *     confirmation is left as it was.
 *  2. A submission's `mediaIds` is rewritten in the canonical order, and every photo's `order` becomes its place in it.
 *  3. A product made from a submission lists its uploaded photos in the same order as its gallery (`images`), or in
 *     capture order when the gallery does not place them.
 *
 * Dry run by default; pass --execute to write. Safe to run again: a second run finds nothing left to change.
 */
async function main() {
  await connectDatabase();
  const delivery = new CatalogMediaService();
  const urlOf = (asset: any) => (asset.deliveryType === 'external' ? asset.secureUrl : delivery.deliveryUrl(asset));
  const mode = execute ? 'EXECUTE' : 'DRY RUN';
  const summary = { submissionsViewsAdded: 0, submissionsReordered: 0, photoOrdersSet: 0, productsReordered: 0, productGalleriesFilled: 0, productPhotoOrdersSet: 0 };
  const photoOps: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }> = [];
  const examples: string[] = [];

  const submissions = await ProductSubmission.find({ deletedAt: { $exists: false }, 'mediaIds.0': { $exists: true } })
    .select('publicId mediaIds mediaViews')
    .lean();
  const canonicalBySubmission = new Map<string, string[]>();

  for (const submission of submissions as any[]) {
    const ids: string[] = (submission.mediaIds || []).map(String);
    const hasViews = Boolean(submission.mediaViews?.front || submission.mediaViews?.side || submission.mediaViews?.back);
    const startViews = hasViews || ids.length < 3 ? submission.mediaViews || {} : { front: ids[0], side: ids[1], back: ids[2] };
    const canonical = canonicalSubmissionMedia(ids, startViews);
    const viewsAdded = !hasViews && Object.keys(canonical.mediaViews).length > 0;
    const reordered = JSON.stringify(canonical.mediaIds) !== JSON.stringify(ids);
    canonicalBySubmission.set(String(submission._id), canonical.mediaIds);
    if (viewsAdded) summary.submissionsViewsAdded += 1;
    if (reordered) summary.submissionsReordered += 1;
    if ((viewsAdded || reordered) && examples.length < 6) examples.push(`${submission.publicId}: ${ids.map((id) => id.slice(-4)).join(',')} -> ${canonical.mediaIds.map((id) => id.slice(-4)).join(',')}${viewsAdded ? ' (views added)' : ''}`);
    if (execute && (viewsAdded || reordered)) {
      await ProductSubmission.updateOne({ _id: submission._id }, { $set: { mediaIds: canonical.mediaIds, mediaViews: canonical.mediaViews } });
    }
    canonical.mediaIds.forEach((id, index) => {
      photoOps.push({ updateOne: { filter: { $or: [{ publicId: id }, { _id: /^[a-f\d]{24}$/i.test(id) ? id : undefined }].filter((clause) => Object.values(clause)[0]) }, update: { $set: { order: index } } } });
    });
  }

  // Only count (and write) photos whose order actually changes.
  // Photos of an approved submission now belong to the product, so look them up by id rather than by owner.
  const photoIds = [...new Set(photoOps.flatMap((op) => ((op.updateOne.filter.$or as any[]) || []).map((clause) => clause.publicId).filter(Boolean)))];
  const assets = await CatalogMediaAsset.find({ publicId: { $in: photoIds } }).select('publicId order').lean();
  const currentOrder = new Map((assets as any[]).map((asset) => [asset.publicId, Number(asset.order || 0)]));
  const changedPhotoOps = photoOps.filter((op) => {
    const clause: any = (op.updateOne.filter.$or as any[])[0];
    return currentOrder.get(clause.publicId) !== (op.updateOne.update.$set as any).order;
  });
  summary.photoOrdersSet = changedPhotoOps.length;
  if (execute && changedPhotoOps.length) await CatalogMediaAsset.bulkWrite(changedPhotoOps as never);

  const products = await Product.find({ deletedAt: { $exists: false }, sourceSubmissionId: { $exists: true, $ne: null }, 'mediaAssetIds.1': { $exists: true } })
    .select('publicId mediaAssetIds images sourceSubmissionId')
    .lean();
  for (const product of products as any[]) {
    const owned: any[] = await CatalogMediaAsset.find({ $or: [{ publicId: { $in: product.mediaAssetIds } }, { _id: { $in: product.mediaAssetIds.filter((id: string) => /^[a-f\d]{24}$/i.test(id)) } }] }).lean({ virtuals: true });
    const captured = canonicalBySubmission.get(String(product.sourceSubmissionId)) || [];
    const gallery: string[] = Array.isArray(product.images) ? product.images : [];
    const rank = (asset: any) => {
      const inGallery = gallery.findIndex((url) => url === urlOf(asset) || url === asset.secureUrl);
      if (inGallery >= 0) return inGallery;
      const inCapture = captured.findIndex((id) => id === asset.publicId || id === String(asset._id));
      return gallery.length + (inCapture < 0 ? 999 : inCapture);
    };
    const next = [...owned].sort((a, b) => rank(a) - rank(b)).map((asset) => String(asset.publicId || asset._id));
    if (JSON.stringify(next) !== JSON.stringify(product.mediaAssetIds.map(String))) {
      summary.productsReordered += 1;
      if (examples.length < 8) examples.push(`${product.publicId} (product): ${product.mediaAssetIds.map((id: string) => String(id).slice(-4)).join(',')} -> ${next.map((id) => id.slice(-4)).join(',')}`);
      if (execute) await Product.updateOne({ _id: product._id }, { $set: { mediaAssetIds: next } });
    }
  }

  // Every product, not just ones made from a submission: its uploaded photos get `order` from their place in the
  // product's list, and a product that has uploaded photos but an empty gallery gets its gallery filled from them, so
  // the admin page and the app have an order to show.
  const allProducts = await Product.find({ deletedAt: { $exists: false }, 'mediaAssetIds.0': { $exists: true } })
    .select('publicId mediaAssetIds images')
    .lean();
  const productPhotoOps: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }> = [];
  for (const product of allProducts as any[]) {
    const ids: string[] = product.mediaAssetIds.map(String);
    const owned: any[] = await CatalogMediaAsset.find({ publicId: { $in: ids } }).lean({ virtuals: true });
    const byId = new Map(owned.map((asset) => [String(asset.publicId), asset]));
    ids.forEach((id, index) => {
      const asset = byId.get(id);
      if (asset && Number(asset.order || 0) !== index) productPhotoOps.push({ updateOne: { filter: { _id: asset._id }, update: { $set: { order: index } } } });
    });
    if (!Array.isArray(product.images) || product.images.length === 0) {
      const urls = ids.map((id) => byId.get(id)).filter(Boolean).map((asset) => urlOf(asset)).filter(Boolean) as string[];
      if (urls.length) {
        summary.productGalleriesFilled += 1;
        if (execute) await Product.updateOne({ _id: product._id }, { $set: { images: urls } });
      }
    }
  }
  summary.productPhotoOrdersSet = productPhotoOps.length;
  if (execute && productPhotoOps.length) await CatalogMediaAsset.bulkWrite(productPhotoOps as never);

  console.log(`[${mode}] database: ${process.env.MONGODB_URI?.replace(/\/\/[^@]*@/, '//***@').replace(/\?.*$/, '')}`);
  console.log(JSON.stringify({ submissionsScanned: submissions.length, ...summary }, null, 2));
  if (examples.length) console.log(['Examples (last 4 characters of each photo id):', ...examples.map((line) => `  ${line}`)].join('\n'));
  if (!execute) console.log('Nothing was written. Run again with --execute to apply.');
  await disconnectDatabase();
}

main().catch(async (error) => {
  console.error(error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
