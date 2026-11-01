import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { AccountStatus, AccountType, UserRole } from '@lib/constants';
import { hashPassword } from '@lib/security';
import { Market } from '@models/platform/network.model';
import { HookPartner, MarketAssociateMarketAssignment, MarketAssociateProfile } from '@models/platform/operations-accounts.model';
import { User } from '@models/users/user.model';
import { nextPublicId } from '@modules/platform/public-id.service';

/**
 * Creates the Market Associate (runner@gmail.com) and Partner (partner@gmail.com) accounts, and can reset
 * the passwords of those two plus admin@gmail.com. Never clears anything; safe to re-run.
 *   npm run seed:launch-accounts               create anything missing (random strong passwords)
 *   npm run seed:launch-accounts -- --reset    also give admin, runner and partner a new password
 * Set ACCOUNT_PASSWORD to choose the password yourself instead of a random one.
 * Generated passwords are written to .launch-credentials (gitignored, owner-only).
 */
const reset = process.argv.includes('--reset');
const chosen = process.env.ACCOUNT_PASSWORD;
const idOf = (record: { _id?: unknown; id?: string }) => String(record.id || record._id || '');
const newPassword = () => chosen || crypto.randomBytes(15).toString('base64url');
const issued: Array<[string, string]> = [];

async function ensurePassword(email: string) {
  const plain = newPassword();
  await User.updateOne({ email }, { $set: { password: await hashPassword(plain), passwordChangedAt: new Date(), accountStatus: AccountStatus.ACTIVE, isActive: true } });
  issued.push([email, plain]);
}

async function main() {
  await connectDatabase();
  const markets = await Market.find({ status: { $in: ['active', 'enabled'] } }).sort({ displayPriority: 1 }).lean();
  if (!markets.length) throw new Error('No active markets found. Copy the markets first.');
  const home = markets[0] as any;

  if (!(await User.exists({ email: 'runner@gmail.com' }))) {
    const publicId = await nextPublicId('marketAssociate');
    const plain = newPassword();
    const account = await User.create({
      publicId, email: 'runner@gmail.com', phone: '+2348020000001', password: await hashPassword(plain),
      firstName: 'Hook', lastName: 'Market Associate', role: UserRole.MARKETASSOCIATE, accountType: AccountType.MARKETASSOCIATE,
      accountStatus: AccountStatus.ACTIVE, isActive: true, isEmailVerified: true, isPhoneVerified: true, passwordChangedAt: new Date(),
    });
    const profile = await MarketAssociateProfile.create({
      publicId, accountId: idOf(account),
      stateIds: [...new Set(markets.map((m: any) => String(m.stateId)))],
      hubIds: [...new Set(markets.map((m: any) => String(m.hubId || '')).filter(Boolean))],
      availability: 'available', status: 'active',
    });
    for (const [index, market] of (markets as any[]).entries()) {
      await MarketAssociateMarketAssignment.create({
        marketAssociateId: idOf(profile), marketId: idOf(market), stateId: String(market.stateId),
        preferredHubId: market.hubId ? String(market.hubId) : undefined,
        priority: index + 1, isPrimary: index === 0, status: 'active', activeFrom: new Date(),
        assignmentReason: 'Launch assignment', createdBy: idOf(account), history: [],
      });
    }
    issued.push(['runner@gmail.com', plain]);
    console.log(`  created — runner@gmail.com (${publicId}), assigned to ${markets.length} markets`);
  } else console.log('  skip — runner@gmail.com already exists');

  if (!(await User.exists({ email: 'partner@gmail.com' }))) {
    const publicId = await nextPublicId('partner');
    const plain = newPassword();
    const account = await User.create({
      publicId, email: 'partner@gmail.com', phone: '+2348020000002', password: await hashPassword(plain),
      firstName: 'Hook', lastName: 'Partner', role: UserRole.PARTNER, accountType: AccountType.PARTNER,
      accountStatus: AccountStatus.ACTIVE, isActive: true, isEmailVerified: true, isPhoneVerified: true, passwordChangedAt: new Date(),
    });
    await HookPartner.create({
      publicId, accountId: idOf(account), name: 'Hook Partner Lagos Island',
      stateId: String(home.stateId), cityId: String(home.cityId), address: home.address, coordinates: home.coordinates,
      contact: { email: account.email, phone: account.phone }, status: 'active',
    });
    issued.push(['partner@gmail.com', plain]);
    console.log(`  created — partner@gmail.com (${publicId})`);
  } else console.log('  skip — partner@gmail.com already exists');

  if (reset) {
    for (const email of ['admin@gmail.com', 'runner@gmail.com', 'partner@gmail.com']) {
      if (issued.some(([e]) => e === email)) continue;
      if (await User.exists({ email })) { await ensurePassword(email); console.log(`  reset — ${email}`); }
    }
  }

  if (issued.length && !chosen) {
    const file = path.resolve(process.cwd(), '.launch-credentials');
    fs.appendFileSync(file, issued.map(([e, p]) => `${e}: ${p}\n`).join(''), { mode: 0o600 });
    console.log(`  passwords saved to ${file}`);
  } else if (issued.length) console.log('  passwords set from ACCOUNT_PASSWORD');
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => void disconnectDatabase());
