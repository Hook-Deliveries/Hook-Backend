import dotenv from 'dotenv';
import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { Category } from '@models/categories/category.model';
import { ProductSubmission } from '@models/catalog/catalog.model';
import { Product } from '@models/products/product.model';
import { CATEGORY_PRODUCT_CATALOG } from '../seeds/category-product-catalog';

dotenv.config({ quiet: true });
const execute = process.argv.includes('--execute');
const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
// Products from the seeded catalogue already have their category; only legacy items are guessed from their title.
const SEEDED_TITLES = new Set(CATEGORY_PRODUCT_CATALOG.map((item) => item.title));

/** Ordered title rules -> leaf slug. Dresses and jackets have no matching sub-category and stay flagged. */
const RULES: Array<[RegExp, string]> = [
  [/dress(?! shoe)/i, 'clothing-dresses'],
  [/jacket/i, 'clothing-jackets'],
  [/wedge/i, 'shoes-slides-female'],
  [/slide|slipper/i, 'shoes-slides-male'],
  [/loafer|monk|pebble|oxford|brogue/i, 'shoes-corporate-shoes-male'],
  [/sneaker|nike|adidas|runner|street court|canvas|slip-on|louis vuitton|trainer/i, 'shoes-sneakers-male'],
  [/tee|t-shirt|jersey/i, 'sports-and-fitness-sportswear'],
  [/smart ?watch/i, 'watch-rubber-strap-watches'],
  [/watch/i, 'watch-leather-watches'],
  [/sunglass|shades/i, 'glasses-sun-shades'],
  [/cap\b/i, 'sports-and-fitness-fitness-accessories'],
  [/crocs leather|backpack/i, 'bags-male-bags'],
  [/bag|handbag|tote|purse/i, 'bags-female-bags'],
];
const leafFor = (title: string) => RULES.find(([re]) => re.test(title))?.[1];

async function main() {
  await connectDatabase();
  const cats = await Category.find({ level: 1 }).lean();
  const bySlug = new Map(cats.map((c) => [c.slug, c]));
  let moved = 0; const left: string[] = [];
  for (const [model, titleKey, label] of [[Product, 'title', 'product'], [ProductSubmission, 'basicTitle', 'submission']] as const) {
    const docs: any[] = await (model as any).find({}).select(`${titleKey} categoryId categorySuggestionId`).lean();
    for (const doc of docs) {
      const title = doc[titleKey] as string;
      if (SEEDED_TITLES.has(title)) continue;
      const slug = leafFor(title);
      const cat = slug && bySlug.get(slug);
      if (!cat) { left.push(`${label}: ${title}`); continue; }
      console.log(`${execute ? 'Moving' : 'Would move'} ${label} "${title}" -> ${slug}`);
      moved += 1;
      if (execute) {
        const set = label === 'product' ? { categoryId: String(cat._id) } : { categorySuggestionId: String(cat._id) };
        await (model as any).updateOne({ _id: doc._id }, { $set: set, $unset: { needsRecategorisation: '' } });
      }
    }
  }
  console.log(`${moved} remapped. Left without a sub-category (${left.length}):\n${left.join('\n')}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => disconnectDatabase());
