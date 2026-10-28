# Database migrations and data integrity

Status as of 2026-10-28. The shared Neon development database (`.env` `DATABASE_URL`, database `neondb`, PostgreSQL 18.6) was inspected read-only and then, with the owner's approval, migrated. See "Neon run log" below.

## Migration inventory

| File | Purpose | Re-runnable | Required by current code |
|---|---|---|---|
| `001_integration_event_worker.sql` | worker leasing columns | yes | yes (included in `baseline.sql`) |
| `002_integration_reliability.sql` | retry/attempt tracking | yes | yes (in baseline) |
| `003_integration_activity_retention.sql` | activity/diagnostic tables, retention | yes | yes (in baseline) |
| `004_align_event_registry_contracts.sql` | data-only: event registry rows | yes | yes |
| `005_tenant_creation_permission.sql` | `TENANTS_CREATE` permission | yes | yes (`POST /tenants/`) |
| `006_integration_manage_permission.sql` | `INTEGRATIONS_MANAGE` permission | yes | yes (all integration writes) |
| `007_tenant_audit_scope.sql` | `audit_logs.tenant_id`, `PLATFORM_AUDIT_READ` | yes | **yes**: `auditLog.js`, `composeAuditLogs`, `GET /audit/*` and every tenant-scoped audit insert (including the ticketing fix in this change) reference `audit_logs.tenant_id`. Without 007 almost every write endpoint fails with `column "tenant_id" does not exist`. |
| `008_inventory_tenant_required.sql` | `inventory_tenant_required` CHECK (NOT VALID) | yes | no (integrity only) |
| `009_case_insensitive_account_identity.sql` | unique indexes on `LOWER(email)`, `LOWER(username)` | yes, but aborts if case-insensitive duplicates exist | signup maps the violation to 409 |
| `010_ticketing_schema.sql` | **new**: ticketing tables, generated from the baseline, `IF NOT EXISTS` / named-constraint guards | yes | yes (`/ticketing/*`) |
| `011_backfill_ticket_audit_tenant.sql` | **new**: fills `tenant_id` on pre-fix ticket audit rows (NULL rows only) | yes | no (visibility of old rows) |
| `012_audit_log_append_only.sql` | **new**: trigger rejecting UPDATE/DELETE on `audit_logs` | yes | no (tamper resistance) |

`schema/baseline.sql` is a `pg_dump --schema-only` of the Neon development database taken 2026-10-27; its header states it already contains 001-003. It also contains every ticketing table (`tickets`, `ticket_assignments`, `ticket_comments`, `ticket_activity`, `ticket_inboxes`, `ticket_story_points`, `ticket_work_verifications`).

### Findings

1. **No migration created the ticketing tables** (they were created out-of-band in the development database and exist only in the baseline snapshot). Fixed by migration 010, which changes nothing where the tables already exist. Its from-scratch path (creating all tables) has **not** been exercised: no scratch PostgreSQL was available, and it is a no-op on Neon.
2. **There was no migration runner or applied-version table.** Whether 005-009 are applied to any given database cannot be known from the repository; existence of a table is not proof (007 and 009 are idempotent and may be half-applied by hand). `scripts/migrate.mjs` now provides tracking (below).
3. The integration-test harness (`testDatabase.js`) rebuilds a `*_test` database from `baseline.sql` plus all migrations in order, which also proves every migration is re-runnable. This could **not** be executed here (no local PostgreSQL). `scripts/migrations/plan.test.mjs` checks file numbering and the absence of destructive statements instead.
4. `TICKET_HR_READ` (used by `GET /ticketing/tenants/:tenantId/work-summary/:userId`) is not seeded by any migration. Today only the employee or a manager can read a summary.

## The migration runner

```
npm run migrate:status                                   # read-only
npm run migrate:apply                                    # dry run only
node scripts/migrate.mjs apply --execute --confirm-database <db name>
node scripts/migrate.mjs baseline --through 009 --confirm-database <db name>   # record, do not run
```

- Tracks `schema_migrations(version, name, checksum, applied_at)`; refuses to apply when a recorded file changed (drift) or went missing; warns about out-of-order pending versions.
- Each migration and its tracking row commit in one transaction under an advisory lock; a failure rolls back and stops.
- `status` never writes (it does not even create the table). `apply` is a dry run unless `--execute` **and** the exact connected database name are given.
- Its planning logic is unit-tested (`scripts/migrations/plan.test.mjs`). The execution path ran for real once, against Neon (log below); there is no automated test for it.

## Neon run log (2026-10-28)

Read-only inspection first (`SET default_transaction_read_only = on`), then:

| Step | Result |
|---|---|
| `migrate:status` | `schema_migrations` absent; target printed as the `neondb` Neon host |
| Pre-state | 006, 007 (column, FK, index, permission), 008 (constraint, not validated), 009 (both indexes) already in effect; ticketing tables present; **`TENANTS_CREATE` permission missing, i.e. 005 had never been applied** (the code requires it, so `POST /tenants/` was returning 403 for everyone); 4 ticket audit rows with `tenant_id` NULL; 0 tenantless inventory rows; 0 case-insensitive duplicate users |
| `baseline --through 003 --confirm-database neondb` | recorded 001-003 without executing (they are in the snapshot taken from this database) |
| `apply --execute --confirm-database neondb` | applied 004-012, all succeeded |
| Post-state | `TENANTS_CREATE` granted to role `dev` (as 005 intends); the 4 ticket audit rows now have `tenant_id` 2; trigger `audit_logs_append_only` present; an `UPDATE` on `audit_logs` is rejected (tested inside a rolled-back transaction) and `INSERT` still works; ticket tables untouched (2 tickets, 4 activity rows) |

Migrations 006-009 were re-run although already in effect; they are idempotent and changed nothing.

## Still open on Neon (needs a business decision, not run)

| Finding (read-only, 2026-10-28) | Needed |
|---|---|
| Tenants `2` and `3` had no owner | **Done 2026-10-28**: seeded user `seedowner` (id 7, role `dev`) as owner of both, with `ADD TENANT MEMBER` audit rows. Change its password and reassign ownership when a real owner is known. |
| Integration `2` (tenant 3) was `active` with no credential | **Done 2026-10-28**: credential rotated by an operator script (hash stored, lifecycle + `ROTATE INTEGRATION CREDENTIAL` audit row, no secret logged). The one-time secret went to a local file, not the repo. |
| Tenantless inventory: 0 | **Done 2026-10-28**: `inventory_tenant_required` validated (run directly, not as a migration, because the test harness inserts legacy rows to test the NOT VALID behaviour) |
| 0 disabled/deleted accounts hold memberships | none |

## Read-only verification queries

```sql
-- Is each migration's effect present?
SELECT name FROM permissions WHERE name IN ('TENANTS_CREATE','INTEGRATIONS_MANAGE','PLATFORM_AUDIT_READ','TICKET_HR_READ');
SELECT column_name FROM information_schema.columns WHERE table_name='audit_logs' AND column_name='tenant_id';
SELECT conname, convalidated FROM pg_constraint WHERE conname IN ('inventory_tenant_required','audit_logs_tenant_id_fkey');
SELECT indexname FROM pg_indexes WHERE indexname IN ('users_email_lower_key','users_username_lower_key','audit_logs_tenant_time_idx');
SELECT to_regclass('public.tickets'), to_regclass('public.schema_migrations');
```

## Data-integrity concerns (verify, then decide)

The earlier audit (`db/reconciliation/2026-10-28-legacy-data.md`) records these against the shared development database; they were **not re-measured** now. Re-check with the read-only queries in that file.

| Concern | Remediation (not executed) |
|---|---|
| Tenantless `inventory` rows (2 on 2026-10-28) | Manual assignment or removal per the reconciliation doc, then `VALIDATE CONSTRAINT inventory_tenant_required` |
| A tenant with no owner (1) | Pick an owner and insert the `tenant_members` row (reconciliation doc, section 2) |
| Active integrations without a credential | Suspend or rotate the credential via the API; see the reconciliation doc |
| Disabled accounts still holding memberships / employee mappings | Review: `SELECT tm.tenant_id, tm.user_id FROM tenant_members tm JOIN users u ON u.id=tm.user_id WHERE u.is_disabled OR u.deleted_at IS NOT NULL;` The API does not remove them automatically; ticket assignment refuses inactive users (`ensureTenantUser`), but existing assignments remain. |
| Role/permission mappings | `SELECT r.name, p.name FROM roles r JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id ORDER BY 1,2;` New accounts are created with **no role** (`signupUserService` does not set `role_id`), so they hold no permissions until an operator assigns one. |
| Ticket audit rows written before this fix have `tenant_id = NULL` | Optional backfill below. Needs approval. |

### Ticket audit backfill

Done by migration 011 (4 rows on Neon). Safe to re-run; it only touches rows whose `tenant_id` is NULL.

## Remaining approvals

Ownerless tenants, the credential-less integration and `VALIDATE CONSTRAINT` above; `trust proxy` is deferred.
