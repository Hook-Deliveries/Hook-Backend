# Phase 4 Database Reset And Seed

The active development workflow does not run incremental migrations. `npm run seed` drops the configured MongoDB database once, then recreates the complete Phase 1-4 baseline in this order:

1. Base operational fixtures and accounts.
2. Phase 2 identity, RBAC, geography, Market, Hub, Partner, and Market Associate foundations.
3. Phase 3 commercial catalog, variants, submissions, and negotiation fixtures.
4. Phase 4 canonical commerce fields, policies, settings, coverage, customer, and address fixtures.

The command is intentionally destructive in every environment. Always verify the complete `MONGODB_URI`, including its database path, before running it.

Incremental migration commands are not exposed through `package.json`. Seed is the supported MongoDB data-management workflow for the current pre-production platform.

Legacy migration source files are retained only as compatibility references and reusable data-shaping functions. They are not part of the supported command surface.
