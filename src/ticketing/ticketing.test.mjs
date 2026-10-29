// Run: node --test src/ticketing/ticketing.test.mjs
// HTTP-level tests of the ticketing router against a fake database. The shared pool's
// query/connect methods are replaced, so nothing here ever opens a PostgreSQL connection.
// (module mocking is avoided on purpose: its API differs between Node 20, 22 and 24.)
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.DATABASE_URL = '';
process.env.SESSION_SECRET ||= 'test-session-secret-0123456789abcdefghij';
process.env.DB_HOST ||= 'localhost';
process.env.DB_NAME ||= 'bean_test';
process.env.DB_USER ||= 'test';
process.env.DB_PASSWORD ||= 'test';

const { pool } = await import('../db/pool.js');
const { default: routes } = await import('./routes/ticket.routes.js');
const { errorHandler, notFoundHandler, requestContext } = await import('../middleware/errorMiddleware.js');

let role;
let authenticated;
let failAudit;
let tenantStatus;
let ticket;
const queries = [];

const baseTicket = () => ({
    id: '7', tenant_id: '2', ticket_number: '13', title: 'Printer broken',
    description: null, ticket_type: 'support', status: 'open', priority: 'medium',
    requester_user_id: '3', inbox_id: null, assigned_to_user_id: null,
    created_by_user_id: '3', parent_ticket_id: null, due_at: null,
    acknowledged_at: null, resolved_at: null, closed_at: null,
    created_at: new Date(), updated_at: new Date(),
});

const query = async (sql, params = []) => {
    if (/FROM users\s+WHERE id/.test(sql)) {
        return { rows: [{ id: 3, username: 'tester', email: 'tester@example.test', role_id: 1 }] };
    }
    queries.push({ sql, params });
    if (sql.includes('FROM tenant_members tm JOIN tenants t')) {
        return { rows: role ? [{ membership_role: role, status: tenantStatus }] : [] };
    }
    if (sql.includes('FROM tenant_members tm JOIN users u')) return { rows: [{}] };
    if (sql.includes('SELECT * FROM tickets')) return { rows: ticket ? [ticket] : [] };
    if (sql.includes('INSERT INTO tickets') || sql.includes('UPDATE tickets')) return { rows: [{ ...(ticket ?? baseTicket()) }] };
    if (sql.includes('COUNT(*)')) return { rows: [{ total: 0 }] };
    if (sql.includes('FROM ticket_assignments')) return { rows: [] };
    if (sql.includes('INSERT INTO ticket_comments')) {
        return { rows: [{ id: '1', author_user_id: '3', body: params[3], is_internal: params[4], created_at: new Date(), updated_at: new Date() }] };
    }
    if (sql.includes('INSERT INTO audit_logs') && failAudit) throw new Error('audit write failed');
    if (sql.includes('COUNT(*)')) return { rows: [{ total: 0 }] };
    return { rows: [] };
};
pool.query = query;
pool.connect = async () => ({ query, release() {} });

let server;
let base;
before(async () => {
    const app = express();
    app.use(requestContext);
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = authenticated ? { userId: 3, authenticatedAt: Date.now(), destroy: (done) => done() } : {};
        next();
    });
    app.use('/ticketing', routes);
    app.use(notFoundHandler);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => {
    role = 'member'; tenantStatus = 'active'; authenticated = true; failAudit = false; ticket = baseTicket(); queries.length = 0;
});

const call = (method, path, body) => fetch(`${base}/ticketing/tenants/2${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
});
const verbs = (list) => list.map(({ sql }) => sql.trim().split(/\s+/).slice(0, 3).join(' '));
const auditInserts = () => queries.filter(({ sql }) => sql.includes('INSERT INTO audit_logs'));

test('unauthenticated requests are rejected before any ticket query', async () => {
    authenticated = false;
    const response = await call('GET', '/tickets');
    assert.equal(response.status, 401);
    assert.equal(queries.length, 0);
});

test('tenant membership is required before any ticket query', async () => {
    role = null;
    const response = await call('GET', '/tickets');
    assert.equal(response.status, 404, 'indistinguishable from a missing tenant');
    assert.equal((await response.json()).error.code, 'TENANT_NOT_FOUND');
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /FROM tenant_members tm JOIN tenants t/);
});

test('members of an inactive tenant get 409 TENANT_INACTIVE', async () => {
    tenantStatus = 'suspended';
    const response = await call('GET', '/tickets');
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'TENANT_INACTIVE');
});

test('list responses are flat { data, pagination } and limit is capped at 20', async () => {
    const response = await call('GET', '/tickets?limit=20');
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(body.data));
    assert.equal(body.pagination.limit, 20);
    assert.equal((await call('GET', '/tickets?limit=21')).status, 400);
});

test('ticket lookups are scoped to the caller tenant (cross-tenant IDs behave as missing)', async () => {
    ticket = null;
    const response = await call('GET', '/tickets/7');
    assert.equal(response.status, 404);
    const lookup = queries.find(({ sql }) => sql.includes('SELECT * FROM tickets'));
    assert.match(lookup.sql, /tenant_id = \$1 AND id = \$2/);
    assert.deepEqual(lookup.params, ['2', '7']);
});

test('malformed IDs are rejected without touching ticket tables', async () => {
    for (const path of ['/tickets/abc', '/tickets/0', '/tickets/1.5', '/tickets/9223372036854775808']) {
        queries.length = 0;
        const response = await call('GET', path);
        assert.equal(response.status, 400, path);
        assert.equal(queries.length, 1, `${path} only ran the membership check`);
    }
});

test('create ticket validates the payload', async () => {
    const invalid = [
        [{}, 'missing title'],
        [{ title: '   ' }, 'blank title'],
        [{ title: 42 }, 'non-text title'],
        [{ title: 'x'.repeat(251) }, 'overlong title'],
        [{ title: 'ok', ticketType: 'epic' }, 'unknown type'],
        [{ title: 'ok', priority: 'asap' }, 'unknown priority'],
        [{ title: 'ok', dueAt: 'tomorrow-ish' }, 'bad due date'],
        [{ title: 'ok', inboxId: 'abc' }, 'bad inbox id'],
        [['title'], 'array body'],
    ];
    for (const [body, label] of invalid) {
        queries.length = 0;
        const response = await call('POST', '/tickets', body);
        assert.equal(response.status, 400, label);
        assert.equal(queries.some(({ sql }) => sql.includes('INSERT INTO tickets')), false, label);
    }
});

test('member cannot create a ticket on behalf of another user', async () => {
    const response = await call('POST', '/tickets', { title: 'Printer broken', requesterUserId: '4' });
    assert.equal(response.status, 403);
    assert.equal(queries.length, 1);
});

test('manager ticket creation commits activity and a tenant-scoped audit entry in one transaction', async () => {
    role = 'admin';
    const response = await call('POST', '/tickets', { title: 'Printer broken' });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).data.title, 'Printer broken');
    assert.deepEqual(verbs(queries), [
        'SELECT tm.membership_role, t.status', 'BEGIN', 'SELECT 1 FROM',
        'INSERT INTO tickets', 'INSERT INTO ticket_activity', 'INSERT INTO audit_logs', 'COMMIT',
    ]);
    const [audit] = auditInserts();
    assert.match(audit.sql, /\(user_id, tenant_id, action/);
    assert.deepEqual(audit.params.slice(0, 4), ['3', '2', 'TICKET_CREATE', 'tickets']);
});

test('failed audit rolls back the ticket and history', async () => {
    role = 'admin';
    failAudit = true;
    const response = await call('POST', '/tickets', { title: 'Printer broken' });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error.code, 'INTERNAL_SERVER_ERROR');
    assert.equal(queries.at(-1).sql, 'ROLLBACK');
    assert.equal(queries.some(({ sql }) => sql === 'COMMIT'), false);
});

test('list tickets rejects invalid pagination and filters', async () => {
    for (const search of ['?limit=21', '?limit=0', '?page=0', '?page=abc', '?status=bogus', '?ticketType=bogus']) {
        const response = await call('GET', `/tickets${search}`);
        assert.equal(response.status, 400, search);
    }
});

test('members only list tickets they are involved in; managers list all', async () => {
    await call('GET', '/tickets');
    const memberList = queries.find(({ sql }) => sql.includes('SELECT t.* FROM tickets'));
    assert.equal(memberList.params[1], false);
    queries.length = 0;
    role = 'owner';
    await call('GET', '/tickets');
    assert.equal(queries.find(({ sql }) => sql.includes('SELECT t.* FROM tickets')).params[1], true);
});

test('a member cannot read a ticket they are not involved in (indistinguishable from missing)', async () => {
    ticket = { ...baseTicket(), requester_user_id: '9', created_by_user_id: '9' };
    const response = await call('GET', '/tickets/7');
    assert.equal(response.status, 404);
});

test('only managers can assign tickets', async () => {
    const response = await call('POST', '/tickets/7/assignments', { userId: '4' });
    assert.equal(response.status, 403);
    assert.equal(queries.some(({ sql }) => sql.includes('UPDATE tickets')), false);
});

test('assignment validates the payload and refuses finished tickets', async () => {
    role = 'admin';
    assert.equal((await call('POST', '/tickets/7/assignments', {})).status, 400);
    assert.equal((await call('POST', '/tickets/7/assignments', { userId: 'x' })).status, 400);
    ticket = { ...baseTicket(), status: 'closed' };
    assert.equal((await call('POST', '/tickets/7/assignments', { userId: '4' })).status, 409);
});

test('assignment records activity and a tenant-scoped audit entry', async () => {
    role = 'admin';
    const response = await call('POST', '/tickets/7/assignments', { userId: '4' });
    assert.equal(response.status, 200);
    const [audit] = auditInserts();
    assert.deepEqual(audit.params.slice(0, 3), ['3', '2', 'TICKET_ASSIGN']);
    assert.equal(queries.at(-1).sql, 'COMMIT');
});

test('only the assigned employee can acknowledge', async () => {
    ticket = { ...baseTicket(), assigned_to_user_id: '9' };
    const response = await call('POST', '/tickets/7/acknowledge');
    assert.equal(response.status, 403);
    assert.equal(queries.at(-1).sql, 'ROLLBACK');
});

test('acknowledgement is refused unless the ticket is open', async () => {
    ticket = { ...baseTicket(), assigned_to_user_id: '3', status: 'in_progress' };
    const response = await call('POST', '/tickets/7/acknowledge');
    assert.equal(response.status, 409);
});

test('unassigned member cannot change status', async () => {
    const response = await call('PATCH', '/tickets/7/status', { status: 'resolved' });
    assert.equal(response.status, 403);
    assert.equal(queries.at(-1).sql, 'ROLLBACK');
});

test('status changes validate the value and the transition table', async () => {
    role = 'admin';
    assert.equal((await call('PATCH', '/tickets/7/status', {})).status, 400);
    assert.equal((await call('PATCH', '/tickets/7/status', { status: 'done' })).status, 400);
    assert.equal((await call('PATCH', '/tickets/7/status', { status: 'resolved' })).status, 409, 'open -> resolved is not allowed');
    ticket = { ...baseTicket(), status: 'closed' };
    assert.equal((await call('PATCH', '/tickets/7/status', { status: 'open' })).status, 409, 'closed is terminal');
});

test('an assigned member cannot close or cancel a ticket', async () => {
    ticket = { ...baseTicket(), assigned_to_user_id: '3' };
    assert.equal((await call('PATCH', '/tickets/7/status', { status: 'cancelled' })).status, 403);
});

test('a valid transition writes activity and a tenant-scoped audit entry', async () => {
    role = 'admin';
    const response = await call('PATCH', '/tickets/7/status', { status: 'in_progress' });
    assert.equal(response.status, 200);
    const [audit] = auditInserts();
    assert.deepEqual(audit.params.slice(0, 3), ['3', '2', 'TICKET_STATUS']);
});

test('comments validate the payload and restrict internal notes', async () => {
    assert.equal((await call('POST', '/tickets/7/comments', {})).status, 400);
    assert.equal((await call('POST', '/tickets/7/comments', { body: 'hi', isInternal: 'yes' })).status, 400);
    assert.equal((await call('POST', '/tickets/7/comments', { body: 'hi', isInternal: true })).status, 403);
    const ok = await call('POST', '/tickets/7/comments', { body: 'hi' });
    assert.equal(ok.status, 201);
});

test('requester cannot see internal comments', async () => {
    const response = await call('GET', '/tickets/7/comments');
    assert.equal(response.status, 200);
    const comments = queries.find(({ sql }) => sql.includes('FROM ticket_comments'));
    assert.equal(comments.params[2], false);
    assert.match(comments.sql, /is_internal = false/);
});

test('inboxes are manager-only to create and validated', async () => {
    assert.equal((await call('POST', '/inboxes', { name: 'Help', email: 'help@example.test' })).status, 403);
    role = 'admin';
    assert.equal((await call('POST', '/inboxes', { name: 'Help', email: 'not-an-email' })).status, 400);
    assert.equal((await call('POST', '/inboxes', { email: 'help@example.test' })).status, 400);
});

test('story points: managers only, bounded precision', async () => {
    assert.equal((await call('PUT', '/tickets/7/story-points', { estimatedPoints: 3 })).status, 403);
    role = 'admin';
    for (const estimatedPoints of [-1, 'abc', 10000, 1.234, undefined]) {
        assert.equal((await call('PUT', '/tickets/7/story-points', { estimatedPoints })).status, 400, String(estimatedPoints));
    }
});

test('a verifier cannot verify their own work', async () => {
    role = 'admin';
    const response = await call('POST', '/tickets/7/verifications', { contributorUserId: '3', verifiedPoints: 2 });
    assert.equal(response.status, 403);
    assert.equal(queries.length, 1);
});

test('verification requires a resolved ticket', async () => {
    role = 'admin';
    const response = await call('POST', '/tickets/7/verifications', { contributorUserId: '4', verifiedPoints: 2 });
    assert.equal(response.status, 409);
});

test('work summary validates dates and needs HR permission for other employees', async () => {
    assert.equal((await call('GET', '/work-summary/4?from=2026-13-40')).status, 400);
    assert.equal((await call('GET', '/work-summary/4?from=2026-02-02&to=2026-01-01')).status, 400);
    const response = await call('GET', '/work-summary/4');
    assert.equal(response.status, 403);
    assert.equal(queries.some(({ sql }) => sql.includes('FROM ticket_work_verifications')), false);
});

test('ticketing errors carry a status-specific code in the standard envelope', async () => {
    const response = await call('GET', '/tickets/abc');
    const body = await response.json();
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.equal(typeof body.error.message, 'string');
    assert.equal(typeof body.error.requestId, 'string');
});

test('IDs and points must be scalars: arrays, objects and unsafe integers are rejected, not coerced', async () => {
    role = 'admin';
    for (const userId of [['4'], { toString: 'x' }, 9007199254740993, true]) {
        const response = await call('POST', '/tickets/7/assignments', { userId });
        assert.equal(response.status, 400, JSON.stringify(userId));
    }
    for (const estimatedPoints of [['5'], { v: 5 }, true]) {
        const response = await call('PUT', '/tickets/7/story-points', { estimatedPoints });
        assert.equal(response.status, 400, JSON.stringify(estimatedPoints));
    }
    assert.equal((await call('POST', '/tickets/7/assignments', { userId: 4 })).status, 200, 'plain integers still work');
});

test('error codes follow the status: 403 FORBIDDEN, 404 NOT_FOUND, 409 CONFLICT', async () => {
    assert.equal((await (await call('POST', '/tickets/7/assignments', { userId: '4' })).json()).error.code, 'FORBIDDEN');
    ticket = null;
    assert.equal((await (await call('GET', '/tickets/7')).json()).error.code, 'NOT_FOUND');
    role = 'admin';
    ticket = { ...baseTicket(), status: 'closed' };
    assert.equal((await (await call('POST', '/tickets/7/assignments', { userId: '4' })).json()).error.code, 'CONFLICT');
});
