import dotenv from 'dotenv';
import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { Product } from '@models/products/product.model';
import { hookIdFromPublicId, nextPublicIds } from '@modules/platform/public-id.service';

dotenv.config({ quiet: true });

const execute = process.argv.includes('--execute');

type Planned = {
  _id: string;
  title: string;
  before: { publicId?: string; hookId?: string };
  after: { publicId: string; hookId: string };
  reason: string;
};

/**
 * Products historically got their identifiers from four different code paths,
 * three of which disagreed on format (a random HK-XXXXXX from the admin
 * create route, a duplicated PRD-… from catalog approval, and a 4-digit
 * HK-000X from the dev seed). This brings every existing row onto the single
 * convention: publicId = PRD-YYYY-NNNNNN, hookId = HK-NNNNNN derived from it.
 */
function plannedHookId(publicId: string) {
  return hookIdFromPublicId(publicId);
}

async function main() {
  await connectDatabase();

  const products = await Product.find({})
    .select('_id title publicId hookId')
    .sort({ createdAt: 1 })
    .lean();

  const missingPublicId = products.filter((product) => !product.publicId);
  const reserved = missingPublicId.length
    ? await nextPublicIds('product', missingPublicId.length)
    : [];

  const plan: Planned[] = [];
  let reservedIndex = 0;

  for (const product of products) {
    const before = { publicId: product.publicId, hookId: product.hookId };
    const publicId = product.publicId || reserved[reservedIndex];
    if (!product.publicId) reservedIndex += 1;
    const hookId = plannedHookId(publicId);

    if (product.publicId === publicId && product.hookId === hookId) continue;

    plan.push({
      _id: String(product._id),
      title: product.title,
      before,
      after: { publicId, hookId },
      reason: !product.publicId
        ? 'missing publicId'
        : product.hookId === product.publicId
          ? 'hookId duplicated publicId'
          : 'hookId not derived from sequence',
    });
  }

  // hookId is unique+sparse, so a collision would abort the write mid-run.
  // Check the whole target set up front and report instead of throwing.
  const targetHookIds = plan.map((item) => item.after.hookId);
  const planIds = new Set(plan.map((item) => item._id));
  const conflicts = await Product.find({
    hookId: { $in: targetHookIds },
    _id: { $nin: [...planIds] },
  }).select('_id hookId').lean();

  console.log(`Scanned ${products.length} Product(s); ${plan.length} need updating.`);
  for (const item of plan) {
    console.log(
      `  ${item.title}\n    ${item.before.publicId || '(no publicId)'} / ${item.before.hookId || '(no hookId)'}` +
      `  ->  ${item.after.publicId} / ${item.after.hookId}   [${item.reason}]`,
    );
  }

  if (conflicts.length) {
    console.error(`\nAborting: ${conflicts.length} target hookId(s) already belong to a different Product:`);
    for (const conflict of conflicts) console.error(`  ${conflict.hookId} -> ${String(conflict._id)}`);
    process.exitCode = 1;
    return;
  }

  if (!plan.length) {
    console.log('Every Product already uses the sequential identifier format.');
    return;
  }

  if (!execute) {
    console.log(`\nDry run. Re-run with --execute to apply ${plan.length} update(s).`);
    return;
  }

  let updated = 0;
  for (const item of plan) {
    await Product.updateOne({ _id: item._id }, { $set: { publicId: item.after.publicId, hookId: item.after.hookId } });
    updated += 1;
  }
  console.log(`\nUpdated ${updated} Product(s).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
