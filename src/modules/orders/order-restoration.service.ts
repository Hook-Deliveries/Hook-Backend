import type { ClientSession } from 'mongoose';
import { Order } from '@models/orders/order.model';
import { CouponService } from '@modules/orders/coupon.service';
import { CreditService } from '@modules/orders/credit.service';
import { NegotiatedQuote } from '@models/catalog/catalog.model';
import { NegotiatedQuoteStatus } from '@lib/constants';

const coupons = new CouponService();
const credits = new CreditService();

/**
 * Gives back whatever a cancelled order consumed: Hook credit returns to the
 * wallet, the coupon redemption is released so the code can be used again and
 * stops counting against its total-usage limit, and any Hook credit the order
 * earned is clawed back — the reward was for an order that no longer stands.
 *
 * Called from every path that cancels an order. Both operations are
 * idempotent — the credit refund is keyed on the order id and the coupon
 * release only acts on redemptions still marked 'applied' — so cancelling
 * twice, or a retried call, never pays out twice.
 *
 * Without a session it never throws: a cancellation must still succeed even
 * if restoring the incentives fails. Callers that run it inside the
 * cancellation's own transaction pass the session instead; then any failure
 * propagates and rolls the cancellation back, so an order can never end up
 * cancelled with its credits still spent.
 */
export async function restoreOrderIncentives(orderIdentifier: string, session?: ClientSession) {
  try {
    const order = await Order.findOne({
      $or: [{ _id: orderIdentifier }, { publicId: orderIdentifier }, { orderCode: orderIdentifier }],
    })
      .select('_id publicId userId creditsAppliedMinor')
      .session(session ?? null)
      .lean();
    if (!order) return { creditsReturnedMinor: 0, couponsReleased: 0 };

    const orderId = String(order._id);
    const creditsAppliedMinor = Number(order.creditsAppliedMinor || 0);

    if (creditsAppliedMinor > 0 && order.userId) {
      await credits.refund({
        userId: String(order.userId),
        amountMinor: creditsAppliedMinor,
        orderId,
      }, session);
    }

    // Take back the coin the order earned. The earn is keyed on the order's
    // publicId (what the payment path passes) while the spend uses _id, so
    // try both rather than assume which identifier recorded it.
    if (order.userId) {
      for (const identifier of [...new Set([orderId, String(order.publicId || '')].filter(Boolean))]) {
        await credits.reverseEarn({ userId: String(order.userId), orderId: identifier }, session);
      }
    }

    // A quote spent on this order is handed back while it is still valid, so the customer can use their agreed price again.
    await NegotiatedQuote.updateMany(
      { usedByOrderId: orderId, status: NegotiatedQuoteStatus.USED, expiresAt: { $gt: new Date() } },
      { $set: { status: NegotiatedQuoteStatus.ACTIVE }, $unset: { usedByOrderId: 1, usedAt: 1 } },
      { session },
    );

    // Redemptions are stored against the order's _id at checkout time.
    const couponsReleased = await coupons.release(orderId, session);

    return { creditsReturnedMinor: creditsAppliedMinor, couponsReleased };
  } catch (error) {
    if (session) throw error;
    console.error('[order] restoring incentives failed', orderIdentifier, error);
    return { creditsReturnedMinor: 0, couponsReleased: 0 };
  }
}
