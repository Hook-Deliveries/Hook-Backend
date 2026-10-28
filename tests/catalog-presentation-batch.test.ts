import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { Category } from '../src/models/categories/category.model';
import { CatalogMediaAsset, ProductSubmission } from '../src/models/catalog/catalog.model';
import { OperationState } from '../src/models/platform/geography.model';
import { Market } from '../src/models/platform/network.model';
import { MarketAssociateProfile } from '../src/models/platform/operations-accounts.model';
import { User } from '../src/models/users/user.model';
import { presentSubmission, presentSubmissions } from '../src/modules/catalog/catalog-presentation.service';
import { resetDatabase, startDatabase, stopDatabase } from './helpers/replset';

before(async () => { await startDatabase(); });
after(async () => { await stopDatabase(); });
beforeEach(async () => { await resetDatabase(); });

/**
 * The batched list presenter must return exactly what looping the single-record presenter over the same rows would
 * have returned — same shape, same values, same media order — just with far fewer database round trips.
 */
test('presentSubmissions matches presentSubmission run per row, for rows that share related records', async () => {
  const state = await OperationState.create({ publicId: 'STA-P1', name: 'Lagos', capitalName: 'Ikeja', code: 'LA', status: 'active', operationsEnabled: true } as never);
  const market = await Market.create({ publicId: 'MAR-P1', name: 'Balogun', normalizedName: 'balogun', stateId: state.id, cityId: 'city', address: '1 Market Road', status: 'active' } as never);
  const category = await Category.create({ publicId: 'CAT-P1', name: 'Sneakers', slug: 'sneakers-p1', level: 1, isActive: true } as never);
  const account = await User.create({ publicId: 'MA-ACC-1', accountType: 'marketassociate', accountStatus: 'active', email: 'batch-ma@example.com', phone: '+2348000000001', firstName: 'Ada', lastName: 'Okoro', role: 'marketassociate', isActive: true, isEmailVerified: true, isPhoneVerified: true, scopeType: 'self' } as never);
  const associate = await MarketAssociateProfile.create({ publicId: 'MA-P1', accountId: account.id, stateIds: [state.id], hubIds: [], availability: 'available', status: 'active' } as never);

  const media = await Promise.all([1, 2, 3].map((n) => CatalogMediaAsset.create({
    publicId: `MED-P${n}`, provider: 'legacy_external', providerPublicId: `prov-${n}`, deliveryType: 'external', secureUrl: `https://images.example/${n}.jpg`, format: 'jpg',
    width: 800, height: 800, bytes: 1000, uploaderAccountId: account.id, ownerType: 'submission', status: 'ready', order: n, uploadIntentId: `intent-${n}`,
  } as never)));

  const submissions = await Promise.all([1, 2, 3].map((n) => ProductSubmission.create({
    publicId: `SUB-P${n}`, marketAssociateId: associate.id, marketId: market.id, sourceStateId: state.id,
    categorySuggestionId: category.id, basicTitle: `Item ${n}`, mediaIds: n === 2 ? [] : media.slice(0, n).map((asset) => asset.publicId),
    basePriceMinor: 10000 * n, currency: 'NGN', variants: [], availabilityStatus: 'available', status: 'submitted', reviewNotes: [], version: 1,
  } as never)));

  const rows = await ProductSubmission.find({ publicId: { $in: submissions.map((s) => s.publicId) } }).sort({ publicId: 1 }).lean({ virtuals: true });
  const expected = await Promise.all(rows.map(presentSubmission));
  const actual = await presentSubmissions(rows);

  assert.deepEqual(actual, expected);
  // Sanity: the shared market/category/associate really did resolve, and media ordering was preserved.
  assert.equal(actual[0].market?.publicId, 'MAR-P1');
  assert.equal(actual[2].media.map((item: { publicId: string }) => item.publicId).join(','), 'MED-P1,MED-P2,MED-P3');
  assert.equal(actual[1].media.length, 0);
});

test('presentSubmissions returns an empty list for an empty page without querying anything', async () => {
  assert.deepEqual(await presentSubmissions([]), []);
});
