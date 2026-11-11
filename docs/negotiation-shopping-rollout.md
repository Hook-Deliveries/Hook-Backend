# Negotiation shopping rollout

Deploy backend support before releasing the updated Hook App. Negotiation and
shopping intents are always enabled and use only configured backend Azure. No
destructive transcript migration is required. Existing offer, accept and close
endpoints remain supported. Missing message IDs use legacy keys in the app.

Customer negotiation is a guided flow, not a chat:

- `GET /negotiations/:id/offer-flow` returns everything the screen shows: list price, the three suggested
  totals, Hook's counter, the locked price, rounds left and the history of offers. Amounts are totals for the whole
  quantity, with the per-item price alongside.
- `POST /negotiations/:id/offer-total` with `{totalPriceMinor}` and an `Idempotency-Key`. The rules are checked
  before a round is spent (below the list price, a serious amount, below Hook's last counter, above the customer's
  last offer). Nothing is locked automatically while offers remain: when Hook accepts a price the customer chooses to
  lock it (`POST /negotiations/:id/accept`) or to try for less, and Hook keeps the best accepted price for them. The best
  price is locked on its own only when the last offer is used. The flow also returns `priceAccepted`, `lastRound` and a
  `midpoint` ("meet in the middle") suggestion, which goes through the same rules and pricing engine as any offer.
- Existing `POST /negotiations`, `/accept` and `/close` are unchanged. The locked price goes into the cart with
  `POST /cart/items` and `quoteId`; the cart service rechecks price, options, ownership and expiry.

Pricing is decided only by the Pricing Engine. The AI picks which suggested prices to show and writes short notes
(validated, with an evenly spread fallback), and words each answer. If the AI provider is down offers still work.

A locked price belongs to the product for its whole lifetime (`negotiationQuoteMinutes`): it holds at any quantity
(up to the cart limit of 99) and in any option, and is applied by the cart on every way of adding that product. Lines
already in the cart move to it when it is locked, a quantity change keeps it, and checkout spends it once per order.
`GET /negotiation-quotes/active` lists the customer's current locked prices (product, per-item price, list price,
percent off, expiry) so every screen that shows a price can lead with it. If the product goes off sale or the minimum
price rises above the locked price, it is cancelled.

The previous customer chat (`/messages`, `/actions/:actionId/confirm` and the `negotiation.send` socket event) was
removed. Partners still send free-text through `POST /partner/customers/:customerId/negotiations/:id/offers`.

Checks run locally: `npm run test:negotiation`, backend build/lint, app
TypeScript/lint. The unit tests mock persistence; they do not substitute for
MongoDB concurrency integration tests or a payment-provider staging test.

Before enabling production shopping intents:

- Verify real catalog category/market alternatives, unavailable variants and
  quote expiry against staging MongoDB.
- Confirm simultaneous/retried actions produce one quoted cart line and a
  persisted receipt, including process interruption between cart and receipt.
- Exercise invalid Azure JSON, provider failures and adversarial prompts with
  staging credentials. Ensure no private floor prices or credentials enter logs.
- Android/iOS: check long chats, recommendation collapse/favourites, resumed
  legacy transcripts, cancellation, failed-send retry, small screens, keyboard,
  large text, reduced motion, screen readers, image recycling and footer position.
- Compare the screen against Figma node `2591:5517` using authenticated real data.

Missing configuration, provider outages, or invalid AI output return HTTP 503
`NEGOTIATION_UNAVAILABLE`; they never activate scripted replies or another AI
provider. Existing approved quotes remain usable through ordinary checkout.

## Strict Azure, live chat, and store notices

Configure `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`,
`AZURE_OPENAI_DEPLOYMENT_NAME`, and `AZURE_OPENAI_API_VERSION` only on the backend.
`AZURE_OPENAI_MODEL_NAME` is optional and only selects request parameters. For Docker the values
live in `deploy/.env`; `GET /admin/negotiation-settings` reports `providerConfigured` and the names
(never the values) of anything missing.

## Price changes, limits and wording fallback

- Every offer, accept and cart/checkout step is judged on the product's rules as they are now
  (`negotiation-live-rules.service.ts`). A customer pays the lower of the agreed and current price.
  A locked price is cancelled when the product goes off sale, negotiation is switched off, or the
  minimum price rises above it (`NEGOTIATED_PRICE_VOIDED`, `NEGOTIATION_PRODUCT_UNAVAILABLE`).
  Admin edits trigger an immediate reconcile; the 60-second `catalog-deadlines` job is the safety net.
- Re-rolling is limited: one live session per item, a cooldown (`negotiationCooldownMinutes`, default 30)
  and a daily cap (`negotiationMaxSessionsPerDay`, default 3) on sessions that actually made an offer.
  Sessions ended by a product change never count. Run `npm run db:dedupe-negotiations -- --execute`
  once to close pre-existing duplicate live sessions and build the unique index.
- If the model's wording breaks a rule twice, the customer gets safe fixed wording with the same
  decision and price (`providerFallback: true`). A real Azure outage still fails closed with 503.
Disabling Azure wording in Commerce Settings pauses replies. No negotiation
feature switches are required in the environment.

The existing Socket.IO server accepts authenticated `negotiation.subscribe`,
`negotiation.unsubscribe`, and `negotiation.message.send` acknowledgements.
HTTP and socket sends share persisted command keys and session leases. Recover
history on reconnect; do not rely on Socket.IO replay. Test process interruption,
concurrent confirmations, and multiple devices against staging MongoDB.

New sessions atomically set a notification-outbox marker. The worker retries
scoped viewer notifications with persisted deduplication keys; transcript
permission remains separate. Restart backend bootstrap to register App Releases
permissions. Super Admin receives initial access; other roles need assignment.

The Admin form publishes a version number directly for both platforms, with
optional release notes. Android opens the fixed Play listing for
`com.biodun42.hook`. iOS resolves the matching bundle ID through Apple's lookup
service; no listing URL environment variable is needed. A missing Apple listing
shows a clear error instead of opening Google Play or another app. Announcement
does not upload a store build and should happen after store availability.
The app reads native version/build with `expo-application`, caches confirmed
policy, and defers enforcement during payment handoff. Rebuild native clients
after installing this module. Verify optional dismissal, mandatory enforcement,
withdrawal, offline recovery, and payment return on both platforms. New version
announcements are optional; legacy confirmed minimum policies remain readable.

Deploy backend and indexes first (transactions require a MongoDB replica set),
then Admin, then native App store builds. Local mocked tests are not production
rollout approval; complete the device and staging checks above before enabling.
