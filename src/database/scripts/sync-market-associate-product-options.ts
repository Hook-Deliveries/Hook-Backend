import dotenv from 'dotenv';
import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { ProductSubmission, ProductVariant } from '@models/catalog/catalog.model';
import { MarketAssociateProfile } from '@models/platform/operations-accounts.model';
import { Product } from '@models/products/product.model';
import { User } from '@models/users/user.model';
import { nextPublicId } from '@modules/platform/public-id.service';
import { productOptions, MARKET_ASSOCIATE_PRODUCT_CATALOG } from '../seeds/market-associate-product-catalog';

dotenv.config({ quiet: true });

const execute = process.argv.includes('--execute');

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function optionKey(size?: string, colour?: string) {
  return `${size || ''}|${colour || ''}`;
}

async function main() {
  await connectDatabase();

  const account = await User.findOne({ email: 'runner@gmail.com', isActive: true }).select('_id').lean();
  if (!account) throw new Error('Active runner@gmail.com account was not found');

  const marketAssociate = await MarketAssociateProfile.findOne({ accountId: String(account._id), status: 'active' }).select('_id').lean();
  if (!marketAssociate) throw new Error('Active Market Associate profile for runner@gmail.com was not found');

  let matchedProducts = 0;
  let createdVariants = 0;
  let retainedVariants = 0;
  let deactivatedVariants = 0;
  const matchedProductIds: string[] = [];

  for (const seed of MARKET_ASSOCIATE_PRODUCT_CATALOG) {
    const product = await Product.findOne({
      slug: slugify(seed.title),
      sourceMarketAssociateId: String(marketAssociate._id),
    });
    if (!product) {
      console.warn(`Skipped missing Product: ${seed.title}`);
      continue;
    }

    matchedProducts += 1;
    matchedProductIds.push(String(product._id));
    const desiredOptions = productOptions(seed);
    const desiredKeys = new Set(desiredOptions.map((option) => optionKey(option.size, option.colour)));
    const existingVariants = await ProductVariant.find({ productId: String(product._id), deletedAt: { $exists: false } });
    const existingByKey = new Map(existingVariants.map((variant) => [optionKey(variant.size, variant.colour), variant]));

    const missingOptions = desiredOptions.filter((option) => !existingByKey.has(optionKey(option.size, option.colour)));
    const obsoleteVariants = existingVariants.filter((variant) => variant.active && !desiredKeys.has(optionKey(variant.size, variant.colour)));
    const retained = existingVariants.filter((variant) => desiredKeys.has(optionKey(variant.size, variant.colour)));

    console.log(`${seed.title}: ${retained.length} retained, ${missingOptions.length} added, ${obsoleteVariants.length} retired`);
    if (!execute) continue;

    await Product.updateOne(
      { _id: product._id },
      {
        $set: { sizes: seed.sizes, colors: seed.colors },
        $inc: { catalogVersion: 1 },
      },
    );

    await ProductSubmission.updateOne(
      { productId: String(product._id), marketAssociateId: String(marketAssociate._id) },
      {
        $set: { variants: desiredOptions },
        $inc: { version: 1 },
      },
    );

    if (retained.length) {
      await ProductVariant.updateMany(
        { _id: { $in: retained.map((variant) => variant._id) } },
        { $set: { active: true }, $unset: { deletedAt: 1 } },
      );
    }

    if (obsoleteVariants.length) {
      await ProductVariant.updateMany(
        { _id: { $in: obsoleteVariants.map((variant) => variant._id) } },
        { $set: { active: false } },
      );
    }

    for (let index = 0; index < missingOptions.length; index += 1) {
      const option = missingOptions[index];
      const publicId = await nextPublicId('variant');
      await ProductVariant.create({
        publicId,
        productId: String(product._id),
        sku: `${product.hookId}-OPT-${publicId.split('-').at(-1)}`,
        ...option,
        mediaAssetIds: [],
      });
    }

    retainedVariants += retained.length;
    createdVariants += missingOptions.length;
    deactivatedVariants += obsoleteVariants.length;
  }

  if (!execute) {
    const [activeVariants, genericVariants, approvedCaptures] = await Promise.all([
      ProductVariant.countDocuments({ productId: { $in: matchedProductIds }, active: true }),
      ProductVariant.countDocuments({ productId: { $in: matchedProductIds }, active: true, size: /^one size$/i }),
      ProductSubmission.countDocuments({ productId: { $in: matchedProductIds }, status: 'approved' }),
    ]);
    console.log(`Dry run complete for ${matchedProducts} Products. Run with --execute to apply changes.`);
    console.log(`Current database: ${activeVariants} active variants, ${genericVariants} active One Size variants, and ${approvedCaptures} approved Market Associate captures.`);
    return;
  }

  const [activeVariants, genericVariants, approvedCaptures] = await Promise.all([
    ProductVariant.countDocuments({ productId: { $in: matchedProductIds }, active: true }),
    ProductVariant.countDocuments({ productId: { $in: matchedProductIds }, active: true, size: /^one size$/i }),
    ProductSubmission.countDocuments({ productId: { $in: matchedProductIds }, status: 'approved' }),
  ]);
  console.log(`Synchronized ${matchedProducts} Products: ${retainedVariants} variants retained, ${createdVariants} added, ${deactivatedVariants} retired.`);
  console.log(`Verified ${activeVariants} active variants, ${genericVariants} active One Size variants, and ${approvedCaptures} approved Market Associate captures.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDatabase();
  });
