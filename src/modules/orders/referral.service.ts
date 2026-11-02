import { randomBytes } from 'crypto';
import { PaymentStatus } from '@lib/constants';
import { CommerceSettings } from '@models/commerce/commerce.model';
import { Order } from '@models/orders/order.model';
import { Referral } from '@models/promotions/referral.model';
import { User } from '@models/users/user.model';
import { CreditService } from '@modules/orders/credit.service';
import { createCommerceNotification } from '@modules/notifications';
import { nextPublicId } from '@modules/platform';
import { HttpError } from '@utils/http';

const DEFAULT_SIGNUP_BONUS_MINOR = 30000;
const DEFAULT_REFERRER_BONUS_MINOR = 100000;

// No I/O/0/1 — these codes get read aloud and typed by hand.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function formatNaira(minor: number) {
  return `₦${Math.round(Number(minor || 0) / 100).toLocaleString('en-NG')}`;
}

function randomCode(length = 7) {
  const bytes = randomBytes(length);
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
  }
  return code;
}

export class ReferralService {
  private credits = new CreditService();

  private async bonuses() {
    const settings = await CommerceSettings.findOne({ key: 'commerce' })
      .select('referralSignupBonusMinor referralReferrerBonusMinor')
      .lean();
    return {
      signupBonusMinor: Number(settings?.referralSignupBonusMinor ?? DEFAULT_SIGNUP_BONUS_MINOR),
      referrerBonusMinor: Number(settings?.referralReferrerBonusMinor ?? DEFAULT_REFERRER_BONUS_MINOR),
    };
  }

  /** Mints the user's own shareable code on first use. */
  async ensureCode(userId: string) {
    const user = await User.findById(userId).select('referralCode').lean();
    if (!user) throw new HttpError(404, 'User not found', undefined, 'NOT_FOUND');
    if (user.referralCode) return user.referralCode;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = randomCode();
      try {
        await User.updateOne({ _id: userId }, { $set: { referralCode: code } });
        return code;
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
      }
    }
    throw new HttpError(500, 'Could not generate a referral code. Please try again.');
  }

  /**
   * Called when a new account is created with someone else's code. The new
   * user is credited immediately; the referrer's bonus waits for qualify().
   * Never throws into the signup path — a bad code must not block signup.
   */
  async applyCode(code: string, newUserId: string) {
    try {
      const normalized = String(code || '').trim().toUpperCase();
      if (!normalized) return undefined;

      const referrer = await User.findOne({ referralCode: normalized }).select('_id').lean();
      if (!referrer) return undefined;
      if (String(referrer._id) === String(newUserId)) return undefined;

      const existing = await Referral.findOne({ refereeUserId: newUserId }).lean();
      if (existing) return undefined;

      const { signupBonusMinor, referrerBonusMinor } = await this.bonuses();
      const referral = await Referral.create({
        publicId: await nextPublicId('referral'),
        referrerUserId: String(referrer._id),
        refereeUserId: newUserId,
        code: normalized,
        status: 'pending',
        signupBonusMinor,
        referrerBonusMinor,
      });

      // No signup credit here: every new account already receives the ₦300
      // welcome bonus from CreditService.grantWelcomeBonus(), so paying a
      // referral signup bonus on top would credit the same person twice for
      // the same event. The referrer's reward still lands in qualify().
      return referral;
    } catch (error) {
      console.error('[referral] applyCode failed', error);
      return undefined;
    }
  }

  /**
   * Releases the referrer's bonus once the referred user has actually paid for
   * an order. Idempotent: the status guard plus the ledger's unique key mean a
   * replayed payment webhook cannot pay the referrer twice.
   */
  async qualify(userId: string, orderId: string) {
    try {
      const referral = await Referral.findOne({ refereeUserId: userId, status: 'pending' });
      if (!referral) return undefined;

      const claimed = await Referral.findOneAndUpdate(
        { _id: referral._id, status: 'pending' },
        { $set: { status: 'qualified', qualifiedAt: new Date(), qualifyingOrderId: orderId } },
        { returnDocument: 'after' },
      ).lean({ virtuals: true });
      if (!claimed) return undefined;

      await this.credits.record({
        userId: referral.referrerUserId,
        type: 'referral_bonus',
        amountMinor: referral.referrerBonusMinor,
        referralId: String(referral._id),
        orderId,
        idempotencyKey: `referral-bonus:${referral._id}`,
        note: 'A friend you referred completed their first order',
      });

      await createCommerceNotification({
        eventKey: `credit:referral:${referral._id}`,
        userId: referral.referrerUserId,
        title: 'You earned Hook credit',
        body: `A friend you referred completed their first order, so ${formatNaira(referral.referrerBonusMinor)} Hook credit is now in your account.`,
        type: 'hook_coin',
        data: { section: 'credits', referralId: String(referral._id) },
      }).catch(() => undefined);

      return claimed;
    } catch (error) {
      console.error('[referral] qualify failed', error);
      return undefined;
    }
  }

  async summary(userId: string) {
    const [code, referrals] = await Promise.all([
      this.ensureCode(userId),
      Referral.find({ referrerUserId: userId, deletedAt: { $exists: false } })
        .select('publicId refereeUserId status referrerBonusMinor qualifiedAt createdAt')
        .sort({ createdAt: -1 })
        .limit(100)
        .lean({ virtuals: true }),
    ]);

    const refereeIds = referrals.map((item) => item.refereeUserId);
    const referees = refereeIds.length
      ? await User.find({ _id: { $in: refereeIds } }).select('_id firstName lastName').lean()
      : [];
    const nameById = new Map(
      referees.map((item) => [String(item._id), `${item.firstName || ''} ${item.lastName || ''}`.trim() || 'Hook customer']),
    );

    const qualified = referrals.filter((item) => item.status === 'qualified');
    return {
      code,
      totalReferrals: referrals.length,
      qualifiedReferrals: qualified.length,
      pendingReferrals: referrals.filter((item) => item.status === 'pending').length,
      totalEarnedMinor: qualified.reduce((sum, item) => sum + Number(item.referrerBonusMinor || 0), 0),
      referrals: referrals.map((item) => ({
        id: item.publicId,
        name: nameById.get(String(item.refereeUserId)) || 'Hook customer',
        status: item.status,
        bonusMinor: item.referrerBonusMinor,
        qualifiedAt: item.qualifiedAt,
        createdAt: item.createdAt,
      })),
    };
  }

  /** True when this is the referee's first paid order, used to gate qualify(). */
  async isFirstPaidOrder(userId: string, orderId: string) {
    const earlier = await Order.countDocuments({
      userId,
      _id: { $ne: orderId },
      paymentStatus: PaymentStatus.SUCCESSFUL,
    });
    return earlier === 0;
  }
}
