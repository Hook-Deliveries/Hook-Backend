import { Request } from 'express';
import { getPagination, paginated, routeParam } from '@lib/api-utils';
import { MongoRepository } from '@lib/mongo-repository';
import { AdminAuditLog } from '@models/admin/admin-audit-log.model';
import { Booth } from '@models/booths/booth.model';
import { Category } from '@models/categories/category.model';
import { Logistics } from '@models/logistics/logistics.model';
import { Negotiation } from '@models/negotiations/negotiation.model';
import { OperationalState } from '@models/operations/operational-state.model';
import { VendorFulfilment } from '@models/orders/vendor-fulfilment.model';
import { EscrowLedger } from '@models/payments/escrow-ledger.model';
import { BoothInventory } from '@models/booths/booth-inventory.model';
import { AccountDeletionRequest } from '@models/support/account-deletion-request.model';
import { OrderItem } from '@models/orders/order-item.model';
import { Order } from '@models/orders/order.model';
import { Payment } from '@models/payments/payment.model';
import { Product } from '@models/products/product.model';
import { Settlement } from '@models/settlements/settlement.model';
import { User } from '@models/users/user.model';
import { RefundRequest } from '@models/orders/refund-request.model';
import { Vendor } from '@models/vendors/vendor.model';

export const adminRepos = {
  users: () => new MongoRepository(User),
  vendors: () => new MongoRepository(Vendor, { owner: () => adminRepos.users() }),
  products: () => new MongoRepository(Product, { vendor: () => adminRepos.vendors(), category: () => adminRepos.categories() }),
  orders: () => new MongoRepository(Order, { user: () => adminRepos.users() }),
  orderItems: () => new MongoRepository(OrderItem, { product: () => adminRepos.products(), vendor: () => adminRepos.vendors(), order: () => adminRepos.orders() }),
  categories: () => new MongoRepository(Category),
  payments: () => new MongoRepository(Payment, { order: () => adminRepos.orders() }),
  logistics: () => new MongoRepository(Logistics, { order: () => adminRepos.orders(), driver: () => adminRepos.users() }),
  negotiations: () => new MongoRepository(Negotiation, { user: () => adminRepos.users(), product: () => adminRepos.products() }),
  settlements: () => new MongoRepository(Settlement, { vendor: () => adminRepos.vendors(), order: () => adminRepos.orders() }),
  booths: () => new MongoRepository(Booth),
  auditLogs: () => new MongoRepository(AdminAuditLog),
  operationalStates: () => new MongoRepository(OperationalState),
  fulfilments: () => new MongoRepository(VendorFulfilment, { vendor: () => adminRepos.vendors(), order: () => adminRepos.orders() }),
  escrowLedger: () => new MongoRepository(EscrowLedger),
  boothInventory: () => new MongoRepository(BoothInventory, { product: () => adminRepos.products(), vendor: () => adminRepos.vendors(), booth: () => adminRepos.booths() }),
  deletionRequests: () => new MongoRepository(AccountDeletionRequest, { user: () => adminRepos.users() }),
  refundRequests: () => new MongoRepository(RefundRequest),
};

export { getPagination, paginated, routeParam };

export function actor(req: Request) {
  return {
    performedBy: req.user!.sub,
    performedByEmail: req.user!.email,
    ipAddress: req.ip,
  };
}
