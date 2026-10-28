    # Integration event pipeline

1. A client posts an event to `POST /integrations/:integration_id/events` with `X-Bean-App-Key` and `Authorization: Bearer <secret>`. The secret is checked against `integrated_apps.credential_hash`; the integration and its tenant must both be active. This is a server-to-server endpoint: integration `app_url`s are not CORS origins, so the secret must never be shipped to a browser.
2. The event envelope is `{ "eventId", "eventType", "occurredAt", "payload" }`. The event type must be active in `event_registry`, enabled in `integrated_app_event_subscriptions`, and its payload must match its registered JSON Schema Draft 7 schema. Ajv validates the schema; schemas over 32 KiB or 2,000 nodes / 20 levels are rejected.
3. Accepted events are inserted as `pending` in `integration_events`; duplicates are acknowledged without a second insert. This endpoint does not run business handlers.
4. The in-process worker starts on server boot, checks immediately, then runs every five minutes. It claims one event at a time with `FOR UPDATE SKIP LOCKED` and a committed lease; business writes, analytics outbox writes, audit entries, and the `processed` status commit together. Handler failures roll back business writes and update the attempt history.

`transaction.completed` (or handler keys `process_sale` and `sales`) expects payload fields `externalTransactionId`, `productId` (the Bean inventory SKU), `quantity`, `status` (`completed`), `saleAmount` (a decimal string such as `"1299.00"`; JSON numbers are rejected), `currency`, and `externalUserId`. The occurrence timestamp belongs in the event envelope. The external user must map through `integration_user_mappings`. The worker deducts stock, creates a `sales_transactions` row, creates a commission when an active tenant commission rule exists, and inserts a `sale.processed` row into `analytics_outbox`.

`inventory.adjusted` (or handler keys `process_inventory_adjustment` and `inventory_adjusted`) expects `productId`, positive integer `quantity`, and `adjustment` (`increase`, `decrease`, or `set`); it writes the inventory change and an analytics outbox row atomically.

Analytics consumers should claim `analytics_outbox` rows using `FOR UPDATE SKIP LOCKED`, then mark them processed after ingestion. Refund and referral handlers need their own agreed payload schemas and business semantics before enabling those event types in subscriptions.

Apply migrations in order. `001_integration_event_worker.sql` establishes the outbox if absent; `002_integration_reliability.sql` adds retry, lease, attempt-history, and diagnostic storage; `003_integration_activity_retention.sql` adds activity, tenant inventory policy, credential rotation metadata, retention snapshots, and long-lived event-ID deduplication; `004_align_event_registry_contracts.sql` replaces the drifted snake_case `event_registry` payload schemas for `transaction.completed` and `inventory.adjusted` with the camelCase contract below (without it, no event can pass both the registry schema and the handler validation). `005_tenant_creation_permission.sql` adds `TENANTS_CREATE`; `006_integration_manage_permission.sql` adds `INTEGRATIONS_MANAGE` (granted to every role that held `INTEGRATIONS_READ`); `007_tenant_audit_scope.sql` adds `audit_logs.tenant_id` and `PLATFORM_AUDIT_READ`; `008_inventory_tenant_required.sql` blocks new tenantless inventory; `009_case_insensitive_account_identity.sql` makes email and username unique regardless of case. Apply 005–009 **before** deploying code that depends on them: audited writes fail without 007's column. `db/schema/baseline.sql` is a schema-only snapshot of the shared development database (it already includes 001-003) used to build disposable test databases.

A suspended tenant's integrations are rejected at authentication, and events accepted before a suspension fail with `TENANT_INACTIVE` (action required, retryable by a tenant admin after reactivation) without business effects.

## Tests

`npm test` runs the unit tests. `npm run test:db` runs the end-to-end pipeline tests (HTTP ingestion, deduplication races, worker business effects, rollback, retries, lease recovery, tenant isolation) against real PostgreSQL. It drops and rebuilds the `public` schema from the baseline plus all migrations, so it refuses to run unless `DATABASE_URL` is empty, `DB_HOST` is local, and `DB_NAME` ends in `_test`:

```sh
DATABASE_URL= DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=bean_integration_test DB_USER=bean_test DB_PASSWORD=unused NODE_ENV=test npm run test:db
```

## Tenant onboarding and integration lifecycle

All routes need a Bean session. Reading integrations needs the account-level `INTEGRATIONS_READ` permission; every change (register, subscriptions, user mappings, activate, suspend, disconnect, credential rotation, event retry, inventory-policy settings) needs `INTEGRATIONS_MANAGE` instead, which is denied with `403 PERMISSION_REQUIRED` (migration 006 granted it to every role that held `INTEGRATIONS_READ`). Tenant authority still comes from `tenant_members` on top of either permission (`owner`/`admin` may change things; any member may read). Integrations of a deleted tenant behave as if they do not exist. App-scoped routes take no tenant ID: the tenant is read from the integration row and the caller's membership in it is checked. Non-members get `404`, non-admin members `403`.

- `POST /tenants` `{ "name", "slug" }` creates an active tenant and makes the caller its `owner` (audited as `CREATE TENANT`). `GET /tenants` lists the caller's tenants.
- `POST /integrations/tenants/:tenant_id/apps` `{ "name", "description"?, "appUrl"?, "webhookUrl"? }` registers a `pending` integration and returns its generated `appKey` and secret **once**. Only the bcrypt hash is stored.
- `PUT /integrations/:integration_id/subscriptions` `{ "eventTypes": [...] }` sets the enabled event types. Only active registry types with a supported handler are accepted; other existing subscriptions are disabled, not deleted.
- `PUT /integrations/:integration_id/user-mappings` `{ "externalUserId", "userId", "isActive"? }` maps a client-side user to a member of the same tenant (required for sales).
- `GET /integrations/:integration_id` returns the integration (never the secret or hash), its subscriptions, and readiness checks.
- `POST /integrations/:integration_id/activate` moves `pending`/`suspended` to `active` only when the tenant is active, a credential exists, and at least one supported subscription is enabled. Otherwise it returns `409 INTEGRATION_NOT_READY` with the failed checks and records a failed lifecycle entry.
- `POST /integrations/:integration_id/suspend` moves `active` to `suspended`. Deliveries are refused while suspended.
- `POST /integrations/:integration_id/disconnect` moves any non-revoked state to `revoked`. This is terminal: the credential hash is cleared and subscriptions are disabled. Events accepted before disconnection were authenticated and are still processed.

Each change writes an `integration_lifecycle_activity` row (actor, request ID as correlation ID) and an `audit_logs` entry; neither contains secrets.

## Activity feed and tenant operations

## Integrated Applications dashboard

All three views need a session, `INTEGRATIONS_READ`, and membership in the tenant that owns the integration. The integration is resolved from its ID and the caller's membership. `tenantId` is optional; if given, it must match, otherwise the response is `404`, the same as for non-members. Paginated views use `page`/`limit` (max 20) and return the usual `pagination` block. Ordering is newest first with a deterministic tie-breaker. None of these views return payloads, secrets, or credential hashes, and none of them write anything.

- `GET /integrations/:integration_id/activity?from&to&eventType&status&recordType&page&limit` is the event-processing timeline. Each row has `recordType`:
  - `integration_event`: the queued event, with `receivedAt`, `eventOccurredAt`, `processedAt`, `attemptCount`. `pending` means accepted (HTTP 202) but not processed; only `processed` means the business effects committed.
  - `delivery_diagnostic`: one per delivery attempt, so duplicates and invalid deliveries stay visible (`accepted`, `duplicate`, `invalid`, `ingestion_failed`).
  - `processing_attempt`: a worker attempt (`processed`, `failed`, `retry_scheduled`, ...).
  - `sale`: the business effect.
  - `analytics_outbox`: outbox state.

  `occurredAt` is the timeline position. Lifecycle changes are no longer in this feed; they are in the audit view.
- `GET /integrations/:integration_id/audit?from&to&source=audit_log|lifecycle&actor=user|system&page&limit` returns:
  - `integration_lifecycle_activity` rows, which include refused activations, plus
  - `audit_logs` rows that can be verifiably attributed to the integration: `integrated_apps` and subscription audits by integration ID; mapping and event audits through their own rows. Event audits drop out once retention removes the event.

  Tenant-wide audits (inventory-policy changes) are not attributed to a single integration; their per-integration lifecycle rows are. Audit `changes.before`/`after` are reduced to an allowlist of scalar fields.
- `GET /integrations/:integration_id/analytics?from&to` (default the last 30 days, at most 366) returns a versioned contract (`schemaVersion: 1`):
  - `events`: `total`, `byStatus`, `byType`, `successRate` over settled events, `topFailureCodes`.
  - `deliveries`: `accepted`, `duplicate`, `invalid`, `ingestionFailed`.
  - `processingLatencyMs`: `samples`, `average`, `p50`, `p95`, `max`.
  - `sales.byCurrency` and `commissions.byCurrency`: linked through `sales_transactions.integrated_app_id`; amounts are decimal strings.
  - `inventoryAdjustments`: counts from outbox facts.
  - `limitations`: retention and attribution caveats for the UI.

  All sections are read in one read-only snapshot. Empty windows return zeros and `null` averages and rates, never placeholder data.
- `POST /integrations/:integration_id/credentials/rotate` accepts `{ "tenantId": 1 }`. It requires `INTEGRATIONS_MANAGE` plus owner/admin membership. The new 48-byte cryptographically generated secret is bcrypt-hashed, invalidates the old secret immediately, and is returned once. Store it in the integrated application before its next request; Bean cannot recover it later. The operation is rate-limited and audited without logging the secret.
- `GET /integrations/tenants/:tenant_id/settings` and `PUT /integrations/tenants/:tenant_id/settings/inventory-policy` expose tenant owner/admin inventory configuration. The accepted `inventoryShortagePolicy` values are `require_intervention` (default), `allow_negative_inventory`, and `record_sale_without_stock_deduction`. Client events cannot override this policy. The selected policy and stock action are snapshotted on each sale.

Retention is a bounded worker run at `INTEGRATION_RETENTION_INTERVAL_MS` (default 24 hours), using at most `INTEGRATION_RETENTION_BATCH_SIZE` rows per table per run. Defaults are 90 days for processed source events, 180 days for finished attempts, 90 days for diagnostics, and 90 days after successful outbox delivery. Only processed source events and outbox messages are eligible; pending, processing, failed, and exhausted outbox records are retained. Attempt, sale, and outbox rows keep compact event/integration identifiers so the timeline remains correlatable after source payload cleanup. A compact deduplication tombstone (integration ID + event ID and non-sensitive correlation identifiers) is retained indefinitely to prevent replaying an old inventory adjustment after event payload expiry. Tune periods with `INTEGRATION_EVENT_RETENTION_DAYS`, `INTEGRATION_ATTEMPT_RETENTION_DAYS`, `INTEGRATION_DIAGNOSTIC_RETENTION_DAYS`, and `ANALYTICS_OUTBOX_RETENTION_DAYS`.

## Refund and referral contracts (not enabled)

These are versioned contract proposals, not registered event types or working handlers. The current database does not define refund ledger/reversal behavior or referral attribution policy, so do not subscribe clients to them until those tenant rules are approved and persisted.

Proposed `transaction.refunded.v1` payload:

```json
{
  "schemaVersion": "1",
  "externalTransactionId": "order-9081",
  "externalRefundId": "refund-2201",
  "refundedAmount": "12.50",
  "currency": "PHP",
  "providerStatus": "completed"
}
```

`occurredAt` remains in the Bean event envelope. The refund policy must still define partial refund handling, provider status mapping, and commission reversal (`full`, pro-rata, none, or manual review) before activation. Refund identifiers must be idempotent per integration.

Proposed `employee.referral.recorded.v1` payload:

```json
{
  "schemaVersion": "1",
  "externalTransactionId": "order-9081",
  "referringEmployeeExternalId": "store-employee-499",
  "attribution": {
    "source": "campaign",
    "reference": "spring-2026"
  }
}
```

Before activation, tenant policy must define attribution precedence, required employee mapping, eligibility, and any commission effect. No referral or refund outcome is inferred by the current worker.

## Analytics delivery boundary

The activity endpoint is an observability feed and is not an analytics destination. The outbox stores transactional business facts with stable source integration/event identifiers. No analytics consumer or delivery endpoint exists in this backend, so there is no dispatcher, downstream acknowledgment, or delivery guarantee yet. The outbox schema now has lease/retry fields for a future dispatcher, and source-event cleanup no longer cascades away outbox facts. A destination contract and consumer-side deduplication remain prerequisites for delivery.

Worker settings are `INTEGRATION_WORKER_INTERVAL_MS` (default `300000`), `INTEGRATION_WORKER_BATCH_SIZE` (`100`), `INTEGRATION_MAX_ATTEMPTS` (`5`), `INTEGRATION_LEASE_MS` (`300000`), and `INTEGRATION_RETRY_DELAYS_MS` (`60000,300000,900000,3600000`). The delays have ±20% jitter. The periodic worker polls at its configured interval, so retries become eligible at their scheduled time and are picked up at the next poll.

## Event investigation

- `GET /integrations/events?tenantId=1&status=failed&correlationId=<id>` searches Bean's queue. It also accepts `internalEventId`, `eventId`, `externalTransactionId`, `integrationId`, `eventType`, `errorCode`, `from`, and `to`, plus the existing `page`/`limit` pagination.
- `GET /integrations/events/:event_id?tenantId=1` returns the event timeline, processing attempts, and matching delivery diagnostics without returning the raw payload.
- `GET /integrations/diagnostics?tenantId=1&outcome=invalid` searches accepted/duplicate/rejected delivery diagnostics.
- `GET /integrations/diagnostics/unauthorized` is a platform-wide view: it requires `PLATFORM_AUDIT_READ` (not tenant `AUDIT_READ`) and returns only request IDs, timestamps, response status, and error code for unauthenticated attempts; it does not retain or expose caller-claimed identities.
- `POST /integrations/events/:event_id/retry` requires a Bean session, `INTEGRATIONS_MANAGE`, tenant owner/admin membership, and `{ "tenantId": 1, "reason": "Corrected the stock mapping" }`. Only action-required failed events are eligible; each retry is audited and uses the existing event ID.

Malformed authenticated JSON and authenticated validation/ingestion failures are recorded without storing raw payloads. Unauthenticated failures retain no caller-claimed integration or tenant IDs.

Example accepted delivery:

```http
POST /integrations/12/events
X-Bean-App-Key: storefront-key
Authorization: Bearer <integration-secret>
Content-Type: application/json
```

```json
{
  "eventId": "storefront-event-9081",
  "eventType": "transaction.completed",
  "occurredAt": "2026-10-22T08:15:00Z",
  "correlationId": "checkout-9081",
  "payload": {
    "externalTransactionId": "order-9081",
    "productId": "BEAN-42",
    "quantity": 2,
    "status": "completed",
    "saleAmount": "1299.00",
    "currency": "PHP",
    "externalUserId": "store-employee-499"
  }
}
```

Bean replies `202` with `{ "message", "data": { "integrationId", "eventId", "status": "pending", "receivedAt" } }`. `occurredAt` must include a timezone and may be no more than five minutes in the future; old timestamps are accepted for imported historical transactions.

## Optional client-side diagnostic contract

No client diagnostic endpoint or registered diagnostic URL exists in the current project, so Bean does not call client apps for explanations. A future optional contract could be an authenticated `POST` to a fixed, administrator-configured client endpoint with `{eventId, externalTransactionId, correlationId, from, to}` and a bounded response such as `{available:true, diagnostics:[{requestId,eventId,outcome,errorCode,errorSummary,occurredAt}]}`. It must use the registered integration credential, enforce a short time window and response cap, and never accept a URL from an event payload. Until a destination and authorization contract exist, Bean's own receipt and worker timeline is the supported diagnostic source.
