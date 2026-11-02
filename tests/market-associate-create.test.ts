import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Request, Response } from 'express';
import { PlatformController } from '../src/controllers/admin/platform.controller';
import { HttpError } from '../src/utils/http';
import { OperationState } from '../src/models/platform/geography.model';
import { Market } from '../src/models/platform/network.model';
import { MarketAssociateMarketAssignment, MarketAssociateProfile } from '../src/models/platform/operations-accounts.model';
import { User } from '../src/models/users/user.model';
import { resetDatabase, startDatabase, stopDatabase } from './helpers/replset';

const controller = new PlatformController();

before(async () => { await startDatabase(); });
after(async () => { await stopDatabase(); });
beforeEach(async () => { await resetDatabase(); });

async function world() {
  const state = await OperationState.create({ publicId: 'STA-1', name: 'Lagos', capitalName: 'Ikeja', code: 'LA', status: 'active', operationsEnabled: true } as never);
  const other = await OperationState.create({ publicId: 'STA-2', name: 'Oyo', capitalName: 'Ibadan', code: 'OY', status: 'active', operationsEnabled: true } as never);
  const market = (name: string, stateId: string, status: 'active' | 'inactive', publicId: string) =>
    Market.create({ publicId, name, normalizedName: name.toLowerCase(), stateId, cityId: 'city', address: '1 Market Road', status } as never);
  return {
    state, other,
    balogun: await market('Balogun', state.id, 'active', 'MAR-1'),
    tejuosho: await market('Tejuosho', state.id, 'active', 'MAR-2'),
    dormant: await market('Dormant', state.id, 'inactive', 'MAR-3'),
    faraway: await market('Ibadan Central', other.id, 'active', 'MAR-4'),
  };
}

function call(body: Record<string, unknown>) {
  const req = { body, params: {}, query: {}, user: { sub: 'admin-1', permissions: ['runners.manage', 'runners.assign'], roleKeys: ['SUPER_ADMIN'], scopeType: 'global', assignedStateIds: [], assignedHubIds: [] }, headers: {}, ip: '127.0.0.1', header: () => undefined } as unknown as Request;
  let status = 200; let payload: unknown;
  const res = { req, status(code: number) { status = code; return this; }, json(value: unknown) { payload = value; return this; }, setHeader() { return this; } } as unknown as Response;
  return controller.createMarketAssociate(req, res).then(() => ({ status, payload: payload as any }));
}

const person = { firstName: 'Biodun', lastName: 'Bodija', email: 'ma@example.com', phone: '+2347048436388' };

test('a Market Associate can be created with a starting Market, which becomes their primary', async () => {
  const w = await world();
  const { status } = await call({ ...person, stateIds: ['STA-1'], marketIds: ['MAR-1', 'MAR-2'] });
  assert.equal(status, 201);
  const profile = await MarketAssociateProfile.findOne({}).lean();
  const assignments = await MarketAssociateMarketAssignment.find({ marketAssociateId: String(profile!._id) }).sort({ priority: 1 }).lean();
  assert.equal(assignments.length, 2);
  assert.equal(assignments[0].marketId, String(w.balogun._id));
  assert.equal(assignments[0].isPrimary, true);
  assert.equal(assignments[1].isPrimary, false);
});

test('creating without Markets still works', async () => {
  await world();
  const { status } = await call({ ...person, stateIds: ['STA-1'] });
  assert.equal(status, 201);
  assert.equal(await MarketAssociateMarketAssignment.countDocuments({}), 0);
});

test('a duplicate email or phone is a clear 409 that names the field', async () => {
  await world();
  await call({ ...person, stateIds: ['STA-1'] });
  await assert.rejects(() => call({ ...person, phone: '+2348000000000', stateIds: ['STA-1'] }), (error: HttpError) => error.statusCode === 409 && (error.details as any).field === 'email');
  await assert.rejects(() => call({ ...person, email: 'other@example.com', stateIds: ['STA-1'] }), (error: HttpError) => error.statusCode === 409 && (error.details as any).field === 'phone');
});

test('a bad starting Market refuses the whole invitation and leaves nothing behind', async () => {
  await world();
  await assert.rejects(() => call({ ...person, stateIds: ['STA-1'], marketIds: ['MAR-3'] }), (error: HttpError) => error.statusCode === 409);
  await assert.rejects(() => call({ ...person, stateIds: ['STA-1'], marketIds: ['MAR-4'] }), (error: HttpError) => error.statusCode === 409);
  assert.equal(await User.countDocuments({ email: person.email }), 0);
  assert.equal(await MarketAssociateProfile.countDocuments({}), 0);
});

test('cancelling an invitation removes the account, and the same email can be invited again', async () => {
  await world();
  await call({ ...person, stateIds: ['STA-1'], marketIds: ['MAR-1'] });
  const profile = await MarketAssociateProfile.findOne({}).lean();
  const req = { body: { reason: 'Wrong person' }, params: { id: String(profile!._id) }, query: {}, user: { sub: 'admin-1', permissions: ['runners.manage'], roleKeys: ['SUPER_ADMIN'], scopeType: 'global', assignedStateIds: [], assignedHubIds: [] }, headers: {}, ip: '127.0.0.1', header: () => undefined } as unknown as Request;
  const res = { req, status() { return this; }, json() { return this; }, setHeader() { return this; } } as unknown as Response;
  await controller.cancelMarketAssociateInvitation(req, res);
  assert.equal(await User.countDocuments({ email: person.email }), 0);
  assert.equal(await MarketAssociateProfile.countDocuments({}), 0);
  assert.equal(await MarketAssociateMarketAssignment.countDocuments({}), 0);
  const again = await call({ ...person, stateIds: ['STA-1'] });
  assert.equal(again.status, 201);
});
