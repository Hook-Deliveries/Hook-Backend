import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { startDatabase, resetDatabase, stopDatabase } from './helpers/replset';
import { MarketVendor } from '../src/models/catalog/market-vendor.model';
import { ProductSubmission } from '../src/models/catalog/catalog.model';
import { Notification } from '../src/models/notifications/notification.model';
import { Product } from '../src/models/products/product.model';
import { provisionVendorAccount } from '../src/modules/catalog/vendor-account.service';
import { VendorCatalogService } from '../src/modules/catalog/vendor-catalog.service';
import { notifyVendorProductLive } from '../src/modules/notifications/vendor-product-notifications.service';

process.env.PUSH_ENABLED = 'false';

const id = () => new mongoose.Types.ObjectId();

before(async () => { await startDatabase(); });
after(stopDatabase);
beforeEach(async () => { await resetDatabase(); });

async function vendor(name: string) {
  const _id = id();
  await MarketVendor.collection.insertOne({
    _id, publicId: `MVD-${name}`, marketId: '64b000000000000000000001', stateId: 'state-1', businessName: `${name} Stores`, contactName: `${name} Owner`,
    normalizedPhone: `0803000${name.length}000`, phone: `0803000${name.length}000`, email: `${name.toLowerCase()}@example.com`, status: 'active', preferredContactChannel: 'phone', createdAt: new Date(),
  });
  const record = (await MarketVendor.findById(_id).lean()) as any;
  const { accountId } = await provisionVendorAccount(record);
  return { record: (await MarketVendor.findById(_id).lean()) as any, accountId };
}

const submissionBase = { marketId: '64b000000000000000000001', sourceStateId: 'state-1', categorySuggestionId: 'c', mediaIds: [], basePriceMinor: 1000, currency: 'NGN', variants: [], availabilityStatus: 'available', version: 1 };

async function submission(publicId: string, vendorId: string, createdBy: 'vendor' | 'market_associate', status: string) {
  await ProductSubmission.collection.insertOne({ _id: id(), publicId, basicTitle: publicId, marketVendorId: vendorId, createdBy, status, reviewNotes: [], createdAt: new Date(), ...submissionBase });
}

async function product(publicId: string, vendorId: string, fields: Record<string, unknown>) {
  const _id = id();
  await Product.collection.insertOne({
    _id, publicId, hookId: `HK-${publicId}`, slug: publicId.toLowerCase(), title: `Item ${publicId}`, sourceMarketVendorId: vendorId, sourceStateId: 'state-1',
    catalogVersion: 1, createdAt: new Date(), updatedAt: new Date(), ...fields,
  } as any);
  return String(_id);
}

test('products a Market Associate sends in for a vendor appear on the vendor shelf; unfinished drafts stay private', async () => {
  const { record, accountId } = await vendor('Ada');
  const vendorId = String(record._id);
  await submission('SUB-OWN', vendorId, 'vendor', 'draft');
  await submission('SUB-MA-SENT', vendorId, 'market_associate', 'submitted');
  await submission('SUB-MA-LIVE', vendorId, 'market_associate', 'approved');
  await submission('SUB-MA-DRAFT', vendorId, 'market_associate', 'draft');

  const service = new VendorCatalogService();
  const shelf = (await service.list(accountId, {})).data.map((row: any) => row.publicId).sort();
  assert.deepEqual(shelf, ['SUB-MA-LIVE', 'SUB-MA-SENT', 'SUB-OWN']);
  assert.equal((await service.dashboard(accountId)).totalProducts, 3);

  // The vendor can open what the associate added, but only the creator may change it.
  assert.equal((await service.detail(accountId, 'SUB-MA-SENT')).createdBy, 'market_associate');
  await assert.rejects(() => service.detail(accountId, 'SUB-MA-DRAFT'), /not found/i);
  await assert.rejects(() => service.update(accountId, 'SUB-MA-SENT', {} as any), /not found/i);
});

test('a vendor confirming a product that reached the end of its window puts it back on sale with a fresh window', async () => {
  const { record, accountId } = await vendor('Bola');
  const vendorId = String(record._id);
  await product('PRD-WAIT', vendorId, { status: 'availability_unconfirmed', availabilityStatus: 'unconfirmed', availabilityPreviousStatus: 'published', commercialApproval: { approved: true }, availabilityCheckRequestedAt: new Date() });

  const result = await new VendorCatalogService().confirmAvailability(accountId, 'PRD-WAIT');
  assert.equal(result.status, 'published');
  const live: any = await Product.findOne({ publicId: 'PRD-WAIT' }).lean();
  assert.equal(live.availabilityStatus, 'available');
  assert.ok(new Date(live.availabilityValidUntil).getTime() > Date.now(), 'the window starts again');
  assert.equal(live.availabilityPreviousStatus, undefined);
  assert.equal(live.catalogVersion, 2);
});

test('a vendor cannot use confirming to put a product live that was never live, or one they do not own', async () => {
  const mine = await vendor('Chi');
  const other = await vendor('Dayo');
  await product('PRD-DRAFT', String(mine.record._id), { status: 'draft', availabilityStatus: 'unconfirmed' });
  await product('PRD-THEIRS', String(other.record._id), { status: 'availability_unconfirmed', availabilityStatus: 'unconfirmed', availabilityPreviousStatus: 'published', commercialApproval: { approved: true } });
  const service = new VendorCatalogService();
  await assert.rejects(() => service.confirmAvailability(mine.accountId, 'PRD-DRAFT'), /not waiting for your confirmation/);
  await assert.rejects(() => service.confirmAvailability(mine.accountId, 'PRD-THEIRS'), /not found/i);
});

test('the vendor is asked to confirm when the window runs out, once, and not for a product that is not waiting', async () => {
  const { record, accountId } = await vendor('Ene');
  const vendorId = String(record._id);
  await product('PRD-DUE', vendorId, { status: 'availability_unconfirmed', availabilityStatus: 'unconfirmed', availabilityPreviousStatus: 'published', availabilityCheckRequestedAt: new Date() });
  await product('PRD-LIVE', vendorId, { status: 'published', availabilityStatus: 'available', publishedAt: new Date(Date.now() - 3 * 24 * 3_600_000) });

  assert.equal(await notifyVendorProductLive('PRD-DUE', 'confirm_availability'), true);
  const rows = (await Notification.find({ userId: accountId }).lean()) as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Is this still available?');
  assert.equal(rows[0].data.action, 'confirm_availability');
  assert.equal(rows[0].data.productId, 'PRD-DUE');

  assert.equal(await notifyVendorProductLive('PRD-DUE', 'confirm_availability'), false, 'asking twice for the same window never repeats it');
  assert.equal(await notifyVendorProductLive('PRD-LIVE', 'confirm_availability'), false, 'a product still on sale is not asked about');
  assert.equal(await Notification.countDocuments({ userId: accountId }), 1);
});

test('a product Hook created directly for a vendor shows on their shelf, read-only, with its stock controls', async () => {
  const { record, accountId } = await vendor('Femi');
  const other = await vendor('Gloria');
  const vendorId = String(record._id);
  await product('PRD-DIRECT', vendorId, { status: 'published', availabilityStatus: 'available', images: ['https://cdn.example/a.jpg'], colors: ['Black'], sizes: ['42', '43'], costPrice: 30000, basePriceMinor: 3_000_000, currency: 'NGN' });
  await product('PRD-DRAFT-DIRECT', vendorId, { status: 'draft', availabilityStatus: 'unconfirmed' });
  await product('PRD-OTHER', String(other.record._id), { status: 'published', availabilityStatus: 'available' });

  const service = new VendorCatalogService();
  const rows = (await service.list(accountId, {})).data as any[];
  assert.deepEqual(rows.map((row) => row.publicId), ['PRD-DIRECT'], 'only the vendor\'s own published product, not a draft or someone else\'s');
  assert.equal(rows[0].status, 'approved');
  assert.equal(rows[0].createdBy, 'market_associate');
  assert.equal(rows[0].product.status, 'published');
  assert.equal(rows[0].imageUrl, 'https://cdn.example/a.jpg');

  const detail: any = await service.detail(accountId, 'PRD-DIRECT');
  assert.equal(detail.basicTitle, 'Item PRD-DIRECT');
  assert.equal(detail.variants.length, 2);
  assert.equal(detail.media[0].deliveryUrl, 'https://cdn.example/a.jpg');
  await assert.rejects(() => service.detail(accountId, 'PRD-OTHER'), /not found/i);
  await assert.rejects(() => service.detail(accountId, 'PRD-DRAFT-DIRECT'), /not found/i);

  // The same stock controls work on it.
  const out = await service.setAvailability(accountId, 'PRD-DIRECT', 'unavailable' as any);
  assert.equal(out.outOfStock, true);
});
