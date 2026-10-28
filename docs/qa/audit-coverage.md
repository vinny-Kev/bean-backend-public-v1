# Audit coverage

The audit trail is the `audit_logs` table (`user_id`, `tenant_id`, `action`, `table_name`, `record_id`, `old_data`, `new_data`, `created_at`), written through `composeAuditLogs`. Business mutations pass the open transaction client, so the change and its audit row commit or roll back together. Request/correlation IDs are not stored in `audit_logs` (the integration lifecycle and diagnostics tables do store them).

## Matrix

| Area | Action recorded | Transactional with the change | Automated test |
|---|---|---|---|
| Signup | `SIGNUP` (actor = new user; no email or password) | **yes (added)** | `src/auth/authAudit.test.js` |
| Login success | `LOGIN_SUCCESS` | no (written after the session is saved; a failure returns 500) | `authAudit.test.js` |
| Login failure, existing account | `LOGIN_FAILURE` (no credentials) | n/a, best effort | `authAudit.test.js` |
| Login failure, unknown email | not recorded, deliberately (anonymous guessing must not grow the table) | n/a | `authAudit.test.js` |
| Logout | `LOGOUT` | n/a, best effort (never blocks logout) | `authAudit.test.js` |
| Tenant create | `CREATE TENANT` | yes | Requestly collection (not run) |
| Member add / role change / remove | `ADD TENANT MEMBER`, `UPDATE TENANT MEMBER ROLE`, `REMOVE TENANT MEMBER` | yes | Requestly collection, DB tests (not run) |
| Inventory create / update | `CREATE INVENTORY`, `UPDATE INVENTORY` | yes | DB tests (not run) |
| Inventory read | `READ INVENTORY` | no, best effort, errors swallowed | DB tests (not run) |
| Integration register, subscriptions, user mapping, activate, suspend, disconnect | `CREATE INTEGRATION`, `UPDATE INTEGRATION SUBSCRIPTIONS`, `UPDATE INTEGRATION USER MAPPING`, `ACTIVATE/SUSPEND/DISCONNECT INTEGRATION` plus lifecycle activity | yes | DB tests (not run) |
| Credential rotation | `ROTATE INTEGRATION CREDENTIAL` (no secret) plus lifecycle (failures too) | yes | DB tests (not run) |
| Inventory shortage policy | `UPDATE INTEGRATION INVENTORY POLICY` | yes | DB tests (not run) |
| Manual event retry | `RETRY INTEGRATION EVENT` | yes | DB tests (not run) |
| Integration list read | `GET TENANT INTEGRATIONS` (when rows are returned) | no, best effort | DB tests (not run) |
| Event ingestion | `integration_event_diagnostics` row (not `audit_logs`) | yes | DB tests (not run) |
| Worker | `PROCESS INTEGRATION EVENT`, `FAIL INTEGRATION EVENT`, `RECOVER INTEGRATION EVENT LEASE` | yes | DB tests (not run) |
| Tickets: create, assign, acknowledge, status, comment, estimate, verify, revoke, inbox create | `TICKET_CREATE`, `TICKET_ASSIGN`, `TICKET_ACKNOWLEDGE`, `TICKET_STATUS`, `TICKET_COMMENT`, `TICKET_ESTIMATE`, `TICKET_VERIFY`, `TICKET_VERIFY_REVOKE`, `TICKET_INBOX_CREATE` | yes | `src/ticketing/ticketing.test.mjs` (tenant id, ordering, rollback on audit failure) |
| Health probes | none, deliberately | n/a | `src/health/health.test.js` |

## Fixes made

- **Ticket audit rows now carry `tenant_id`**; before, they were invisible to tenant owners and admins.
- Signup, logout and failed login are now audited.

## Gaps and limitations (not fixed)

- No role/permission-change, tenant-rename or tenant-status endpoints exist, so there is nothing to audit; roles are assigned in the database.
- Read endpoints are not audited except the inventory and integration lists. `work-summary` (HR-style data) reads are not audited; decide whether they should be.
- `LOGIN_SUCCESS` is written after the session is saved and is not atomic with it; if the audit write fails, login returns 500 but the session already exists.
- Refused operations (403/404/409) are not audited, except integration activation refusals and failed credential rotations (lifecycle table).
- Pre-fix ticket audit rows were backfilled with `tenant_id` by migration 011 (4 rows on Neon).
- Immutability: the application issues no `UPDATE`/`DELETE` on `audit_logs` (repository grep), and migration 012 (applied to Neon) makes the database reject both. Not covered: `TRUNCATE`, and a table owner/superuser who drops the trigger; for full protection run the app as a role without UPDATE/DELETE/TRUNCATE on `audit_logs`.
- Sensitive data: audit payloads are built from explicit fields (no request bodies, headers, passwords, cookies or credentials). The integration history endpoint additionally runs `sanitizeAuditData`. `GET /audit/*` returns raw `old_data`/`new_data`, so any new audit writer must keep to that rule.
- Duplicates: none found; services write the audit rows and no middleware does.
