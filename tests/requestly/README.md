# Bean onboarding pipeline for Requestly

File: `bean-backend-e2e.postman_collection.json`. Collection name: **Bean Backend E2E (onboarding, members, isolation, integrations)**. It is a Postman Collection v2.1 file, the format Requestly imports.

| Folder | Purpose |
|---|---|
| **`00 Onboarding pipeline (automated)`** | The scripted onboarding journey. Run this one. |
| `99 Full E2E walkthrough (manual steps)` | The earlier walkthrough. It needs variables copied by hand, so leave it unchecked for the onboarding run. |

> **Safety.** Run this only against a local backend that uses a disposable `*_test` database. Never point `base_url` at a backend connected to Neon or production. The pipeline creates accounts, a tenant, an integration, inventory, and events on every run. It deletes nothing, but it is not meant for real data. The seed script refuses to run unless `DATABASE_URL` is empty, the host is local, and the database name ends in `_test`.

## What it tests

The onboarding folder runs 76 requests with about 170 assertions, in dependency order:

1. **Create user.** Registers a brand-new account (the "new hire") with values unique to the run.
2. **Authenticate.** A wrong password gives a generic `401`. Login sets the `bean.sid` session. `/auth/me` restores the user and shows no account permissions. An unsafe request without `Origin` gets `403 ORIGIN_DENIED`. The new hire cannot create a tenant (`403`).
3. **Create tenant.** The seeded founder creates the organization and becomes its `owner`. A duplicate slug gets `409 TENANT_SLUG_TAKEN`. The tenant appears in `GET /tenants`, and `GET /tenants/:id` shows one member.
4. **Onboard employees.** Through the membership API:
   - the manager is added as `admin` (by email) and the cashier as `member` (by username);
   - adding someone twice gives `409 ALREADY_MEMBER`, and an unknown account gives `404 USER_NOT_FOUND`;
   - the member list comes back ordered owner, admin, member;
   - changing your own role gives `403 CANNOT_CHANGE_OWN_ROLE`;
   - a tenant inventory item is created.
5. **Verify tenant boundaries.**
   - The manager (a tenant admin) still has no `TENANTS_CREATE` and cannot grant `admin` (`403 OWNER_REQUIRED`), but can add the new hire as a member.
   - The cashier can read inventory but cannot add members (`403 TENANT_ROLE_REQUIRED`) or create inventory (`403`).
   - The rival owner (seeded, owning another tenant) gets `404 TENANT_NOT_FOUND` for this tenant's details, members, member addition, and inventory, and `404` when updating this tenant's item through the rival tenant's own path.
6. **Onboard integrated app.**
   - Back in the founder's session, the founder gets `404` on the rival tenant and on the rival's item. This is the reverse direction of the boundary check.
   - The app is registered. Its one-time credential is captured into a runtime variable and never shown again.
   - Readiness is not ready yet.
   - An unsupported subscription gets `422`. The supported subscriptions are configured.
   - `cashier-001` is mapped to the cashier and `manager-001` to the manager. Mapping a non-member gets `422 USER_NOT_TENANT_MEMBER`.
   - The cashier cannot suspend the app (`403 TENANT_ADMIN_REQUIRED`).
7. **Activate integration.**
   - An event sent while the app is pending gets `401`.
   - Activating with no supported subscription gets `409 INTEGRATION_NOT_READY` with the failed check.
   - After the subscriptions are restored, the app is ready and activation succeeds.
8. **Exercise integration.**
   - A sale event gets `202 pending` (accepted, not yet processed).
   - The same event again gets `200 duplicate`. A numeric `saleAmount` gets `400 INVALID_EVENT_PAYLOAD`.
   - A poll waits until the worker reports `processed`.
   - The activity feed shows both deliveries, one sale, the invalid delivery, and no payloads.
   - The audit history shows the lifecycle steps, including the failed activation, the cashier mapping with the cashier's user ID, and processing.
9. **Verify completed onboarding.**
   - The app belongs to the tenant, is active, has a `lastEventAt`, and exposes no credential fields.
   - Stock went from 50 to 49, deducted once despite the duplicate delivery.
   - Analytics shows one processed event, accepted, duplicate, and invalid deliveries, and one PHP sale of `250.00`.
   - The tenant has four members.
   - After logout, requests get `401`.

**Not tested here:** email invitations (not implemented), member removal, credential rotation and disconnect (they are in the `99` folder), tenant deletion, role assignment (there is no API for it), commissions (no commission rule is seeded), and the global `/audit/all` route.

## Prerequisites

- **Requestly desktop app.** The session relies on cookies. Requestly documents its cookie jar as a desktop-app feature. The scripts also capture `bean.sid` and send it explicitly when Requestly exposes the `Set-Cookie` header to scripts.
- **The Requestly API client must send the `Origin` header** set on each request. The backend's CSRF check rejects unsafe requests without a trusted `Origin`.
- **Local backend** (`npm run dev` in `backend/`) started with:
  - `DATABASE_URL=` (empty) and `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` for a local database whose name ends in `_test`, e.g. `bean_requestly_test`.
  - `APP_ORIGINS` including the collection's `origin` value (default `http://localhost:5173`).
  - `INTEGRATION_WORKER_INTERVAL_MS=2000`, so the event is processed within seconds. The default is 5 minutes, and the poll gives up after 90 seconds.
- **Database:** create it, then apply `db/schema/baseline.sql` followed by every file in `db/migrations` in order, 001 through 005. Migration 005 adds the `TENANTS_CREATE` permission. For example, with `psql`:
  ```sh
  createdb bean_requestly_test
  psql -d bean_requestly_test -f db/schema/baseline.sql
  for f in db/migrations/*.sql; do psql -d bean_requestly_test -f "$f"; done
  ```

## Test accounts

| Account | How it is provisioned | Role (account permissions) | In the onboarding tenant |
|---|---|---|---|
| founder (`founder.requestly@example.test`) | seeded | `onboarding_founder`: `TENANTS_CREATE`, `INTEGRATIONS_READ`, `INTEGRATIONS_MANAGE`, `INVENTORY_READ/CREATE/UPDATE` | owner (creates it) |
| manager (`manager.requestly@example.test`) | seeded | `onboarding_employee`: `INTEGRATIONS_READ`, `INVENTORY_READ` (read-only: no `INTEGRATIONS_MANAGE`) | admin |
| cashier (`rqcashier`, `cashier.requestly@example.test`) | seeded | `onboarding_employee` | member |
| new hire (`newhire.<run>@example.test`) | **created by the collection** | none | member (added by the manager) |
| rival owner (`rival.requestly@example.test`) | seeded, owns the seeded tenant `requestly-rival` with item `RIVAL-1` | `onboarding_founder` | not a member (cross-tenant checks) |

The founder has to be seeded. Bean's policy is that new signups have no account permissions and cannot create tenants, and there is no role-assignment API. The collection does not bypass that; it demonstrates it in folder 2.

The seed script creates its own test roles (`onboarding_founder`, `onboarding_employee`) and does not change existing roles. Run it once per database, from `backend/`. It is idempotent and resets the seeded accounts' passwords to `REQUESTLY_TEST_PASSWORD`.

```sh
DATABASE_URL= DB_HOST=127.0.0.1 DB_PORT=5432 DB_NAME=bean_requestly_test DB_USER=<local user> DB_PASSWORD=<local password> \
REQUESTLY_TEST_PASSWORD='Onboard!Test1' node tests/requestly/seed-onboarding.mjs
```

### Running against the shared staging database (Neon)

The connected Neon database is staging. Every run writes to it: a new-hire account, a tenant, an app, events and a sale. Staging needs, once:

1. **Migrations 005–009**, applied in order with the Neon SQL editor or `psql -v ON_ERROR_STOP=1 -f`, **before** the backend code that needs them is deployed. 005 adds `TENANTS_CREATE` and grants it to `dev`. 006 adds `INTEGRATIONS_MANAGE`. 007 adds `audit_logs.tenant_id`, which every audited write now uses, so the backend returns `500` on audited operations without it. 008 and 009 add inventory and account constraints. See `db/reconciliation/2026-10-28-legacy-data.md`.
2. **The seed, with an explicit opt-in.** From `backend/`, using the normal `.env`:
   ```sh
   REQUESTLY_TEST_PASSWORD='Onboard!Test1' node tests/requestly/seed-onboarding.mjs --target=staging
   ```
   The script refuses and prints the hostname that `DATABASE_URL` points at. If that host is your staging database, re-run with `REQUESTLY_STAGING_HOST=<that hostname>` added.
3. **A backend with a fast worker.** Start it with `INTEGRATION_WORKER_INTERVAL_MS=2000 npm run dev`. With the default 5-minute interval, the "Wait for the worker" step gives up after 90 seconds.

Each run leaves its new-hire account and tenant behind. Those are test data, and they can't be bulk-deleted through the API.

## Import and configure

1. Requestly desktop → **API Client** → **Import** → **Postman** → choose `tests/requestly/bean-backend-e2e.postman_collection.json`.
2. Open the collection's **Variables**. Only these need to match your setup:

   | Variable | Example | Notes |
   |---|---|---|
   | `base_url` | `http://localhost:3000` | your local backend |
   | `origin` | `http://localhost:5173` | must be listed in the backend's `APP_ORIGINS` |
   | `test_password` | `Onboard!Test1` | must equal `REQUESTLY_TEST_PASSWORD` used when seeding |

   The account variables (`founder_email`, `manager_email`, `cashier_email`, `cashier_username`, `rival_email`, `rival_slug`, `rival_sku`) already match the seed script.

   Everything else, including IDs, the app key and credential, the session cookie, and the per-run values, is set by scripts as **runtime variables**. Requestly documents runtime variables as not saved back, so the credential and session are not persisted in the collection. Leave those variables empty.

## Run

1. **Collection Runner:** select the collection, then **uncheck the `99 Full E2E walkthrough (manual steps)` folder**. Requestly's docs don't describe running a single folder; if your version offers "Run" on the folder itself, use that instead.
2. **Delay:** set it to `1000` ms. The "Wait for the worker" request re-runs itself, through `rq.execution.setNextRequest`, until the event is processed. The delay spaces out those polls.
3. **Iterations:** set to `1`, then click **Run**.

**Expected result:** every request passes all its tests (about 170 assertions; the poll request repeats a few times). The tenant created in this run ends with:
- 4 members;
- one active integration with a `lastEventAt`;
- the item at 49 units;
- analytics with one processed `PHP 250.00` sale.

## Reading failures

- **`Script error` or tests saying a variable is missing:** an earlier request in the chain failed. Fix the first failure in run order; later ones usually follow from it.
- **Every request after a login is `401`:** the session isn't being carried.
  - Use the desktop app and check that its cookie jar is on.
  - Or make sure scripts can read `Set-Cookie`.
  - Make sure `base_url` uses the same host throughout. Cookies are per host, so `localhost` and `127.0.0.1` are different.
- **`403 ORIGIN_DENIED` on unsafe requests other than the deliberate negative:** `origin` is not in `APP_ORIGINS`, or the `Origin` header isn't being sent.
- **`429` or a login suddenly `401`/`429`:**
  - The backend allows **3 failed logins per 15 minutes per IP**. Each run uses one (the wrong-password negative). After 3 runs, every login is blocked until the window passes.
  - Signup allows **5 per hour per IP**, and each run uses one.
  - Restarting the backend resets both limits, because they are kept in memory.
- **`403` on tenant creation by the founder:** migration 005 isn't applied, or the seed wasn't run, so the founder has no `TENANTS_CREATE`.
- **Rival tenant or `RIVAL-1` not found (folder 5):** run the seed script.
- **Unexpected `404 TENANT_NOT_FOUND`:** this is how tenant isolation answers anyone who isn't a member. It is expected in the cross-tenant requests and a real failure anywhere else.
- **"Event processed by the worker" fails:** the worker didn't process the event within 90 seconds. Set `INTEGRATION_WORKER_INTERVAL_MS=2000` and check the backend log. If the event ended up `failed`, open the activity feed request's response for its `errorCode`.

## Resetting and rerunning

Each run generates unique values: new-hire account, tenant slug, SKU and event IDs. You can rerun without cleaning anything; each run leaves one more isolated tenant. Keep the rate limits above in mind, or restart the backend between runs.

For a clean slate, drop and recreate the **local** `*_test` database, apply the schema and migrations, and re-run the seed script. Never do this against Neon or any shared database.

## How this collection was verified

The collection could not be run in the Requestly app from here. It was verified in these ways:
- **Schema:** it was validated against the official Postman Collection v2.1 JSON Schema, and the validator rejects a deliberately broken copy.
- **Runner emulation:** `npm run test:db` includes `requestlyOnboarding.db.test.js`. That test runs this folder through `src/integrations/tests/support/requestlyRunner.js`, an emulation of the documented Requestly script API, against a real-session server, twice: once with a cookie jar, and once with scripts carrying the cookie. It also checks that reruns stay isolated.
- **Real server and real Chai:** the folder was also run against the real `src/server.js`, with its background worker and real sessions, using real Chai assertions, in both cookie modes. All assertions passed.
- **Mutation check:** two deliberately wrong expectations produced exactly two failures, so the assertions do detect errors.

Behaviors that depend on the Requestly app itself still need your first run to confirm:
- that its Postman importer keeps these native `rq.*` scripts;
- its cookie jar;
- that it sends the `Origin` header;
- `setNextRequest` polling inside its runner.
