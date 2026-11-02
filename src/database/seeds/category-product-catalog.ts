import fs from "node:fs";
import path from "node:path";

/**
 * Seed catalogue for the category tree: real-looking products in every
 * sub-category that has honest imagery. Photos are Unsplash (free licence) and,
 * for a few niche items, Wikimedia Commons images mirrored into our Cloudinary
 * (see seed-image-mirror.json for each image's licence and source).
 *
 * Sub-categories with no suitable photo (Wigs, Boxers, Singlet, Lace, and the
 * children's footwear types) are deliberately left without seed products
 * rather than showing a misleading picture.
 */
export interface SeedImage {
  url: string;
  source: "unsplash" | "wikimedia";
  license?: string;
  credit?: string;
}
export interface SeedVariant {
  size?: string;
  colour?: string;
  attributes?: Record<string, string>;
}
export interface CatalogSeed {
  title: string;
  /** Leaf category slug, e.g. shoes-sneakers-male. */
  leaf: string;
  description: string;
  images: SeedImage[];
  costPrice: number;
  sellingPrice: number;
  floorPrice: number;
  quantity: number;
  variants: SeedVariant[];
}

const u = (id: string): SeedImage => ({
  url: `https://images.unsplash.com/photo-${id}?w=1200&auto=format&fit=crop&q=85`,
  source: "unsplash",
});

const mirrorFile = path.join(__dirname, "seed-image-mirror.json");
const mirror: Record<string, { url: string; license: string; title: string }> =
  fs.existsSync(mirrorFile)
    ? JSON.parse(fs.readFileSync(mirrorFile, "utf8"))
    : {};
/** A Wikimedia photo mirrored into Cloudinary; undefined until the mirror script has run. */
const w = (key: string): SeedImage | undefined =>
  !mirror[key] && Object.keys(mirror).length
    ? (console.warn(`Seed image "${key}" is missing from seed-image-mirror.json; run mirror-seed-images.ts`), undefined)
    : mirror[key]
    ? {
        url: mirror[key].url,
        source: "wikimedia",
        license: mirror[key].license,
        credit: mirror[key].title,
      }
    : undefined;
const imgs = (...items: Array<SeedImage | undefined>) =>
  items.filter((item): item is SeedImage => Boolean(item));

const cross = (
  sizes: string[],
  colours: string[],
  extra: Record<string, string> = {},
): SeedVariant[] =>
  (sizes.length ? sizes : [undefined]).flatMap((size) =>
    (colours.length ? colours : [undefined]).map((colour) => ({
      size,
      colour,
      attributes: { ...extra },
    })),
  );

const MEN = ["40", "41", "42", "43", "44", "45"];
const WOMEN = ["36", "37", "38", "39", "40", "41"];
const CLOTHING = ["S", "M", "L", "XL", "2XL"];

/** Price helper: cost in naira, sells at about +25%, negotiation floor at about +10%. */
const price = (cost: number) => ({
  costPrice: cost,
  sellingPrice: Math.round((cost * 1.25) / 500) * 500,
  floorPrice: Math.round((cost * 1.1) / 500) * 500,
});

const BASE_CATALOG: CatalogSeed[] = (
  [
    // Shoes: sneakers
    {
      title: "Crimson Flyknit Runner",
      leaf: "shoes-sneakers-male",
      description:
        "A breathable knit runner in deep red with a cushioned sole. Light on the foot for daily miles and easy to wear with casual outfits.",
      images: imgs(
        u("1542291026-7eec264c27ff"),
        u("1460353581641-37baddab0fa2"),
      ),
      ...price(32000),
      quantity: 24,
      variants: cross(MEN, ["Red", "Black"]),
    },
    {
      title: "Carbon Tan Court Low",
      leaf: "shoes-sneakers-male",
      description:
        "A tan suede-look low-top with a cream sole and contrast stitching. Works with jeans and chinos alike.",
      images: imgs(u("1549298916-b41d501d3772")),
      ...price(38000),
      quantity: 18,
      variants: cross(MEN, ["Tan", "Brown"]),
    },
    {
      title: "Snow White Leather Court",
      leaf: "shoes-sneakers-male",
      description:
        "A clean white court sneaker with a perforated toe and soft leather upper. A wardrobe staple that goes with everything.",
      images: imgs(
        u("1608231387042-66d1773070a5"),
        u("1600269452121-4f2416e55c28"),
      ),
      ...price(29000),
      quantity: 30,
      variants: cross(MEN, ["White"]),
    },
    {
      title: "Urban Hi-Top Retro",
      leaf: "shoes-sneakers-male",
      description:
        "A retro high-top with a padded collar and grippy cupsole, in a bold red and black colourway.",
      images: imgs(u("1556906781-9a412961c28c"), u("1552346154-21d32810aba3")),
      ...price(45000),
      quantity: 12,
      variants: cross(MEN, ["Red", "Black"]),
    },
    {
      title: "Pastel Skate Low",
      leaf: "shoes-sneakers-female",
      description:
        "A pastel-panelled low-top with a chunky sole. Soft lilac, peach and mint tones make it a statement pair.",
      images: imgs(u("1595950653106-6c9ebd614d3a")),
      ...price(36000),
      quantity: 15,
      variants: cross(WOMEN, ["Pink", "White"]),
    },
    {
      title: "Sunset Air Trainer",
      leaf: "shoes-sneakers-female",
      description:
        "A lightweight trainer in white with orange accents and a visible air cushion for all-day comfort.",
      images: imgs(u("1600185365483-26d7a4cc7519")),
      ...price(41000),
      quantity: 14,
      variants: cross(WOMEN, ["White", "Orange"]),
    },
    {
      title: "Sand Minimal Leather Sneaker",
      leaf: "shoes-sneakers-female",
      description:
        "A minimalist leather sneaker in sand and white with a padded tongue. Simple, versatile and easy to style.",
      images: imgs(u("1603808033192-082d6919d3e1")),
      ...price(34000),
      quantity: 16,
      variants: cross(WOMEN, ["Cream", "White"]),
    },
    // Corporate shoes
    {
      title: "Chestnut Double Monk Strap",
      leaf: "shoes-corporate-shoes-male",
      description:
        "A double monk strap dress shoe in polished chestnut leather with a stitched sole. Made for the office and formal events.",
      images: imgs(u("1533867617858-e7b97e060509")),
      ...price(55000),
      quantity: 10,
      variants: cross(MEN, ["Brown"]),
    },
    {
      title: "Oxblood Leather Oxford",
      leaf: "shoes-corporate-shoes-male",
      description:
        "A classic lace-up oxford in rich oxblood leather with a burnished toe. A dress shoe that ages beautifully.",
      images: imgs(u("1449505278894-297fdb3edbc1")),
      ...price(52000),
      quantity: 12,
      variants: cross(MEN, ["Brown", "Black"]),
    },
    {
      title: "Teal Suede Brogue",
      leaf: "shoes-corporate-shoes-male",
      description:
        "A suede brogue in teal with tonal laces and a leather-lined interior. Smart with a suit, sharp with chinos.",
      images: imgs(u("1560343090-f0409e92791a")),
      ...price(48000),
      quantity: 8,
      variants: cross(MEN, ["Teal"]),
    },
    {
      title: "Navy Suede Court Heel",
      leaf: "shoes-corporate-shoes-female",
      description:
        "A suede court heel in navy with a cushioned insole. Elegant enough for the boardroom, comfortable enough for the day.",
      images: imgs(u("1515347619252-60a4bf4fff4f")),
      ...price(42000),
      quantity: 14,
      variants: cross(WOMEN, ["Navy"]),
    },
    {
      title: "Black Block-Heel Ankle Boot",
      leaf: "shoes-corporate-shoes-female",
      description:
        "A sleek black ankle boot on a stable block heel with a smooth leather finish. Sharp for work and evenings.",
      images: imgs(u("1582897085656-c636d006a246")),
      ...price(46000),
      quantity: 11,
      variants: cross(WOMEN, ["Black"]),
    },
    {
      title: "Tan Leather Ankle Boot",
      leaf: "shoes-corporate-shoes-female",
      description:
        "A tan leather ankle boot with a low stacked heel and a soft lining. A versatile smart-casual choice.",
      images: imgs(u("1531310197839-ccf54634509e")),
      ...price(44000),
      quantity: 9,
      variants: cross(WOMEN, ["Tan", "Brown"]),
    },
    // Slides and sandals
    {
      title: "Everyday Rubber Slides",
      leaf: "shoes-slides-male",
      description:
        "Lightweight rubber slides with a contoured footbed and a wide strap. Quick to slip on for home, pool and errands.",
      images: imgs(w("slide_black")),
      ...price(8500),
      quantity: 40,
      variants: cross(MEN, ["Black", "Grey"]),
    },
    {
      title: "Pattern Comfort Slides Set",
      leaf: "shoes-slides-female",
      description:
        "Soft-footbed slides in a trio of finishes: printed black, patterned grey and lavender. Light, flexible and easy to clean.",
      images: imgs(w("slide_three")),
      ...price(7500),
      quantity: 35,
      variants: cross(WOMEN, ["Black", "Grey", "Blue"]),
    },
    {
      title: "Cork Footbed Buckle Sandal",
      leaf: "shoes-sandals-male",
      description:
        "A two-strap sandal with a moulded cork footbed and adjustable buckles. Supportive for long days on your feet.",
      images: imgs(u("1603487742131-4160ec999306")),
      ...price(18000),
      quantity: 20,
      variants: cross(MEN, ["Grey", "Brown"]),
    },
    {
      title: "Burgundy Platform Sandal",
      leaf: "shoes-sandals-female",
      description:
        "A slingback platform sandal in burgundy leather with a cross-strap front. Comfortable height with a fashionable finish.",
      images: imgs(u("1562273138-f46be4ebdf33")),
      ...price(21000),
      quantity: 16,
      variants: cross(WOMEN, ["Burgundy", "Tan"]),
    },
    // Bags
    {
      title: "Navy Everyday Backpack",
      leaf: "bags-male-bags",
      description:
        "A minimal navy backpack with a padded laptop sleeve and water-resistant fabric. Built for commutes and campus.",
      images: imgs(u("1553062407-98eeb64c6a62")),
      ...price(26000),
      quantity: 22,
      variants: [
        { colour: "Navy", attributes: { size: "Medium" } },
        { colour: "Black", attributes: { size: "Medium" } },
      ],
    },
    {
      title: "Cognac Leather Backpack",
      leaf: "bags-male-bags",
      description:
        "A soft leather backpack in warm cognac with a padded back and two roomy compartments. Ages with character.",
      images: imgs(u("1622560480605-d83c853bc5c3")),
      ...price(58000),
      quantity: 9,
      variants: [{ colour: "Brown", attributes: { size: "Large" } }],
    },
    {
      title: "Carbon Black Daypack",
      leaf: "bags-male-bags",
      description:
        "A clean black daypack with a zip main compartment and comfortable straps. Light enough for travel.",
      images: imgs(u("1581605405669-fcdf81165afa")),
      ...price(19000),
      quantity: 28,
      variants: [{ colour: "Black", attributes: { size: "Medium" } }],
    },
    {
      title: "Trail Canvas Rucksack",
      leaf: "bags-male-bags",
      description:
        "A rugged canvas rucksack in forest green with leather straps and a roll-top closure. Made for weekends away.",
      images: imgs(u("1491637639811-60e2756cc1c7")),
      ...price(35000),
      quantity: 12,
      variants: [{ colour: "Green", attributes: { size: "Large" } }],
    },
    {
      title: "Sunset Top-Handle Bag",
      leaf: "bags-female-bags",
      description:
        "A structured top-handle bag in vivid coral with a polished clasp and detachable strap. Statement style, everyday size.",
      images: imgs(u("1584917865442-de89df76afd3")),
      ...price(48000),
      quantity: 10,
      variants: [{ colour: "Red", attributes: { size: "Medium" } }],
    },
    {
      title: "Quilted Chain Shoulder Bag",
      leaf: "bags-female-bags",
      description:
        "A black quilted shoulder bag with a gold chain strap and a magnetic flap. Compact, elegant and easy to dress up.",
      images: imgs(u("1548036328-c9fa89d128fa")),
      ...price(72000),
      quantity: 6,
      variants: [{ colour: "Black", attributes: { size: "Small" } }],
    },
    {
      title: "Woven Rattan Handbag",
      leaf: "bags-female-bags",
      description:
        "A hand-woven rattan bag with a leather flap and top handle. Light, airy and perfect for warm days.",
      images: imgs(u("1590874103328-eac38a683ce7")),
      ...price(39000),
      quantity: 8,
      variants: [{ colour: "Tan", attributes: { size: "Medium" } }],
    },
    {
      title: "Blush Chevron Crossbody",
      leaf: "bags-female-bags",
      description:
        "A pink crossbody with a chevron colour-block flap and a slim chain. Small enough for the essentials.",
      images: imgs(u("1566150905458-1bf1fc113f0d")),
      ...price(27000),
      quantity: 14,
      variants: [{ colour: "Pink", attributes: { size: "Small" } }],
    },
    {
      title: "Teal Structured Satchel",
      leaf: "bags-female-bags",
      description:
        "A teal leather satchel with a gold push-lock and roomy interior. A work-ready bag that holds a tablet.",
      images: imgs(u("1594223274512-ad4803739b7c")),
      ...price(44000),
      quantity: 9,
      variants: [{ colour: "Teal", attributes: { size: "Medium" } }],
    },
    {
      title: "Ruby Envelope Clutch Bag",
      leaf: "bags-female-bags",
      description:
        "A red quilted envelope bag with a gold chain and monogram-style clasp for evenings and events.",
      images: imgs(u("1587467512961-120760940315")),
      ...price(65000),
      quantity: 5,
      variants: [{ colour: "Red", attributes: { size: "Small" } }],
    },
    // Watches
    {
      title: "Beige Leather Strap Classic",
      leaf: "watch-leather-watches",
      description:
        "A slim minimalist watch with a beige leather strap and a rose-gold case. Quartz movement, everyday elegance.",
      images: imgs(u("1524592094714-0f0654e20314")),
      ...price(42000),
      quantity: 15,
      variants: [{ colour: "Brown" }, { colour: "Black" }],
    },
    {
      title: "Midnight Dial Field Watch",
      leaf: "watch-leather-watches",
      description:
        "A black-dial field watch with luminous hands and a durable leather strap. Clear to read at a glance.",
      images: imgs(u("1434056886845-dac89ffe9b56")),
      ...price(36000),
      quantity: 12,
      variants: [{ colour: "Black" }, { colour: "Brown" }],
    },
    {
      title: "Steel Bracelet Automatic",
      leaf: "watch-chain-watches",
      description:
        "A stainless steel bracelet watch with a dark dial and date window. Solid, weighty and made to last.",
      images: imgs(u("1547996160-81dfa63595aa")),
      ...price(115000),
      quantity: 6,
      variants: [{ colour: "Silver" }, { colour: "Gold" }],
    },
    {
      title: "Arctic Rubber Sport Watch",
      leaf: "watch-rubber-strap-watches",
      description:
        "A modern sport watch in white with a soft rubber strap and a bold round face. Water resistant and lightweight.",
      images: imgs(u("1523275335684-37898b6baf30")),
      ...price(28000),
      quantity: 20,
      variants: [{ colour: "White" }, { colour: "Black" }],
    },
    {
      title: "Active Smart Watch",
      leaf: "watch-rubber-strap-watches",
      description:
        "A smart watch with a bright display, activity tracking and a comfortable silicone strap.",
      images: imgs(u("1434493789847-2f02dc6ca35d")),
      ...price(64000),
      quantity: 14,
      variants: [{ colour: "Black" }, { colour: "White" }],
    },
    // Glasses
    {
      title: "Rose Cat-Eye Sunglasses",
      leaf: "glasses-female-glasses",
      description:
        "Oversized cat-eye frames with gradient rose lenses and UV protection. A flattering shape for every face.",
      images: imgs(u("1508296695146-257a814070b4")),
      ...price(14000),
      quantity: 26,
      variants: [{ colour: "Pink" }, { colour: "Brown" }],
    },
    {
      title: "Classic Wayfarer Black",
      leaf: "glasses-male-glasses",
      description:
        "The everyday wayfarer in gloss black with polarised lenses and a sturdy hinge.",
      images: imgs(u("1572635196237-14b3f281503f")),
      ...price(18000),
      quantity: 30,
      variants: [{ colour: "Black" }],
    },
    {
      title: "Browline Clear Lens Frames",
      leaf: "glasses-clear-glasses",
      description:
        "Browline frames in tortoise and clear metal with anti-glare clear lenses. A smart look for reading and screens.",
      images: imgs(u("1574258495973-f010dfbb5371")),
      ...price(12000),
      quantity: 24,
      variants: [{ colour: "Brown" }, { colour: "Black" }],
    },
    {
      title: "Gold Round Sun Shades",
      leaf: "glasses-sun-shades",
      description:
        "Round gold-rim sun shades with green tinted lenses. Lightweight metal frame with adjustable nose pads.",
      images: imgs(u("1511499767150-a48a237f0083")),
      ...price(15000),
      quantity: 22,
      variants: [{ colour: "Gold" }],
    },
    {
      title: "Crystal Frame Beach Shades",
      leaf: "glasses-sun-shades",
      description:
        "Clear-frame sun shades with warm amber lenses. Made for the coast, the pool and long sunny days.",
      images: imgs(u("1577803645773-f96470509666")),
      ...price(13000),
      quantity: 20,
      variants: [{ colour: "Brown" }],
    },
    {
      title: "Shoreline Dark Shades",
      leaf: "glasses-sun-shades",
      description:
        "Dark round sun shades with a gradient tint and a slim frame, ideal for driving and travel.",
      images: imgs(u("1473496169904-658ba7c44d8a")),
      ...price(11000),
      quantity: 28,
      variants: [{ colour: "Black" }],
    },
    // Children
    {
      title: "Kids Sunburst Trainer",
      leaf: "children-children-sneakers",
      description:
        "A colourful cushioned trainer with a flexible sole and easy lace-up fit, sized for growing feet.",
      images: imgs(u("1514989940723-e8e51635b782")),
      ...price(15000),
      quantity: 20,
      variants: (["Male", "Female"] as const).flatMap((gender) =>
        cross(["28", "30", "32", "34"], ["Orange"], { gender }),
      ),
    },
    {
      title: "Explorer Mini Backpack",
      leaf: "children-children-bags",
      description:
        "A light pastel-blue mini backpack with padded straps and a zip pocket. Sized for school and days out.",
      images: imgs(u("1503919545889-aef636e10ad4")),
      ...price(9500),
      quantity: 25,
      variants: [{ colour: "Blue" }, { colour: "Pink" }],
    },
    // Sports and fitness
    {
      title: "Predator Turf Football Boots",
      leaf: "sports-and-fitness-football-boots",
      description:
        "Firm-ground football boots with a textured strike zone and a snug sock fit. Built for grip and control.",
      images: imgs(u("1511886929837-354d827aae26")),
      ...price(34000),
      quantity: 16,
      variants: cross(MEN, ["Black"]),
    },
    {
      title: "Aqua Strike Football Boots",
      leaf: "sports-and-fitness-football-boots",
      description:
        "Lightweight football boots with a knit collar and studded outsole for quick acceleration.",
      images: imgs(u("1579952363873-27f3bade9f55")),
      ...price(38000),
      quantity: 12,
      variants: cross(MEN, ["Blue", "White"]),
    },
    {
      title: "Heritage Long-Sleeve Match Jersey",
      leaf: "sports-and-fitness-jerseys",
      description:
        "A retro long-sleeve club jersey with a collared neckline and stitched crest. Breathable and true to fit.",
      images: imgs(w("jersey1"), w("jersey2")),
      ...price(13000),
      quantity: 30,
      variants: cross(CLOTHING, ["White"]),
    },
    {
      title: "Green Band Classic Jersey",
      leaf: "sports-and-fitness-jerseys",
      description:
        "A white classic-fit jersey with a bold green chest band and lace-up collar. Soft, sweat-wicking fabric.",
      images: imgs(w("jersey3")),
      ...price(14500),
      quantity: 26,
      variants: cross(CLOTHING, ["White", "Green"]),
    },
    {
      title: "Studio Studio Yoga Mat 6mm",
      leaf: "sports-and-fitness-yoga-mats",
      description:
        "A non-slip 6 mm yoga mat with dense cushioning for joints. Easy to roll, easy to wipe clean.",
      images: imgs(u("1601925260368-ae2f83cf8b7f")),
      ...price(9000),
      quantity: 40,
      variants: cross([], ["Teal", "Purple", "Black"], { thickness: "6 mm" }),
    },
    {
      title: "Pilates Pink Mat 8mm",
      leaf: "sports-and-fitness-yoga-mats",
      description:
        "An extra-thick 8 mm mat in soft pink for pilates, stretching and floor workouts.",
      images: imgs(u("1518611012118-696072aa579a")),
      ...price(11000),
      quantity: 30,
      variants: cross([], ["Pink"], { thickness: "8 mm" }),
    },
    {
      title: "High-Rise Training Set",
      leaf: "sports-and-fitness-sportswear",
      description:
        "A matching sports top and high-waist leggings in stretch fabric with a secure fit for training and running.",
      images: imgs(u("1518310383802-640c2de311b2")),
      ...price(19000),
      quantity: 22,
      variants: cross(CLOTHING, ["Black", "Red"]),
    },
    {
      title: "Hydra Shaker Bottle 700ml",
      leaf: "sports-and-fitness-fitness-accessories",
      description:
        "A leak-proof 700 ml shaker bottle with a mixing agitator and a flip cap. BPA free.",
      images: imgs(u("1610824352934-c10d87b700cc")),
      ...price(5500),
      quantity: 60,
      variants: [
        { colour: "Teal", attributes: { type: "Shaker bottle" } },
        { colour: "Black", attributes: { type: "Shaker bottle" } },
      ],
    },
    {
      title: "Rubber Hex Dumbbell Pair",
      leaf: "sports-and-fitness-fitness-accessories",
      description:
        "A pair of rubber-coated hex dumbbells that will not roll away and protect your floor.",
      images: imgs(u("1534438327276-14e5300c3a48")),
      ...price(24000),
      quantity: 15,
      variants: [{ colour: "Black", attributes: { type: "Dumbbell pair" } }],
    },
    {
      title: "Olympic Barbell Bar",
      leaf: "sports-and-fitness-fitness-accessories",
      description:
        "A knurled steel barbell bar with a smooth rotation, for squats, deadlifts and presses.",
      images: imgs(u("1517836357463-d25dfeac3438")),
      ...price(48000),
      quantity: 6,
      variants: [{ colour: "Silver", attributes: { type: "Barbell" } }],
    },
    // Underwear
    {
      title: "Cream Seamless Comfort Bra",
      leaf: "underwear-bra",
      description:
        "A seamless wire-free bra in soft cream with stretch straps and no-show edges. All-day comfort.",
      images: imgs(w("bra_cream")),
      ...price(6500),
      quantity: 40,
      variants: cross(["32B", "34B", "34C", "36C", "36D"], ["Cream"]),
    },
    {
      title: "Burgundy Smooth Support Bra",
      leaf: "underwear-bra",
      description:
        "A smooth-finish support bra in burgundy with wide straps and a removable pad.",
      images: imgs(w("bra_burgundy")),
      ...price(7500),
      quantity: 32,
      variants: cross(["32B", "34B", "34C", "36C", "36D"], ["Burgundy"]),
    },
    {
      title: "Festive Print Crew Socks",
      leaf: "underwear-socks",
      description:
        "Soft cotton-blend crew socks in a cheerful print with a cushioned foot.",
      images: imgs(u("1582966772680-860e372bb558")),
      ...price(3200),
      quantity: 80,
      variants: cross([], ["Red"], { sizeRange: "41 - 45", pack: "3 pairs" }),
    },
    {
      title: "Statement Lips Socks",
      leaf: "underwear-socks",
      description:
        "Fun printed socks in soft combed cotton with a stay-put cuff.",
      images: imgs(u("1586350977771-b3b0abd50c82")),
      ...price(3000),
      quantity: 70,
      variants: cross([], ["White"], { sizeRange: "36 - 40", pack: "1 pair" }),
    },
    // Fabrics
    {
      title: "Hand-Dyed Adire Indigo Bundle",
      leaf: "fabrics-adire",
      description:
        "Authentic hand-dyed Adire cloth from Abeokuta in rich indigo and multi-colour patterns. Sold by the yard.",
      images: imgs(w("adire_stack"), w("adire_market")),
      ...price(14000),
      quantity: 30,
      variants: cross([], ["Blue", "Multi"], { yards: "5 yards" }).concat(
        cross([], ["Blue"], { yards: "6 yards" }),
      ),
    },
    {
      title: "African Wax Print Ankara",
      leaf: "fabrics-other-types-of-fabric",
      description:
        "Vibrant wax print fabric in bold patterns, ideal for tailored outfits, headwraps and home decor. Sold by the yard.",
      images: imgs(w("wax")),
      ...price(11000),
      quantity: 45,
      variants: cross([], ["Multi"], { yards: "6 yards" }),
    },
    {
      title: "Stone-Wash Denim Fabric",
      leaf: "fabrics-other-types-of-fabric",
      description:
        "Mid-weight stone-washed denim fabric with a soft hand, perfect for jackets, jeans and bags. Sold by the yard.",
      images: imgs(u("1604176354204-9268737828e4")),
      ...price(9500),
      quantity: 35,
      variants: cross([], ["Blue"], { yards: "5 yards" }).concat(
        cross([], ["Blue"], { yards: "2 yards" }),
      ),
    },
    // Gadgets
    {
      title: "Slim 10000mAh Power Bank",
      leaf: "gadgets-powerbank",
      description:
        "A slim 10,000 mAh power bank with fast charging and dual outputs. Fits in a pocket.",
      images: imgs(u("1609091839311-d5365f9ff1c5")),
      ...price(11500),
      quantity: 50,
      variants: cross([], ["Black"], { capacity: "10,000 mAh" }).concat(
        cross([], ["Black"], { capacity: "20,000 mAh" }),
      ),
    },
    {
      title: "Fast Wall Charger Kit",
      leaf: "gadgets-chargers",
      description:
        "A compact fast-charging wall adapter with a matching cable. Safe, quick top-ups for phones and tablets.",
      images: imgs(u("1583863788434-e58a36330cf0")),
      ...price(6500),
      quantity: 65,
      variants: [
        {
          colour: "White",
          attributes: { wattage: "20 W", connector: "USB-C" },
        },
        {
          colour: "White",
          attributes: { wattage: "33 W", connector: "USB-C" },
        },
        {
          colour: "White",
          attributes: { wattage: "20 W", connector: "Lightning" },
        },
      ],
    },
    {
      title: "Studio Wireless Headphones",
      leaf: "gadgets-headphone",
      description:
        "Over-ear wireless headphones with deep bass, soft cushions and up to 30 hours of playback.",
      images: imgs(u("1505740420928-5e560c06d30e")),
      ...price(32000),
      quantity: 22,
      variants: [
        { colour: "Black", attributes: { connectivity: "Bluetooth" } },
        { colour: "Grey", attributes: { connectivity: "Bluetooth" } },
      ],
    },
    {
      title: "Wired Monitor Headphones",
      leaf: "gadgets-headphone",
      description:
        "Lightweight wired headphones with balanced sound and a foldable design for studio and travel.",
      images: imgs(u("1583394838336-acd977736f90")),
      ...price(14000),
      quantity: 28,
      variants: [{ colour: "Black", attributes: { connectivity: "Wired" } }],
    },
    {
      title: "Max Noise-Cancelling Headphones",
      leaf: "gadgets-headphone",
      description:
        "Premium noise-cancelling over-ear headphones with a metal frame and spatial audio. Silver finish.",
      images: imgs(u("1609081219090-a6d81d3085bf")),
      ...price(210000),
      quantity: 4,
      variants: [
        { colour: "Silver", attributes: { connectivity: "Bluetooth" } },
      ],
    },
    {
      title: "True Wireless Earbuds Pro",
      leaf: "gadgets-earpods",
      description:
        "True wireless earbuds with active noise cancellation, a charging case and a secure fit.",
      images: imgs(u("1572569511254-d8f925fe2cbb")),
      ...price(58000),
      quantity: 18,
      variants: [
        { colour: "White", attributes: { compatibility: "Universal" } },
        { colour: "White", attributes: { compatibility: "iPhone" } },
      ],
    },
    {
      title: "Compact Earbuds Trio",
      leaf: "gadgets-earpods",
      description:
        "Compact true wireless earbuds with a pocket case and clear calls. Available in three finishes.",
      images: imgs(u("1590658268037-6bf12165a8df")),
      ...price(19000),
      quantity: 30,
      variants: [
        { colour: "Black", attributes: { compatibility: "Universal" } },
        { colour: "White", attributes: { compatibility: "Universal" } },
      ],
    },
    {
      title: "Rugged Portable Bluetooth Speaker",
      leaf: "gadgets-speakers",
      description:
        "A waterproof portable speaker with punchy bass and a 12-hour battery.",
      images: imgs(u("1608043152269-423dbba4e7e1")),
      ...price(28000),
      quantity: 26,
      variants: [
        { colour: "Black", attributes: { connectivity: "Bluetooth" } },
      ],
    },
    {
      title: "Pulse Light Party Speaker",
      leaf: "gadgets-speakers",
      description:
        "A colourful light-up speaker with big sound and dynamic LED patterns for parties.",
      images: imgs(u("1589003077984-894e133dabab")),
      ...price(35000),
      quantity: 14,
      variants: [
        { colour: "Black", attributes: { connectivity: "Bluetooth" } },
      ],
    },
    {
      title: "Studio Bookshelf Speaker",
      leaf: "gadgets-speakers",
      description:
        "A wooden bookshelf speaker with a rich, warm sound for desks and living rooms.",
      images: imgs(u("1545454675-3531b543be5d")),
      ...price(72000),
      quantity: 6,
      variants: [{ colour: "Green", attributes: { connectivity: "Wired" } }],
    },
    {
      title: "Carbon Slim Phone Case",
      leaf: "gadgets-phone-cases",
      description:
        "A slim carbon-fibre-look phone case with raised edges and precise cut-outs. Light protection with grip.",
      images: imgs(u("1601593346740-925612772716")),
      ...price(3500),
      quantity: 90,
      variants: [
        { colour: "Black", attributes: { phoneModel: "iPhone 13 Pro" } },
        { colour: "Black", attributes: { phoneModel: "iPhone 14 Pro" } },
        { colour: "Black", attributes: { phoneModel: "iPhone 15 Pro" } },
      ],
    },
    // Wigs
    {
      title: "Honey Blonde Lace Front Wig",
      leaf: "wigs",
      description:
        "A soft honey-blonde lace front wig with loose natural waves and a realistic hairline. Pre-plucked and easy to style.",
      images: imgs(u("1573617868130-7e757dbad187")),
      ...price(85000),
      quantity: 8,
      variants: (['14"', '18"', '22"'] as const).map((length) => ({
        colour: "Blonde",
        attributes: { length, texture: "Body wave" },
      })),
    },
    {
      title: "Ginger Straight Bob Wig",
      leaf: "wigs",
      description:
        "A silky ginger-to-honey straight wig with a dark root for a natural look. Lightweight cap and adjustable straps.",
      images: imgs(
        u("1663582816182-15cf69d87665"),
        u("1663582815412-665909d70e01"),
      ),
      ...price(72000),
      quantity: 10,
      variants: (['12"', '16"', '20"'] as const).map((length) => ({
        colour: "Orange",
        attributes: { length, texture: "Straight" },
      })),
    },
  ] as CatalogSeed[]
).filter((item) => item.images.length > 0);

const manifestFile = path.join(__dirname, "seed-image-manifest.json");
/** URLs confirmed by verify-seed-images.ts. Without the manifest every URL is trusted. */
const verified: Record<string, boolean> = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : {};
const usable = (image: SeedImage) => verified[image.url] !== false;

/** Leaves whose photos may stand in for each other (same kind of product). */
const FAMILIES: string[][] = [
  ["gadgets-earpods", "gadgets-headphone", "gadgets-speakers"],
  ["gadgets-chargers", "gadgets-powerbank", "gadgets-phone-cases"],
  ["watch-leather-watches", "watch-rubber-strap-watches", "watch-chain-watches"],
  ["glasses-sun-shades", "glasses-male-glasses", "glasses-female-glasses", "glasses-clear-glasses"],
  ["bags-female-bags", "bags-male-bags", "children-children-bags"],
  ["shoes-sneakers-male", "shoes-sneakers-female", "children-children-sneakers"],
  ["shoes-corporate-shoes-male", "shoes-corporate-shoes-female"],
  ["shoes-slides-male", "shoes-slides-female", "shoes-sandals-male", "shoes-sandals-female"],
  ["fabrics-adire", "fabrics-other-types-of-fabric"],
  ["underwear-socks", "underwear-bra"],
  ["sports-and-fitness-jerseys", "sports-and-fitness-sportswear", "sports-and-fitness-fitness-accessories", "sports-and-fitness-yoga-mats", "sports-and-fitness-football-boots"],
];
export const MIN_SEED_IMAGES = 3;
const hash = (text: string) => [...text].reduce((total, char) => (total * 31 + char.charCodeAt(0)) >>> 0, 7);

/**
 * Every product gets its own photos first, then unused photos of the same leaf,
 * then of its family, picked in a stable order by title so re-seeding is deterministic.
 */
function withGalleries(items: CatalogSeed[]): CatalogSeed[] {
  return items.map((item) => {
    const own = item.images.filter(usable);
    const family = FAMILIES.find((group) => group.includes(item.leaf)) || [item.leaf];
    const seen = new Set(own.map((image) => image.url));
    const rank = (candidate: CatalogSeed) => (candidate.leaf === item.leaf ? 0 : 1);
    const pool = items
      .filter((candidate) => candidate !== item && family.includes(candidate.leaf))
      .sort((a, b) => rank(a) - rank(b) || (hash(item.title + a.title) - hash(item.title + b.title)))
      .flatMap((candidate) => candidate.images.filter(usable));
    const gallery = [...own];
    for (const image of pool) {
      if (gallery.length >= MIN_SEED_IMAGES) break;
      if (!seen.has(image.url)) { seen.add(image.url); gallery.push(image); }
    }
    return { ...item, images: gallery };
  });
}

export const CATEGORY_PRODUCT_CATALOG: CatalogSeed[] = withGalleries(BASE_CATALOG);
