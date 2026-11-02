import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemVerifySchema } from '../src/validations/fulfilment.schemas';
import { decryptPackageCredential, encryptPackageCredential } from '../src/lib/package-credential-crypto';
import { RunnerPackage } from '../src/models/fulfilment/fulfilment.model';
import { ItemResolution } from '../src/models/fulfilment/item-resolution.model';
import { Payment } from '../src/models/payments/payment.model';

const completeItem = {
  photos: [
    { view: 'front', url: 'https://images.example/front.jpg' },
    { view: 'side', url: 'https://images.example/side.jpg' },
    { view: 'back', url: 'https://images.example/back.jpg' },
  ],
  actualColor: 'Black', actualSize: '42', actualQuantity: 2, unitCostMinor: 30000,
  supplierReference: 'STALL-17', conditionNote: 'New and inspected',
  checks: { productMatches: true, sizeMatches: true, colorMatches: true, quantityMatches: true },
};

test('item fulfilment requires front, side and back photos and allows up to four extras', () => {
  assert.equal(itemVerifySchema.safeParse(completeItem).success, true);
  const duplicateFront = { ...completeItem, photos: [completeItem.photos[0], completeItem.photos[0], completeItem.photos[2]] };
  assert.equal(itemVerifySchema.safeParse(duplicateFront).success, false);
  const extras = ['extra1', 'extra2', 'extra3', 'extra4'].map((view) => ({ view, url: completeItem.photos[0].url }));
  assert.equal(itemVerifySchema.safeParse({ ...completeItem, photos: [...completeItem.photos, ...extras] }).success, true);
  assert.equal(itemVerifySchema.safeParse({ ...completeItem, photos: [...completeItem.photos, ...extras, { view: 'extra4', url: completeItem.photos[0].url }] }).success, false);
  assert.equal(itemVerifySchema.safeParse({ ...completeItem, photos: [completeItem.photos[0], completeItem.photos[1], extras[0]] }).success, false);
});

test('Hub handover credential can be redisplayed from encrypted storage without storing plaintext', () => {
  process.env.PACKAGE_CREDENTIAL_ENCRYPTION_KEY = 'test-package-key';
  const encrypted = encryptPackageCredential('4821');
  assert.notEqual(encrypted, '4821');
  assert.equal(decryptPackageCredential(encrypted), '4821');
});

test('active Hub handover codes are unique within a Hub', () => {
  const index = RunnerPackage.schema.indexes().find(([fields, options]) => fields.hubId === 1 && fields.scanCredentialHash === 1 && options.unique);
  assert.ok(index);
  assert.deepEqual(index?.[1].partialFilterExpression, { status: 'READY_FOR_HUB' });
});

test('substitution top-up references are unique and never stored as a generic order payment', () => {
  const path = Payment.schema.path('itemResolutionId') as any;
  assert.equal(path.options.unique, true);
  assert.equal(path.options.sparse, true);
  assert.equal(ItemResolution.schema.path('adjustmentPaymentReference'), undefined);
  assert.equal(ItemResolution.schema.path('adjustmentAuthorizationUrl')?.instance, 'String');
  assert.equal(ItemResolution.schema.path('adjustmentProviderReference')?.instance, 'String');
});
