import { ProductAvailabilityStatus } from '@lib/constants';
import { Product } from '@models/products/product.model';
import { Market } from '@models/platform/network.model';
import { MarketAssociateMarketAssignment, MarketAssociateProfile } from '@models/platform/operations-accounts.model';
import { User } from '@models/users/user.model';
import { EmailService } from '@emails/email.service';

const email = new EmailService();

/**
 * Runs once a day (scheduled in server.ts). For every active Market
 * Associate, finds products in their assigned markets still awaiting an
 * availability check and emails them the list — skipped entirely when
 * there's nothing to check, so this never sends an empty digest.
 */
export async function sendDailyAvailabilityDigests() {
  const marketAssociates = await MarketAssociateProfile.find({ status: 'active' }).select('_id accountId').lean();
  let sent = 0;
  for (const marketAssociate of marketAssociates) {
    const assignments = await MarketAssociateMarketAssignment.find({
      marketAssociateId: marketAssociate._id.toString(),
      status: 'active',
    }).select('marketId').lean();
    const marketIds = [...new Set(assignments.map((assignment) => assignment.marketId))];
    if (!marketIds.length) continue;

    const products = await Product.find({
      marketId: { $in: marketIds },
      availabilityStatus: ProductAvailabilityStatus.UNCONFIRMED,
      deletedAt: { $exists: false },
    }).select('title marketId').limit(50).lean();
    if (!products.length) continue;

    const markets = await Market.find({ _id: { $in: marketIds } }).select('name').lean();
    const marketNameById = new Map(markets.map((market) => [String(market._id), market.name]));
    const account = await User.findById(marketAssociate.accountId).select('email firstName').lean();
    if (!account?.email) continue;

    await email.sendAvailabilityDigest({
      to: account.email,
      name: account.firstName,
      products: products.map((product) => ({
        title: product.title,
        marketName: marketNameById.get(String(product.marketId)) || 'Your Market',
      })),
    }).catch(() => undefined);
    sent += 1;
  }
  return sent;
}
