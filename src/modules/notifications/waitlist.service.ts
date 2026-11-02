import { randomUUID } from 'crypto';
import { WaitlistEntry } from '@models/promotions/waitlist-entry.model';
import { CreditService } from '@modules/orders';
import { EmailService } from '@emails/email.service';
import { HttpError, isDuplicateKeyError } from '@utils/http';
import { nextPublicId } from '@modules/platform';

function backendOrigin() {
  return String(process.env.APP_URL || 'http://localhost:4000').replace(/\/$/, '');
}

export class WaitlistService {
  private creditsInstance?: CreditService;
  private get credits() {
    return (this.creditsInstance ??= new CreditService());
  }
  private email = new EmailService();

  /** Re-submitting the same email is a friendly no-op, not an error; consent is already validated at the route, so this just timestamps it. */
  async join(input: { email: string; name: string; phone: string; city: string; itemInterest?: string }) {
    const email = input.email.trim().toLowerCase();
    const existing = await WaitlistEntry.findOne({ email });
    if (existing) return { publicId: existing.publicId, alreadyJoined: true };
    try {
      const entry = await WaitlistEntry.create({
        publicId: await nextPublicId('waitlistEntry'),
        email,
        name: input.name.trim(),
        phone: input.phone.trim(),
        city: input.city.trim(),
        itemInterest: input.itemInterest?.trim() || undefined,
        consentedAt: new Date(),
        unsubscribeToken: randomUUID(),
      });
      return { publicId: entry.publicId, alreadyJoined: false };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const winner = await WaitlistEntry.findOne({ email }).lean();
      return { publicId: winner?.publicId, alreadyJoined: true };
    }
  }

  /** A one-click unsubscribe link, clicked directly from an email — idempotent, and returns plain HTML since a mail client opens it in a browser, not an API client. */
  async unsubscribe(token: string) {
    const entry = await WaitlistEntry.findOne({ unsubscribeToken: token });
    if (entry && !entry.unsubscribedAt) {
      entry.unsubscribedAt = new Date();
      await entry.save();
    }
    return { unsubscribed: Boolean(entry) };
  }

  async list(input: { search?: string; skip: number; limit: number }) {
    const filter: Record<string, unknown> = { deletedAt: { $exists: false } };
    if (input.search) {
      const term = input.search.trim();
      filter.$or = [
        { email: { $regex: term, $options: 'i' } },
        { name: { $regex: term, $options: 'i' } },
        { phone: { $regex: term, $options: 'i' } },
        { city: { $regex: term, $options: 'i' } },
      ];
    }
    const [data, total, redeemed] = await Promise.all([
      WaitlistEntry.find(filter).sort({ createdAt: -1 }).skip(input.skip).limit(input.limit).lean(),
      WaitlistEntry.countDocuments(filter),
      WaitlistEntry.countDocuments({ ...filter, redeemedByUserId: { $exists: true } }),
    ]);
    return { data, total, redeemed };
  }

  async remove(id: string) {
    const entry = await WaitlistEntry.findOne({ publicId: id });
    if (!entry) throw new HttpError(404, 'Waitlist entry not found');
    entry.deletedAt = new Date();
    await entry.save();
  }

  /**
   * A subject+message blast to every targeted entry. There is no bulk-send
   * API to call instead, so this loops the ordinary single-recipient sender
   * in small concurrency-limited batches rather than firing everything at
   * once against Brevo's rate limits.
   */
  async broadcast(input: { subject: string; message: string; targetIds?: string[] }) {
    // Unconditional — even an explicit targetIds selection cannot re-include
    // someone who unsubscribed. This is the one filter clause that never moves.
    const filter: Record<string, unknown> = { deletedAt: { $exists: false }, unsubscribedAt: { $exists: false } };
    if (input.targetIds?.length) filter.publicId = { $in: input.targetIds };
    const entries = await WaitlistEntry.find(filter).select('email name unsubscribeToken').lean();
    let sent = 0;
    let failed = 0;
    const BATCH_SIZE = 20;
    for (let index = 0; index < entries.length; index += BATCH_SIZE) {
      const batch = entries.slice(index, index + BATCH_SIZE);
      const results = await Promise.allSettled(batch.map((entry) => this.email.sendWaitlistMessage({
        email: entry.email,
        name: entry.name,
        subject: input.subject,
        message: input.message,
        unsubscribeUrl: `${backendOrigin()}/api/v1/public/waitlist/unsubscribe/${entry.unsubscribeToken}`,
      })));
      for (const result of results) {
        if (result.status === 'fulfilled') sent++;
        else failed++;
      }
    }
    return { sent, failed };
  }

  /**
   * Grants (or queues) a chosen credit amount for every targeted entry. An
   * entry whose email already has an account is credited immediately; one
   * that hasn't signed up yet gets the amount stored, and
   * CreditService.grantWaitlistBonus applies it automatically the moment
   * that email does sign up.
   */
  async gift(input: { amountMinor: number; reason: string; targetIds?: string[]; actorId?: string }) {
    if (input.amountMinor <= 0) throw new HttpError(400, 'Amount must be greater than zero', undefined, 'VALIDATION_ERROR');
    const filter: Record<string, unknown> = { deletedAt: { $exists: false }, creditGrantedAt: { $exists: false } };
    if (input.targetIds?.length) filter.publicId = { $in: input.targetIds };
    const entries = await WaitlistEntry.find(filter);
    let grantedNow = 0;
    let pendingForSignup = 0;
    for (const entry of entries) {
      if (entry.redeemedByUserId) {
        await this.credits.grantAdminCredit({
          userId: entry.redeemedByUserId,
          amountMinor: input.amountMinor,
          reason: input.reason,
          actorId: input.actorId,
          idempotencyKey: `waitlist:${entry.redeemedByUserId}`,
          type: 'waitlist_bonus',
        });
        entry.creditGrantedAt = new Date();
        await entry.save();
        grantedNow++;
      } else {
        entry.pendingCreditMinor = input.amountMinor;
        entry.giftReason = input.reason;
        await entry.save();
        pendingForSignup++;
      }
    }
    return { grantedNow, pendingForSignup };
  }
}
