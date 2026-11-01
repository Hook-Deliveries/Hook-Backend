# Phase 5 Residual Cleanup Prompt

Review the Phase 5 implementation after QA data has been seeded and the first
manual fulfilment lifecycle has completed. Verify that legacy Vendor, Booth,
Driver/Fleet, settlement, OPay, and old refund consumers remain historical only.
Remove any remaining active consumer, route, permission, seed fixture, or
navigation entry only after import and data-reference evidence is recorded.

Recheck task and package idempotency, outbox replay, state and Hub scope,
Partner custody code limits, return windows,
captured-balance refund limits, and provider integration exceptions. Preserve
legacy collections and user-owned configuration unless a later approved phase
provides a verified replacement.
