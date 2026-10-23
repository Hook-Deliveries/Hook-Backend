import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { startDatabase, resetDatabase, stopDatabase } from './helpers/replset';
import { WaitlistService } from '../src/modules/notifications/waitlist.service';
import { CreditService } from '../src/modules/orders/credit.service';
import { WaitlistEntry } from '../src/models/promotions/waitlist-entry.model';
import { CreditLedger } from '../src/models/promotions/credit-ledger.model';
import { User } from '../src/models/users/user.model';

before(startDatabase);
after(stopDatabase);
beforeEach(resetDatabase);

const waitlist = new WaitlistService();
const credits = new CreditService();

async function createUser(email: string) {
  const user = await User.create({ email } as never);
  return String(user._id);
}

test('joining twice with the same email is a no-op, not an error', async () => {
  const first = await waitlist.join({ email: 'Test@Example.com', name: 'Test' });
  const second = await waitlist.join({ email: 'test@example.com', name: 'Test Again' });
  assert.equal(first.alreadyJoined, false);
  assert.equal(second.alreadyJoined, true);
  assert.equal(await WaitlistEntry.countDocuments({ email: 'test@example.com' }), 1);
});

test('grantWelcomeBonus settles a waitlist entry exactly once even if called twice', async () => {
  await waitlist.join({ email: 'waiter@example.com', name: 'Waiter' });
  await waitlist.gift({ amountMinor: 50000, reason: 'Launch gift' });
  const userId = await createUser('waiter@example.com');

  await credits.grantWelcomeBonus(userId);
  await credits.grantWelcomeBonus(userId);

  const waitlistEntries = await CreditLedger.countDocuments({ userId, type: 'waitlist_bonus' });
  assert.equal(waitlistEntries, 1, 'waitlist credit is granted exactly once');
  const balance = await credits.balance(userId);
  assert.ok(balance >= 50000, 'the gifted amount landed in the balance');

  const entry = await WaitlistEntry.findOne({ email: 'waiter@example.com' }).lean();
  assert.equal(entry?.redeemedByUserId, userId);
  assert.ok(entry?.creditGrantedAt);
});

test('gift: an already-redeemed entry is credited immediately, a pending one is queued for signup', async () => {
  await waitlist.join({ email: 'already-has-account@example.com', name: 'Early' });
  await waitlist.join({ email: 'not-signed-up-yet@example.com', name: 'Later' });
  const earlyUserId = await createUser('already-has-account@example.com');
  await WaitlistEntry.updateOne({ email: 'already-has-account@example.com' }, { $set: { redeemedByUserId: earlyUserId, redeemedAt: new Date() } });

  const result = await waitlist.gift({ amountMinor: 75000, reason: 'Launch gift' });
  assert.equal(result.grantedNow, 1);
  assert.equal(result.pendingForSignup, 1);

  const earlyBalance = await credits.balance(earlyUserId);
  assert.ok(earlyBalance >= 75000, 'the already-signed-up user was credited right away');

  const pendingEntry = await WaitlistEntry.findOne({ email: 'not-signed-up-yet@example.com' }).lean();
  assert.equal(pendingEntry?.pendingCreditMinor, 75000);
  assert.equal(pendingEntry?.creditGrantedAt, undefined);

  // Now that email actually signs up — the queued credit should land automatically.
  const lateUserId = await createUser('not-signed-up-yet@example.com');
  await credits.grantWelcomeBonus(lateUserId);
  const lateBalance = await credits.balance(lateUserId);
  assert.ok(lateBalance >= 75000, 'the queued gift landed once the account was created');
});

test('unsubscribe is idempotent and excludes the entry from broadcasts even when explicitly targeted', async () => {
  await waitlist.join({ email: 'stay@example.com', name: 'Stay' });
  await waitlist.join({ email: 'leave@example.com', name: 'Leave' });
  const leaver = await WaitlistEntry.findOne({ email: 'leave@example.com' }).lean();

  const first = await waitlist.unsubscribe(leaver!.unsubscribeToken);
  const second = await waitlist.unsubscribe(leaver!.unsubscribeToken);
  assert.equal(first.unsubscribed, true);
  assert.equal(second.unsubscribed, true, 'a repeat click on the same link is not an error');

  const unrecognized = await waitlist.unsubscribe('not-a-real-token');
  assert.equal(unrecognized.unsubscribed, false);

  const allIds = (await WaitlistEntry.find().select('publicId').lean()).map((entry) => entry.publicId);
  const result = await waitlist.broadcast({ subject: 'Hi', message: 'We are live', targetIds: allIds });
  assert.equal(result.sent, 1, 'only the still-subscribed entry is emailed, even though both were targeted');
});

test('grantAdminCredit is a distinct one-off gift, not tied to the waitlist', async () => {
  const userId = await createUser('regular-customer@example.com');
  await credits.grantAdminCredit({ userId, amountMinor: 20000, reason: 'Goodwill', idempotencyKey: 'test-gift-1' });
  const entry = await CreditLedger.findOne({ userId, type: 'admin_adjustment' }).lean();
  assert.equal(entry?.amountMinor, 20000);
  assert.equal(entry?.note, 'Goodwill');
});
