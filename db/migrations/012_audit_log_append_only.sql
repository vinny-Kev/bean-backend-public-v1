-- Approved 2026-10-28.
--
-- Makes audit_logs append-only at the database level: no application code path (and no
-- compromised session) can UPDATE or DELETE audit rows. The application only ever INSERTs and SELECTs
-- audit_logs (verified by grep in docs/qa/audit-coverage.md).
--
-- Not covered: TRUNCATE (the integration test fixtures truncate audit_logs, so no TRUNCATE trigger is
-- proposed) and a superuser/table owner who can drop the trigger. For real tamper resistance also
-- run the application as a role without UPDATE/DELETE/TRUNCATE on audit_logs:
--     REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM <application_role>;
--
-- Idempotent. Review in a transaction first:  BEGIN;  \i this file;  -- test an UPDATE;  ROLLBACK;
CREATE OR REPLACE FUNCTION audit_logs_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs;
CREATE TRIGGER audit_logs_append_only
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_change();
