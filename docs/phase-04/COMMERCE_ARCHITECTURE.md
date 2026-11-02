# Phase 4 Commerce Architecture

The backend is the only authority for basket ownership, catalog versions, quote use, State grouping, delivery fees, policies, totals, payment evidence, and Order approval.

## Boundaries

- Guests authenticate with `X-Guest-Session` and may browse, negotiate, and maintain one backend basket. Checkout is customer-only.
- Customer and Partner-assisted baskets share `CartService`; ownership is `guest`, `customer`, or `partner_assisted`.
- `CheckoutService` has customer and Partner facades but one preview and confirmation transaction.
- A confirmation creates one State Order, immutable items, one payment, quote consumption, and removes only that State group.
- Physical stock is neither reserved nor deducted. Fulfilment sourcing belongs to Phase 5.
- Historical Booth, Vendor, gift, OPay, and major-unit fields remain compatibility-only.

## Canonical Statuses

Orders: `AWAITING_PAYMENT`, `VERIFICATION_PENDING`, `OPERATIONS_REVIEW`, `APPROVED_FOR_FULFILMENT`, `CANCELLED`.

Payments: `PENDING`, `PROCESSING`, `CONFIRMED`, `FAILED`, `REFUND_PENDING`, `REFUNDED`.

Only verified Paystack evidence can emit `ORDER_APPROVED_FOR_FULFILMENT`.
