# Hook Phase 5 Fulfilment Prompt

Begin from the actual Phase 4 implementation and consume only idempotent `ORDER_APPROVED_FOR_FULFILMENT` outbox events. Build Market Associate sourcing, Market availability confirmation, Dispatch Hub receiving, consolidation, external logistics booking, package tracking, handover collection, returns, and refunds without reintroducing Vendors, Booths, Drivers, fleets, client prices, or client payment confirmation.

Before implementation, verify the Phase 4 migration, Paystack sandbox webhook, outbox replay behavior, and all documents under `docs/phase-04`.
