import { ProductStatus } from '@lib/constants';
import { EmailService } from '@emails/email.service';
import { MarketVendor } from '@models/catalog/market-vendor.model';
import { ProductSubmission } from '@models/catalog/catalog.model';
import { Notification } from '@models/notifications/notification.model';
import { Product } from '@models/products/product.model';
import { User } from '@models/users/user.model';
import { createCommerceNotification } from './commerce-notification.service';

/**
 * Tells a vendor, in the app, by browser/phone push and by email, when their product reaches customers:
 *  - `live`: it was published (approved straight to live, or published later by Hook);
 *  - `back_on_sale`: it passed a market recheck after being out of stock;
 *  - `confirm_availability`: its availability window ran out, so it is hidden until the vendor confirms it is still available.
 *
 * Safe to call from every publish path and to call twice: each moment notifies once, keyed by when the product went
 * live, so a retry, a second publish path or an edit never repeats it. Products without a vendor owner (captured by a
 * Market Associate or created by staff) are ignored here, because their submitter is told by the review decision.
 */
/** How recent the moment must be to announce it. The window job runs on a schedule, so its moment gets more room. */
const FRESH_MS: Record<Moment, number> = { live: 15 * 60_000, back_on_sale: 15 * 60_000, confirm_availability: 6 * 60 * 60_000 };

type Moment = 'live' | 'back_on_sale' | 'confirm_availability';

const COPY: Record<Moment, { title: string; body: (title: string) => string; reason: string }> = {
  live: {
    title: 'Your product is now live',
    body: (title) => `${title} is live in the Hook app. Customers can find and buy it now.`,
    reason: 'Customers can see it in the Hook app now. If you run out, mark it out of stock from your products page and it leaves the app straight away.',
  },
  back_on_sale: {
    title: 'Your product is back on sale',
    body: (title) => `${title} passed its market recheck and is back on sale in the Hook app.`,
    reason: 'It passed Hook’s market recheck, so customers can see and buy it again.',
  },
  confirm_availability: {
    title: 'Is this still available?',
    body: (title) => `${title} reached the end of its availability window, so customers cannot see it. Confirm it is still available to put it back on sale.`,
    reason: 'Open the product and tap “Yes, still available”. If you have run out, mark it out of stock instead.',
  },
};

export async function notifyVendorProductLive(productId: string, moment: Moment = 'live') {
  const isObjectId = /^[a-f\d]{24}$/i.test(productId);
  const product: any = await Product.findOne(isObjectId ? { $or: [{ _id: productId }, { publicId: productId }] } : { publicId: productId })
    .select('publicId title status publishedAt lastAvailabilityConfirmedAt availabilityCheckRequestedAt availabilityPreviousStatus sourceMarketVendorId sourceSubmissionId')
    .lean();
  if (!product?.publicId || !product.sourceMarketVendorId) return false;
  // Asking for a confirmation only makes sense for a product that was live and is now waiting; the others need it on sale.
  const waiting = product.status === ProductStatus.AVAILABILITY_UNCONFIRMED && product.availabilityPreviousStatus === ProductStatus.PUBLISHED;
  if (moment === 'confirm_availability' ? !waiting : product.status !== ProductStatus.PUBLISHED) return false;

  // The moment this notification is about, so only a fresh one is announced and each one is announced once.
  const moments: Record<Moment, unknown> = { live: product.publishedAt, back_on_sale: product.lastAvailabilityConfirmedAt || product.publishedAt, confirm_availability: product.availabilityCheckRequestedAt };
  const at = new Date((moments[moment] as Date | undefined) || 0);
  if (!at.getTime() || Date.now() - at.getTime() > FRESH_MS[moment]) return false;
  const eventKey = `vendor-product:${product.publicId}:${moment}:${at.getTime()}`;
  if (await Notification.exists({ eventKey })) return false;

  const vendor: any = await MarketVendor.findById(product.sourceMarketVendorId).select('accountId email contactName').lean();
  if (!vendor?.accountId) return false;
  const submission: any = product.sourceSubmissionId ? await ProductSubmission.findById(product.sourceSubmissionId).select('publicId').lean() : null;
  const copy = COPY[moment];
  const title = product.title || 'Your product';

  // In-app notification, plus the phone and browser push that goes with it.
  await createCommerceNotification({
    eventKey,
    userId: vendor.accountId,
    title: copy.title,
    body: copy.body(title),
    type: 'submission_decision',
    data: { decision: moment, action: moment === 'confirm_availability' ? 'confirm_availability' : undefined, productTitle: title, productId: product.publicId, submissionId: submission?.publicId, href: submission?.publicId ? `/vendor/products/${submission.publicId}` : '/vendor/products' },
  }).catch(() => undefined);

  const account: any = await User.findById(vendor.accountId).select('email firstName').lean();
  const to = account?.email || vendor.email;
  if (to) {
    await new EmailService().sendSubmissionDecision({ to, name: account?.firstName || vendor.contactName, productTitle: title, decision: moment, reason: copy.reason }).catch(() => undefined);
  }
  return true;
}

/** Fire-and-forget wrapper for the publish paths: it can never fail or slow the action that published the product. */
export function notifyVendorProductLiveInBackground(productId?: string, moment: Moment = 'live') {
  if (!productId) return;
  void notifyVendorProductLive(productId, moment).catch((error) => console.warn('[vendor] product live notification failed', error instanceof Error ? error.message : error));
}
