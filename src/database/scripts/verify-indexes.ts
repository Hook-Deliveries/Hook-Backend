import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '@config/data-source';

/**
 * Production runs with autoIndex off, so a unique index declared in a schema
 * may simply not exist in the database, and the idempotency guarantee it is
 * supposed to give does not exist either. This lists every index each model
 * declares that the live collection lacks. With --create it builds the
 * missing ones (a unique index fails if duplicates exist: run
 * report-duplicates first).
 *
 *   npm run db:verify-indexes            # report only, exits 1 on drift
 *   npm run db:verify-indexes -- --create
 */
const create = process.argv.includes('--create');

function sameKey(a: Record<string, unknown>, b: Record<string, unknown>) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((key, i) => bk[i] === key && String(a[key]) === String(b[key]));
}

async function loadModels(dir: string): Promise<void> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) await loadModels(full);
    else if (/\.model\.(ts|js)$/.test(name)) await import(full);
  }
}

async function main() {
  await connectDatabase();
  // Development connects with autoIndex on, which builds missing indexes in the
  // background as models load and would hide the very drift this reports.
  mongoose.connection.config.autoIndex = false;
  // No model barrel exists, so load every *.model file to register its schema.
  await loadModels(join(__dirname, '..', '..', 'models'));
  await loadModels(join(__dirname, '..', '..', 'modules'));
  let missing = 0;
  for (const model of Object.values(mongoose.models)) {
    const declared = model.schema.indexes();
    let live: Array<{ key: Record<string, unknown>; unique?: boolean }> = [];
    try {
      live = await model.collection.indexes();
    } catch {
      // Collection does not exist yet: every declared index is missing.
    }
    for (const [key, options] of declared) {
      // Text indexes are stored as { _fts, _ftsx }, so match on any text index.
      if (Object.values(key as Record<string, unknown>).includes('text')) {
        if (live.some((index) => '_fts' in index.key)) continue;
      }
      const found = live.find((index) => sameKey(index.key, key as Record<string, unknown>));
      const wantsUnique = Boolean((options as { unique?: boolean }).unique);
      if (found && (!wantsUnique || found.unique)) continue;
      missing += 1;
      console.log(`${wantsUnique ? 'UNIQUE ' : ''}MISSING  ${model.modelName}  ${JSON.stringify(key)}`);
      if (create) {
        try {
          await model.collection.createIndex(key as any, options as any);
          console.log('   created');
        } catch (error) {
          console.log(`   FAILED: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
  }
  console.log(missing ? `\n${missing} index(es) ${create ? 'processed' : 'missing'}.` : '\nAll declared indexes exist.');
  await disconnectDatabase();
  process.exit(missing && !create ? 1 : 0);
}

void main();
