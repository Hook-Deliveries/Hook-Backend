import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { startDatabase, resetDatabase, stopDatabase } from './helpers/replset';
import { MarketVendor } from '../src/models/catalog/market-vendor.model';
import { ProductSubmission } from '../src/models/catalog/catalog.model';
import { User } from '../src/models/users/user.model';
import { comparePassword } from '../src/lib/security';
import { AccountType } from '../src/lib/constants';
import { DEFAULT_VENDOR_PASSWORD, provisionVendorAccount, syncVendorAccount } from '../src/modules/catalog/vendor-account.service';
import { VendorCatalogService } from '../src/modules/catalog/vendor-catalog.service';
import { requirePasswordChanged } from '../src/middleware/auth';

const id = () => new mongoose.Types.ObjectId();

before(async () => { await startDatabase(); });
after(stopDatabase);
beforeEach(async () => { await resetDatabase(); });

async function vendor(name: string, email: string) {
  const _id = id();
  await MarketVendor.collection.insertOne({
    _id, publicId: `MVD-${name}`, marketId: '64b000000000000000000001', stateId: 'state-1', businessName: `${name} Stores`, contactName: `${name} Owner`,
    normalizedPhone: `0803000${name.length}000`, phone: `0803000${name.length}000`, email, status: 'active', preferredContactChannel: 'phone', createdAt: new Date(),
  });
  return (await MarketVendor.findById(_id).lean()) as any;
}

test('a vendor gets a verified login with the default password and a forced change', async () => {
  const v = await vendor('Ada', 'ada@example.com');
  const { accountId } = await provisionVendorAccount(v);
  const account: any = await User.findById(accountId).lean();
  assert.equal(account.accountType, AccountType.VENDOR);
  assert.equal(account.mustChangePassword, true);
  assert.equal(account.isEmailVerified, true);
  assert.equal(await comparePassword(DEFAULT_VENDOR_PASSWORD, account.password), true);
  const linked: any = await MarketVendor.findById(v._id).lean();
  assert.equal(linked.accountId, accountId);
  assert.ok(linked.verifiedAt);
  // Running it again is a no-op.
  assert.equal((await provisionVendorAccount(linked)).accountId, accountId);
  assert.equal(await User.countDocuments({ email: 'ada@example.com' }), 1);
});

test('an email already used by another kind of account is refused', async () => {
  await User.collection.insertOne({ _id: id(), email: 'taken@example.com', accountType: AccountType.CUSTOMER, role: 'shopper', isActive: true });
  const v = await vendor('Bola', 'taken@example.com');
  await assert.rejects(() => provisionVendorAccount(v), /already exists/);
});

test('the password-change gate blocks until the flag is cleared', async () => {
  const v = await vendor('Chi', 'chi@example.com');
  const { accountId } = await provisionVendorAccount(v);
  const run = () => new Promise<any>((resolve) => requirePasswordChanged({ user: { sub: accountId } } as any, {} as any, (error?: any) => resolve(error)));
  assert.equal((await run())?.code, 'PASSWORD_CHANGE_REQUIRED');
  await User.updateOne({ _id: accountId }, { $set: { mustChangePassword: false } });
  assert.equal(await run(), undefined);
});

test('suspending a vendor locks their login', async () => {
  const v = await vendor('Dayo', 'dayo@example.com');
  const { accountId } = await provisionVendorAccount(v);
  await syncVendorAccount({ ...v, accountId }, { status: 'blocked' });
  assert.equal(((await User.findById(accountId).lean()) as any).isActive, false);
});

test('a vendor only sees their own products, and reviewer identities stay hidden', async () => {
  const a = await vendor('Ene', 'ene@example.com');
  const b = await vendor('Femi', 'femi@example.com');
  const accountA = (await provisionVendorAccount(a)).accountId;
  await provisionVendorAccount(b);
  const base = { marketId: '64b000000000000000000001', sourceStateId: 'state-1', categorySuggestionId: 'c', mediaIds: [], basePriceMinor: 1000, currency: 'NGN', variants: [], availabilityStatus: 'available', createdBy: 'vendor', version: 1 };
  await ProductSubmission.collection.insertOne({ _id: id(), publicId: 'SUB-A', basicTitle: 'Mine', marketVendorId: String(a._id), status: 'changes_requested', reviewNotes: [{ action: 'changes_requested', message: 'Add a clearer photo', actorId: 'staff-1', createdAt: new Date() }], createdAt: new Date(), ...base });
  await ProductSubmission.collection.insertOne({ _id: id(), publicId: 'SUB-B', basicTitle: 'Theirs', marketVendorId: String(b._id), status: 'draft', reviewNotes: [], createdAt: new Date(), ...base });
  const service = new VendorCatalogService();
  const list = await service.list(accountA, {});
  assert.deepEqual(list.data.map((row: any) => row.publicId), ['SUB-A']);
  assert.equal(list.data[0].reviewNotes[0].message, 'Add a clearer photo');
  assert.equal('actorId' in list.data[0].reviewNotes[0], false);
  await assert.rejects(() => service.detail(accountA, 'SUB-B'), /not found/i);
  const dash = await service.dashboard(accountA);
  assert.equal(dash.changesRequested, 1);
  assert.equal(dash.drafts, 0);
});

test('changing payout details needs the password and is verified straight away', async () => {
  const v = await vendor('Gina', 'gina@example.com');
  const { accountId } = await provisionVendorAccount(v);
  const service = new VendorCatalogService();
  const bank = { method: 'bank_transfer' as const, bankName: 'GTBank', accountName: 'Gina Stores', accountNumber: '0123456789' };
  await assert.rejects(() => service.updatePayment(accountId, { ...bank, password: 'wrong-password' }), /not correct/);
  const saved = await service.updatePayment(accountId, { ...bank, password: DEFAULT_VENDOR_PASSWORD });
  assert.equal(saved.vendor.paymentProfile.accountNumberLast4, '6789');
  assert.equal(saved.vendor.paymentProfile.verificationStatus, 'verified');
  assert.equal('accountNumberEncrypted' in saved.vendor.paymentProfile, false);
  // Bank details are required for a bank transfer, but the saved number can be kept.
  await assert.rejects(() => service.updatePayment(accountId, { method: 'bank_transfer', bankName: '', password: DEFAULT_VENDOR_PASSWORD }), /Enter the bank/);
  const cash = await service.updatePayment(accountId, { method: 'cash', password: DEFAULT_VENDOR_PASSWORD });
  assert.equal(cash.vendor.paymentProfile.method, 'cash');
  assert.equal(cash.vendor.paymentProfile.accountNumberLast4, null);
});

test('payouts total what was collected and paid, and orders never expose buyers', async () => {
  const { VendorCollection, VendorPaymentRecord } = await import('../src/models/catalog/market-vendor.model');
  const v = await vendor('Hana', 'hana@example.com');
  const { accountId } = await provisionVendorAccount(v);
  const collection = id();
  await VendorCollection.collection.insertOne({ _id: collection, publicId: 'COL-1', marketVendorId: String(v._id), marketId: 'm', marketAssociateId: 'a', productSubmissionId: 's', productTitleSnapshot: 'Bag', quantity: 2, actualCostMinor: 500000, currency: 'NGN', status: 'collected', paymentStatus: 'recorded', createdAt: new Date() });
  await VendorPaymentRecord.collection.insertOne({ _id: id(), publicId: 'VPR-1', collectionId: String(collection), marketVendorId: String(v._id), marketId: 'm', marketAssociateId: 'a', amountMinor: 300000, currency: 'NGN', method: 'cash', status: 'recorded', recordedAt: new Date(), createdAt: new Date() });
  const service = new VendorCatalogService();
  const payouts = await service.payouts(accountId, {});
  assert.deepEqual([payouts.summary.collectedMinor, payouts.summary.paidMinor, payouts.summary.outstandingMinor], [500000, 300000, 200000]);
  assert.equal(payouts.data[0].paymentStatus, 'recorded');
  const orders = await service.orders(accountId, {});
  assert.equal(orders.data.length, 0);
});
