-- Ticket audit rows written before the tenant_id fix have tenant_id NULL, so tenant owners and
-- admins could not see them in GET /audit/tenants/:tenant_id. Fill the tenant from the ticket or
-- inbox the row refers to. Only NULL rows are touched, each is filled from its own record, and
-- re-running changes nothing. Must run before 012 (audit_logs becomes append-only).
UPDATE audit_logs a SET tenant_id = t.tenant_id
FROM tickets t
WHERE a.tenant_id IS NULL AND a.table_name = 'tickets' AND a.record_id = t.id AND a.action LIKE 'TICKET\_%';

UPDATE audit_logs a SET tenant_id = i.tenant_id
FROM ticket_inboxes i
WHERE a.tenant_id IS NULL AND a.table_name = 'ticket_inboxes' AND a.record_id = i.id AND a.action LIKE 'TICKET\_%';
