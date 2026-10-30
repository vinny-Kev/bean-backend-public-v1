# Bean Enterprise Management System: backend

Express 5 + PostgreSQL API (sessions in PostgreSQL, ES modules, Node >= 20).

## Local setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill it in. Use a local PostgreSQL (`DB_HOST`, `DB_NAME`, ...) and leave `DATABASE_URL` empty. **Never run tests or the Postman collection against a shared or production database.**
3. Create the schema (see "Migrations"), then `npm run dev` (listens on `http://127.0.0.1:3000` by default).

## Identity, email and onboarding

Registration requires email verification (6-digit code by email), sign-in from an unrecognised browser needs an emailed code, and password reset, email change, invitations and ownership transfer are email-confirmed. Read `docs/identity/identity-backend.md` (contract, security model, migrations 013-016, configuration).

- **Local development**: leave `MAIL_TRANSPORT=outbox` (the default outside production). Every email is written to `.mail-outbox/` (gitignored) so you can read the code or link. Nothing is sent.
- **Real delivery**: `MAIL_TRANSPORT=smtp` plus `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM_ADDRESS`, `APP_BASE_URL` (see `.env.example`; keep credentials in the deployment's secret store).
- **Tests**: mail goes to an in-memory capture transport.

## Health checks

| Path | Meaning | Auth |
|---|---|---|
| `GET /health` | Liveness: process is serving HTTP (`{"status":"ok"}`); never touches the database | none |
| `GET /health/ready` | Readiness: `SELECT 1` with a 2 s timeout. `200 {"status":"ok","checks":{"database":"ok"}}` or `503 {"status":"unavailable","checks":{"database":"unavailable"}}` | none |

Both are public, return no internals, are never audited and are `Cache-Control: no-store`. Use `/health` for process liveness and `/health/ready` for load-balancer readiness.

## Tests

```
npm test                 # every unit/HTTP test that needs no database (77+ tests)
npm run test:db          # PostgreSQL-backed suite (scripts/run-db-tests.mjs): runs against a scratch database whose name ends in _test
                         #   (default <your server>/bean_test; the real database named in .env is never rebuilt)
npm run check:api        # every registered route is in the API spec and the Postman collection
npm run audit:deps       # npm audit for production dependencies
```

DB tests rebuild the `public` schema, so the harness refuses any database whose name does not end in `_test`. `npm run test:db` takes the server from `DATABASE_URL`, swaps the database name for `bean_test` (create it once with `CREATE DATABASE bean_test`) and sets the flag that allows a hosted scratch database. With local settings (`DATABASE_URL` empty, `DB_HOST` local, `DB_NAME` ending in `_test`) run `node --test --test-concurrency=1 "src/**/*.db.test.js"` directly.

## Migrations

```
npm run migrate:status                                              # read-only
npm run migrate:apply                                               # dry run
node scripts/migrate.mjs apply --execute --confirm-database <name>  # real run, needs the exact DB name
```

The runner tracks `schema_migrations` and refuses on drift. Migrations 001-012 are recorded on the shared Neon database. `012` makes `audit_logs` append-only. Read `docs/qa/database-integrity.md` before pointing it at an existing database (use `baseline` for versions already applied by hand).

## API documentation and Postman

- Reference: `docs/api/API_REFERENCE.md`. Collection: `postman/Bean-Enterprise-Management.postman_collection.json`. Environment template: `postman/Bean-Local.postman_environment.json.example`.
- Both are **generated** from `scripts/api-docs/spec/*.mjs`: edit the spec, then `npm run docs:api`. `npm test` fails if the committed files drift from the spec or a route is undocumented.
- Import the collection and the environment template into Postman, fill `userEmail`, `userPassword`, `signupPassword`, `inviteEmail` in your environment (never commit them), and run the folders in order: Health, Authentication, Tenants, Inventory, Audit, Integrations, Tickets. Postman's cookie jar keeps the `bean.sid` session; non-GET requests send `Origin: {{origin}}` (must equal an `APP_ORIGINS` entry).
- Many requests need account permissions that only a database operator can assign (accounts start with no role). `tests/requestly/` contains a seeded end-to-end suite with its own fixtures for a disposable `*_test` database.

## Further reading

`docs/CODING_STANDARDS.md`, `docs/qa/` (initial findings, audit coverage, database integrity, endpoint coverage, final report).
