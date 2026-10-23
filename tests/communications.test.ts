import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { startDatabase, resetDatabase, stopDatabase } from './helpers/replset';
import { AccountType, ScopeType } from '@lib/constants';
import { CommunicationsService } from '../src/modules/notifications/communications.service';
import { User } from '../src/models/users/user.model';
import { StaffProfile, MarketAssociateProfile } from '../src/models/platform/operations-accounts.model';
import { Role } from '../src/models/platform/access.model';
import { Notification } from '../src/models/notifications/notification.model';

before(startDatabase);
after(stopDatabase);
beforeEach(resetDatabase);

const communications = new CommunicationsService();

async function createUser(email: string, accountType: string) {
  const user = await User.create({ email, accountType } as never);
  return String(user._id);
}

test('resolveAudience: customers segment returns only customer accounts', async () => {
  const customerId = await createUser('customer@example.com', AccountType.CUSTOMER);
  await createUser('staffer@example.com', AccountType.STAFF);
  await createUser('associate@example.com', AccountType.MARKETASSOCIATE);

  const recipients = await communications.resolveAudience({ segment: 'customers' });
  assert.equal(recipients.length, 1);
  assert.equal(String(recipients[0]._id), customerId);
});

test('resolveAudience: market_associates segment filters by state when provided', async () => {
  const lagosUserId = await createUser('lagos-ma@example.com', AccountType.MARKETASSOCIATE);
  const abujaUserId = await createUser('abuja-ma@example.com', AccountType.MARKETASSOCIATE);
  await MarketAssociateProfile.create({
    publicId: 'MA-1', accountId: lagosUserId, stateIds: ['lagos'], hubIds: [], availability: 'available', status: 'active',
  } as never);
  await MarketAssociateProfile.create({
    publicId: 'MA-2', accountId: abujaUserId, stateIds: ['abuja'], hubIds: [], availability: 'available', status: 'active',
  } as never);

  const allAssociates = await communications.resolveAudience({ segment: 'market_associates' });
  assert.equal(allAssociates.length, 2);

  const lagosOnly = await communications.resolveAudience({ segment: 'market_associates', stateIds: ['lagos'] });
  assert.equal(lagosOnly.length, 1);
  assert.equal(String(lagosOnly[0]._id), lagosUserId);
});

test('resolveAudience: staff segment filters by role key when provided', async () => {
  const role = await Role.create({
    key: 'OPERATIONS_LEAD', name: 'Operations Lead', description: '', permissionKeys: [], defaultScopeType: ScopeType.MULTI_STATE, isSystem: false, isActive: true,
  } as never);
  const otherRole = await Role.create({
    key: 'FINANCE_OFFICER', name: 'Finance Officer', description: '', permissionKeys: [], defaultScopeType: ScopeType.MULTI_STATE, isSystem: false, isActive: true,
  } as never);

  const leadUserId = await createUser('lead@example.com', AccountType.STAFF);
  const financeUserId = await createUser('finance@example.com', AccountType.STAFF);
  await StaffProfile.create({
    publicId: 'ST-1', accountId: leadUserId, roleIds: [String(role._id)], scopeType: 'global', stateIds: [], hubIds: [], status: 'active',
  } as never);
  await StaffProfile.create({
    publicId: 'ST-2', accountId: financeUserId, roleIds: [String(otherRole._id)], scopeType: 'global', stateIds: [], hubIds: [], status: 'active',
  } as never);

  const allStaff = await communications.resolveAudience({ segment: 'staff' });
  assert.equal(allStaff.length, 2);

  const leadsOnly = await communications.resolveAudience({ segment: 'staff', roleKey: 'OPERATIONS_LEAD' });
  assert.equal(leadsOnly.length, 1);
  assert.equal(String(leadsOnly[0]._id), leadUserId);
});

test('resolveAudience: explicit userIds ignores segment filters entirely', async () => {
  const customerId = await createUser('picked-customer@example.com', AccountType.CUSTOMER);
  const staffId = await createUser('picked-staff@example.com', AccountType.STAFF);
  await createUser('not-picked@example.com', AccountType.CUSTOMER);

  const recipients = await communications.resolveAudience({ userIds: [customerId, staffId] });
  const ids = recipients.map((recipient) => String(recipient._id)).sort();
  assert.deepEqual(ids, [customerId, staffId].sort());
});

test('send: writes one idempotent Notification per recipient, re-sending the same broadcast id is a no-op', async () => {
  const userId = await createUser('inbox@example.com', AccountType.CUSTOMER);

  await communications.send({
    title: 'Hello', body: 'World', channels: ['inbox'], audience: { userIds: [userId] }, senderUserId: 'admin-1',
  });
  assert.equal(await Notification.countDocuments({ userId, type: 'admin_broadcast' }), 1);

  // Simulate a retried request re-inserting the exact same eventKey — must not duplicate.
  const existing = await Notification.findOne({ userId, type: 'admin_broadcast' }).lean();
  await Notification.create({
    userId, title: 'Hello', body: 'World', type: 'admin_broadcast', eventKey: existing!.eventKey,
  } as never).catch(() => undefined);
  assert.equal(await Notification.countDocuments({ userId, type: 'admin_broadcast' }), 1, 'duplicate eventKey insert was rejected, not appended');
});

test('send: throws when no accounts match the audience', async () => {
  await assert.rejects(() => communications.send({
    title: 'Hello', body: 'World', channels: ['inbox'], audience: { segment: 'customers' }, senderUserId: 'admin-1',
  }));
});
