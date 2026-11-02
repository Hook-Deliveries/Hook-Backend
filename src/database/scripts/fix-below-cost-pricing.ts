import dotenv from 'dotenv';
import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { Product } from '@models/products/product.model';

dotenv.config({ quiet: true });

const execute = process.argv.includes('--execute');

/**
 * A batch of seed/demo products have sellingPrice below costPrice — already
 * a loss at the listed price, before any negotiation. Corrects them:
 *
 *   sellingPrice = round(costPrice * 1.10, nearest 100)   (10% margin)
 *   minAcceptablePrice = new sellingPrice - (old sellingPrice - old minAcceptablePrice)
 *
 * The floor shift preserves each product's existing discount range rather
 * than resetting it, so negotiation-worthy products stay negotiation-worthy.
 * basePriceMinor/sellingPriceMinor and catalogVersion are kept in sync.
 */
async function main() {
  await connectDatabase();

  const products = await Product.find({
    deletedAt: { $exists: false },
    $expr: { $lt: ['$sellingPrice', '$costPrice'] },
  }).select('title costPrice sellingPrice minAcceptablePrice basePriceMinor sellingPriceMinor catalogVersion');

  if (!products.length) {
    console.log('No below-cost products found. Nothing to change.');
    return;
  }

  const plan = products.map((product) => {
    const cost = Number(product.costPrice);
    const oldSelling = Number(product.sellingPrice);
    const oldFloor = Number(product.minAcceptablePrice);
    const discountRange = oldSelling - oldFloor;
    const newSelling = Math.round((cost * 1.1) / 100) * 100;
    const newFloor = Math.max(cost, newSelling - discountRange);
    return { product, cost, oldSelling, oldFloor, newSelling, newFloor };
  });

  console.log(`Found ${plan.length} below-cost product(s):`);
  for (const item of plan) {
    console.log(
      `  ${item.product.title}\n` +
        `    cost ₦${item.cost} | selling ₦${item.oldSelling} → ₦${item.newSelling} | floor ₦${item.oldFloor} → ₦${item.newFloor}`,
    );
  }

  if (!execute) {
    console.log(`\nDry run. Re-run with --execute to apply pricing to ${plan.length} product(s).`);
    return;
  }

  for (const item of plan) {
    await Product.updateOne(
      { _id: item.product._id },
      {
        $set: {
          sellingPrice: item.newSelling,
          minAcceptablePrice: item.newFloor,
          sellingPriceMinor: item.newSelling * 100,
        },
        $inc: { catalogVersion: 1 },
      },
    );
  }
  console.log(`\nCorrected pricing on ${plan.length} product(s).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
