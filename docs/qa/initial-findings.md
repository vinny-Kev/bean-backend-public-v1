# Initial findings (baseline, 2026-10-28)

Scope: the `backend/` repository at commit `b9e4bb3` on branch `kevin-dev` (clean working tree). Findings come from reading the code and running the commands noted. Nothing was run against a database (see "Environment").

## Environment and stack

| Item | Value |
|---|---|
| Runtime | Node.js >= 20 (`engines`), ES modules, run here on v22.20.0 |
| Framework | Express 5.2.1, `express-session` + `connect-pg-simple` (PostgreSQL sessions), `helmet`, `cors`, `express-rate-limit`, `pg`, `bcrypt`, `ajv` |
| Entry point | `src/server.js` (starts listening on import; mounts `/auth /inventory /audit /integrations /tenants /ticketing`) |
| Default address | `HOST=127.0.0.1`, `PORT=3000` (`src/config.js`) |
| Tests | `node --test` (no framework); DB tests need a local `*_test` PostgreSQL |
| Lint / format | none configured before this work |
| Migrations | 9 idempotent SQL files + `db/schema/baseline.sql`; **no runner, no applied-version table** |
| Local `.env` | points `DATABASE_URL` at a shared **Neon** database. No command in this QA connected to it. |

## Baseline command results

| Command | Result before changes |
|---|---|
| `npm test` | 23 pass, **1 fail**: `src/ticketing/ticketing.test.mjs` (`mock.module is not a function`; with the flag, the `exports` option is not supported on Node 22) |
| `node --experimental-test-module-mocks --test src/ticketing/ticketing.test.mjs` (documented command) | **fail** (`does not provide an export named 'pool'`) |
| `npm test:db` suite | registers 0 tests: skipped because no local `*_test` database exists |
| `npm audit` | 0 vulnerabilities |

## Confirmed defects

| # | Finding | Evidence | Status |
|---|---|---|---|
| D1 | Ticket audit rows were written without `tenant_id` (`recordAudit` in `ticketShared.js` inserted only user/action/table/record/data). Per migration 007, rows with NULL tenant are visible only in the platform view, so tenant owners/admins could never see ticket history in `GET /audit/tenants/:id`. | code reading | **Fixed**, tested |
| D2 | The ticketing test only worked on newer Node versions and broke `npm test` (and the documented command) on the installed Node 22. | baseline run | **Fixed** (portable test, 29 cases) |
| D3 | No audit entry for signup, logout, or failed login; only successful login was recorded. | code reading | **Fixed**, tested |
| D4 | Ticket ID / points parsing used `String(value)`: `["4"]` was accepted as `4`, and `9007199254740993` (JSON number) silently became `9007199254740992`. | code reading | **Fixed**, tested |
| D5 | Ticketing code was formatted differently from the rest of the codebase (2 spaces, double quotes vs 4 spaces, single quotes). | diff | **Fixed** (formatting only, covered by tests) |
| D6 | No health endpoint for deployment probes (only `GET /inventory/health/`, which touches nothing). | code reading | **Fixed** (`/health`, `/health/ready`) |
| D7 | `body-parser`, `ajv`, `qs`, `ip-address` advisories raised previously. | `npm audit` = 0 now (installed: body-parser 2.4.0, ajv 8.20.0, qs 6.17.0, ip-address 10.7.5) | **Already resolved** |

## Potential risks needing investigation or a decision

| # | Risk | Notes |
|---|---|---|
| R1 | Ticketing answered **403** to non-members; every other module answers 404 so tenant IDs cannot be probed. | **Resolved 2026-10-28 (approved)**: 404 `TENANT_NOT_FOUND`; members of an inactive tenant get 409 `TENANT_INACTIVE`. |
| R2 | The ticket list response was double nested and allowed `limit` up to 100. | **Resolved (approved)**: flat `{ data, pagination }`, `limit` 1-20. |
| R3 | Ticket error `code` was always `TICKETING_ERROR`. | **Resolved (approved)**: `VALIDATION_ERROR` (400), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `TENANT_NOT_FOUND`, `TENANT_INACTIVE`. |
| R4 | Reassigning an acknowledged ticket keeps status `acknowledged`, so the new assignee cannot acknowledge (acknowledge needs `open`). | Needs a product decision; documented. |
| R5 | Signup returns 409 `An account with those details already exists.` which confirms an account exists (enumeration). Login responses are uniform. | Inherent unless signup becomes email-verified; documented. |
| R6 | App does not set `trust proxy`. Behind a reverse proxy/PaaS every client shares the proxy IP for IP-keyed rate limits (login, signup, credential rotation, event delivery). | Deployment-dependent; needs the hosting topology. |
| R7 | `audit_logs` was protected only by the absence of write endpoints. | **Resolved (approved)**: migration 012 (append-only trigger), applied to Neon. |
| R8 | `GET /integrations/all/:tenant_id` returns an empty 200 for non-members instead of 404. | Not a data leak; documented. |
| R9 | `READ INVENTORY` and `GET TENANT INTEGRATIONS` audit every read (noise), and swallow audit errors. | Existing design decision; kept. |
| R10 | `HR` summary reads (`work-summary`) are not audited. | Documented; decision needed if HR data is sensitive. |
| R11 | Neon `DATABASE_URL` sits in a developer `.env` while DB tests refuse remote databases (good). The shared DB's migration state is unknown. | See `database-integrity.md`. |

## Already resolved / existing design decisions to preserve

- Origin allow-list instead of CSRF tokens, plus `SameSite` cookies (asserted by the existing Requestly collection in `tests/requestly`, which was not run here).
- Session regeneration on login, 6 h absolute lifetime, uniform 401 for bad login (with a timing-equalised bcrypt dummy for integrations).
- Tenant isolation by membership join; non-members get 404 (tenants, inventory, integrations).
- Transactional audit for business mutations (`composeAuditLogs(entry, client)`).
- Request-size limits (100 KB JSON, 10 KB form) and per-route rate limits.
- Error handler never returns internals; logs only error codes.
- Soft-deleted tenants, case-insensitive account uniqueness (migration 009), NOT VALID inventory tenant check (008).

## Approvals

Granted 2026-10-28 and carried out: ticketing contract changes (R1-R3), ticketing schema migration, ticket-audit backfill, append-only audit trigger, and `migrate:status` / baseline / apply against the shared Neon database (see `database-integrity.md`).

Still open:
1. Ownerless tenants and an active integration without a credential on Neon (need a business decision, see `database-integrity.md`); `VALIDATE CONSTRAINT inventory_tenant_required`.
2. `trust proxy` (R6) and dependency bumps: deferred by the owner.
