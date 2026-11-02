# Hook Phase 4 Commerce Prompt

Continue from the verified Phase 3 implementation on `development`. Read all Phase 1-3 reports and architecture documents first.

Implement the customer commerce layer without weakening Phase 2 identity/RBAC or Phase 3 catalog/pricing boundaries:

- Guest browsing through backend guest sessions and verified-customer conversion.
- Public categories, products, search, product detail, and safe availability.
- Customer negotiation UI backed by Phase 3 sessions.
- Attach only valid, unexpired, customer-owned `QTE` quotes to basket lines.
- State-grouped baskets; never mix State fulfilment rules silently.
- One checkout per State with home delivery for app orders.
- Address creation, validation, ownership, selection, and State compatibility.
- Hook Partner assisted ordering and initiating-Partner pickup attribution.
- Paystack prepayment with server-verified payment events.
- Server-derived order lines, discounts, delivery rules, totals, currency, idempotency, and inventory validation.
- Order creation and immutable pricing/quote snapshots.

Do not trust client prices, quote details, payment success, address ownership, State scope, or availability. Do not revive Vendor workflows. Do not implement Phase 5 dispatch, consolidation, provider booking, returns, or refunds beyond the event foundations Phase 4 requires.

Before implementation, resolve Phase 3 blockers: install MongoDB Database Tools, create and restore-verify a backup, execute and verify the Phase 3 migration, configure signed Cloudinary, review the dependency advisory, and record the resulting repository SHAs.
