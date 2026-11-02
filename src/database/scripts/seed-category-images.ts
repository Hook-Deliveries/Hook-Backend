import dotenv from 'dotenv';
import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { Category } from '@models/categories/category.model';

dotenv.config({ quiet: true });
const execute = process.argv.includes('--execute');
const u = (id: string) => `https://images.unsplash.com/photo-${id}?w=600&auto=format&fit=crop&q=80`;

/** Category slug -> a photo that shows what the category actually is. Wigs, Boxers, Singlet, Lace and Cables have no honest photo yet. */
const IMAGES: Record<string, string> = {
  wigs: u('1573617868130-7e757dbad187'),
  shoes: u('1542291026-7eec264c27ff'),
  'shoes-sneakers-male': u('1549298916-b41d501d3772'),
  'shoes-sneakers-female': u('1595950653106-6c9ebd614d3a'),
  'shoes-corporate-shoes-male': u('1533867617858-e7b97e060509'),
  'shoes-corporate-shoes-female': u('1515347619252-60a4bf4fff4f'),
  'shoes-sandals-male': u('1603487742131-4160ec999306'),
  'shoes-sandals-female': u('1562273138-f46be4ebdf33'),
  bags: u('1584917865442-de89df76afd3'),
  'bags-male-bags': u('1553062407-98eeb64c6a62'),
  'bags-female-bags': u('1548036328-c9fa89d128fa'),
  watch: u('1524592094714-0f0654e20314'),
  'watch-leather-watches': u('1434056886845-dac89ffe9b56'),
  'watch-chain-watches': u('1547996160-81dfa63595aa'),
  'watch-rubber-strap-watches': u('1523275335684-37898b6baf30'),
  glasses: u('1572635196237-14b3f281503f'),
  'glasses-female-glasses': u('1508296695146-257a814070b4'),
  'glasses-male-glasses': u('1572635196237-14b3f281503f'),
  'glasses-clear-glasses': u('1574258495973-f010dfbb5371'),
  'glasses-sun-shades': u('1511499767150-a48a237f0083'),
  children: u('1514989940723-e8e51635b782'),
  'children-children-sneakers': u('1514989940723-e8e51635b782'),
  'children-children-bags': u('1503919545889-aef636e10ad4'),
  'sports-and-fitness': u('1534438327276-14e5300c3a48'),
  'sports-and-fitness-football-boots': u('1511886929837-354d827aae26'),
  'sports-and-fitness-yoga-mats': u('1601925260368-ae2f83cf8b7f'),
  'sports-and-fitness-sportswear': u('1518310383802-640c2de311b2'),
  'sports-and-fitness-fitness-accessories': u('1517836357463-d25dfeac3438'),
  underwear: u('1582966772680-860e372bb558'),
  'underwear-socks': u('1586350977771-b3b0abd50c82'),
  fabrics: u('1604176354204-9268737828e4'),
  'fabrics-other-types-of-fabric': u('1604176354204-9268737828e4'),
  gadgets: u('1505740420928-5e560c06d30e'),
  'gadgets-powerbank': u('1609091839311-d5365f9ff1c5'),
  'gadgets-chargers': u('1583863788434-e58a36330cf0'),
  'gadgets-headphone': u('1583394838336-acd977736f90'),
  'gadgets-earpods': u('1590658268037-6bf12165a8df'),
  'gadgets-speakers': u('1608043152269-423dbba4e7e1'),
  'gadgets-phone-cases': u('1601593346740-925612772716'),
};

async function main() {
  await connectDatabase();
  let changed = 0;
  for (const [slug, iconUrl] of Object.entries(IMAGES)) {
    const found = await Category.findOne({ slug }).select('name iconUrl').lean();
    if (!found) { console.log(`skip (missing) ${slug}`); continue; }
    if (found.iconUrl === iconUrl) continue;
    console.log(`${execute ? 'set' : 'would set'} ${slug}`);
    if (execute) await Category.updateOne({ slug }, { $set: { iconUrl } });
    changed += 1;
  }
  console.log(`${changed} category image(s) ${execute ? 'updated' : 'to update; run with --execute'}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => disconnectDatabase());
