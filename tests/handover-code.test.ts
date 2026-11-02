import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { startDatabase, resetDatabase, stopDatabase } from './helpers/replset';
import { fulfilmentService } from '../src/modules/fulfilment/fulfilment.service';
import { FulfilmentTask, RunnerPackage } from '../src/models/fulfilment/fulfilment.model';
import { MarketAssociateProfile } from '../src/models/platform/operations-accounts.model';
import { Order } from '../src/models/orders/order.model';
import { encryptPackageCredential } from '../src/lib/package-credential-crypto';

before(async () => { await startDatabase(); await RunnerPackage.init(); });
after(stopDatabase);
beforeEach(async () => { await resetDatabase(); await RunnerPackage.init(); });

const staff = { accountId: 'hub-staff-1', accountType: 'staff', hubIds: [] as string[], stateIds: [] as string[] };
const ME = 'ma-account-1';

async function seed(status = 'SOURCING') {
  const profileId = new mongoose.Types.ObjectId();
  await MarketAssociateProfile.collection.insertOne({ _id: profileId, accountId: ME, status: 'active', createdAt: new Date(), updatedAt: new Date() } as any);
  const orderId = new mongoose.Types.ObjectId();
  await Order.collection.insertOne({ _id: orderId, publicId: 'ORD-H-1', orderCode: 'ORD-H-1', userId: 'u1', commerceStatus: 'IN_FULFILMENT', timeline: [], sourceStateId: 'st', createdAt: new Date(), updatedAt: new Date() } as any);
  const taskId = new mongoose.Types.ObjectId();
  const itemId = String(new mongoose.Types.ObjectId());
  await FulfilmentTask.collection.insertOne({
    _id: taskId, publicId: 'FUL-H-1', orderId: String(orderId), sourceStateId: 'st', marketId: 'mk', hubId: 'hub-1', marketAssociateId: String(profileId),
    orderItemIds: [itemId], itemVerifications: [{ orderItemId: itemId, matched: true }], status, version: 1, idempotencyKey: `k-${taskId}`,
    createdAt: new Date(), updatedAt: new Date(),
  } as any);
  return { taskId: String(taskId), orderId: String(orderId) };
}

const submit = () => fulfilmentService.marketAssociateTransition(ME, 'FUL-H-1', 'submit', 1, {});
const detail = () => fulfilmentService.marketAssociateTask(ME, 'FUL-H-1') as Promise<any>;
const receive = (id: string, code: string) => fulfilmentService.receivePackage(staff, id, { hubId: 'hub-1', scanCredential: code, idempotencyKey: `hub-receive-${id}-${code}` });
const rejects = (fn: () => Promise<unknown>, check: (error: any) => boolean) => assert.rejects(fn, check);

test('submitting returns a four-digit code, and the same code is shown again on every later read', async () => {
  await seed();
  const result: any = await submit();
  const code = result.package.scanCredential;
  assert.match(code, /^\d{4}$/);
  assert.equal(result.package.scanCredentialCiphertext, undefined, 'the encrypted form never leaves the server');
  assert.equal(result.package.scanCredentialHash, undefined);

  const first = await detail();
  const second = await detail();
  assert.equal(first.package.scanCredential, code);
  assert.equal(second.package.scanCredential, code);
  assert.equal(first.status, 'READY_FOR_HUB');

  // submitting again (double tap, retry) returns the same code and creates no second package
  const again: any = await submit();
  assert.equal(again.package.scanCredential, code);
  assert.equal(await RunnerPackage.countDocuments({}), 1);
});

test('the Hub accepts the right code, after which the task is received and the code is gone', async () => {
  await seed();
  const code = ((await submit()) as any).package.scanCredential;
  const packageId = (await detail()).package.publicId;

  await receive(packageId, code);
  const after = await detail();
  assert.equal(after.status, 'HUB_RECEIVED');
  assert.equal(after.package.status, 'HUB_RECEIVED');
  assert.equal(after.package.scanCredential, undefined, 'the code is not shown once custody has changed');
  assert.equal((await RunnerPackage.findOne({ publicId: packageId }).select('+scanCredentialCiphertext').lean() as any).scanCredentialCiphertext, undefined);
});

test('wrong codes are counted, the fifth locks the package, and then even the right code is refused', async () => {
  await seed();
  const code = ((await submit()) as any).package.scanCredential;
  const packageId = (await detail()).package.publicId;
  const wrong = code === '1234' ? '4321' : '1234';

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await rejects(() => receive(packageId, wrong), (error) => error.code === 'ACCESS_DENIED' && error.details?.attemptsRemaining === 5 - attempt);
  }
  await rejects(() => receive(packageId, wrong), (error) => /locked/i.test(error.message));
  await rejects(() => receive(packageId, code), (error) => error.statusCode === 423);
  assert.equal((await detail()).status, 'READY_FOR_HUB');
});

test('an unreadable code does not break the task; the associate can request a new one that works', async () => {
  await seed();
  const original = ((await submit()) as any).package.scanCredential;
  // simulate a rotated key / damaged value
  await RunnerPackage.collection.updateOne({}, { $set: { scanCredentialCiphertext: 'garbage.value.here' } });

  const view = await detail();
  assert.equal(view.status, 'READY_FOR_HUB');
  assert.equal(view.package.scanCredential, undefined);
  assert.equal(view.package.credentialUnavailable, true);

  const issued: any = await fulfilmentService.regenerateHandoverCode(ME, 'FUL-H-1');
  const code = issued.package.scanCredential;
  assert.match(code, /^\d{4}$/);
  assert.equal((await detail()).package.scanCredential, code);
  assert.equal((await detail()).package.credentialUnavailable, undefined);

  // the fresh code is the one the Hub can use; asking again does not rotate it
  assert.equal(((await fulfilmentService.regenerateHandoverCode(ME, 'FUL-H-1')) as any).package.scanCredential, code);
  const packageId = (await detail()).package.publicId;
  if (original !== code) await rejects(() => receive(packageId, original), (error) => error.code === 'ACCESS_DENIED');
  await receive(packageId, code);
  assert.equal((await detail()).status, 'HUB_RECEIVED');
});

test('a readable code is never rotated, and a locked package cannot be reissued by the associate', async () => {
  await seed();
  const code = ((await submit()) as any).package.scanCredential;
  assert.equal(((await fulfilmentService.regenerateHandoverCode(ME, 'FUL-H-1')) as any).package.scanCredential, code);

  await RunnerPackage.collection.updateOne({}, { $set: { scanCredentialCiphertext: encryptPackageCredential('0000'.replace(/0/g, '9')) } });
  await RunnerPackage.collection.updateOne({}, { $set: { scanCredentialCiphertext: 'broken.value.x', credentialLockedAt: new Date() } });
  await rejects(() => fulfilmentService.regenerateHandoverCode(ME, 'FUL-H-1'), (error) => error.statusCode === 423);
});

test('regeneration is only possible while the package waits for the Hub, and only for its own associate', async () => {
  await seed('SOURCING');
  await rejects(() => fulfilmentService.regenerateHandoverCode(ME, 'FUL-H-1'), (error) => error.code === 'INVALID_STATE_TRANSITION');
  await FulfilmentTask.collection.updateOne({}, { $set: { status: 'READY_FOR_HUB' } });
  await rejects(() => fulfilmentService.regenerateHandoverCode('someone-else', 'FUL-H-1'), (error) => error.statusCode === 403);
});

test('a task the Hub already received but left at READY_FOR_HUB is corrected when read, with no code shown', async () => {
  await seed();
  await submit();
  const packageId = (await detail()).package.publicId;
  await RunnerPackage.collection.updateOne({ publicId: packageId }, { $set: { status: 'HUB_RECEIVED', handedOverAt: new Date() }, $unset: { scanCredentialCiphertext: 1 } });
  const view = await detail();
  assert.equal(view.status, 'HUB_RECEIVED');
  assert.equal(view.package.scanCredential, undefined);
});

test('in production the code key must be configured explicitly', async () => {
  const { encryptPackageCredential: encrypt } = await import('../src/lib/package-credential-crypto');
  const saved = { env: process.env.NODE_ENV, key: process.env.PACKAGE_CREDENTIAL_ENCRYPTION_KEY };
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.PACKAGE_CREDENTIAL_ENCRYPTION_KEY;
    assert.throws(() => encrypt('1234'), /PACKAGE_CREDENTIAL_ENCRYPTION_KEY is required in production/);
    process.env.PACKAGE_CREDENTIAL_ENCRYPTION_KEY = 'x'.repeat(40);
    assert.doesNotThrow(() => encrypt('1234'));
  } finally {
    process.env.NODE_ENV = saved.env;
    if (saved.key === undefined) delete process.env.PACKAGE_CREDENTIAL_ENCRYPTION_KEY; else process.env.PACKAGE_CREDENTIAL_ENCRYPTION_KEY = saved.key;
  }
});
