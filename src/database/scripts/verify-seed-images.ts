import fs from "node:fs";
import path from "node:path";
import { CATEGORY_PRODUCT_CATALOG } from "../seeds/category-product-catalog";

/**
 * Downloads the first bytes of every seed image and keeps only URLs that really
 * return an image. The result is written to seeds/seed-image-manifest.json and
 * the catalogue only fills galleries from verified URLs.
 *
 * Run: npx ts-node -r tsconfig-paths/register src/database/scripts/verify-seed-images.ts
 */
const out = path.join(__dirname, "../seeds/seed-image-manifest.json");

async function check(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { headers: { Range: "bytes=0-2047" }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok && response.status !== 206) return false;
    return (response.headers.get("content-type") || "").startsWith("image/");
  } catch {
    return false;
  }
}

async function main() {
  const urls = [...new Set(CATEGORY_PRODUCT_CATALOG.flatMap((item) => item.images.map((image) => image.url)))];
  const manifest: Record<string, boolean> = {};
  for (let i = 0; i < urls.length; i += 8) {
    const batch = urls.slice(i, i + 8);
    const results = await Promise.all(batch.map(check));
    batch.forEach((url, index) => { manifest[url] = results[index]; });
  }
  fs.writeFileSync(out, JSON.stringify(manifest, null, 1));
  const bad = Object.entries(manifest).filter(([, ok]) => !ok).map(([url]) => url);
  console.log(`Verified ${urls.length - bad.length}/${urls.length} images.`);
  for (const url of bad) console.log(`  BROKEN ${url}`);
}

void main();
