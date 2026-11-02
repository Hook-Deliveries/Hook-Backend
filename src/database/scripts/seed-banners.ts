import dotenv from 'dotenv';
import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { Banner } from '@models/platform/banner.model';
import { Category } from '@models/categories/category.model';

dotenv.config({ quiet: true });
const execute = process.argv.includes('--execute');
const u = (id: string) => `https://images.unsplash.com/photo-${id}?w=1000&h=560&auto=format&fit=crop&q=80`;

/** Starter marquee messages. Idempotent by text; edit or replace them in Admin > Settings > Banners. */
const BANNERS = [
  { text: 'Negotiate your price on thousands of items', tone: 'gold', placement: 'home', imageUrl: u('1549298916-b41d501d3772'), link: undefined },
  { text: 'New in Sneakers: fresh pairs from Balogun market', tone: 'dark', placement: 'home', imageUrl: u('1542291026-7eec264c27ff'), link: 'shoes-sneakers-male' },
  { text: 'Earn Hook credit on every order you complete', tone: 'green', placement: 'home', imageUrl: u('1524592094714-0f0654e20314'), link: undefined },
  { text: 'Gadgets: power banks, earbuds and speakers now live', tone: 'dark', placement: 'all', imageUrl: u('1609091839311-d5365f9ff1c5'), link: 'gadgets' },
  { text: 'Orders start at ₦18,000. Save smaller carts for later', tone: 'gold', placement: 'category', imageUrl: u('1584917865442-de89df76afd3'), link: undefined },
] as const;

async function main() {
  await connectDatabase();
  let created = 0;
  for (const [index, item] of BANNERS.entries()) {
    if (await Banner.exists({ text: item.text, deletedAt: { $exists: false } })) {
      if (execute) await Banner.updateOne({ text: item.text }, { $set: { imageUrl: item.imageUrl } });
      continue;
    }
    const category = item.link ? await Category.findOne({ slug: item.link }).select('publicId').lean() : null;
    console.log(`${execute ? 'create' : 'would create'} "${item.text}"`);
    if (execute) {
      await Banner.create({ text: item.text, tone: item.tone, placement: item.placement, imageUrl: item.imageUrl, isActive: true, sortOrder: index, linkType: category ? 'category' : 'none', linkTarget: category?.publicId });
    }
    created += 1;
  }
  console.log(`${created} banner(s) ${execute ? 'created' : 'to create; run with --execute'}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => disconnectDatabase());
