import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { CatalogMediaAsset } from '../src/models/catalog/catalog.model';
import { syncProductPhotoAssets } from '../src/modules/catalog/commercial-catalog.service';
import { resetDatabase, startDatabase, stopDatabase } from './helpers/replset';

before(async () => { await startDatabase(); });
after(async () => { await stopDatabase(); });
beforeEach(async () => { await resetDatabase(); });

async function photo(name: string) {
  return CatalogMediaAsset.create({
    publicId: `MED-S-${name}`, provider: 'legacy_external', providerPublicId: `prov-${name}`, deliveryType: 'external', secureUrl: `https://img.example/${name}.jpg`, format: 'jpg',
    width: 800, height: 800, bytes: 1000, uploaderAccountId: 'acct', ownerType: 'product', ownerId: 'prod-1', status: 'ready', order: 0, uploadIntentId: `intent-${name}`,
  } as never);
}

test('the product photo list follows the gallery order and each photo records its place', async () => {
  await Promise.all(['front', 'side', 'back'].map(photo));
  const ids = ['MED-S-front', 'MED-S-side', 'MED-S-back'];
  // The admin moved the back photo to the front.
  const result = await syncProductPhotoAssets(ids, ['https://img.example/back.jpg', 'https://img.example/front.jpg', 'https://img.example/side.jpg']);
  assert.deepEqual(result, ['MED-S-back', 'MED-S-front', 'MED-S-side']);
  const orders = Object.fromEntries((await CatalogMediaAsset.find({}).lean()).map((asset: any) => [asset.publicId, asset.order]));
  assert.deepEqual(orders, { 'MED-S-back': 0, 'MED-S-front': 1, 'MED-S-side': 2 });
});

test('a photo taken out of the gallery leaves the list, and a photo added by link does not break it', async () => {
  await Promise.all(['front', 'side'].map(photo));
  const result = await syncProductPhotoAssets(['MED-S-front', 'MED-S-side'], ['https://elsewhere.example/new.jpg', 'https://img.example/side.jpg']);
  assert.deepEqual(result, ['MED-S-side']);
});

test('a product with no uploaded photos has nothing to sync', async () => {
  assert.deepEqual(await syncProductPhotoAssets([], ['https://img.example/a.jpg']), []);
});
