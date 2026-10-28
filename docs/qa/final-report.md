# Final QA report (2026-10-28)

Branch `kevin-dev` from commit `b9e4bb3`. Nothing is committed; all code changes are in the working tree for review. **Update (same day, after approval):** ticketing contract changes were made and migrations 010-012 were applied to the shared Neon database (section 9). Companion documents: `initial-findings.md`, `audit-coverage.md`, `database-integrity.md`, `endpoint-coverage.md`, `../api/API_REFERENCE.md`, `../CODING_STANDARDS.md`.

## 1. What was inspected

Entry point and config, all route files and the services/middleware behind them (auth, tenants, inventory, audit, integrations, ticketing), audit writing, session/origin/permission/rate-limit middleware, error handler, validation utilities, migrations 001-009 and `baseline.sql`, existing tests (including `tests/requestly`), `package.json`, and `npm audit`. No database was contacted (see section 12).

## 2. What changed

| Area | Change | Files |
|---|---|---|
| Ticketing defect | Audit rows now include `tenant_id` | `src/ticketing/services/ticketShared.js` |
| Ticketing hardening | IDs/points must be strings or safe integers (arrays, objects, unsafe integers rejected instead of coerced) | `ticketShared.js` |
| Ticketing tests | Rewritten without Node-version-specific module mocks; 29 cases | `src/ticketing/ticketing.test.mjs` |
| Formatting | Ticketing code reformatted to the project style (no logic change) | `src/ticketing/**` |
| Health | `GET /health` (liveness), `GET /health/ready` (database readiness, 503 on failure) | `src/health/`, `src/server.js` |
| Audit | `SIGNUP` (transactional), `LOGOUT`, `LOGIN_FAILURE` | `src/auth/services/*`, `src/middleware/auth/authMiddleware.js`, `src/auth/authAudit.test.js` |
| API docs | Single endpoint spec, generated Postman collection (58 requests), environment template, API reference, coverage check, guard tests | `scripts/api-docs/`, `postman/`, `docs/api/` |
| Ticketing contract (approved) | Non-members get 404 `TENANT_NOT_FOUND`; inactive tenant 409 `TENANT_INACTIVE`; flat `{ data, pagination }` list with `limit` 1-20; specific error codes (`VALIDATION_ERROR`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`) | `src/ticketing/**`, spec |
| Migrations | Tracking runner; 010 ticketing schema, 011 ticket-audit backfill, 012 append-only `audit_logs` trigger | `scripts/migrate.mjs`, `scripts/migrations/`, `db/migrations/010-012` |
| Standards/docs | `.editorconfig`, coding standards, README, QA documents, npm scripts | repo root, `docs/` |

## 3. Deliberately left unchanged (and why)

- Public endpoint paths and the contracts of non-ticketing modules (clients may depend on them). The ticketing contract was changed with your approval.
- The two error-shape conventions (`{message}` and `{error:{code,message}}`): documented in the API reference rather than merged; permission failures already carry both.
- Per-read audit rows for inventory/integration lists, signup's 409 message, origin-allow-list CSRF design.
- Dependencies and `package-lock.json`: `npm audit` reports 0 vulnerabilities, so no change was needed or made.
- No linter/formatter dependency was added.
- The existing Requestly collection in `tests/requestly/` (separate seeded E2E suite).

## 4. Endpoints

58 registered (discovered from `src/server.js` and the router files), 58 documented in Postman, 0 missing, 0 duplicates, 0 undocumented-auth. Per module: health 2 (new) + inventory route check 1, auth 4, tenants 8, inventory 3 more (list/create/update), audit 2, integrations 20, ticketing 18. Six requests have state-dependent outcomes (listed in `endpoint-coverage.md`); one example (`analytics`) abbreviates a sub-object.

## 5. Ticket-management defects

Found and fixed: missing `tenant_id` in audit rows (D1), non-portable broken test (D2), lenient ID/points coercion (D4), formatting drift (D5). Fixed with your approval: 403 vs 404 for non-members (now 404, plus 409 for inactive tenants), nested list response and `limit` up to 100 (now flat, max 20), constant error code (now status-specific), missing ticketing migration (010). Documented, **not** changed: acknowledge after reassignment, no duplicate-submission guard on ticket creation, HR summary reads unaudited. Concurrency: status, assignment, estimate and verification paths lock the ticket row (`FOR UPDATE`); that locking is by code reading only (needs a real PostgreSQL to prove).

## 6. Coding standard

`.editorconfig` and `docs/CODING_STANDARDS.md` record the conventions; the one clearly divergent module (ticketing) was brought into line.

## 7. Audit improvements

See `audit-coverage.md`: ticket tenant scoping fixed; signup, logout and failed login added; limitations listed (non-atomic login audit, unaudited reads/refusals, no database-level immutability yet).

## 8. Health endpoint behavior

`GET /health` -> `200 {"status":"ok"}` (no database). `GET /health/ready` -> `200 {"status":"ok","checks":{"database":"ok"}}`, or `503 {"status":"unavailable","checks":{"database":"unavailable"}}` after a failed or 2 s-timed-out `SELECT 1`. Public, no session/origin, `Cache-Control: no-store`, mounted before CORS/sessions, no audit.

## 9. Migration and data-integrity findings

Run against Neon (`neondb`) with approval; full log in `database-integrity.md`. Read-only inspection first, then `baseline --through 003` and `apply` of 004-012: all succeeded. Findings: migration 005 had never been applied, so `TENANTS_CREATE` did not exist and tenant creation was failing for every account; it is now granted to role `dev` as 005 intends. 4 ticket audit rows backfilled to tenant 2. `audit_logs` is now append-only (UPDATE rejected, verified in a rolled-back transaction). Still open, needing your decision: tenants 2 and 3 have no owner, integration 2 is active without a credential, and `VALIDATE CONSTRAINT inventory_tenant_required` can now be run (0 tenantless rows). The from-scratch path of migration 010 was not exercised (no scratch PostgreSQL; it is a no-op on Neon).

## 10. Dependency and security findings

- `npm audit`: 0 vulnerabilities (body-parser 2.4.0, ajv 8.20.0, qs 6.17.0, ip-address 10.7.5 installed): the earlier advisories are **resolved**. Available non-security bumps: express 5.3.0, express-rate-limit 8.7.1, dotenv 18.0.9 (patch/minor), ajv-formats 3.x (major). Not applied.
- Public ingestion endpoint: 100 KB `strict` JSON limit, 120 requests/min/IP, schema complexity limits, bcrypt-verified credentials with timing equalisation. Other request-size limits: 100 KB JSON, 10 KB form.
- Reviewed with no defect found by reading: session fixation, session lifetime, origin check, permission and tenant checks, mass assignment on write endpoints, parameterised SQL everywhere, error disclosure.
- Open: signup enumeration (409), no `trust proxy` (rate limits key on the proxy IP behind a proxy), ticket 403-vs-404 probing, audit table not append-only at the database level.
- **Not** done: no penetration or load testing, and no replay of the Postman collection (no running backend/database).

## 11. Tests actually executed

Run with `DATABASE_URL=` blanked so nothing could reach the shared database.

| Check | Result |
|---|---|
| `npm test` (before) | 23 pass, 1 fail (ticketing test, pre-existing) |
| `npm test` (after) | **77 pass, 0 fail, 0 skipped** (32 ticketing, 9 auth-audit, 5 health, 4 API-docs guards, 4 migration-planner, plus the 23 pre-existing) |
| `npm run check:api` | 58/58, no gaps |
| `npm audit` | 0 vulnerabilities |
| Collection JSON validity | structurally validated by `scripts/api-docs/apiDocs.test.mjs` (Postman v2.1 fields, valid JSON bodies, Origin header on unsafe methods, no secrets). Not validated against the official JSON schema (offline) and **not executed in Postman/newman** |
| `npm run test:db` (`*.db.test.js`) | **Blocked**: registers 0 tests; no local PostgreSQL `*_test` database exists on this machine |
| `scripts/migrate.mjs` | Planning logic unit-tested; execution path ran for real against Neon (status, baseline, apply: all succeeded), no automated test |
| Requestly suite in `tests/requestly` | **Not run** (needs a running backend and seeded `*_test` database) |
| Lint / type check | none configured |

No regressions were introduced by these changes in any check that could run.

## 12. Actions requiring your approval

None open. Deferred by you: `trust proxy` and dependency bumps. Follow-up: replace the seeded owner `seedowner` with a real owner.

## 13. Reproduce the verification

```
cd backend
DATABASE_URL= npm test
npm run check:api
npm audit
npm run docs:api   # regenerates postman/ and docs/api/; the apiDocs test in npm test fails if committed files drift
# needs a local PostgreSQL database named <something>_test, DATABASE_URL empty:
npm run test:db
```

## 14. Remaining manual steps

- Provision a local `*_test` PostgreSQL, run `npm run test:db` and the Requestly suite, then run the Postman collection folder by folder (requires seeded roles/permissions).
- Restart/redeploy the backend so it runs the new ticketing contract and audit changes (the database is already migrated), then use `/health/ready` as the readiness probe and `/health` as liveness.
- Review and commit; nothing was committed or deployed.
