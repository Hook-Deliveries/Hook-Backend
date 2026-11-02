import type { ClientSession } from 'mongoose';
import { CommerceSettings } from '@models/commerce/commerce.model';
import { calculateHookCoinEarnMinor } from '@lib/hook-coin';
import { createCommerceNotification } from '@modules/notifications';
import { CreditLedger, type CreditEntryType } from '@models/promotions/credit-ledger.model';
import { WaitlistEntry } from '@models/promotions/waitlist-entry.model';
import { HttpError } from '@utils/http';
import { User } from '@models/users/user.model';

const DEFAULT_SPEND_CAP_PERCENT = 20;

function formatNaira(minor: number) {
  return `₦${Math.round(Number(minor || 0) / 100).toLocaleString('en-NG')}`;
}

const DEFAULT_WELCOME_BONUS_MINOR = 30000;

export class CreditService {
  /** Balance is always derived from the ledger, never stored. */
  async balance(userId: string, session?: ClientSession) {
    const [row] = await CreditLedger.aggregate<{ total: number }>([
      { $match: { userId, deletedAt: { $exists: false } } },
      { $group: { _id: null, total: { $sum: '$amountMinor' } } },
    ]).session(session ?? null);
    return Math.max(0, Number(row?.total || 0));
  }

  /** Keyed on the user id so every signup path (password, Google, Apple, legacy OTP) can call this without risking a double grant. */
  async grantWelcomeBonus(userId: string) {
    // Also the one funnel point to settle a waitlist entry for this email.
    await this.grantWaitlistBonus(userId).catch(() => undefined);
    // Guard on the entry TYPE, not just the idempotency key, since the backfill script credits existing accounts under its own key.
    const existing = await CreditLedger.findOne({ userId, type: 'welcome_bonus' })
      .select('amountMinor')
      .lean();

    // Announce separately: a user credited by the backfill script has the ledger row but was never told about it.
    if (existing) {
      await this.announceWelcomeBonus(userId, Number(existing.amountMinor));
      return undefined;
    }

    const settings = await CommerceSettings.findOne({ key: 'commerce' })
      .select('welcomeBonusMinor')
      .lean();
    const amountMinor = Number(settings?.welcomeBonusMinor ?? DEFAULT_WELCOME_BONUS_MINOR);
    if (amountMinor <= 0) return undefined;
    const entry = await this.record({
      userId,
      type: 'welcome_bonus',
      amountMinor,
      idempotencyKey: `welcome:${userId}`,
      note: 'Welcome to Hook',
    });
    await this.announceWelcomeBonus(userId, amountMinor);
    return entry;
  }

  /** Settles a waitlist entry for this user, if any, marking it redeemed and granting credit only once. */
  private async grantWaitlistBonus(userId: string) {
    const user = await User.findById(userId).select('email').lean();
    const email = String(user?.email || '').toLowerCase();
    if (!email) return;
    const entry = await WaitlistEntry.findOne({ email, deletedAt: { $exists: false } });
    if (!entry) return;
    if (!entry.redeemedByUserId) {
      entry.redeemedByUserId = userId;
      entry.redeemedAt = new Date();
    }
    const amountMinor = Number(entry.pendingCreditMinor || 0);
    if (amountMinor > 0 && !entry.creditGrantedAt) {
      await this.record({
        userId,
        type: 'waitlist_bonus',
        amountMinor,
        idempotencyKey: `waitlist:${userId}`,
        note: entry.giftReason || 'Waitlist launch credit',
      });
      entry.creditGrantedAt = new Date();
      await this.notify(userId, `credit:waitlist:${userId}`, {
        title: 'You have Hook credit to spend',
        body: `We added ${formatNaira(amountMinor)} Hook credit to your account as a thank-you for joining the waitlist.`,
      });
    }
    await entry.save();
  }

  /** A manual, admin-initiated grant; the caller-supplied idempotencyKey prevents a double-submitted form from double-granting. */
  async grantAdminCredit(input: { userId: string; amountMinor: number; reason: string; actorId?: string; idempotencyKey: string; type?: CreditEntryType }) {
    if (input.amountMinor <= 0) throw new HttpError(400, 'Amount must be greater than zero', undefined, 'VALIDATION_ERROR');
    const entry = await this.record({
      userId: input.userId,
      type: input.type || 'admin_adjustment',
      amountMinor: input.amountMinor,
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId,
      note: input.reason,
    });
    await this.notify(input.userId, `credit:admin:${input.idempotencyKey}`, {
      title: 'Hook credit added to your account',
      body: `${formatNaira(input.amountMinor)} Hook credit was added to your account.`,
    });
    return entry;
  }

  /** Idempotent on eventKey, so calling it repeatedly posts only one. */
  async announceWelcomeBonus(userId: string, amountMinor: number) {
    if (amountMinor <= 0) return;
    await this.notify(userId, `credit:welcome:${userId}`, {
      title: 'You have Hook credit to spend',
      body: `We added ${formatNaira(amountMinor)} Hook credit to your account. Use it when you pay now.`,
    });
  }

  /** Posts a notification for a credit movement; dedupes on eventKey so a replayed grant can't double-notify. */
  private async notify(userId: string, eventKey: string, copy: { title: string; body: string }) {
    await createCommerceNotification({
      eventKey,
      userId,
      title: copy.title,
      body: copy.body,
      type: 'hook_coin',
      data: { section: 'credits' },
    }).catch(() => undefined);
  }

  /** Credits a share of the order back at payment, keyed on the order so a replayed Paystack webhook can't credit it twice. */
  async earnOnOrder(
    input: { userId: string; orderId: string; subtotalMinor: number },
    session?: ClientSession,
  ) {
    if (!input.userId || input.subtotalMinor <= 0) return undefined;

    const settings = await CommerceSettings.findOne({ key: 'commerce' })
      .select('orderEarnEnabled orderEarnPercent orderEarnMaxMinor')
      .session(session ?? null)
      .lean();
    const amountMinor = calculateHookCoinEarnMinor(input.subtotalMinor, {
      enabled: settings?.orderEarnEnabled,
      percent: settings?.orderEarnPercent,
      maxMinor: settings?.orderEarnMaxMinor,
    });
    if (amountMinor <= 0) return undefined;

    const entry = await this.record({
      userId: input.userId,
      type: 'order_earn',
      amountMinor,
      orderId: input.orderId,
      idempotencyKey: `earn:${input.orderId}`,
      note: 'Earned from an order',
    }, session);
    // Inside a transaction, the notification is left to the outbox consumer so the commit doesn't depend on it.
    if (!session) await this.announceEarn(input.userId, input.orderId, amountMinor);
    return entry;
  }

  async announceEarn(userId: string, orderId: string, amountMinor: number) {
    if (amountMinor <= 0) return;
    await this.notify(userId, `credit:earn:${orderId}`, {
      title: 'You earned Hook credit',
      body: `${formatNaira(amountMinor)} Hook credit was added to your account for your order.`,
    });
  }

  /** Reverses an earn on order cancellation by posting a negative entry, keeping the ledger append-only. */
  async reverseEarn(input: { userId: string; orderId: string }, session?: ClientSession) {
    const earned = await CreditLedger.findOne({
      userId: input.userId,
      orderId: input.orderId,
      type: 'order_earn',
      amountMinor: { $gt: 0 },
      deletedAt: { $exists: false },
    }).select('amountMinor').session(session ?? null).lean();
    const amountMinor = Number(earned?.amountMinor || 0);
    if (amountMinor <= 0) return undefined;
    return this.record({
      userId: input.userId,
      type: 'order_earn',
      amountMinor: -Math.abs(amountMinor),
      orderId: input.orderId,
      idempotencyKey: `earn-reversal:${input.orderId}`,
      note: 'Reversed after the order was cancelled',
    }, session);
  }

  async spendCapPercent() {
    const settings = await CommerceSettings.findOne({ key: 'commerce' })
      .select('creditSpendCapPercent')
      .lean();
    const percent = Number(settings?.creditSpendCapPercent ?? DEFAULT_SPEND_CAP_PERCENT);
    return Math.min(Math.max(percent, 0), 100);
  }

  /** Caps spendable credit at a share of the subtotal so a large balance cannot wipe out a small order. */
  async spendableFor(userId: string, subtotalMinor: number) {
    const [balance, percent] = await Promise.all([this.balance(userId), this.spendCapPercent()]);
    const cap = Math.floor((subtotalMinor * percent) / 100);
    return Math.max(0, Math.min(balance, cap));
  }

  async history(userId: string, limit = 50) {
    return CreditLedger.find({ userId, deletedAt: { $exists: false } })
      .select('type amountMinor orderId referralId note createdAt')
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(limit, 1), 200))
      .lean({ virtuals: true });
  }

  /** Writes one ledger entry; the unique idempotencyKey makes a retried webhook or replayed checkout confirm safe. */
  async record(input: {
    userId: string;
    type: CreditEntryType;
    amountMinor: number;
    idempotencyKey: string;
    orderId?: string;
    referralId?: string;
    actorId?: string;
    note?: string;
  }, session?: ClientSession) {
    if (session) {
      // Check for the replay first since a duplicate-key error would abort the transaction; the unique index backstops a race.
      const existing = await CreditLedger.findOne({ idempotencyKey: input.idempotencyKey })
        .session(session)
        .lean({ virtuals: true });
      if (existing) return existing;
      const [created] = await CreditLedger.create([input], { session });
      return created;
    }
    try {
      return await CreditLedger.create(input);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        return CreditLedger.findOne({ idempotencyKey: input.idempotencyKey }).lean({ virtuals: true });
      }
      throw error;
    }
  }

  async spend(
    input: { userId: string; amountMinor: number; orderId: string; idempotencyKey: string },
    session?: ClientSession,
  ) {
    if (input.amountMinor <= 0) return undefined;
    const key = `spend:${input.idempotencyKey}`;
    // A replay of an already-booked spend must succeed even though the balance has since dropped by that very spend.
    const already = await CreditLedger.findOne({ idempotencyKey: key }).session(session ?? null).lean({ virtuals: true });
    if (already) return already;
    // Touch the customer's document first so two concurrent spends conflict on it and the second retries against the reduced balance.
    if (session) await User.updateOne({ _id: input.userId }, { $inc: { creditSpendCounter: 1 } }, { session, strict: false });
    const balance = await this.balance(input.userId, session);
    if (balance < input.amountMinor) {
      throw new HttpError(409, 'Your Hook credit balance changed. Review checkout again.', undefined, 'CREDIT_BALANCE_CHANGED');
    }
    return this.record({
      userId: input.userId,
      type: 'order_spend',
      amountMinor: -Math.abs(input.amountMinor),
      orderId: input.orderId,
      idempotencyKey: key,
      note: 'Applied to order',
    }, session);
  }

  /** Returns credits when an order they paid for is cancelled. */
  async refund(input: { userId: string; amountMinor: number; orderId: string }, session?: ClientSession) {
    if (input.amountMinor <= 0) return undefined;
    const entry = await this.record({
      userId: input.userId,
      type: 'order_refund',
      amountMinor: Math.abs(input.amountMinor),
      orderId: input.orderId,
      idempotencyKey: `refund:${input.orderId}`,
      note: 'Returned from a cancelled order',
    }, session);
    if (!session) await this.announceRefund(input.userId, input.orderId, input.amountMinor);
    return entry;
  }

  async announceRefund(userId: string, orderId: string, amountMinor: number) {
    if (amountMinor <= 0) return;
    await this.notify(userId, `credit:refund:${orderId}`, {
      title: 'Hook credit returned',
      body: `${formatNaira(amountMinor)} Hook credit is back in your account after your order was cancelled.`,
    });
  }
}
