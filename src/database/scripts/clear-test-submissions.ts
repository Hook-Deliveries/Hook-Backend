import { Model } from 'mongoose';
import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { CartItem } from '@models/cart/cart-item.model';
import { CatalogMediaAsset, NegotiatedQuote, ProductSubmission, ProductVariant } from '@models/catalog/catalog.model';
import { Negotiation } from '@models/negotiations/negotiation.model';
import { ProductLike } from '@models/products/product-like.model';
import { Product } from '@models/products/product.model';

type AnyModel = Model<any>;
type Target = { label: string; model: AnyModel; filter: Record<string, unknown> };

const execute = process.argv.includes('--execute');

// The "Test" submission a Market Associate created while trying the capture
// flow (SUB-2026-000063), which produced live product PRD-2026-000090. This
// removes both records plus everything downstream of them.
const SUBMISSION_PUBLIC_IDS = ['SUB-2026-000063'];

function unique(values: unknown[]) {
  return [...new Set(values.filter(Boolean).map(String))];
}

async function main() {
  await connectDatabase();

  const submissions = await ProductSubmission.find({ publicId: { $in: SUBMISSION_PUBLIC_IDS } })
    .select('_id publicId basicTitle status productId mediaIds')
    .lean();
  if (!submissions.length) {
    console.log('No matching submissions found. Nothing to do.');
    return;
  }
  const submissionRefs = unique(submissions.flatMap((item) => [item._id, item.publicId]));

  // There's no soft-delete query middleware in this codebase — every query
  // filters deletedAt itself when it wants to. A plain find() here already
  // returns the soft-deleted "Test 2" product along with the live "Test" one.
  const products = await Product.find({ sourceSubmissionId: { $in: submissionRefs } })
    .select('_id publicId title status deletedAt')
    .lean();
  const productRefs = unique(products.flatMap((item) => [item._id, item.publicId]));

  const negotiations = await Negotiation.find({ productId: { $in: productRefs } }).select('_id publicId').lean();
  const negotiationRefs = unique(negotiations.flatMap((item) => [item._id, item.publicId]));

  const targets: Target[] = [
    { label: 'Negotiated quotes', model: NegotiatedQuote, filter: { $or: [{ productId: { $in: productRefs } }, { negotiationId: { $in: negotiationRefs } }] } },
    { label: 'Negotiations', model: Negotiation, filter: { productId: { $in: productRefs } } },
    { label: 'Saved products', model: ProductLike, filter: { productId: { $in: productRefs } } },
    { label: 'Cart lines', model: CartItem, filter: { productId: { $in: productRefs } } },
    { label: 'Product variants', model: ProductVariant, filter: { productId: { $in: productRefs } } },
    { label: 'Product media records', model: CatalogMediaAsset, filter: { ownerType: 'product', ownerId: { $in: productRefs } } },
    { label: 'Test Product(s)', model: Product, filter: { _id: { $in: products.map((item) => item._id) } } },
    { label: 'Submission media records', model: CatalogMediaAsset, filter: { ownerType: 'submission', ownerId: { $in: submissionRefs } } },
    { label: 'Test submission(s)', model: ProductSubmission, filter: { _id: { $in: submissions.map((item) => item._id) } } },
  ];

  console.log(`Found ${submissions.length} test submission(s) and ${products.length} linked Product(s):`);
  for (const item of submissions) console.log(`  ${item.publicId} — "${item.basicTitle}" (${item.status})`);
  for (const item of products) console.log(`  ${item.publicId} — "${item.title}" (${item.status}${item.deletedAt ? ', already soft-deleted' : ''})`);

  console.log(`\n${execute ? 'Clearing' : 'Dry run for'} the records above:`);
  for (const target of targets) {
    const count = await target.model.countDocuments(target.filter);
    if (!count) continue;
    if (execute) await target.model.deleteMany(target.filter);
    console.log(`${execute ? 'Deleted' : 'Would delete'} ${count} ${target.label}`);
  }

  if (!execute) console.log('\nNo data changed. Run with --execute to apply this cleanup.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
