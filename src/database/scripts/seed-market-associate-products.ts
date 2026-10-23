import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { ProductAvailabilityStatus, ProductStatus, ProductSubmissionStatus } from '@lib/constants';
import { Category } from '@models/categories/category.model';
import { CatalogMediaAsset, ProductSubmission, ProductVariant } from '@models/catalog/catalog.model';
import { MarketVendor } from '@models/catalog/market-vendor.model';
import { MarketAssociateMarketAssignment, MarketAssociateProfile } from '@models/platform/operations-accounts.model';
import { Product } from '@models/products/product.model';
import { User } from '@models/users/user.model';
import { hookIdFromPublicId, nextPublicId } from '@modules/platform/public-id.service';
import { productGallery, productOptions, MARKET_ASSOCIATE_PRODUCT_CATALOG } from '../seeds/market-associate-product-catalog';

dotenv.config({ quiet: true });

const execute = process.argv.includes('--execute');

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function main() {
  await connectDatabase();

  const marketAssociateAccount = await User.findOne({ email: 'runner@gmail.com', isActive: true }).lean();
  if (!marketAssociateAccount) throw new Error('Active runner@gmail.com account was not found');
  const marketAssociate = await MarketAssociateProfile.findOne({ accountId: String(marketAssociateAccount._id), status: 'active' }).lean();
  if (!marketAssociate) throw new Error('Active Market Associate profile for runner@gmail.com was not found');
  const assignment = await MarketAssociateMarketAssignment.findOne({
    marketAssociateId: String(marketAssociate._id),
    status: 'active',
    activeFrom: { $lte: new Date() },
    $or: [{ activeTo: { $exists: false } }, { activeTo: null }, { activeTo: { $gt: new Date() } }],
  }).sort({ isPrimary: -1, priority: 1 }).lean();
  if (!assignment) throw new Error('runner@gmail.com has no active Market assignment');
  const vendor = await MarketVendor.findOne({ marketId: assignment.marketId, status: { $in: ['active', 'pending'] }, deletedAt: { $exists: false } }).lean();
  if (!vendor) throw new Error('The assigned Market has no active supplier record');

  const admin = await User.findOne({ email: 'admin@gmail.com', isActive: true }).lean();
  if (!admin) throw new Error('Active admin@gmail.com account was not found');
  const categories = await Category.find({ slug: { $in: MARKET_ASSOCIATE_PRODUCT_CATALOG.map((item) => item.categorySlug) }, isActive: true }).lean();
  const categoryBySlug = new Map(categories.map((category) => [category.slug, category]));
  const missingCategories = [...new Set(MARKET_ASSOCIATE_PRODUCT_CATALOG.map((item) => item.categorySlug))]
    .filter((slug) => !categoryBySlug.has(slug));
  if (missingCategories.length) throw new Error(`Missing active categories: ${missingCategories.join(', ')}`);

  const slugs = MARKET_ASSOCIATE_PRODUCT_CATALOG.map((item) => slugify(item.title));
  const existing = await Product.find({ slug: { $in: slugs } }).select('slug').lean();
  const existingSlugs = new Set(existing.map((item) => item.slug));
  const pending = MARKET_ASSOCIATE_PRODUCT_CATALOG.filter((item) => !existingSlugs.has(slugify(item.title)));

  console.log(`${execute ? 'Creating' : 'Dry run for'} ${pending.length} Product(s) for runner@gmail.com; ${existing.length} already exist`);
  if (!execute) {
    for (const item of pending) console.log(`Would create ${item.categorySlug}: ${item.title}`);
    console.log('No data changed. Run with --execute to create these approved captures.');
    return;
  }

  for (const item of pending) {
    const category = categoryBySlug.get(item.categorySlug)!;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const now = new Date();
        const submission = await ProductSubmission.create([{
          publicId: await nextPublicId('submission'),
          marketAssociateId: String(marketAssociate._id),
          marketId: assignment.marketId,
          marketVendorId: String(vendor._id),
          sourceStateId: assignment.stateId,
          categorySuggestionId: String(category._id),
          basicTitle: item.title,
          notes: `Market Associate capture approved for ${category.name}.`,
          mediaIds: [],
          basePriceMinor: item.costPrice * 100,
          currency: 'NGN',
          variants: productOptions(item),
          availabilityStatus: ProductAvailabilityStatus.AVAILABLE,
          availabilityNote: 'Available from a verified Hook Market supplier.',
          status: ProductSubmissionStatus.APPROVED,
          reviewNotes: [{ action: 'approved', message: 'Approved catalog product.', actorId: String(admin._id), createdAt: now }],
          submittedAt: now,
          reviewedAt: now,
          reviewedBy: String(admin._id),
          version: 1,
        }], { session }).then((rows) => rows[0]);

        const images = productGallery(item);
        const media = await CatalogMediaAsset.insertMany(images.map((url, index) => ({
          publicId: `MED-SEED-${slugify(item.title)}-${index + 1}`,
          provider: 'legacy_external',
          providerPublicId: `unsplash/${slugify(item.title)}/${index + 1}`,
          resourceType: 'image',
          deliveryType: 'external',
          secureUrl: url,
          format: 'jpg',
          width: 1200,
          height: 1200,
          bytes: 1,
          uploaderAccountId: String(marketAssociateAccount._id),
          ownerType: 'submission',
          ownerId: String(submission._id),
          uploadIntentId: `seed-${slugify(item.title)}-${index + 1}`,
          status: 'ready',
          order: index,
          metadata: { source: 'unsplash', seeded: true },
        })), { session });
        submission.mediaIds = media.map((asset) => asset.publicId);

        const productPublicId = await nextPublicId('product');
        const product = await Product.create([{
          publicId: productPublicId,
          hookId: hookIdFromPublicId(productPublicId),
          title: item.title,
          slug: slugify(item.title),
          description: item.description,
          costPrice: item.costPrice,
          sellingPrice: item.sellingPrice,
          minAcceptablePrice: item.floorPrice,
          basePriceMinor: item.costPrice * 100,
          sellingPriceMinor: item.sellingPrice * 100,
          markupMinor: (item.sellingPrice - item.costPrice) * 100,
          discountMinor: 0,
          currency: 'NGN',
          sourceStateId: assignment.stateId,
          marketId: assignment.marketId,
          sourceSubmissionId: String(submission._id),
          sourceMarketVendorId: String(vendor._id),
          sourceMarketAssociateId: String(marketAssociate._id),
          categoryId: String(category._id),
          quantity: item.quantity,
          reservedQuantity: 0,
          colors: item.colors,
          sizes: item.sizes,
          images,
          mediaAssetIds: [],
          negotiationRules: { enabled: true, minimumNegotiablePriceMinor: item.floorPrice * 100, maximumDiscountMinor: (item.sellingPrice - item.floorPrice) * 100, maximumCustomerOffers: 3, acceptedQuoteExpiryMinutes: 30 },
          availabilityStatus: ProductAvailabilityStatus.AVAILABLE,
          customerAvailabilityNote: 'Available from a verified Hook Market supplier.',
          lastMarketVerifiedAt: now,
          lastPriceVerifiedAt: now,
          lastAvailabilityConfirmedAt: now,
          availabilityValidUntil: new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000),
          publishedAt: now,
          publishedBy: String(admin._id),
          commercialApproval: { approved: true, approvedBy: String(admin._id), approvedAt: now },
          catalogMigrationVersion: 3,
          catalogVersion: 1,
          status: ProductStatus.PUBLISHED,
          viewCount: 0,
          orderCount: 0,
          averageRating: 0,
          source: 'field_agent',
        }], { session }).then((rows) => rows[0]);

        const options = productOptions(item);
        const variantPublicIds = await Promise.all(options.map(() => nextPublicId('variant')));
        await ProductVariant.insertMany(options.map((option, index) => ({
          publicId: variantPublicIds[index],
          productId: String(product._id),
          sku: `${product.hookId}-${String(index + 1).padStart(2, '0')}`,
          size: option.size,
          colour: option.colour,
          attributes: {},
          active: true,
          mediaAssetIds: [],
        })), { session });
        submission.productId = String(product._id);
        await submission.save({ session });
      });
      console.log(`Created ${item.categorySlug}: ${item.title}`);
    } finally {
      await session.endSession();
    }
  }

  const seededSlugs = MARKET_ASSOCIATE_PRODUCT_CATALOG.map((item) => slugify(item.title));
  const seededProducts = await Product.find({ slug: { $in: seededSlugs }, sourceMarketAssociateId: String(marketAssociate._id) })
    .select('_id categoryId images status availabilityStatus')
    .lean();
  const productIds = seededProducts.map((item) => String(item._id));
  const [approvedCaptures, variants] = await Promise.all([
    ProductSubmission.countDocuments({ marketAssociateId: String(marketAssociate._id), productId: { $in: productIds }, status: ProductSubmissionStatus.APPROVED }),
    ProductVariant.countDocuments({ productId: { $in: productIds }, active: true }),
  ]);
  const counts = new Map<string, number>();
  for (const product of seededProducts) counts.set(String(product.categoryId), (counts.get(String(product.categoryId)) || 0) + 1);
  const completeGalleries = seededProducts.filter((item) => item.images?.length === 3).length;
  console.log(`Verified ${seededProducts.length} Products, ${approvedCaptures} approved captures, ${variants} active variants, and ${completeGalleries} three-image galleries`);
  for (const category of categories) console.log(`${category.name}: ${counts.get(String(category._id)) || 0}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
