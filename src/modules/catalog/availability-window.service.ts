import { availabilityWindowEnd } from '@lib/product-availability';
import { CommerceSettings } from '@models/commerce/commerce.model';

/** The admin-configured length of a confirmation, in Lagos calendar days (the verification day counts as the first). */
export async function availabilityWindowDays(): Promise<number> {
  const settings = await CommerceSettings.findOne({ key: 'commerce' }).select('catalogAvailabilityCheckDays').lean();
  return Math.min(Math.max(Number(settings?.catalogAvailabilityCheckDays || 4), 1), 30);
}

/** When a confirmation made at `verifiedAt` runs out under the current setting. */
export async function availabilityValidUntil(verifiedAt: Date): Promise<Date> {
  return availabilityWindowEnd(verifiedAt, await availabilityWindowDays());
}
