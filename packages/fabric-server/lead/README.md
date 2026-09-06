# Durable lead checkout (fabric-4xk.1)

`LeadOrderPlugin` adds two Shop API mutations. Both use Vendure's `Permission.Owner` session middleware.

1. Call `prepareLeadOrder { sessionCapability }` with credentials enabled. Wait for the response and retain its session cookie (or bearer token) before submitting anything.
2. Generate a UUID v4 `submissionToken` for this checkout attempt. Persist that token, the capability, and the exact payload until its outcome is known.
3. Call `submitLeadOrder(input: { sessionCapability, submissionToken, items: [{ productVariantId, quantity }], contact: { fullName, phone } })` with the established session. The receipt contains `orderId`, `code`, `currencyCode`, `totalWithTax`, and line quantities/prices in minor currency units.
4. On transport failure retry the same token and normalized payload. Clear the frontend cart only after receiving the receipt. A subsequent intentional order requires a new token. Never automatically obtain a new capability/session and resubmit an unresolved attempt: that represents a different scope and could create another order.

The capability is derived from the existing session secret and active channel. It is not an order access token. A lost initial anonymous handshake response creates no lead. A submit with an old capability in a new session is rejected, even if the UUID is the same. Replays remain scoped to channel and session; receipt lookup by UUID alone does not exist. Expired sessions require manual reconciliation of an unresolved submission rather than automatic resubmission.

Inputs are bounded to 50 distinct variants, quantities 1–100 with total quantity at most 500, a 200-character name and 40-character phone before normalization. Duplicate variants are rejected. Names are trimmed and whitespace collapsed; phones remove spaces, brackets and hyphens and must contain 7–15 digits with an optional leading plus. UUIDs are case insensitive. Variant and parent product availability and current-channel membership are checked; prices and totals are calculated exclusively by Vendure. Errors expose fixed `LEAD_*` codes, never raw SQL or payloads.

## Cart and transaction semantics

PostgreSQL locks the persisted Session row for the whole submission. This serializes different tokens as well as replays across server instances. The durable unique constraint is `(channelId, sessionId, tokenHash)`, with an additional unique order ID. The fingerprint is checked before any order mutation.

An attached, active, current-channel `AddingItems` cart is reused with its items replaced by the explicit payload. Authenticated active-order fallback is restricted to the same originating channel. A noneditable cart is rejected. Other-channel carts are preserved. Vendure automatically adds nondefault-channel orders to the default channel too, so membership alone cannot establish provenance: a private, Shop-unwritable `leadOriginChannel` marker records the creating channel through `OrderEvent.created`. Legacy unmarked single-channel carts are supported; unmarked multichannel carts are preserved conservatively. With no attributable current-channel cart, a new order is created. The plugin uses public `OrderService` methods and an additional `LeadSubmitted` state with Vendure's `OrderPlacedStrategy`. The state becomes inactive, placed quantities/history are persisted, and the submitted cart is detached in the same transaction. No payment is created and no stock is allocated by this lead-only transition.

The submitted order has no outgoing state transitions. Public order interceptors lock and recheck state before normal core line mutations. A blocking `OrderEvent` handler also rejects stale scalar/contact updates to a submitted order inside the core transaction. An Order entity save subscriber protects core error-result paths which skip line hooks but still save a stale order. Session cache invalidation occurs after commit; Vendure's default strategy rejects cached inactive orders independently. Receipt and rendered operator email are immutable snapshots, unaffected by later catalog changes. Failures before commit roll back cart changes, receipt and outbox together. General legacy Shop `activeOrder` multichannel isolation is tracked separately in `fabric-jjd`.

## Notification delivery

The receipt row also owns exactly one logical outbox notification. Its HTML is generated from the existing operator template, preserving product names, links, contact details and totals. The dedicated flow does not emit the broad contact `OrderEvent`; legacy callers retain their existing notification handler unchanged.

Each server/worker polls the durable outbox. PostgreSQL `LIMIT 1 FOR UPDATE SKIP LOCKED` loads and claims at most one pending row and commits `attempting` before SMTP. The same transaction records the attempted from/to/cc, subject and Message-ID. SMTP and every history/recovery path use this durable envelope; a later recipient/configuration change cannot rewrite the historical destination. The sender uses existing `ORDER_NOTIFICATION_*` and `EMAIL_*` variables, bounded SMTP timeouts, no SMTP debug logging, and a stable message ID including the scoped submission identity and order code. Missing SMTP configuration leaves notifications pending. Successful SMTP acceptance and email history are recorded atomically as `sent`; definitive rejection, including partial recipient rejection, records `failed`. Network/ack ambiguity records `ambiguous`. Failed or ambiguous rows are never automatically resent.

If a process crashes after claiming or after SMTP accepts but before the database records success, the row remains `attempting`. After ten minutes it becomes `ambiguous` with a history entry using the original envelope. Pre-upgrade attempts without an envelope are explicitly marked `[original envelope unavailable]` with `attemptedEnvelopeStatus: unavailable`; current environment values must never be substituted. This deliberately does **not** promise SMTP exactly once: an operator must check the provider/mailbox using the recorded Message-ID, or external provider records when the original envelope is unavailable, before deciding on any manual resend. There is no public retry mutation or automatic state reset. A crash before SMTP may therefore require manual delivery; this is the duplicate-avoidance tradeoff. Durable history records fixed error categories rather than provider error strings. The snapshot/history contain customer data and remain admin/database-only.

## Migration and staged release

Migration `1788648000000-add-lead-submission.ts` adds the plugin table and nullable internal origin column on `order` in the configured database schema. It preserves existing rows. Down migration locks both tables and refuses rollback when any receipt or marked cart exists; application rollback must normally leave the additive schema in place. Never delete receipts or cart markers to make migration rollback succeed.

Migration `1788651000000-add-lead-attempted-envelope.ts` adds the nullable JSON envelope to existing submission tables without rewriting historical attempts. Its down migration refuses to discard any recorded envelope. Run both migrations before starting the revised backend; leaving these additive columns in place is the normal application rollback path.

Local acceptance uses a dedicated PostgreSQL fixture, an in-process delivery stub and a loopback SMTP sink with `.invalid` addresses. No message is sent to people or an external mail server. It is not proof of a deployed test image or of production readiness. `fabric-u17.17` owns test image, schema and runtime checks. No production/main deployment is authorized by this task.

Release backend plus additive migration first through normal test CI, leaving the legacy storefront and its email handler functional. Verify readiness/schema and old-API compatibility. Then deploy the dependent storefront using the handshake and durable mutation. Roll back the storefront first if necessary; keep the durable backend/table available for unresolved retries. The legacy active-cart behavior remains the parent task's responsibility until storefront callers switch contracts.

Do not submit synthetic leads on a shared environment with operator SMTP configured. Disabling SMTP alone is insufficient: pending synthetic rows would flush when SMTP is restored. Use this isolated local fixture, or an explicitly configured non-human test sink and ensure all synthetic outbox records are consumed/reconciled before restoring real recipients. Never copy fixture data to shared test or production. Shared runtime smoke can remain read-only until that delivery isolation is proven.

## Verification

From the Vendure worktree, after the normal core/common/email/asset/dashboard builds:

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.docker-runtime.json
# Set DB_HOST=127.0.0.1, DB_PORT, DB_NAME, DB_USERNAME, DB_PASSWORD from a private local fixture configuration.
node node_modules/ts-node/dist/bin.js --project tsconfig.docker-runtime.json --transpile-only packages/fabric-server/lead/lead-postgres.e2e.ts
```

The harness creates a uniquely named `lead_test_*` schema and two separate Vendure processes on loopback ports 31670/31671 (`LEAD_TEST_BASE_PORT` can override). It exercises actual HTTP session middleware, PostgreSQL transaction locks and unique constraints, 20 concurrent same-token calls, different-token races, rollback injection, cart/session/channel boundaries, additive migration up/empty down/nonempty refusal, process restart, and local-only notification outcomes. SMTP environment variables are removed inside each worker; the dedicated SMTP regression then sets only the owned loopback sink and validated `.invalid` recipients. Actual QueryRunner instrumentation verifies the claim SELECT returns exactly one row under a backlog while both processes make progress. A real SMTP acceptance followed by injected finish failure and restart verifies unchanged attempted envelope/history after recipient configuration changes, with no resend. Fixture schemas are retained for inspection; remove them only under the fixture owner's explicit cleanup policy. The harness requires actual PostgreSQL and does not fall back to SQLite or mocks.

Focused ESLint covers lead code, notification formatting and both migrations. The standalone runner's explicit evidence logging and fixture startup error reporting have narrowly documented `no-console` exceptions; production files have no new exceptions. Two existing `no-console` errors in unchanged portions of `vendure-config.ts` are baseline findings, distinct from this task's clean changed-code lint.
