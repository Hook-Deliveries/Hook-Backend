import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { v2 as cloudinary } from 'cloudinary';

dotenv.config({ quiet: true });

/**
 * Copies the few seed photos that come from Wikimedia Commons into the
 * project's own Cloudinary, so the app is not hotlinking a server that
 * rate-limits (HTTP 429). Writes the resulting URLs next to the sources.
 *   node ... mirror-seed-images.ts --execute
 */
const execute = process.argv.includes('--execute');
const sourcesFile = path.join(__dirname, '../seeds/seed-image-sources.json');
const mirroredFile = path.join(__dirname, '../seeds/seed-image-mirror.json');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const sources = JSON.parse(fs.readFileSync(sourcesFile, 'utf8')) as Record<string, { url: string; license: string; title: string }>;
  const mirrored: Record<string, { url: string; license: string; title: string; source: string }> = fs.existsSync(mirroredFile) ? JSON.parse(fs.readFileSync(mirroredFile, 'utf8')) : {};
  cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true });

  for (const [key, source] of Object.entries(sources)) {
    if (mirrored[key]) { console.log(`  have    ${key}`); continue; }
    console.log(`  ${execute ? 'upload ' : 'would  '} ${key}  (${source.license})`);
    if (!execute) continue;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        const result = await cloudinary.uploader.upload(source.url, { folder: 'hook/seed', public_id: `seed-${key}`, overwrite: false, resource_type: 'image', tags: ['seed', 'wikimedia'] });
        mirrored[key] = { url: result.secure_url, license: source.license, title: source.title, source: source.url };
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        console.log(`    attempt ${attempt} failed: ${message.slice(0, 90)}`);
        await sleep(4000 * attempt);
      }
    }
    await sleep(1500);
  }
  if (execute) fs.writeFileSync(mirroredFile, `${JSON.stringify(mirrored, null, 1)}\n`);
  if (!execute) console.log('\nNo data changed. Run with --execute to upload.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
