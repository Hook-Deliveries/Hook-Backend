import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { formatPublicId } from '@modules/platform/public-id.service';

dotenv.config({ quiet: true });

/**
 * Copies waitlist signups that exist in one database but not another. Nothing is removed from the source, nothing in the
 * target is overwritten, and re-running it only copies what is still missing. Emails decide who is "the same person".
 * Each copied entry keeps its id, signup time, consent and unsubscribe token, and no email is sent.
 *
 *   SOURCE: MONGODB_URI (from .env)      TARGET: TARGET_MONGODB_URI
 *   TARGET_MONGODB_URI="mongodb+srv://..." npm run db:transfer-waitlist               (dry run)
 *   TARGET_MONGODB_URI="mongodb+srv://..." npm run db:transfer-waitlist -- --execute
 */
const execute = process.argv.includes('--execute');
const source = process.env.MONGODB_URI;
const target = process.env.TARGET_MONGODB_URI;
const mask = (email: string) => email.replace(/^(.).*(@.*)$/, '$1***$2');

async function main() {
  if (!source || !target) throw new Error('Set MONGODB_URI (source) and TARGET_MONGODB_URI (target).');
  if (source === target) throw new Error('Source and target are the same database.');
  const [from, to] = await Promise.all([mongoose.createConnection(source).asPromise(), mongoose.createConnection(target).asPromise()]);
  try {
    console.log(`${execute ? 'Applying' : 'Dry run of'} the waitlist transfer\n  from ${from.host} to ${to.host}\n`);
    const fromEntries = from.db!.collection('waitlistentries');
    const toEntries = to.db!.collection('waitlistentries');
    const counters = to.db!.collection('publicidcounters');

    const existing = await toEntries.find({}).project({ email: 1, publicId: 1, unsubscribeToken: 1 }).toArray();
    const knownEmails = new Set(existing.map((row) => String(row.email).toLowerCase()));
    const takenIds = new Set(existing.map((row) => String(row.publicId)));
    const takenTokens = new Set(existing.map((row) => String(row.unsubscribeToken)));

    const missing = (await fromEntries.find({ deletedAt: { $exists: false } }).sort({ createdAt: 1 }).toArray())
      .filter((row) => !knownEmails.has(String(row.email).toLowerCase()));
    if (!missing.length) return console.log('Nothing to copy: every signup in the source is already in the target.');

    const [{ sequence = 0 } = {}] = await counters.find({ prefix: 'WTL', year: new Date().getUTCFullYear() }).project({ sequence: 1 }).toArray();
    let next = Number(sequence);
    const year = new Date().getUTCFullYear();
    const rows = missing.map((row) => {
      const copy = { ...row } as Record<string, unknown> & { publicId: string; unsubscribeToken: string; email: string };
      // Ids, tokens and account links that mean something only inside the source database must not be carried over blindly.
      if (takenIds.has(copy.publicId)) { next += 1; copy.publicId = formatPublicId('WTL', year, next); }
      if (takenTokens.has(copy.unsubscribeToken)) throw new Error(`Unsubscribe token clash for ${mask(copy.email)}; resolve by hand.`);
      if (copy.redeemedByUserId) { delete copy.redeemedByUserId; delete copy.redeemedAt; delete copy.creditGrantedAt; }
      return copy;
    });

    for (const row of rows) console.log(`  copy  ${row.publicId}  ${mask(row.email)}  ${row.createdAt ? new Date(row.createdAt as Date).toISOString().slice(0, 16) : ''}`);
    const highest = Math.max(next, ...rows.map((row) => Number(String(row.publicId).split('-')[2]) || 0));

    if (!execute) return console.log(`\n${rows.length} signup(s) would be copied and the WTL counter raised to ${highest}. No data changed. Run with --execute to apply.`);
    await toEntries.insertMany(rows as never[], { ordered: true });
    await counters.updateOne(
      { prefix: 'WTL', year },
      { $max: { sequence: highest }, $setOnInsert: { prefix: 'WTL', year, createdAt: new Date() }, $set: { updatedAt: new Date() } },
      { upsert: true },
    );
    console.log(`\nCopied ${rows.length} signup(s); the WTL counter is now at least ${highest}. Target now has ${await toEntries.countDocuments({})} entries.`);
  } finally {
    await Promise.all([from.close(), to.close()]);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
