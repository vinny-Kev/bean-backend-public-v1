# Backend coding standards

These describe the conventions the codebase already follows (most of it) and the ones applied to the ticketing module. There is deliberately **no new linter or formatter dependency**: `.editorconfig` covers whitespace, and the rules below are checked in review.

## Formatting

- 4-space indentation, LF line endings, UTF-8, final newline (`.editorconfig`; JSON/YAML use 2 spaces).
- Single quotes, semicolons, trailing commas in multi-line literals, max line length about 140.
- ES modules only (`import`/`export`, explicit `.js` extensions). Group imports: Node built-ins, packages, then relative modules.
- The ticketing module was reformatted once to this style (`npx prettier --single-quote --tab-width 4 --print-width 140 --trailing-comma all`, run ad hoc, not a dependency). Other modules were left untouched to avoid noisy diffs.

## Naming

- Files: `camelCase.js` for modules, `*.routes.js` for routers, `*.test.js` / `*.test.mjs` for tests, `*.db.test.js` for PostgreSQL-backed tests.
- Variables/functions `camelCase`; constants `UPPER_SNAKE` only for frozen lookup tables.
- JSON request/response fields `camelCase`; database columns `snake_case`; map explicitly at the boundary.
- Route params in the existing modules use `snake_case` (`:tenant_id`); ticketing uses `camelCase` (`:tenantId`). Kept as-is (public paths are not renamed).

## Layering

Route (middleware chain) → authentication/authorization → validation → handler/service → SQL → response.

- Routers only wire middleware; business rules live in services.
- Tenant authority comes from `tenant_members`, never from the request body. A URL tenant ID only *selects* the tenant.
- Every tenant-scoped query includes `tenant_id`.
- Use `pool.query` for single reads; use a client with `BEGIN`/`COMMIT`/`ROLLBACK` (always `release()` in `finally`) for multi-statement writes.
- Every state-changing business operation writes its audit row **in the same transaction** (`composeAuditLogs(entry, client)`), with `tenantId` set unless the event is account-level.
- Never put request bodies, headers, passwords, cookies or credentials into audit data.

## Validation and errors

- Validate before touching the database; reject unknown keys on write endpoints that take small bodies; IDs must be string or safe-integer scalars (`parsePositiveId`, ticketing `idValue`).
- Errors: `{ "error": { "code", "message" } }` for new code. Older modules return `{ "message" }`; both shapes are documented in `docs/api/API_REFERENCE.md` and must not be changed without a client migration.
- Unexpected errors go to `next(error)`; the central handler returns a generic 500 with `requestId`. Never return SQL, stack traces or file paths.
- Async handlers wrap their body in `try/catch` and call `next`.

## Logging

- Structured one-line JSON for errors (`{ level, event, requestId, ... }`) without messages or payloads. Breadcrumb `console.log` lines are limited to the existing middleware chain.

## Tests

- Pure logic: `*.test.js` beside the code. HTTP behavior without a database: replace `pool.query`/`pool.connect` on the shared pool (see `src/ticketing/ticketing.test.mjs`); do not rely on Node's experimental module mocks, which differ between Node versions.
- Anything touching real SQL: `*.db.test.js` against a local `*_test` database only.
- A new or changed endpoint needs: a spec entry in `scripts/api-docs/spec/`, `npm run docs:api`, and a passing `npm run check:api`.
