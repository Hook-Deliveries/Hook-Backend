# Negotiation shopping rollout

Deploy backend support before releasing the updated Hook App. Negotiation and
shopping intents are always enabled and use only configured backend Azure. No
destructive transcript migration is required. Existing offer, accept and close
endpoints remain supported. Missing message IDs use legacy keys in the app.

New customer endpoints:

- `POST /negotiations/:id/messages` with `{message}` and an `Idempotency-Key`.
- `POST /negotiations/:id/actions/:actionId/confirm` with `{variantId, quantity}`.
  The action ID identifies the persisted execution; approved prices are never
  accepted from the client. The variant must match the session and its quote.

The action is leased before execution, stores its receipt, and replays completed
results. Quoted cart writes set the quote's exact quantity rather than incrementing
it. Pricing, stock, ownership, options and expiry are checked by the cart service.
Payment continues through the existing checkout. Azure output cannot approve a
price or execute a cart write.

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
