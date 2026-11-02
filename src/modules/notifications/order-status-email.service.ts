import { EmailService } from '@emails/email.service';
import type { OrderEmailLine } from '@emails/email.types';
import { Order } from '@models/orders/order.model';
import { OrderItem } from '@models/orders/order-item.model';
import { User } from '@models/users/user.model';
import { customerStatusDetail, customerStatusLabel, shouldEmailStatus } from '@lib/order-status-labels';

const email = new EmailService();

/**
 * Sends the customer one email per timeline step.
 *
 * Before this existed only three of the sixteen transition sites emailed
 * anything, so a customer heard nothing between paying and delivery — the
 * sourcing step they care about most was entirely silent. Routing every
 * transition through here is what guarantees no step is missed.
 *
 * Fire-and-forget by contract: a mail failure must never roll back or block a
 * status change, so everything is wrapped and nothing is rethrown.
 */
export async function sendOrderStatusEmail(orderIdentifier: unknown, status: string) {
  try {
    // Intermediate machine states would otherwise produce a dozen
    // near-identical mails for a single order.
    if (!shouldEmailStatus(status)) return;

    const order = await Order.findOne(
      typeof orderIdentifier === 'string' && !/^[a-f\d]{24}$/i.test(orderIdentifier)
        ? { publicId: orderIdentifier }
        : { _id: orderIdentifier },
    ).select('publicId orderCode userId guestEmail guestName totalMinor total').lean() as any;
    if (!order) return;

    const customer = order.userId
      ? await User.findById(order.userId).select('email firstName').lean() as any
      : undefined;
    const to = customer?.email || order.guestEmail;
    if (!to) return;

    const items = await OrderItem.find({ orderId: String(order._id) })
      .select('productSnapshot productTitle productImage quantity totalPriceMinor totalPrice')
      .lean() as any[];

    const lines: OrderEmailLine[] = items.map((item) => ({
      title: item.productSnapshot?.title || item.productTitle || 'Product',
      quantity: Number(item.quantity || 0),
      amount: Number(item.totalPriceMinor ?? Math.round(Number(item.totalPrice || 0) * 100)) / 100,
      imageUrl: item.productSnapshot?.image || item.productImage,
    }));

    await email.sendOrderStatusUpdate({
      to,
      name: customer?.firstName || order.guestName,
      orderCode: order.publicId || order.orderCode,
      status: customerStatusLabel(status),
      detail: customerStatusDetail(status),
      amount: Number(order.totalMinor ?? Math.round(Number(order.total || 0) * 100)) / 100,
      itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
      lines,
    });
  } catch {
    // Intentionally swallowed — see the fire-and-forget contract above.
  }
}
